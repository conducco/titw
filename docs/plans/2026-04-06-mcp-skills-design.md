# Design: MCP + Skills Integration

**Date:** 2026-04-06
**Status:** Approved
**Approach:** Framework manages lifecycle (Approach 2)

---

## Problem

titw agents cannot use external tools or reusable behaviors today. Adding tools requires touching the runner, which is a LLM-provider-specific file — not accessible to non-technical users. Two capabilities are needed:

- **MCP (Model Context Protocol)**: connect agents to MCP servers so they can call external tools (filesystem, web search, databases, custom APIs) without runner changes
- **Skills**: attach reusable markdown-based instruction sets to agents, packageable as npm modules, injected into the system prompt automatically

---

## Approach

Framework manages connection lifecycle and system prompt assembly. Runner receives ready-to-use tool schemas and a dispatch function. Non-technical users only touch `AgentConfig`.

---

## New Interfaces

### `MCPServerConfig`

```ts
interface MCPServerConfig {
  type: 'stdio' | 'sse'
  // stdio — local process (most MCP servers)
  command?: string           // e.g. 'npx'
  args?: string[]            // e.g. ['-y', '@modelcontextprotocol/server-filesystem']
  env?: Record<string, string>
  // sse — remote server
  url?: string
  // behaviour
  required?: boolean         // default false — if true, agent spawn fails on connection error
  timeoutMs?: number         // default 10_000
}
```

### `AgentConfig` additions

```ts
interface AgentConfig {
  // ... existing fields unchanged ...
  mcpServers?: MCPServerConfig[]
  skills?: string[]   // local paths or npm package names
}
```

### `AgentRunParams` additions

```ts
interface AgentRunParams {
  // ... existing fields unchanged — no breaking change ...
  mcpTools: MCPToolSchema[]   // default [] when no MCP configured
  callMcpTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}
```

`mcpTools` defaults to `[]` and `callMcpTool` defaults to a function that throws a clear error if called without MCP configured. All existing runners work unchanged.

---

## New Classes

### `MCPToolkit`

Wraps `@modelcontextprotocol/sdk`. Scoped per-agent (each agent gets its own connections, matching `AsyncLocalStorage` isolation).

**Responsibilities:**
- Connect to each configured MCP server at spawn time
- Discover tool schemas from connected servers
- Expose schemas as `MCPToolSchema[]` (JSON Schema, ready for any LLM provider)
- Dispatch tool calls to the correct server
- Disconnect all servers at kill time

**Key methods:**
```ts
class MCPToolkit {
  static async connect(servers: MCPServerConfig[]): Promise<MCPToolkit>
  get tools(): MCPToolSchema[]
  async call(toolName: string, args: Record<string, unknown>): Promise<unknown>
  async disconnect(): Promise<void>
}
```

### `SkillRegistry`

Stateless — loads skill files once at spawn, returns the composed system prompt injection. No runtime overhead.

**Skill sources:**
- Local file: `'./skills/researcher.md'`
- npm package: `'@titw/skill-researcher'` (must export `{ name, content }` or have `skill.md` at package root)

**Key method:**
```ts
class SkillRegistry {
  static async load(skills: string[], cwd: string): Promise<string>
  // Returns composed <skill> injection string, empty string if no skills
}
```

---

## Skill Format

```markdown
---
name: careful-researcher
description: Deep research with source verification
version: 1.0.0
---

When researching any topic:
- Always identify the original primary source
- Cross-reference at least two independent sources
- Note publication or release dates for all claims
```

Frontmatter is optional — filename is used as the skill name if omitted.

**npm package convention:**
```ts
// index.js (or skill.md at package root)
module.exports = {
  name: 'careful-researcher',
  description: 'Deep research with source verification',
  version: '1.0.0',
  content: `When researching...`
}
```

---

## System Prompt Assembly Order

```
[base systemPrompt from AgentConfig]
[<skill name="..."> injections]     ← skills (new)
[<agent-memory scope="..."> tags]   ← memory (existing)
```

Skills are injected before memory. Memory (learned knowledge) takes precedence over skill instructions when they conflict.

Each skill is wrapped in a named tag:
```
<skill name="careful-researcher">
When researching any topic:
...
</skill>
```

---

## Lifecycle

```
TeamOrchestrator._spawnMember()
  ├── AgentLoader.resolveModel()          (existing)
  ├── AgentMemory.buildInjection()        (existing)
  ├── SkillRegistry.load()                (new) → appends <skill> tags to systemPrompt
  ├── MCPToolkit.connect()                (new) → discovers tool schemas
  └── InProcessBackend.spawn({
        systemPrompt,   // base + skills + memory
        mcpTools,       // [] if no MCP configured
        callMcpTool,    // dispatch fn, or throws if called without MCP
      })

InProcessBackend.kill()
  └── MCPToolkit.disconnect()             (new) → closes server processes/connections
```

---

## Error Handling

### MCP connection failures at spawn

| Scenario | `required: false` (default) | `required: true` |
|---|---|---|
| Server starts, tools discovered | ✓ | ✓ |
| Server fails to start | warn + skip | throw — agent does not spawn |
| Connection timeout | warn + skip | throw |
| Server connects, returns no tools | warn + continue | warn + continue |

Agent always spawns with whatever tools successfully connected.

### MCP server crash mid-run

`callMcpTool` catches disconnection errors and returns a structured error result — the LLM receives it as a `tool_result` and can react:

```ts
{ error: true, message: "MCP server 'filesystem' disconnected. Tool 'read_file' is unavailable." }
```

No reconnection attempts. A `[MCPToolkit] server disconnected: <name>` warning is logged.

### Tool name collisions

- **Between MCP servers:** last registration wins + `console.warn`
- **MCP tool named `send_message`:** hard error at spawn — reserved name collision breaks routing

### Skill loading failures

| Scenario | Behavior |
|---|---|
| File not found | warn + skip skill |
| Malformed frontmatter | warn + use filename as name, inject content |
| npm package not installed | warn + skip |
| Skill listed twice | deduplicate by name + warn |
| Skill content > 50 KB | warn + truncate with `<!-- skill truncated -->` |

Skill errors never block agent spawn.

---

## Runner Integration (minimal changes)

```ts
const runner: AgentRunner = async (params) => {
  // Merge built-in tools with MCP-discovered tools
  const allTools = [...PROVIDER_TOOLS, ...params.mcpTools]

  // In the tool dispatch loop:
  if (params.mcpTools.some(t => t.name === block.name)) {
    const result = await params.callMcpTool(block.name, block.input as Record<string, unknown>)
    toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) })
  }
}
```

---

## Example Usage

```ts
const team: TeamConfig = {
  name: 'research-team',
  members: [
    {
      name: 'researcher',
      systemPrompt: 'You are a research specialist.',
      model: 'claude-haiku-4-5-20251001',
      skills: [
        './skills/careful-researcher.md',
        '@titw/skill-citation-formatter',
      ],
      mcpServers: [
        {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-brave-search'],
          env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY! },
        },
        {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { ALLOWED_DIRS: '/tmp/research' },
          required: true,   // team cannot run without filesystem access
        },
      ],
    },
  ],
}
```

---

## New Dependencies

- `@modelcontextprotocol/sdk` — MCP client (new runtime dependency)
- `gray-matter` or manual frontmatter parsing for skills (small, or hand-rolled to avoid deps)

---

## Out of Scope (this iteration)

- Plugin architecture (to be designed separately)
- MCP resource and prompt primitives (tools only for now)
- Remote MCP servers with authentication (SSE basic support only)
- Skill versioning / conflict resolution across packages
