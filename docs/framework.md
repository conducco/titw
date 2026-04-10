# titw — Framework Reference

**titw** is a TypeScript framework for building multi-agent teams. It handles the operational infrastructure — spawning agents, routing messages between them, persisting memory across sessions, injecting skills, and connecting to external tools — so application code only needs to implement the LLM call itself.

---

## Philosophy

### The framework does not call LLMs

Every LLM framework eventually becomes a problem: it accumulates opinions about which provider to use, how to format prompts, how to handle retries, and what the tool schema looks like. titw avoids this entirely. The framework never imports an LLM SDK. It calls a single user-provided function — `AgentRunner` — and receives a result. The LLM call, the retry logic, the tool schema format, the streaming approach — all of that lives in the runner the user writes.

This means switching from Anthropic to OpenAI to a local model requires changing one file. Nothing else moves.

### State is files, not in-memory

Agent inboxes are JSON files on disk. Memory is markdown files. The team can crash and restart without losing messages. Multiple processes can write to inboxes safely (file-level atomic writes). Running in Docker or on a remote machine requires no special configuration — just mount the same directory.

### Configuration is declared, not programmed

A team is a plain `TeamConfig` object validated at startup by Zod. Members, models, memory scopes, MCP servers, skills — all declared. No subclassing, no builder patterns, no registration hooks. The framework reads the config and sets everything up.

### Isolation through context, not processes

Each agent runs as an async function in the same Node.js process, isolated via `AsyncLocalStorage`. This means zero spawn overhead, no IPC, and shared memory when intentional (e.g. `PermissionBridge`). The tradeoff: agents share the same event loop. For workloads requiring true process isolation (e.g. agents executing arbitrary code), swap `InProcessBackend` for a `TeammateExecutor` that runs agents in containers.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Application                         │
│                                                                 │
│   TeamConfig ──────────────────────────────────────────────┐   │
│   AgentRunner ─────────────────────────────────────────┐   │   │
└───────────────────────────────────────────────────────┼───┼───┘
                                                        │   │
                                                        ▼   ▼
┌─────────────────────────────────────────────────────────────────┐
│                       TeamOrchestrator                          │
│                                                                 │
│  start() ──► validates TeamConfig (Zod)                         │
│              for each member:                                   │
│                AgentLoader.resolveModel()                       │
│                AgentMemory.buildSystemPromptInjection()         │
│                SkillRegistry.load()                             │
│                MCPToolkit.connect()                             │
│                backend.spawn(...)                               │
│                                                                 │
│  sendMessage() ──► Mailbox.write(agentName, message)            │
│  stop()        ──► backend.kill(agentId) for each agent         │
└────────────────────────────┬────────────────────────────────────┘
                             │ backend.spawn()
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      InProcessBackend                           │
│  (implements TeammateExecutor)                                  │
│                                                                 │
│  AsyncLocalStorage.run(context, async () => {                   │
│    await runner({                                               │
│      agentId, systemPrompt, model, maxTurns,                    │
│      readMailbox, sendMessage,                                  │
│      mcpTools, callMcpTool,                                     │
│      abortSignal, onProgress                                    │
│    })                                                           │
│  })                                                             │
└────────────────────────────┬────────────────────────────────────┘
                             │ runner(params)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                         AgentRunner                             │
