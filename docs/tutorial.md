# titw Tutorial

A production-grade multi-agent team — built correctly from the start.

By the end you'll have a runner you can drop into a real product: tool-use-based routing, error handling with retries, graceful shutdown, and explicit completion signaling.

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

## Step 5 — Adding MCP tools and skills

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

## Step 6 — Handle shutdown inside the runner

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

## Step 7 — Run it

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

## Step 8 — Memory Gateway (default: FileProvider + KGC)

The `AgentMemory.write()` call in Step 4 seeds memory manually before a run. The Memory Gateway adds a **runtime write path**: an observer agent (the KGC) silently receives every team message, extracts knowledge triples, and stores them via a pluggable provider. Future runs see accumulated knowledge without manual seeding.

Three pieces to wire:

1. A **provider** — where memory is stored
2. An **observer agent** declared on `TeamConfig.observerAgent`
3. A **KGC runner branch** that reads observed messages, extracts triples, and calls `params.writeMemory`

`FileProvider` (the default option) stores triples in the same markdown files `AgentMemory` already uses — no new formats, no new dependencies.

### Add the KGC agent to your team config

Update `src/team.ts`:

```ts
import type { TeamConfig } from '@conducco/titw'

export const team: TeamConfig = {
  name: 'research-team',
  leadAgentName: 'lead',
  defaultModel: 'claude-opus-4-6',
  observerAgent: 'kgc',            // every team message is CC'd to this agent

  members: [
    // lead, researcher, writer from Step 3 — unchanged

    {
      name: 'kgc',
      model: 'claude-haiku-4-5-20251001',   // cheap — extraction only
      memory: 'project',                     // controls which scope write() targets
      systemPrompt: `
You observe all messages in this team. Extract factual triples as JSON.
Output ONLY a JSON array — no other text:
[{"subject":"...","predicate":"...","object":"...","weight":0.8}]
Never send messages to other agents.
      `.trim(),
    },
  ],
}
```

### Pass FileProvider to the orchestrator

Update `src/main.ts`:

```ts
import {
  TeamOrchestrator,
  createConfig,
  FileProvider,
  Mailbox,
  sanitizeName,
} from '@conducco/titw'
import { team } from './team.js'
import { runner } from './runner.js'

async function main() {
  const config = createConfig()
  // ...mailbox clear + AgentMemory seed (unchanged from Step 4)...

  const orch = new TeamOrchestrator({
    team,
    runner,
    config,
    cwd: process.cwd(),
    memoryProvider: new FileProvider({
      cwd: process.cwd(),
      memoryBaseDir: config.memoryBaseDir,
    }),
  })

  await orch.start()
  // ...rest unchanged...
}
```

### Add a KGC branch to your runner

Rename the existing `export const runner` in `src/runner.ts` to `const mainRunner`, then append:

```ts
function tryParseTriples(text: string) {
  try {
    const parsed = JSON.parse(text.trim())
    if (Array.isArray(parsed)) return parsed
  } catch { /* not JSON */ }
  return null
}

const kgcRunner: AgentRunner = async (params) => {
  const inbox = await params.readMailbox()
  if (inbox.length === 0) {
    return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
  }

  const observed = inbox.map(m => `[${m.from}]: ${m.text}`).join('\n\n')

  const response = await withRetry(() =>
    client.messages.create({
      model: params.model,
      max_tokens: 2048,
      system: params.systemPrompt,
      messages: [{ role: 'user', content: observed }],
    }),
  )

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')

  const triples = tryParseTriples(text)
  if (triples && params.writeMemory) {
    await params.writeMemory(triples)
  }

  return {
    output: text,
    toolUseCount: 0,
    tokenCount: response.usage.input_tokens + response.usage.output_tokens,
    stopReason: 'complete',
  }
}

// Dispatcher — routes KGC agent to its own runner
export const runner: AgentRunner = async (params) => {
  if (params.agentId.startsWith('kgc@')) return kgcRunner(params)
  return mainRunner(params)
}
```

After each run, extracted triples are appended to the project memory file:

```
- Actor Model invented-by Carl Hewitt (weight: 0.9)
- Erlang implements Actor Model (weight: 0.8)
- Akka uses Actor Model (weight: 0.85)
```

At the next spawn, `FileProvider` injects them into the agent's system prompt inside `<agent-memory>` tags — alongside anything already in the file.

---

## Step 9 — Obsidian memory

To write knowledge into an Obsidian vault, swap the provider in `src/main.ts`. The KGC agent, team config, and runner are unchanged.

```ts
import { TeamOrchestrator, createConfig, ObsidianProvider } from '@conducco/titw'

const orch = new TeamOrchestrator({
  team,
  runner,
  config,
  cwd: process.cwd(),
  memoryProvider: new ObsidianProvider('/Users/you/vault'),
})
```

Each subject entity gets its own note, using Obsidian wikilinks for relationships:

```markdown
<!-- /Users/you/vault/project/Actor-Model.md -->
- invented-by: [[Carl Hewitt]]
- implemented-by: [[Erlang]] <!-- weight: 0.8 -->
- implemented-by: [[Akka]] <!-- weight: 0.85 -->
```

Scope (`user` / `project` / `local`) maps to a subdirectory inside the vault. `buildSystemPromptInjection` reads all `.md` files in the scope subdirectory and injects them at spawn time. The vault graph view shows entity relationships natively — no extra tooling required.

**Vault layout:**

```
/Users/you/vault/
  project/
    Actor-Model.md
    Carl-Hewitt.md
    Erlang.md
  user/
    (agent personal memory)
```

---

## Step 10 — FalkorDB memory

FalkorDB stores triples as graph edges and retrieves them with time-decay scoring: older facts rank lower without ever being deleted. Useful when agent knowledge evolves over time — stale facts fade out of context rather than accumulating noise.

**Install the optional peer dependency:**

```bash
npm install falkordb
```

**Start FalkorDB locally with Docker:**

```bash
docker run -p 6379:6379 falkordb/falkordb
```

**Import from the sub-path export and add connection lifecycle:**

```ts
import { TeamOrchestrator, createConfig } from '@conducco/titw'
import { FalkorProvider } from '@conducco/titw/falkor'
import { team } from './team.js'
import { runner } from './runner.js'

async function main() {
  const config = createConfig()
  // ...mailbox clear + AgentMemory seed (unchanged from Step 4)...

  const provider = new FalkorProvider({
    url: 'redis://localhost:6379',
    graphName: 'research-team',
    lambda: 0.95,   // decay factor — optional, default 0.95 (~14-day half-life)
  })

  await provider.connect()   // must be called before orch.start()

  const orch = new TeamOrchestrator({
    team,
    runner,
    config,
    cwd: process.cwd(),
    memoryProvider: provider,
  })

  await orch.start()
  // ...run team, wait for result...

  await orch.stop()
  await provider.disconnect()   // must be called after orch.stop()
}
```

**Decay formula:** `score = weight × λ^(age_in_days)`

At spawn time the 50 highest-scoring triples are injected. A triple written today with `weight: 1.0` and `λ = 0.95` scores `0.95` after 1 day, `0.77` after 5 days, `0.60` after 10 days.

| λ | Approximate half-life |
|---|----------------------|
| 0.99 | ~69 days |
| 0.95 | ~14 days |
| 0.90 | ~7 days |
| 0.80 | ~3 days |

Facts are never deleted — decay affects ranking only.

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

**Azure AI Foundry example** — if you are on the `@anthropic-ai/sdk` path (rather than OpenAI above), you can target Azure AI Foundry by swapping only the client config:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { buildAzureFoundryClientConfig } from '@conducco/titw'

const client = new Anthropic(buildAzureFoundryClientConfig({
  endpoint: process.env.AZURE_AI_ENDPOINT!,   // Target URI from Foundry portal
  apiKey:   process.env.AZURE_AI_API_KEY!,    // Project API Key from Foundry portal
}))
```

The `TOOLS` definition, message loop, tool dispatch, and retry logic from Step 2 are **unchanged**. Set `defaultModel` in your `TeamConfig` to the **Foundry deployment name** (not the underlying model identifier).

See `docs/runner-azure-foundry.md` for the full provisioning walkthrough and common issues.

**DeepSeek on Azure AI Foundry example** — same helper, but use the OpenAI SDK. DeepSeek's endpoint path (`/api/projects/...`) is different from Claude's — just pass your Target URI:

```ts
import OpenAI from 'openai'
import { buildAzureFoundryClientConfig } from '@conducco/titw'

const client = new OpenAI(buildAzureFoundryClientConfig({
  endpoint: process.env.AZURE_AI_DEEPSEEK_ENDPOINT!,
  apiKey:   process.env.AZURE_AI_DEEPSEEK_KEY!,
}))
```

The `TOOLS` format and message loop must use the OpenAI-compatible format (`chat.completions.create`, `role: 'tool'` results). Set `defaultModel` in your `TeamConfig` to the **deployment name**.

See `docs/runner-deepseek-foundry.md` for the full provisioning walkthrough and common issues.

---

## What to build next

- **Real tools** — expose `Bash`, `Read`, `Write` as additional tools in `TOOLS` and execute them when the model calls them
- **Typed structured messages** — use `createPlanApprovalRequest` / `createPermissionRequest` from `@conducco/titw` for lead-worker coordination instead of free-text
- **Custom backend** — implement `TeammateExecutor` to run agents in Docker containers or remote workers
- **Prompt cache sharing** — use `buildCacheablePrefix` for byte-identical system prompt prefixes across fork children to maximise LLM cache hit rates
- **Custom memory provider** — implement `IMemoryProvider` to write triples to any backend (vector DB, SQL, external service)
