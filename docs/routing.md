# Routing in titw

Agents communicate by routing messages to each other using the `send_message` tool. This document explains why tool-use routing is the right approach, how to implement it, and common patterns.

---

## Why tool-use routing

The naive approach is to ask the model to embed a routing marker in its response text:

```ts
// ❌ Fragile — models drop the marker in long or structured responses
const match = text.match(/SEND TO (\w+): (.+)/s)
```

This fails silently. When the model produces a markdown report, a long analysis, or a code block, it often omits the plain-text instruction. The pipeline stalls with no error.

**Tool-use is reliable.** Modern LLMs are heavily fine-tuned to invoke tools correctly. When `send_message` is in the tool list, the model calls it as a structured action — not embedded in prose — and the routing destination is a required parameter, not something the model can accidentally omit.

---

## The `send_message` tool

Define this tool in every runner:

```ts
// Anthropic
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
          description: 'Recipient name — another agent (e.g. "researcher") or "user" when the task is complete.',
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
```

```ts
// OpenAI
const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to another agent or back to the user.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient name — another agent or "user".' },
          content: { type: 'string', description: 'The message content.' },
        },
        required: ['to', 'content'],
      },
    },
  },
]
```

**The `"user"` recipient** is the convention for signalling task completion. The orchestrator polls the `user` inbox to detect when the lead has finished.

---

## Full dispatch loop

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { AgentRunner } from '@conducco/titw'

const client = new Anthropic()

const TOOLS: Anthropic.Tool[] = [/* definition above */]

export const runner: AgentRunner = async (params) => {
  const messages: Anthropic.MessageParam[] = []
  if (params.prompt) messages.push({ role: 'user', content: params.prompt })

  let turns = 0
  let tokenCount = 0
  let lastOutput = ''

  while (!params.abortSignal.aborted) {
    const inbox = await params.readMailbox()
    for (const msg of inbox) {
      messages.push({ role: 'user', content: `[From ${msg.from}]: ${msg.text}` })
    }

    const last = messages.at(-1)
    if (!last || last.role !== 'user') { await new Promise(r => setTimeout(r, 500)); continue }
    if (turns++ >= params.maxTurns) break

    const res = await client.messages.create({
      model: params.model,
      max_tokens: 4096,
      system: params.systemPrompt,
      tools: TOOLS,
      messages,
      signal: params.abortSignal,
    })

    messages.push({ role: 'assistant', content: res.content })
    tokenCount += res.usage.input_tokens + res.usage.output_tokens

    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    if (text) lastOutput = text

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type === 'tool_use' && block.name === 'send_message') {
        const { to, content } = block.input as { to: string; content: string }
        await params.sendMessage(to, { from: params.agentId, text: content })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Message delivered to ${to}.` })
      }
    }
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults })
  }

  return { output: lastOutput, toolUseCount: 0, tokenCount, stopReason: params.abortSignal.aborted ? 'aborted' : 'complete' }
}
```

### OpenAI

```ts
import OpenAI from 'openai'
import type { AgentRunner } from '@conducco/titw'

const client = new OpenAI()

const TOOLS: OpenAI.ChatCompletionTool[] = [/* definition above */]

export const runner: AgentRunner = async (params) => {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: params.systemPrompt },
  ]
  if (params.prompt) messages.push({ role: 'user', content: params.prompt })

  let turns = 0
  let tokenCount = 0
  let lastOutput = ''

  while (!params.abortSignal.aborted) {
    const inbox = await params.readMailbox()
    for (const msg of inbox) {
      messages.push({ role: 'user', content: `[From ${msg.from}]: ${msg.text}` })
    }

    const last = messages.at(-1)
    if (!last || last.role !== 'user') { await new Promise(r => setTimeout(r, 500)); continue }
    if (turns++ >= params.maxTurns) break

    const res = await client.chat.completions.create({
      model: params.model,
      messages,
      tools: TOOLS,
    })

    const msg = res.choices[0]!.message
    messages.push(msg)
    tokenCount += res.usage?.total_tokens ?? 0
    if (msg.content) lastOutput = msg.content

    for (const call of msg.tool_calls ?? []) {
      if (call.function.name === 'send_message') {
        const { to, content } = JSON.parse(call.function.arguments) as { to: string; content: string }
        await params.sendMessage(to, { from: params.agentId, text: content })
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Message delivered to ${to}.` })
      }
    }
  }

  return { output: lastOutput, toolUseCount: 0, tokenCount, stopReason: params.abortSignal.aborted ? 'aborted' : 'complete' }
}
```

**Always return tool results to the model** (the `toolResults.push` / `messages.push` step). If you skip this, the model stalls waiting for a response that never arrives.

---

## Routing patterns

### Linear pipeline

The most common pattern. Each agent has exactly one downstream destination.

```
user → lead → researcher → lead → writer → lead → user
```

System prompt for `researcher`:
```
When your research is complete, deliver it by calling:
send_message(to="lead", content=<your findings>)
```

### Fan-out

The lead delegates to multiple workers in parallel, then collects results.

```
lead → researcher
lead → coder
researcher → lead  (results)
coder → lead       (results)
lead → user
```

System prompt for `lead`:
```
1. Send the research task: send_message(to="researcher", content=...)
2. Send the coding task: send_message(to="coder", content=...)
3. When both have replied, synthesize and send_message(to="user", content=...)
```

Because routing is explicit (`to` is a required parameter), fan-out works correctly — there is no ambiguity about where each response goes.

### Fan-in (workers reply to lead)

Workers always reply to the agent that assigned them work. The lead's system prompt tracks pending responses:

```
You have delegated to researcher and coder. Wait for both replies before proceeding.
When both have responded, synthesize the results and send_message(to="user", content=...).
```

---

## Common mistakes

**1. Forgetting to return tool results to the model**

After calling `send_message`, push a `tool_result` back into the message array. If you don't, the model is left in a state where it called a tool but never received confirmation — it will stall or repeat itself.

**2. Routing to `"user"` too early**

Only call `send_message(to="user", ...)` when the full task is complete. The orchestrator treats a message in the `user` inbox as the terminal signal. Sending an intermediate result there will cause the orchestrator to stop the team prematurely.

**3. Not passing `signal` to the SDK**

Pass `params.abortSignal` to your SDK call (`signal` in Anthropic, not supported in all OpenAI versions). Without it, in-flight API requests are not cancelled when `orch.stop()` fires, causing the process to hang until they complete.

**4. Infinite loops from missing tool calls**

If the model produces text without calling `send_message`, and your runner loops back to wait for more input, it will call the model again with the same prompt — potentially forever. Guard with `maxTurns` and log a warning when the limit is reached.