│  (user-provided — the only place LLM calls happen)              │
│                                                                 │
│  while (!abortSignal.aborted) {                                 │
│    inbox = await readMailbox()       // reads from disk         │
│    response = await llm.call(...)    // YOUR LLM call           │
│    await sendMessage(to, content)    // writes to disk          │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘

Shared infrastructure used throughout:
  Mailbox        — JSON files at {teamsDir}/{team}/inboxes/{agent}.json
  AgentMemory    — markdown files at scoped paths under ~/.titw/ and .titw/
  SkillRegistry  — markdown files loaded once at spawn
  MCPToolkit      — MCP server connections managed per-agent
  IMemoryProvider — pluggable read/write backend; defaults to AgentMemory behavior
```

---

## Core Components

### TeamConfig and AgentConfig

The entry point for every team. `TeamConfig` describes the team structure; `AgentConfig` describes each member. Both are plain TypeScript interfaces validated at startup with Zod — no subclassing required.

```ts
interface TeamConfig {
  name: string                   // human-readable team name
  description?: string
  leadAgentName: string          // must match one member's name
  members: AgentConfig[]         // at least one member required
  defaultModel?: string          // fallback model for all members
  allowedPaths?: TeamAllowedPath[]  // pre-granted filesystem paths
  observerAgent?: string             // agent name that receives CC of every team message (KGC pattern)
}

interface AgentConfig {
  name: string
  systemPrompt: string
  model?: string | 'inherit'     // 'inherit' = use team defaultModel
  permissionMode?: 'default' | 'plan' | 'bubble' | 'bypass'
  tools?: string[]               // tool names this agent can use (informational)
  disallowedTools?: string[]
  mcpServers?: MCPServerConfig[] // external tools via MCP
  skills?: string[]              // markdown skill files or npm packages
  memory?: 'user' | 'project' | 'local'  // enable persistent memory
  maxTurns?: number              // override config.defaultMaxTurns
  color?: string                 // UI display color
}
```

**Validation** happens in `TeamOrchestrator.start()` via `AgentLoader.validateTeam()`. A mismatch between `leadAgentName` and actual member names throws before any agents spawn.

**Agent identity** is `{agentName}@{teamName}` (e.g. `researcher@research-team`). Team names are sanitized to lowercase-hyphenated form (`sanitizeName()`) for filesystem paths.

---

### AgentRunner — the seam

`AgentRunner` is the single interface between the framework and any LLM provider. The framework calls it with everything an agent needs to operate; the runner calls the LLM and uses the provided functions to communicate.

```ts
type AgentRunner = (params: AgentRunParams) => Promise<AgentRunResult>

interface AgentRunParams {
  agentId: string           // "researcher@research-team"
  systemPrompt: string      // assembled by framework: base + skills + memory
  prompt: string            // initial prompt (usually empty — agents are mailbox-driven)
  model: string             // resolved model identifier
  maxTurns: number          // max LLM turns before forced exit
  abortSignal: AbortSignal  // fires when orch.stop() is called
  readMailbox: () => Promise<TeammateMessage[]>            // poll inbox
  sendMessage: (to, msg) => Promise<void>                  // write to another agent's inbox
  mcpTools: MCPToolSchema[]                                // MCP-discovered tool schemas
  callMcpTool: (name, args) => Promise<unknown>            // dispatch MCP tool call
  onProgress?: (progress: AgentProgress) => void
  writeMemory?: (triples: Triple[]) => Promise<void>  // only set for the observer agent
}

interface AgentRunResult {
  output: string
  toolUseCount: number
  tokenCount: number
  stopReason: 'complete' | 'aborted' | string
}
```

The runner is typically an `async` loop:
1. Drain the mailbox — get new messages
2. If nothing to respond to, wait 500ms and retry
3. Call the LLM with accumulated message history
4. If the response contains a `send_message` tool call, route to the named agent
5. Push tool results back to the LLM
6. Repeat until `abortSignal.aborted` or `maxTurns` reached

See `docs/tutorial.md` and `docs/routing.md` for complete implementations.

---

### TeamOrchestrator

The main lifecycle manager. One instance per team.

```ts
const orch = new TeamOrchestrator({ team, runner, config, cwd })

await orch.start()                              // spawns all members
await orch.sendMessage('lead', { from: 'user', text: '...' })
await orch.stop()                               // kills all agents

orch.teamName          // string
orch.leadAgentName     // string
orch.memberNames       // string[]
orch.isRunning         // boolean
orch.activeMemberCount // number
```

**`start()`** validates the team config, then spawns all members concurrently via `Promise.all`. For each member it:
1. Resolves the model (`AgentLoader.resolveModel`)
2. Builds the memory injection (via `IMemoryProvider.buildSystemPromptInjection` if `memoryProvider` is set, otherwise `AgentMemory`)
3. Loads skills (`SkillRegistry.load`)
4. Connects MCP servers (`MCPToolkit.connect`)
5. Assembles the system prompt: `base + skillInjection + memoryInjection`
6. Calls `backend.spawn()` with all resolved parameters

**`stop()`** calls `backend.kill(agentId)` for every spawned agent. Kill signals the `AbortController`, which fires `abortSignal` inside the runner, causing any in-flight LLM calls to cancel (when `signal` is passed to the SDK).

**Custom backends**: The `backend` option accepts any `TeammateExecutor` implementation. The default is `InProcessBackend`. Implement `TeammateExecutor` to run agents in Docker containers, remote workers, or separate processes.

---

### InProcessBackend

The default `TeammateExecutor`. Runs each agent as an `async` function in the same Node.js process, isolated via `AsyncLocalStorage`.

**What `AsyncLocalStorage` provides**: Each agent's execution context — its `agentId`, `agentName`, `teamName`, and `Mailbox` instance — is scoped to that agent's async call tree. Code running inside the runner can read the current agent's context without it being passed explicitly. This is analogous to thread-local storage.

**What it does not provide**: Process isolation, memory limits, CPU limits, or security sandboxing. Agents share the heap and the event loop. If one agent throws an uncaught exception, only that agent's task fails — the error is caught in the `finally` block, `onIdle` fires, and the team continues. But a synchronous infinite loop would block the entire process.

**Cancellation**: Each agent gets its own `AbortController`. `kill(agentId)` calls `abortController.abort()`. When the runner passes `abortSignal` to its SDK call, the in-flight HTTP request is cancelled immediately.

```ts
// Inside InProcessBackend.spawn():
void this.storage.run(context, async () => {
  try {
    await spawnCfg.runner({ ..., abortSignal: abortController.signal })
  } catch (err) {
    if (!abortController.signal.aborted) console.error(...)
  } finally {
    this.running.delete(agentId)
    spawnCfg.onIdle?.()   // ← MCPToolkit.disconnect() fires here
  }
})
```

---

### Mailbox — inter-agent communication

Every agent has a persistent JSON inbox on disk:

```
{teamsDir}/{teamName}/inboxes/{agentName}.json
```

Default location: `~/.titw/teams/{team}/inboxes/{agent}.json`

A `TeammateMessage` is:
```ts
interface TeammateMessage {
  from: string
  text: string
  timestamp: string   // ISO 8601, set on write
  read: boolean       // false on write, true after readMailbox()
  color?: string
  summary?: string
}
```

**How agents send messages**: The runner calls `params.sendMessage(to, message)`. This writes to `{to}.json` on disk. The recipient's next `readMailbox()` call will pick it up.

**How agents read messages**: `params.readMailbox()` calls `Mailbox.readUnread()` (filters `read: false`) then `markAllRead()`. The runner gets the new messages and appends them to its LLM message history.

**Why file-based**: Persistence across restarts. Inspectable with any text editor. No message broker dependency. Deliverable from outside the framework (write a JSON file manually to inject a message). Survives a process crash mid-conversation — messages accumulate until the agent restarts and drains its inbox.

**`user` inbox convention**: Messages sent `to: "user"` land in a `user.json` inbox. The orchestrator-side code polls this to detect when the lead has completed the task. This is how multi-agent teams signal completion to external callers.

**Observer CC**: When `TeamConfig.observerAgent` is set, every `Mailbox.write()` call automatically delivers a copy to the observer's inbox in addition to the primary recipient. The observer never appears in any agent's peers list — it is invisible to the team. This is the delivery mechanism for the KGC pattern.

**Structured messages**: Some framework protocols (shutdown negotiation, plan approval, permission requests) use structured payloads serialized as JSON in `text`. `isStructuredMessage()` and `parseStructuredMessage()` detect and deserialize these.

---

### AgentMemory — 3-tier persistent memory

Agents can have persistent memory that survives across sessions. Memory is plain markdown stored in `MEMORY.md` files, injected into the system prompt at spawn time.

**Three scopes**:

| Scope | Location | Use case |
|---|---|---|
| `user` | `{memoryBaseDir}/agent-memory/{agentType}/MEMORY.md` | Preferences shared across all projects (defaults to `~/.titw/memory/`) |
| `project` | `{cwd}/.titw/agent-memory/{agentType}/MEMORY.md` | Project-specific knowledge — can be committed to VCS |
| `local` | `{cwd}/.titw/agent-memory-local/{agentType}/MEMORY.md` | Ephemeral, gitignored — session notes, in-progress state |

**Injection format**: When memory exists, it's appended to the system prompt as:

```
<agent-memory scope="project">
The following is your persistent memory from previous sessions:
{content}
</agent-memory>
```

**System prompt assembly order**:
```
{agentConfig.systemPrompt}
{skill injections}          ← <skill name="..."> tags
{memory injection}          ← <agent-memory scope="..."> tag
```

Skills are injected before memory. The convention: skill instructions define general behaviour; memory (learned knowledge) takes precedence when they conflict.

**Reading and writing**:
```ts
const memory = new AgentMemory({ agentType: 'researcher', cwd, memoryBaseDir })
await memory.write('project', 'Preferred citation format: APA.')
await memory.append('local', '\n- Checked arXiv 2024-01-15.')
const content = await memory.read('user')
```

`AgentMemory` is the default. To make memory pluggable — and to support runtime writes via a KGC agent — use the Memory Gateway described below.

---

### Memory Gateway — pluggable providers

The Memory Gateway replaces `AgentMemory` with a two-method interface, making storage backends swappable without changing any other code.

```ts
interface IMemoryProvider {
  buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string>
  write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void>
  connect?(): Promise<void>     // optional lifecycle hook (e.g. database connection)
  disconnect?(): Promise<void>
}

interface Triple {
  subject: string
  predicate: string
  object: string
  weight?: number   // default 1.0; used for decay scoring in FalkorProvider
}
```

- `buildSystemPromptInjection` — the read path, called at spawn time. Returns an `<agent-memory>` tag or an empty string.
- `write` — the write path, called by the KGC runner after extracting triples from observed messages.

**Passing a provider**:

```ts
const orch = new TeamOrchestrator({
  team,
  runner,
  config,
  cwd: process.cwd(),
  memoryProvider: new FileProvider({ cwd: process.cwd(), memoryBaseDir: config.memoryBaseDir }),
})
```

If `memoryProvider` is absent, the orchestrator falls back to `AgentMemory` — zero breaking changes.

**Three built-in providers**:

| Provider | Import | Storage | Extra deps |
|----------|--------|---------|------------|
| `FileProvider` | `@conducco/titw` | Same markdown files as `AgentMemory` | None |
| `ObsidianProvider` | `@conducco/titw` | One `.md` note per entity with wikilinks | None |
| `FalkorProvider` | `@conducco/titw/falkor` | Redis graph database with time-decay scoring | `falkordb` |

**The KGC pattern**: Set `TeamConfig.observerAgent: 'kgc'` to nominate an agent that receives a silent CC of every message. The framework passes `writeMemory` only to that agent's runner. The runner extracts triples from the observed messages and calls `params.writeMemory(triples)`. The provider persists them; subsequent spawns see the accumulated knowledge via `buildSystemPromptInjection`.

```ts
// In the KGC runner — the framework sets writeMemory only for the observer agent
const triples = tryParseTriples(response.text)
if (triples && params.writeMemory) {
  await params.writeMemory(triples)
}
```

**FalkorProvider lifecycle**: Because it manages a Redis connection, call `connect()` before `orch.start()` and `disconnect()` after `orch.stop()`. The decay formula is `score = weight × λ^(age_in_days)`; the top 50 results by score are injected at spawn time. No triples are ever deleted.

See `docs/memory-gateway.md` for full usage examples and common mistakes.

---

### SkillRegistry — reusable instruction sets

Skills are markdown files that extend an agent's behaviour without touching its `systemPrompt`. They're loaded once at spawn time, wrapped in `<skill>` tags, and injected into the system prompt.

**Skill file format** (frontmatter optional):
```markdown
---
name: careful-researcher
description: Deep research with source verification
---

When researching any topic:
- Always identify the original primary source
- Cross-reference at least two independent sources
```

**Sources**:
- Local path: `'./skills/careful-researcher.md'` or `'/absolute/path/skill.md'`
- npm package: `'@titw/skill-researcher'` (must export `{ name, content }` or have `skill.md` at package root)

**Injection format**:
```
<skill name="careful-researcher">
When researching any topic:
...
</skill>
```

**Error behaviour**: SkillRegistry never throws. Missing files warn and skip. Malformed frontmatter uses the filename as the skill name. Duplicate skill names are deduplicated. Skills over 50KB are truncated with `<!-- skill truncated -->`.

---

### MCPToolkit — external tools via MCP

MCP (Model Context Protocol) allows agents to call external tools — filesystem access, web search, databases, custom APIs — without changes to the runner. The framework manages connection lifecycle; the runner receives tool schemas and a dispatch function.

**Configuration** (per agent in `AgentConfig`):
```ts
mcpServers: [
  {
    type: 'stdio',              // local process (most MCP servers)
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { ALLOWED_DIRS: '/tmp/research' },
    required: true,             // team fails to spawn if this can't connect
    timeoutMs: 10_000,
  },
  {
    type: 'sse',                // remote server
    url: 'http://mcp.internal/sse',
  },
]
```

**Lifecycle**: `MCPToolkit.connect()` is called at spawn time for each agent. It connects to each configured server, discovers tool schemas via `listTools()`, and checks for reserved name collisions (`send_message` is reserved — it's the framework's routing primitive). If a `required: true` server fails to connect, the agent does not spawn and any already-connected servers are closed.

**At runtime**: `params.mcpTools` contains all discovered schemas ready to pass to any LLM provider. `params.callMcpTool(name, args)` dispatches a call to the correct server. On server crash mid-run, it returns `{ error: true, message: "..." }` instead of throwing — the LLM receives it as a tool result and can react.

**Disconnect**: Called in `onIdle` when the agent finishes (normal completion, abort, or error). Uses `Promise.allSettled` so one failed close doesn't block others.

**Runner integration**:
```ts
// Merge framework tools with MCP tools
const allTools = [...BUILT_IN_TOOLS, ...params.mcpTools]

// In the tool dispatch loop:
if (params.mcpTools.some(t => t.name === block.name)) {
  const result = await params.callMcpTool(block.name, block.input)
  toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) })
}
```

---

### PermissionBridge — worker permission escalation

When a worker agent needs to perform a sensitive action, it can escalate to the lead rather than executing autonomously. `PermissionBridge` is a shared in-memory object connecting workers to the lead's handler.

```ts
const bridge = new PermissionBridge()

