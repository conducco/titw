# titw Production Tutorial

A production-grade multi-agent team — built correctly from the start.

This tutorial covers what the [basic tutorial](./tutorial.md) deliberately skips: **tool-use-based routing** (no fragile text parsing), **error handling with retries**, **graceful shutdown**, and **explicit completion signaling**.

By the end you'll have a runner you can drop into a real product.

---

## What makes this different from the basic tutorial

| Basic tutorial | This tutorial |
|---|---|
| Routes messages via regex on text | Routes via `send_message` tool call — reliable across all models |
| No error handling | Exponential backoff on transient API errors |
| Fixed-timeout completion detection | Lead explicitly signals done via `SEND TO user` tool |
| No shutdown protocol | `ShutdownNegotiator` for graceful agent termination |

---

## Prerequisites

- Node.js >= 20
- An Anthropic API key (or OpenAI — see [swapping providers](#swapping-providers))

---

## Step 1 — Project setup

```bash
mkdir agent-prod && cd agent-prod
npm init -y
npm install @conducco/titw @anthropic-ai/sdk
npm install -D typescript tsx @types/node
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

---

## Step 2 — The production runner

The core insight: instead of asking the model to embed `SEND TO researcher: ...` in prose (which it often ignores), expose `send_message` as a **tool**. Models follow tool schemas far more reliably than free-text conventions.

Create `src/runner.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { AgentRunner } from '@conducco/titw'

const client = new Anthropic()

// The single tool every agent gets — structured message routing.
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'send_message',
    description:
      'Send a message to another agent or back to the user. ' +
      'Call this when you have results to deliver or need to delegate work.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description:
            'Recipient name — another agent (e.g. "researcher", "writer") or "user" when the task is complete.',
        },
        content: {
          type: 'string',
          description: 'The full message content to deliver.',
        },
      },
      required: ['to', 'content'],
    },
  },
]

// Exponential backoff for transient API errors (rate limits, 529s, etc.)
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      const retryable = status === 429 || status === 529 || status === 503
      if (!retryable || attempt === maxAttempts - 1) throw err
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 200
      console.warn(`[runner] Attempt ${attempt + 1} failed (${status}), retrying in ${Math.round(delay)}ms`)
      await new Promise(r => setTimeout(r, delay))
      lastError = err
    }
  }
  throw lastError
}

