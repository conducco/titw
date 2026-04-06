# MCP + Skills Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCP server connections and markdown-based skill injection to titw agents via `AgentConfig`, with zero changes required to existing runners.

**Architecture:** Two new classes (`SkillRegistry`, `MCPToolkit`) are instantiated per-agent at spawn time by `TeamOrchestrator`. Skills are baked into `systemPrompt`; MCP tool schemas and a dispatch function are passed as new fields on `AgentRunParams`. `InProcessBackend` disconnects MCP servers on kill.

**Tech Stack:** `@modelcontextprotocol/sdk@1.29.0` (new runtime dep), `vitest` for tests, Node.js `fs/promises` for skill file loading.

---

## Pre-flight

```bash
cd /Users/cmedeiros/code/conducco/conducco-agents
npm test   # must be green before starting
```

---

### Task 1: Install MCP SDK

**Files:**
- Modify: `package.json`

**Step 1: Install the SDK**

```bash
npm install @modelcontextprotocol/sdk
```

**Step 2: Verify it resolves**

```bash
node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log('ok', Object.keys(m)))"
```
Expected: `ok [ 'Client', ... ]`

**Step 3: Run tests to confirm nothing broke**

```bash
npm test
```
Expected: all existing tests pass.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency"
```

---

### Task 2: Extend `AgentConfig` types

**Files:**
- Modify: `src/types/agent.ts`

`AgentConfig` already has `mcpServers?: AgentMcpServerSpec[]` with a shape that doesn't support SSE, `required`, or `timeoutMs`. Replace `AgentMcpServerSpec` with a proper `MCPServerConfig` interface and add `skills`.

**Step 1: Write the failing test**

Add to `tests/types.test.ts`:

```ts
import { agentConfigSchema } from '../src/types/agent.js'

it('AgentConfig accepts mcpServers with stdio type', () => {
  const result = agentConfigSchema.safeParse({
    name: 'agent',
    systemPrompt: 'You help.',
    mcpServers: [{ type: 'stdio', command: 'npx', args: ['-y', '@mcp/server'], required: true }],
  })
  expect(result.success).toBe(true)
})

it('AgentConfig accepts mcpServers with sse type', () => {
  const result = agentConfigSchema.safeParse({
    name: 'agent',
    systemPrompt: 'You help.',
    mcpServers: [{ type: 'sse', url: 'http://localhost:3000/sse' }],
  })
  expect(result.success).toBe(true)
})

it('AgentConfig accepts skills array', () => {
  const result = agentConfigSchema.safeParse({
    name: 'agent',
    systemPrompt: 'You help.',
    skills: ['./skills/researcher.md', '@titw/skill-writer'],
  })
  expect(result.success).toBe(true)
})
```

**Step 2: Run to verify it fails**

```bash
npm test -- tests/types.test.ts
```
Expected: FAIL — `mcpServers` type mismatch, `skills` not recognised.

**Step 3: Update `src/types/agent.ts`**

Replace the `AgentMcpServerSpec` type and update `AgentConfig` + the Zod schema:

```ts
// Replace AgentMcpServerSpec with:
export interface MCPServerConfig {
  type: 'stdio' | 'sse'
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse
  url?: string
  // behaviour
  required?: boolean    // default false — spawn fails if connection fails
  timeoutMs?: number    // default 10_000
}

// In AgentConfig, replace:
//   mcpServers?: AgentMcpServerSpec[]
// with:
  mcpServers?: MCPServerConfig[]
  skills?: string[]
```

Update the Zod schema (`agentConfigSchema`) to match:

```ts
const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  required: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

// In agentConfigSchema replace mcpServers line with:
mcpServers: z.array(mcpServerConfigSchema).optional(),
skills: z.array(z.string()).optional(),
```

Also remove the now-unused `AgentMcpServerSpec` type export.

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/types.test.ts
```
Expected: PASS (new tests green, existing tests still green).