// Lead registers a handler
bridge.registerLeaderHandler(async (request) => {
  // request.tool, request.input
  return { approved: true }
})

// Lead can pre-grant paths
bridge.grantPath({ path: '/project/src', toolName: 'Write', grantedBy: 'lead' })

// Worker checks before acting
const ok = bridge.isPathPermitted('/project/src/index.ts', 'Write')
if (!ok) {
  const result = await bridge.requestApproval({ requestId, tool: 'Write', input })
}
```

**Permission modes** (per-agent `permissionMode`):
- `default` — agent acts autonomously
- `plan` — agent presents a plan before executing
- `bubble` — agent surfaces permission requests to the lead
- `bypass` — all permissions granted automatically

---

### ShutdownNegotiator — graceful shutdown

Calling `orch.stop()` immediately aborts all agents. For a graceful shutdown — where the lead finishes its current turn before stopping — use `ShutdownNegotiator`.

**Protocol** (mailbox-based request/response):
1. Orchestrator writes a `shutdown_request` structured message to the lead's inbox
2. Lead detects it during mailbox drain, sends a `shutdown_response` back
3. Orchestrator polls its own inbox until it receives the matching response or times out

```ts
const negotiator = new ShutdownNegotiator({ mailbox, timeoutMs: 10_000 })