export const runner: AgentRunner = async (params) => {
  const messages: Anthropic.MessageParam[] = []

  // Seed with initial prompt only if non-empty — agents are mailbox-driven by default.
  if (params.prompt) {
    messages.push({ role: 'user', content: params.prompt })
  }

  let turns = 0
  let tokenCount = 0
  let toolUseCount = 0
  let lastOutput = ''
  let lastSender: string | undefined

  while (!params.abortSignal.aborted) {
    // Drain the mailbox and append each message as a user turn.
    const inbox = await params.readMailbox()
    for (const msg of inbox) {
      messages.push({
        role: 'user',
        content: `[From ${msg.from}]: ${msg.text}`,
      })
      lastSender = msg.from
    }

    // Nothing to respond to yet — wait for the next mailbox delivery.
    const last = messages.at(-1)
    if (!last || last.role !== 'user') {
      await new Promise(r => setTimeout(r, 500))
      continue
    }

    if (turns >= params.maxTurns) {
      console.warn(`[${params.agentId}] Reached maxTurns (${params.maxTurns}), stopping.`)
      break
    }
    turns++

    // Call the LLM with retry logic for transient failures.
    const response = await withRetry(() =>
      client.messages.create({
        model: params.model,
        max_tokens: 8096,
        system: params.systemPrompt,
        tools: [...TOOLS, ...params.mcpTools] as Anthropic.Tool[],
        messages,
        // Surface the abort signal so in-flight requests are cancelled on stop().
        signal: params.abortSignal,
      }),
    )

    tokenCount += response.usage.input_tokens + response.usage.output_tokens

    // Append the full assistant response (may include text + tool_use blocks).
    messages.push({ role: 'assistant', content: response.content })

    // Extract text for logging and output.
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    )
    const text = textBlocks.map(b => b.text).join('\n')
    if (text) {
      lastOutput = text
      console.log(`[${params.agentId}] Turn ${turns}: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`)
    }

    // Process tool calls — this is how agents route messages.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const block of toolUseBlocks) {
      if (block.name === 'send_message') {
        const input = block.input as { to: string; content: string }
        toolUseCount++
        console.log(`[${params.agentId}] → send_message to ${input.to}`)
        await params.sendMessage(input.to, {
          from: params.agentId,
          text: input.content,
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Message delivered to ${input.to}.`,
        })
      } else if (params.mcpTools.some(t => t.name === block.name)) {
        toolUseCount++
        console.log(`[${params.agentId}] → mcp tool: ${block.name}`)
        const result = await params.callMcpTool(
          block.name,
          block.input as Record<string, unknown>,
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        })
      }
    }

    // Return tool results to the model so it can continue reasoning.
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults })
    }

    params.onProgress?.({
      toolUseCount,
      tokenCount,
      lastActivity: `Turn ${turns}`,
    })

    // If the model didn't call any tools and we have a previous sender,
    // auto-reply — prevents silent stalls when the model forgets to route.
    if (toolUseBlocks.length === 0 && text && lastSender) {
      console.log(`[${params.agentId}] → auto-reply to ${lastSender}`)
      await params.sendMessage(lastSender, {
        from: params.agentId,
        text,
      })
    }
  }

  return {
    output: lastOutput,
    toolUseCount,
    tokenCount,
    stopReason: params.abortSignal.aborted ? 'aborted' : 'complete',
  }
}
```

### What changed vs the basic runner

- **Tool-use routing** — `send_message` tool replaces fragile text-pattern matching
- **Tool result loop** — after calling tools the model receives a `tool_result` and can continue reasoning in the same turn
- **`signal` passed to SDK** — in-flight requests are cancelled immediately when `orch.stop()` fires
- **Retry with backoff** — rate limits and overload errors are handled automatically
- **Auto-reply fallback** — if the model omits the tool call, the message still gets delivered

---

## Step 3 — Team configuration

Create `src/team.ts`:

```ts
import type { TeamConfig } from '@conducco/titw'

export const team: TeamConfig = {
  name: 'research-team',
  description: 'Researches a topic and produces a written summary',
  leadAgentName: 'lead',
  defaultModel: 'claude-opus-4-6',

  members: [
    {
      name: 'lead',
      systemPrompt: `You are the team lead for a research operation.

Your workflow:
1. Receive the task from the user.
2. Delegate research by calling send_message(to="researcher", content=<research task>).
3. Wait. When the researcher replies, delegate writing by calling send_message(to="writer", content=<research findings>).
4. Wait. When the writer replies with the draft, deliver it to the user by calling send_message(to="user", content=<final draft>).

Rules:
- Do NOT do research or writing yourself.
- Do NOT call send_message("user", ...) until you have the writer's draft.
- Each step requires exactly one send_message call.`,
      tools: ['*'],
      memory: 'project',
    },

    {
      name: 'researcher',
      systemPrompt: `You are a research specialist.

When you receive a research task, investigate it thoroughly, then deliver your findings by calling:
send_message(to="lead", content=<your complete findings>)

Include primary sources, dates, key contributors, and technical detail.
You MUST call send_message to return your findings — do not just describe them in text.`,
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'bubble',
      maxTurns: 20,
    },

    {
      name: 'writer',
      systemPrompt: `You are a technical writer.

When you receive research findings, write a polished summary (500–800 words), then deliver it by calling:
send_message(to="lead", content=<your complete draft>)

Write in clear prose. Avoid bullet-point overload. Cite specific names, dates, and sources.
You MUST call send_message to return your draft — do not just describe it in text.`,
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 10,
    },
  ],
}
```

---

## Step 4 — Orchestration with graceful shutdown

Create `src/main.ts`:

```ts
import {
  TeamOrchestrator,
  createConfig,
  Mailbox,
  AgentMemory,
  ShutdownNegotiator,
  sanitizeName,
} from '@conducco/titw'
import { team } from './team.js'
import { runner } from './runner.js'

const TASK = `
Research the history and key concepts of the Actor Model in distributed systems.
Produce a concise summary (500–800 words) covering:
- Origins and key contributors
- Core concepts (actors, messages, isolation)
- Modern implementations (Erlang/OTP, Akka, Orleans)
`.trim()

async function main() {
  const config = createConfig()
  const teamName = sanitizeName(team.name)
  const mailbox = new Mailbox({ teamsDir: config.teamsDir, teamName })

  // Clear stale inboxes from previous runs (preserves memory files).
  await Promise.all(
    [...team.members.map(m => m.name), 'user'].map(n => mailbox.clear(n)),
  )

  // Seed the lead's persistent project memory.
  const memory = new AgentMemory({
    agentType: 'lead',
    memoryBaseDir: config.memoryBaseDir,
    cwd: process.cwd(),
  })
  await memory.write(
    'project',
    `User preferences:
- Summaries should be 500–800 words
- Prefer prose over bullet points
- Always include primary sources when available`,
  )

  const orch = new TeamOrchestrator({ team, runner, config, cwd: process.cwd() })
  await orch.start()

  console.log(`Team "${orch.teamName}" started`)
  console.log(`Members: ${orch.memberNames.join(', ')}`)
  console.log(`Lead: ${orch.leadAgentName}\n`)

  // Deliver the task to the lead.
  await orch.sendMessage('lead', {
    from: 'user',
    text: TASK,
    summary: 'research Actor Model',
  })

  // Poll for the lead's final delivery to 'user'.
  console.log('Waiting for result...')
  const timeoutMs = 5 * 60 * 1000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const msgs = await mailbox.readAll('user')
    if (msgs.length > 0) {
      console.log('\n======= Result =======\n')
      for (const msg of msgs) console.log(msg.text)
      break
    }
    await new Promise(r => setTimeout(r, 2000))
  }

  // Graceful shutdown — ask the lead to finish its current turn before stopping.
  const negotiator = new ShutdownNegotiator({ mailbox, timeoutMs: 10_000 })
  const shutdown = await negotiator.requestShutdown({
    fromAgent: 'orchestrator',
    toAgent: 'lead',
  })

  if (shutdown.timedOut) {
    console.log('\nLead timed out — forcing stop.')
  } else {
    console.log('\nLead acknowledged shutdown.')
  }

  await orch.stop()
  console.log('Team stopped.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

---

## Step 4b — Adding MCP tools and skills

To give agents access to external tools via MCP servers, add `mcpServers` to any member in your `TeamConfig`. To inject reusable instruction sets, add `skills`. The framework handles connections and prompt assembly automatically.

Update `src/team.ts` to add MCP and skills to the researcher:

```ts
{
  name: 'researcher',
  systemPrompt: `You are a research specialist. ...`,
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'bubble',
  maxTurns: 20,
  skills: ['./skills/careful-researcher.md'],
  mcpServers: [
    {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY! },
    },
  ],
}
```

Create `skills/careful-researcher.md`:

```markdown
---
name: careful-researcher
description: Deep research with source verification
---

When researching any topic:
- Always identify the original primary source
- Cross-reference at least two independent sources
- Note publication or release dates for all claims
```

The runner already handles MCP dispatch from **Step 2** — no further changes needed. Available MCP tools are automatically merged into the tools list sent to the LLM, and `callMcpTool` dispatches the call to the correct server.

---

## Step 5 — Handle shutdown inside the runner

The `ShutdownNegotiator` sends a structured `shutdown_request` message to the lead's inbox. For the lead to respond, the runner needs to recognise and acknowledge it.

Add this check inside your runner's mailbox-drain loop, in `src/runner.ts`:

```ts
import { isStructuredMessage, parseStructuredMessage } from '@conducco/titw'
// ...

for (const msg of inbox) {
  // Check for graceful shutdown request before queuing as a user turn.
  if (isStructuredMessage(msg)) {
    const parsed = parseStructuredMessage(msg)
    if (parsed?.type === 'shutdown_request') {
      console.log(`[${params.agentId}] Shutdown requested — finishing current work.`)
      // Acknowledge and exit the loop cleanly.
      await params.sendMessage(parsed.from, {
        from: params.agentId,
        type: 'shutdown_response',
        requestId: parsed.requestId,
        approved: true,
        reason: 'acknowledged',
      } as any)
      return {
        output: lastOutput,
        toolUseCount,
        tokenCount,
        stopReason: 'complete',
      }
    }
  }

  messages.push({
    role: 'user',
    content: `[From ${msg.from}]: ${msg.text}`,
  })
  lastSender = msg.from
}
```

---

## Step 6 — Run it

```bash
ANTHROPIC_API_KEY=sk-... npx tsx src/main.ts
```

Expected output:

```
Team "research-team" started
Members: lead, researcher, writer
Lead: lead

Waiting for result...
[lead@research-team] Turn 1: I'll delegate the research phase first...
[lead@research-team] → send_message to researcher
[researcher@research-team] Turn 1: ...
[researcher@research-team] → send_message to lead
[lead@research-team] Turn 2: Research received. Delegating to writer...
[lead@research-team] → send_message to writer
[writer@research-team] Turn 1: ...
[writer@research-team] → send_message to lead
[lead@research-team] Turn 3: ...
[lead@research-team] → send_message to user

======= Result =======

The Actor Model emerged as a revolutionary framework...

Lead acknowledged shutdown.
Team stopped.
```

---

## Swapping providers

Only `src/runner.ts` changes. The framework, team config, and orchestration are identical.

**OpenAI example** — replace the Anthropic client and message format:

```ts
import OpenAI from 'openai'

const client = new OpenAI()

// Replace the TOOLS definition:
const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to another agent or back to the user.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['to', 'content'],
      },
    },
  },
]