**Step 5: Run full test suite**

```bash
npm test
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/types/agent.ts tests/types.test.ts
git commit -m "feat: extend AgentConfig with MCPServerConfig and skills"
```

---

### Task 3: Extend `AgentRunParams` and `TeammateSpawnConfig`

**Files:**
- Modify: `src/backends/types.ts`

**Step 1: Write the failing test**

Add to `tests/backend-types.test.ts`:

```ts
import type { AgentRunParams } from '../src/backends/types.js'

it('AgentRunParams has mcpTools defaulting to empty array shape', () => {
  // Type-level check — if this compiles the shape is correct.
  const params = {} as AgentRunParams
  const tools: unknown[] = params.mcpTools
  const call: (n: string, a: Record<string, unknown>) => Promise<unknown> = params.callMcpTool
  expect(tools).toBeDefined()
  expect(call).toBeDefined()
})
```

**Step 2: Run to verify it fails**

```bash
npm test -- tests/backend-types.test.ts
```
Expected: TypeScript compilation error — `mcpTools` does not exist.

**Step 3: Update `src/backends/types.ts`**

Add `MCPToolSchema` and extend both interfaces:

```ts
// Add after existing imports:
export interface MCPToolSchema {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

// In AgentRunParams add after onProgress:
  mcpTools: MCPToolSchema[]
  callMcpTool: (name: string, args: Record<string, unknown>) => Promise<unknown>

// In TeammateSpawnConfig add after runner:
  mcpTools?: MCPToolSchema[]
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```
Expected: all pass (no callers of the runner check the new fields yet — they're optional on SpawnConfig).

**Step 5: Commit**

```bash
git add src/backends/types.ts tests/backend-types.test.ts
git commit -m "feat: add mcpTools and callMcpTool to AgentRunParams"
```

---

### Task 4: Implement `SkillRegistry`

**Files:**
- Create: `src/skills/SkillRegistry.ts`
- Create: `tests/skill-registry.test.ts`

**Step 1: Write failing tests**

Create `tests/skill-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillRegistry } from '../src/skills/SkillRegistry.js'

let tempDir: string

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'titw-skill-')) })
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('SkillRegistry.load', () => {
  it('returns empty string when no skills given', async () => {
    const result = await SkillRegistry.load([], tempDir)
    expect(result).toBe('')
  })

  it('loads a skill from a local markdown file', async () => {
    writeFileSync(join(tempDir, 'my-skill.md'), [
      '---',
      'name: my-skill',
      'description: Test skill',
      '---',
      '',
      'Always be concise.',
    ].join('\n'))
    const result = await SkillRegistry.load([join(tempDir, 'my-skill.md')], tempDir)
    expect(result).toContain('<skill name="my-skill">')
    expect(result).toContain('Always be concise.')
    expect(result).toContain('</skill>')
  })

  it('uses filename as skill name when frontmatter is absent', async () => {
    writeFileSync(join(tempDir, 'no-frontmatter.md'), 'Be helpful.')
    const result = await SkillRegistry.load([join(tempDir, 'no-frontmatter.md')], tempDir)
    expect(result).toContain('<skill name="no-frontmatter">')
    expect(result).toContain('Be helpful.')
  })

  it('warns and skips a missing file without throwing', async () => {
    const result = await SkillRegistry.load(['/nonexistent/skill.md'], tempDir)
    expect(result).toBe('')
  })

  it('deduplicates skills with the same name', async () => {
    writeFileSync(join(tempDir, 'dup.md'), '---\nname: same\n---\nContent.')
    const result = await SkillRegistry.load(
      [join(tempDir, 'dup.md'), join(tempDir, 'dup.md')],
      tempDir
    )
    const count = (result.match(/<skill name="same">/g) ?? []).length
    expect(count).toBe(1)
  })

  it('truncates skills larger than 50KB', async () => {
    const big = 'x'.repeat(51 * 1024)
    writeFileSync(join(tempDir, 'big.md'), `---\nname: big\n---\n${big}`)
    const result = await SkillRegistry.load([join(tempDir, 'big.md')], tempDir)
    expect(result).toContain('<!-- skill truncated -->')
  })

  it('composes multiple skills in order', async () => {
    writeFileSync(join(tempDir, 'a.md'), '---\nname: alpha\n---\nAlpha content.')
    writeFileSync(join(tempDir, 'b.md'), '---\nname: beta\n---\nBeta content.')
    const result = await SkillRegistry.load(
      [join(tempDir, 'a.md'), join(tempDir, 'b.md')],
      tempDir
    )
    expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('beta'))
  })
})
```

**Step 2: Run to verify they fail**

```bash
npm test -- tests/skill-registry.test.ts
```
Expected: FAIL — `SkillRegistry` not found.

**Step 3: Implement `src/skills/SkillRegistry.ts`**

```ts
import { readFile } from 'fs/promises'
import { join, basename, extname } from 'path'
import { createRequire } from 'module'

const SKILL_SIZE_LIMIT = 50 * 1024 // 50 KB
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/

interface ParsedSkill {
  name: string
  content: string
}

function parseFrontmatter(raw: string, fallbackName: string): ParsedSkill {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { name: fallbackName, content: raw.trim() }

  const [, front, body] = match
  const nameLine = front!.split('\n').find(l => l.startsWith('name:'))
  const name = nameLine ? nameLine.replace('name:', '').trim() : fallbackName
  return { name, content: body!.trim() }
}

async function loadFromPath(skillPath: string): Promise<ParsedSkill | null> {
  try {
    const raw = await readFile(skillPath, 'utf-8')
    const fallbackName = basename(skillPath, extname(skillPath))
    return parseFrontmatter(raw, fallbackName)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      console.warn(`[SkillRegistry] Skill file not found, skipping: ${skillPath}`)
      return null
    }
    throw err
  }
}

async function loadFromPackage(packageName: string, cwd: string): Promise<ParsedSkill | null> {
  try {
    const require = createRequire(join(cwd, 'package.json'))
    const mod = require(packageName) as { name?: string; content?: string }
    if (mod.content) {
      return { name: mod.name ?? packageName, content: mod.content }
    }
    // Fall back to skill.md at package root
    const pkgPath = require.resolve(packageName + '/skill.md')
    return loadFromPath(pkgPath)
  } catch {
    console.warn(`[SkillRegistry] Skill package not found, skipping: ${packageName}`)
    return null
  }
}

function wrapSkill(skill: ParsedSkill): string {
  let content = skill.content
  if (Buffer.byteLength(content, 'utf-8') > SKILL_SIZE_LIMIT) {
    console.warn(`[SkillRegistry] Skill "${skill.name}" exceeds 50KB, truncating.`)
    content = content.slice(0, SKILL_SIZE_LIMIT) + '\n<!-- skill truncated -->'
  }
  return `<skill name="${skill.name}">\n${content}\n</skill>`
}

export class SkillRegistry {
  /**
   * Load and compose skills from local paths or npm package names.
   * Returns a string of <skill> tags ready to append to a system prompt.
   * Never throws — missing or malformed skills are warned and skipped.
   */
  static async load(skills: string[], cwd: string): Promise<string> {
    if (skills.length === 0) return ''

    const loaded: ParsedSkill[] = []
    const seenNames = new Set<string>()

    for (const spec of skills) {
      const isPath = spec.startsWith('.') || spec.startsWith('/')
      const skill = isPath
        ? await loadFromPath(isPath && !spec.startsWith('/') ? join(cwd, spec) : spec)
        : await loadFromPackage(spec, cwd)

      if (!skill) continue

      if (seenNames.has(skill.name)) {
        console.warn(`[SkillRegistry] Duplicate skill "${skill.name}", skipping second occurrence.`)
        continue
      }

      seenNames.add(skill.name)
      loaded.push(skill)
    }

    return loaded.map(wrapSkill).join('\n')
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/skill-registry.test.ts
```
Expected: all PASS.

**Step 5: Full suite**

```bash
npm test
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/skills/SkillRegistry.ts tests/skill-registry.test.ts
git commit -m "feat: add SkillRegistry for markdown skill injection"
```

---

### Task 5: Implement `MCPToolkit`

**Files:**
- Create: `src/backends/MCPToolkit.ts`
- Create: `tests/mcp-toolkit.test.ts`

**Step 1: Write failing tests**

Create `tests/mcp-toolkit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPToolkit } from '../src/backends/MCPToolkit.js'
import type { MCPServerConfig } from '../src/types/agent.js'

// Mock the MCP SDK client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'file contents' }] }),
  })),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({})),
}))

describe('MCPToolkit', () => {
  it('returns empty tools when no servers configured', async () => {
    const toolkit = await MCPToolkit.connect([])
    expect(toolkit.tools).toEqual([])
    await toolkit.disconnect()
  })

  it('discovers tools from a connected server', async () => {
    const servers: MCPServerConfig[] = [
      { type: 'stdio', command: 'npx', args: ['-y', '@mcp/server-filesystem'] },
    ]
    const toolkit = await MCPToolkit.connect(servers)
    expect(toolkit.tools).toHaveLength(1)
    expect(toolkit.tools[0]!.name).toBe('read_file')
    await toolkit.disconnect()
  })

  it('dispatches a tool call to the correct server', async () => {
    const servers: MCPServerConfig[] = [
      { type: 'stdio', command: 'npx', args: ['-y', '@mcp/server-filesystem'] },
    ]
    const toolkit = await MCPToolkit.connect(servers)
    const result = await toolkit.call('read_file', { path: '/tmp/test.txt' })
    expect(result).toEqual([{ type: 'text', text: 'file contents' }])
    await toolkit.disconnect()
  })

  it('returns error result when tool call fails mid-run', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    vi.mocked(Client).mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'broken', description: '', inputSchema: { type: 'object' } }] }),
      callTool: vi.fn().mockRejectedValue(new Error('connection lost')),
    }))
    const toolkit = await MCPToolkit.connect([{ type: 'stdio', command: 'node', args: ['-e', ''] }])
    const result = await toolkit.call('broken', {}) as { error: boolean; message: string }
    expect(result.error).toBe(true)
    expect(result.message).toContain('connection lost')
    await toolkit.disconnect()
  })

  it('warns and skips non-required server that fails to connect', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    vi.mocked(Client).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error('spawn error')),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    }))
    const toolkit = await MCPToolkit.connect([{ type: 'stdio', command: 'missing-cmd', required: false }])
    expect(toolkit.tools).toEqual([])
    await toolkit.disconnect()
  })

  it('throws when a required server fails to connect', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    vi.mocked(Client).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error('spawn error')),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    }))
    await expect(
      MCPToolkit.connect([{ type: 'stdio', command: 'missing-cmd', required: true }])
    ).rejects.toThrow()
  })

  it('throws at connect time if a tool name collides with send_message', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    vi.mocked(Client).mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'send_message', description: '', inputSchema: { type: 'object' } }] }),
      callTool: vi.fn(),
    }))
    await expect(
      MCPToolkit.connect([{ type: 'stdio', command: 'node', args: [] }])
    ).rejects.toThrow(/reserved/)
  })
})
```

**Step 2: Run to verify they fail**

```bash
npm test -- tests/mcp-toolkit.test.ts
```
Expected: FAIL — `MCPToolkit` not found.

**Step 3: Implement `src/backends/MCPToolkit.ts`**

```ts
import type { MCPServerConfig, MCPToolSchema } from '../types/agent.js'

// Lazy imports to avoid hard-loading MCP SDK at module load time
async function getClient() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  return Client
}
async function getStdioTransport() {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  return StdioClientTransport
}
async function getSseTransport() {
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
  return SSEClientTransport
}

const RESERVED_TOOL_NAMES = new Set(['send_message'])
const DEFAULT_TIMEOUT_MS = 10_000

interface ConnectedServer {
  config: MCPServerConfig
  client: { listTools: () => Promise<{ tools: MCPToolSchema[] }>; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> }
  tools: MCPToolSchema[]
}

export class MCPToolkit {
  private readonly servers: ConnectedServer[]

  private constructor(servers: ConnectedServer[]) {
    this.servers = servers
  }

  /** Connect to all configured MCP servers and discover their tools. */
  static async connect(configs: MCPServerConfig[]): Promise<MCPToolkit> {
    if (configs.length === 0) return new MCPToolkit([])

    const Client = await getClient()
    const connected: ConnectedServer[] = []
    const toolIndex = new Map<string, string>() // tool name → server label

    for (const config of configs) {
      const label = config.command ?? config.url ?? 'unknown'
      let client: ConnectedServer['client'] | null = null

      try {
        const transport = config.type === 'sse'
          ? new (await getSseTransport())(new URL(config.url!))
          : new (await getStdioTransport())({
              command: config.command!,
              args: config.args,
              env: config.env,
            })

        const raw = new Client({ name: 'titw', version: '1.0' }, { capabilities: { tools: {} } })

        await Promise.race([
          raw.connect(transport),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP server "${label}" timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)), config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
          ),
        ])

        client = raw as unknown as ConnectedServer['client']
      } catch (err: unknown) {
        const msg = `[MCPToolkit] Failed to connect to MCP server "${label}": ${(err as Error).message}`
        if (config.required) throw new Error(msg)
        console.warn(msg)
        continue
      }

      const { tools } = await client.listTools()

      // Check for reserved name collisions
      for (const tool of tools) {
        if (RESERVED_TOOL_NAMES.has(tool.name)) {
          await client.close().catch(() => undefined)
          throw new Error(
            `MCP server "${label}" exposes a tool named "${tool.name}" which is a reserved titw tool name. ` +
            `Rename the tool in your MCP server configuration.`
          )
        }
        if (toolIndex.has(tool.name)) {
          console.warn(`[MCPToolkit] Tool name collision: "${tool.name}" registered by both "${toolIndex.get(tool.name)}" and "${label}". Using "${label}".`)
        }
        toolIndex.set(tool.name, label)
      }

      connected.push({ config, client, tools })
    }

    return new MCPToolkit(connected)
  }

  /** All discovered tool schemas, ready to pass to any LLM provider. */
  get tools(): MCPToolSchema[] {
    const seen = new Map<string, MCPToolSchema>()
    for (const server of this.servers) {
      for (const tool of server.tools) {
        seen.set(tool.name, tool)
      }
    }
    return Array.from(seen.values())
  }

  /** Dispatch a tool call to the server that owns it. */
  async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    for (const server of this.servers) {
      if (server.tools.some(t => t.name === toolName)) {
        try {
          const result = await server.client.callTool(toolName, args)
          return (result as { content: unknown }).content
        } catch (err: unknown) {
          const label = server.config.command ?? server.config.url ?? 'unknown'
          console.warn(`[MCPToolkit] server disconnected: ${label}`)
          return {
            error: true,
            message: `MCP server "${label}" error calling "${toolName}": ${(err as Error).message}`,
          }
        }
      }
    }
    throw new Error(`[MCPToolkit] No MCP server owns tool "${toolName}". Available: ${this.tools.map(t => t.name).join(', ')}`)
  }

  /** Close all server connections. Called by InProcessBackend on kill. */
  async disconnect(): Promise<void> {
    await Promise.allSettled(this.servers.map(s => s.client.close()))
  }
}
```

**Note:** `MCPToolSchema` needs to be exported from `src/types/agent.ts` — add it there:

```ts
// Add to src/types/agent.ts:
export type { MCPToolSchema } from '../backends/MCPToolkit.js'
```

Wait — circular import risk. Instead, define `MCPToolSchema` in `src/types/agent.ts` (it's a pure data type with no runtime deps) and import it in `MCPToolkit.ts`.

Move the `MCPToolSchema` interface from `src/backends/types.ts` (added in Task 3) to `src/types/agent.ts` and import from there in both `types.ts` and `MCPToolkit.ts`.

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/mcp-toolkit.test.ts
```
Expected: all PASS.

**Step 5: Full suite**

```bash
npm test
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/backends/MCPToolkit.ts tests/mcp-toolkit.test.ts src/types/agent.ts
git commit -m "feat: add MCPToolkit for MCP server connection and tool dispatch"
```

---

### Task 6: Wire into `TeamOrchestrator._spawnMember`

**Files:**
- Modify: `src/orchestrator/TeamOrchestrator.ts`
- Modify: `tests/team-orchestrator.test.ts`

**Step 1: Write failing test**

Add to `tests/team-orchestrator.test.ts`:

```ts
it('injects skill content into systemPrompt when agent has skills', async () => {
  const skillFile = join(tempDir, 'test-skill.md')
  writeFileSync(skillFile, '---\nname: test-skill\n---\nAlways cite sources.')

  let capturedSystemPrompt = ''
  const capturingRunner: AgentRunner = async (params) => {
    capturedSystemPrompt = params.systemPrompt
    return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
  }

  const teamWithSkill: TeamConfig = {
    name: 'skill-test-team',
    leadAgentName: 'lead',
    members: [{ name: 'lead', systemPrompt: 'Base prompt.', skills: [skillFile] }],
  }

  const orch = new TeamOrchestrator({ team: teamWithSkill, runner: capturingRunner, config, cwd: tempDir })
  await orch.start()
  await new Promise(r => setTimeout(r, 50))
  await orch.stop()

  expect(capturedSystemPrompt).toContain('<skill name="test-skill">')
  expect(capturedSystemPrompt).toContain('Always cite sources.')
})

it('passes empty mcpTools when agent has no mcpServers', async () => {
  let capturedTools: unknown[] = []
  const capturingRunner: AgentRunner = async (params) => {
    capturedTools = params.mcpTools
    return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
  }
  const orch = new TeamOrchestrator({ team, runner: capturingRunner, config, cwd: tempDir })
  await orch.start()
  await new Promise(r => setTimeout(r, 50))
  await orch.stop()
  expect(capturedTools).toEqual([])
})
```

You will need `writeFileSync` and a `skillFile` path in the test — add the import at the top of the test file:

```ts
import { writeFileSync } from 'fs'
```

**Step 2: Run to verify it fails**

```bash
npm test -- tests/team-orchestrator.test.ts
```
Expected: FAIL — `params.mcpTools` is undefined, skill not injected.

**Step 3: Update `src/orchestrator/TeamOrchestrator.ts`**

In `_spawnMember`, after the memory injection, add skill loading and MCP connection:

```ts
import { SkillRegistry } from '../skills/SkillRegistry.js'
import { MCPToolkit } from '../backends/MCPToolkit.js'

// In _spawnMember(), after memoryInjection:
const skillInjection = agentConfig.skills?.length
  ? await SkillRegistry.load(agentConfig.skills, this.cwd)
  : ''

const toolkit = await MCPToolkit.connect(agentConfig.mcpServers ?? [])
const systemPrompt = agentConfig.systemPrompt + skillInjection + memoryInjection

const result = await this.backend.spawn({
  // ...existing fields...
  systemPrompt,
  mcpTools: toolkit.tools,
  callMcpTool: (name, args) => toolkit.call(name, args),
  onIdle: () => {
    void toolkit.disconnect()   // disconnect MCP servers when agent goes idle
    spawnCfg.onIdle?.()
  },
})
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/team-orchestrator.test.ts
```
Expected: all PASS.

**Step 5: Full suite**

```bash
npm test
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/orchestrator/TeamOrchestrator.ts tests/team-orchestrator.test.ts
git commit -m "feat: wire SkillRegistry and MCPToolkit into TeamOrchestrator spawn"
```

---

### Task 7: Thread through `InProcessBackend`

**Files:**
- Modify: `src/backends/InProcessBackend.ts`
- Modify: `tests/in-process-backend.test.ts`

**Step 1: Write failing test**

Add to `tests/in-process-backend.test.ts`:

```ts
it('passes mcpTools and callMcpTool from SpawnConfig to runner params', async () => {
  let receivedTools: unknown[] = ['not-set']
  let receivedCaller: unknown = null

  const capturingRunner: AgentRunner = async (params) => {
    receivedTools = params.mcpTools
    receivedCaller = params.callMcpTool
    return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
  }

  const mockCall = async () => ({ result: 'ok' })
  const idlePromise = new Promise<void>(resolve => {
    void backend.spawn({
      agentName: 'mcp-agent',
      teamName: 'test-team',
      agentConfig: { name: 'mcp-agent', systemPrompt: 'Test.' },
      prompt: 'Test.',
      systemPrompt: 'Test.',
      model: 'claude-opus-4-6',
      cwd: tempDir,
      parentId: 'parent',
      runner: capturingRunner,
      titwCfg: createConfig({ teamsDir: join(tempDir, 'teams') }),
      mcpTools: [{ name: 'my_tool', inputSchema: { type: 'object' } }],
      callMcpTool: mockCall,
      onIdle: resolve,
    })
  })

  await idlePromise
  expect(receivedTools).toEqual([{ name: 'my_tool', inputSchema: { type: 'object' } }])
  expect(receivedCaller).toBe(mockCall)
})

it('provides default empty mcpTools when not supplied', async () => {
  let receivedTools: unknown = 'not-set'
  const idlePromise = new Promise<void>(resolve => {
    void backend.spawn({
      agentName: 'no-mcp',
      teamName: 'test-team',
      agentConfig: { name: 'no-mcp', systemPrompt: 'Test.' },
      prompt: 'Test.',
      systemPrompt: 'Test.',
      model: 'claude-opus-4-6',
      cwd: tempDir,
      parentId: 'parent',
      runner: async (params) => {
        receivedTools = params.mcpTools
        return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
      },
      titwCfg: createConfig({ teamsDir: join(tempDir, 'teams') }),
      onIdle: resolve,
    })
  })
  await idlePromise
  expect(receivedTools).toEqual([])
})
```

**Step 2: Run to verify they fail**

```bash
npm test -- tests/in-process-backend.test.ts
```
Expected: FAIL — `params.mcpTools` is undefined.

**Step 3: Update `src/backends/InProcessBackend.ts`**

Pass through the new fields in `spawn()`:

```ts
// In the runner call inside storage.run():
await spawnCfg.runner({
  agentId,
  systemPrompt: spawnCfg.systemPrompt,
  prompt: spawnCfg.prompt,
  model: spawnCfg.model,
  maxTurns: spawnCfg.agentConfig.maxTurns ?? this.config.defaultMaxTurns,
  abortSignal: abortController.signal,
  mcpTools: spawnCfg.mcpTools ?? [],                     // ← new
  callMcpTool: spawnCfg.callMcpTool ?? defaultCallMcp,   // ← new
  readMailbox: async () => { ... },
  sendMessage: async (to, message) => { ... },
  ...(spawnCfg.onProgress !== undefined ? { onProgress: spawnCfg.onProgress } : {}),
})
```

Add the default `callMcpTool` above the class or as a module-level const:

```ts
const defaultCallMcp = async (name: string): Promise<never> => {
  throw new Error(
    `callMcpTool("${name}") was called but no mcpServers are configured for this agent. ` +
    `Add mcpServers to AgentConfig.`
  )
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/in-process-backend.test.ts
```
Expected: all PASS.

**Step 5: Full suite**

```bash
npm test
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/backends/InProcessBackend.ts tests/in-process-backend.test.ts
git commit -m "feat: thread mcpTools and callMcpTool through InProcessBackend"
```

---

### Task 8: Update public exports

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/public-api.test.ts`

**Step 1: Write failing test**

Add to `tests/public-api.test.ts`:

```ts
it('exports SkillRegistry', async () => {
  const { SkillRegistry } = await import('../src/index.js')
  expect(SkillRegistry).toBeDefined()
  expect(typeof SkillRegistry.load).toBe('function')
})

it('exports MCPToolkit', async () => {
  const { MCPToolkit } = await import('../src/index.js')
  expect(MCPToolkit).toBeDefined()
  expect(typeof MCPToolkit.connect).toBe('function')
})

it('exports MCPServerConfig type (structural check via agentConfigSchema)', async () => {
  const { agentConfigSchema } = await import('../src/index.js')
  const result = agentConfigSchema.safeParse({
    name: 'a',
    systemPrompt: 'b',
    mcpServers: [{ type: 'stdio', command: 'npx' }],
    skills: ['./my-skill.md'],
  })
  expect(result.success).toBe(true)
})
```

**Step 2: Run to verify they fail**

```bash
npm test -- tests/public-api.test.ts
```
Expected: FAIL.

**Step 3: Update `src/index.ts`**

Add exports:

```ts
// Skills
export { SkillRegistry } from './skills/SkillRegistry.js'

// Backends — add MCPToolkit alongside InProcessBackend
export { MCPToolkit } from './backends/MCPToolkit.js'

// Types — add MCPServerConfig and MCPToolSchema to the agent types export
export type { MCPServerConfig, MCPToolSchema } from './types/agent.js'
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/public-api.test.ts
```
Expected: all PASS.

**Step 5: Full suite**

```bash
npm test
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/index.ts tests/public-api.test.ts
git commit -m "feat: export SkillRegistry, MCPToolkit, MCPServerConfig from public API"
```

---

### Task 9: Update production tutorial runner

**Files:**
- Modify: `docs/tutorial-production.md`

Add MCP tool dispatch to the runner's tool handling section. No code changes — docs only.

In `tutorial-production.md`, find the tool dispatch loop and add the MCP branch:

```ts
// After handling send_message:
const isMcpTool = params.mcpTools.some(t => t.name === block.name)
if (isMcpTool) {
  toolUseCount++
  console.log(`[${params.agentId}] → mcp tool: ${block.name}`)
  const result = await params.callMcpTool(
    block.name,
    block.input as Record<string, unknown>
  )
  toolResults.push({
    type: 'tool_result',
    tool_use_id: block.id,
    content: JSON.stringify(result),
  })
}
```

And add a usage example in `team.ts` showing `mcpServers` and `skills` on an agent.

**Step 1: Update the tutorial**

Edit `docs/tutorial-production.md` — add the MCP dispatch block to the runner code and a new "Adding MCP tools and skills" section showing:

```ts
// team.ts — researcher with MCP tools and a skill
{
  name: 'researcher',
  systemPrompt: 'You are a research specialist.',
  model: 'claude-haiku-4-5-20251001',
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

**Step 2: Commit**

```bash
git add docs/tutorial-production.md
git commit -m "docs: add MCP tools and skills usage to production tutorial"
```

---

### Task 10: Final verification

```bash
npm test
npm run typecheck
```

Expected: all tests green, no TypeScript errors.

```bash
git log --oneline -10
```

Expected: 9 commits from this plan, all with clean messages.