// Orchestrator side
const result = await negotiator.requestShutdown({ fromAgent: 'orchestrator', toAgent: 'lead' })
// result.approved, result.timedOut

// Runner side (inside the mailbox-drain loop)
const parsed = parseStructuredMessage(msg.text)
if (parsed?.type === 'shutdown_request') {
  await negotiator.respondToShutdown({
    fromAgent: params.agentId,
    toAgent: parsed.from,
    requestId: parsed.request_id,
    approve: true,
  })
  return { output: lastOutput, ... }
}
```

---

### Cache Sharing — prompt cache optimization

For teams where multiple agents share a common system prompt prefix (e.g. a repo context block), `buildCacheablePrefix` constructs a byte-identical prefix string that maximizes LLM prompt cache hits across concurrent agents.

```ts
import { buildCacheablePrefix, isForkBoilerplatePresent, injectForkBoilerplate } from '@conducco/titw'

const prefix = buildCacheablePrefix({
  repoContext: '...',         // identical across all agents
  agentInstructions: '...',   // agent-specific — placed after the shared prefix
})
```

This is only relevant when running large teams with expensive context blocks (code repositories, large document sets) where cache-hit rates measurably reduce cost and latency.

---

## How titw Solves Each Problem

### Operation — team lifecycle

A team moves through three phases:

**Spawn**: `orch.start()` validates the config, resolves each agent's model, assembles their system prompts (base + skills + memory), connects MCP servers, and calls `backend.spawn()` for each member concurrently. All agents start simultaneously and immediately begin polling their inboxes.

**Run**: Agents are mailbox-driven. They loop: drain inbox → call LLM → route response → repeat. There is no central scheduler — agents run independently and coordinate entirely through message passing.

**Stop**: `orch.stop()` calls `backend.kill()` for each agent. Kill fires the `AbortController`, which cancels in-flight LLM requests (when the runner passes `signal` to the SDK) and causes the runner's `while` loop to exit on the next iteration check.

### Communication — message passing

All inter-agent communication goes through the `Mailbox`. There is no direct function call between agents. An agent writes to another agent's inbox file; that agent reads it on its next mailbox poll.

This decoupling has consequences:
- **Asynchrony**: agents don't wait for each other synchronously — they poll and continue
- **Auditability**: every message is a file on disk, readable and modifiable externally
- **Durability**: messages survive process crashes
- **Fan-out**: a lead can send to multiple workers by writing to multiple inboxes

**Routing** is handled by the `send_message` tool in the runner. The model calls `send_message(to="researcher", content="...")` as a structured tool invocation. The runner dispatches it to `params.sendMessage("researcher", { ... })` which writes to the researcher's inbox. See `docs/routing.md` for patterns and implementation.

### Memory — persistence across sessions

Memory addresses the question: *what does an agent remember between runs?*

Without memory, every run starts from a blank system prompt. With memory, accumulated knowledge — project context, user preferences, session notes — persists across restarts without being hardcoded in the `systemPrompt`.

The three-tier structure separates concerns:
- **`user` scope**: who the user is, their preferences, how they like to work — shared across every project
- **`project` scope**: what this project is, its conventions, important context — committed to VCS alongside the code
- **`local` scope**: ephemeral state, in-progress notes, things that shouldn't persist — gitignored

Memory is plain text (markdown). Agents can write to their own memory during a run using the `AgentMemory` API; the orchestrator can write before the run to seed context.

For runtime knowledge extraction, the Memory Gateway adds a write path: a KGC observer agent receives every team message, extracts typed triples, and writes them via `IMemoryProvider.write()`. On the next spawn, `buildSystemPromptInjection` injects the accumulated triples — no manual seeding required. Backends (`FileProvider`, `ObsidianProvider`, `FalkorProvider`) are swappable without touching the runner or team config.

### Answers — how agents respond

Agents produce responses by calling the `send_message` tool. This is the only routing mechanism. The model cannot route by formatting text correctly — it must make a structured tool call that names the recipient explicitly.

**Completion detection**: When the lead calls `send_message(to="user", content="...")`, the response lands in the `user` inbox. External code polls `mailbox.readAll("user")` to detect completion and extract the final output.

**Turn accounting**: The runner tracks `turns` (LLM calls) against `maxTurns`. At the limit, the runner returns with `stopReason: 'complete'`. This prevents infinite loops when the model fails to call `send_message`.

**MCP tool results**: When the model calls an MCP tool, the runner calls `params.callMcpTool(name, args)`, gets the result, and pushes it back as a `tool_result` message. The model receives the result and continues reasoning in the same turn.

---

## Use Cases

### Linear pipeline

The simplest pattern. Each agent has exactly one upstream sender and one downstream recipient.

```
user → lead → researcher → lead → writer → lead → user
```

Each agent's system prompt ends with: *"When done, call send_message(to='lead', content=...)"*. The lead orchestrates the sequence, waiting for each step before delegating the next.

### Fan-out and fan-in

The lead delegates to multiple workers concurrently, collects results, and synthesizes.

```
lead ──► researcher  (parallel)
     ──► coder       (parallel)