// Replace the API call:
const response = await withRetry(() =>
  client.chat.completions.create({
    model: params.model,   // e.g. 'gpt-4o'
    messages: [
      { role: 'system', content: params.systemPrompt },
      ...messages,         // your accumulated OpenAI.ChatCompletionMessageParam[]
    ],
    tools: TOOLS,
  }),
)

// Tool call extraction:
const toolCalls = response.choices[0]?.message?.tool_calls ?? []
for (const call of toolCalls) {
  if (call.function.name === 'send_message') {
    const input = JSON.parse(call.function.arguments) as { to: string; content: string }
    await params.sendMessage(input.to, { from: params.agentId, text: input.content })
  }
}
```

The `params.model` value comes directly from your `TeamConfig` — set it to whatever your provider expects.

---

## What to build next

- **Real tools** — expose `Bash`, `Read`, `Write` as additional tools in `TOOLS` and execute them when the model calls them
- **Typed structured messages** — use `createPlanApprovalRequest` / `createPermissionRequest` from `@conducco/titw` for lead-worker coordination instead of free-text
- **Custom backend** — implement `TeammateExecutor` to run agents in Docker containers or remote workers
- **Prompt cache sharing** — use `buildCacheablePrefix` for byte-identical system prompt prefixes across fork children to maximise LLM cache hit rates