researcher ──► lead  (fan-in)
coder      ──► lead  (fan-in)

lead ──► user  (final output)
```

The lead's system prompt tracks pending responses. Because routing is explicit (`to` is a required parameter), there is no ambiguity when results arrive.

### Long-running teams

Teams where agents wait for external events (user input, webhook callbacks, background processes) between turns. The mailbox-based design handles this naturally — agents block on `readMailbox()` until new messages arrive, consuming no CPU while idle.

### Teams with external tools (MCP)

When agents need to interact with the real world — read files, search the web, query databases — MCP servers provide the tool layer. The framework manages connections; the runner merges MCP tools into the tool list it passes to the LLM.

---

## Extension Points

### Custom TeammateExecutor

Replace `InProcessBackend` with your own executor for true process isolation:

```ts
class DockerBackend implements TeammateExecutor {
  readonly type = 'docker'
  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    // launch a container, pass systemPrompt and model via env
    // write to inbox file on shared volume to deliver messages
  }
  async kill(agentId: string): Promise<boolean> { /* stop container */ }
  // ...
}

const orch = new TeamOrchestrator({ team, runner, config, cwd, backend: new DockerBackend() })
```

### Custom AgentRunner

The runner is the entire LLM integration surface. To add streaming, structured outputs, custom retry logic, or a new provider: implement `AgentRunner`. The framework has no opinion on how this works.

### Skill packages (npm)

Package reusable agent behaviours as npm modules:

```ts
// my-skill-package/index.js
module.exports = {
  name: 'careful-researcher',
  content: `When researching...\n- Always identify primary sources...`
}
```

```ts
// AgentConfig
skills: ['@myorg/skill-careful-researcher']
```

### Custom IMemoryProvider

Implement `IMemoryProvider` to store agent knowledge in any backend — vector databases, graph databases, external APIs — without changing the runner or team config:

```ts
import type { IMemoryProvider, Triple, AgentMemoryScope } from '@conducco/titw'

class MyProvider implements IMemoryProvider {
  async buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string> {
    const facts = await myBackend.query(scope)
    return facts.length
      ? `<agent-memory scope="${scope}">\n${facts.join('\n')}\n</agent-memory>`
      : ''
  }

  async write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void> {
    await myBackend.upsert(triples)
  }
}

const orch = new TeamOrchestrator({ team, runner, config, cwd, memoryProvider: new MyProvider() })
```

If your provider manages a connection, implement `connect()` and `disconnect()` and call them around `orch.start()` / `orch.stop()`.

---

## Configuration Reference

```ts
const config = createConfig({
  teamsDir: `${process.cwd()}/.titw/teams`,    // default: ~/.titw/teams
  memoryBaseDir: `${process.cwd()}/.titw/memory`,  // default: ~/.titw/memory
  defaultModel: 'claude-opus-4-6',              // default: claude-opus-4-6
  defaultMaxTurns: 50,                          // default: 50
  mailboxPollIntervalMs: 500,                   // default: 500ms
  maxMessageHistory: 50,                        // default: 50 (UI transcript cap)
})
```

All fields are optional. `createConfig()` with no arguments uses the defaults.

---

## File System Layout

```
~/.titw/                              ← user-scoped state (across all projects)
  teams/
    {team-name}/
      inboxes/
        {agent-name}.json             ← each agent's message inbox
  memory/
    agent-memory/
      {agent-type}/
        MEMORY.md                     ← user-scope memory

{cwd}/.titw/                          ← project-scoped state
  teams/                              ← (if teamsDir overridden to cwd)
  agent-memory/
    {agent-type}/
      MEMORY.md                       ← project-scope memory (VCS-tracked)
  agent-memory-local/
    {agent-type}/
      MEMORY.md                       ← local-scope memory (gitignored)
```

---

## Public API Summary

```ts
// Configuration
createConfig(overrides?)      // TitwConfig with sensible defaults

// Team types
TeamConfig                    // team declaration (Zod-validated)
AgentConfig                   // member declaration
teamConfigSchema              // Zod schema for validation
agentConfigSchema

// Orchestration
TeamOrchestrator              // main lifecycle manager
AgentLoader                   // model/config resolution helpers
sanitizeName()                // "My Team" → "my-team"
formatAgentId()               // "agent", "team" → "agent@team"
parseAgentId()                // "agent@team" → { agentName, teamName }

// Runner interface
AgentRunner                   // (params: AgentRunParams) => Promise<AgentRunResult>
AgentRunParams                // what the runner receives
AgentRunResult                // what the runner returns

// Backends
InProcessBackend              // default executor (AsyncLocalStorage)
TeammateExecutor              // interface for custom executors
MCPToolkit                    // MCP server connection manager

// Communication
Mailbox                       // file-based inbox per agent
TeammateMessage               // message payload
StructuredMessage             // typed protocol messages (shutdown, approval, etc.)
isStructuredMessage()
parseStructuredMessage()
createShutdownRequest/Response()
createPlanApprovalRequest/Response()
createPermissionRequest/Response()

// Memory
AgentMemory                   // 3-tier persistent memory
IMemoryProvider               // pluggable read/write interface
Triple                        // { subject, predicate, object, weight? }
FileProvider                  // markdown files (same paths as AgentMemory)
ObsidianProvider              // Obsidian vault, one note per entity with wikilinks
// FalkorProvider              — import from '@conducco/titw/falkor' (optional peer: falkordb)

// Providers — LLM client configuration helpers
buildAzureFoundryClientConfig() // Azure AI Foundry config — works with Anthropic and OpenAI SDKs (api-key header fix)
AzureFoundryClientConfig        // { baseURL, apiKey, defaultHeaders }
AzureFoundryOptions             // { endpoint, apiKey }

// Skills
SkillRegistry                 // markdown skill loader

// Patterns
PermissionBridge              // worker → lead permission escalation
ShutdownNegotiator            // graceful shutdown protocol
buildCacheablePrefix()        // prompt cache optimization
```
