# Memory Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a pluggable `IMemoryProvider` interface, `FileProvider`/`ObsidianProvider` in core, `FalkorProvider` as an opt-in export, and an `observerAgent` CC pattern so a KGC agent can write structured triples back to any provider.

**Architecture:** `IMemoryProvider` is a new interface in `src/types/provider.ts`. `TeamConfig` gains `observerAgent?` and `TeamOrchestratorOptions` gains `memoryProvider?`. Mailbox CCs every `write()` call to the observer agent. The orchestrator passes `writeMemory` only to the observer's `AgentRunParams`. Three providers ship: `FileProvider` (wraps `AgentMemory`, zero new deps), `ObsidianProvider` (vault wikilinks, zero new deps), `FalkorProvider` (graph DB, opt-in via `@conducco/titw/falkor` sub-path, peer dep `falkordb`).

**Tech Stack:** TypeScript, Node.js fs/promises, vitest, falkordb (optional peer dep)

**Design doc:** `docs/plans/2026-04-08-memory-gateway-design.md`

---

### Task 1: IMemoryProvider interface + Triple type

**Files:**
- Create: `src/types/provider.ts`
- Test: `tests/types.test.ts` (add to existing file)

**Step 1: Write the failing test**

Add to the end of `tests/types.test.ts`:

```ts
import type { IMemoryProvider, Triple } from '../src/types/provider.js'

describe('IMemoryProvider structural types', () => {
  it('Triple allows weight to be optional', () => {
    const t: Triple = { subject: 'Alice', predicate: 'manages', object: 'ProjectAlpha' }
    expect(t.weight).toBeUndefined()
  })

  it('Triple accepts weight when provided', () => {
    const t: Triple = { subject: 'Alice', predicate: 'manages', object: 'ProjectAlpha', weight: 0.8 }
    expect(t.weight).toBe(0.8)
  })

  it('IMemoryProvider shape is satisfied by a mock object', () => {
    const provider: IMemoryProvider = {
      buildSystemPromptInjection: async () => '',
      write: async () => {},
    }
    expect(typeof provider.buildSystemPromptInjection).toBe('function')
    expect(typeof provider.write).toBe('function')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/cmedeiros/code/conducco/conducco-agents
npx vitest run tests/types.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/types/provider.js'`

**Step 3: Create `src/types/provider.ts`**

```ts
import type { AgentMemoryScope } from './agent.js'

export interface Triple {
  subject: string
  predicate: string
  object: string
  weight?: number
}

export interface IMemoryProvider {
  buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string>
  write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void>
  connect?(): Promise<void>
  disconnect?(): Promise<void>
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/types.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/types/provider.ts tests/types.test.ts
git commit -m "feat: add IMemoryProvider interface and Triple type"
```

---

### Task 2: TeamConfig.observerAgent + schema

**Files:**
- Modify: `src/types/agent.ts:50-108`
- Test: `tests/types.test.ts` (add to existing file)

**Step 1: Write the failing test**

Add to `tests/types.test.ts`:

```ts
import { teamConfigSchema } from '../src/types/agent.js'

describe('TeamConfig.observerAgent', () => {
  const baseTeam = {
    name: 'my-team',
    leadAgentName: 'lead',
    members: [{ name: 'lead', systemPrompt: 'You lead.' }],
  }

  it('accepts a team without observerAgent', () => {
    expect(teamConfigSchema.safeParse(baseTeam).success).toBe(true)
  })

  it('accepts a team with observerAgent set to an existing member name', () => {
    const team = { ...baseTeam, observerAgent: 'lead' }
    expect(teamConfigSchema.safeParse(team).success).toBe(true)
  })

  it('accepts a team with observerAgent set to a non-member name (observer may be unlisted)', () => {
    const team = { ...baseTeam, observerAgent: 'kgc' }
    expect(teamConfigSchema.safeParse(team).success).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/types.test.ts 2>&1 | tail -10
```

Expected: FAIL — `observerAgent` not accepted by schema (Zod strips unknown keys by default, but the tests will fail because the type check will fail)

Actually, with Zod `.object()` the unknown key is stripped but `safeParse` still returns `success: true` unless you use `.strict()`. To verify the field is really there, adjust the test:

```ts
it('preserves observerAgent in parsed output', () => {
  const team = { ...baseTeam, observerAgent: 'kgc' }
  const result = teamConfigSchema.safeParse(team)
  expect(result.success).toBe(true)
  expect((result.data as { observerAgent?: string }).observerAgent).toBe('kgc')
})
```

**Step 3: Add `observerAgent` to `src/types/agent.ts`**

At line 50, modify `TeamConfig`:

```ts
export interface TeamConfig {
  name: string
  description?: string
  leadAgentName: string
  members: AgentConfig[]
  defaultModel?: string
  allowedPaths?: TeamAllowedPath[]
  backend?: 'in-process'
  observerAgent?: string   // ADD THIS LINE
}
```

At line 92, modify `teamConfigSchema` — add inside the `.object({...})`:

```ts
observerAgent: z.string().optional(),
```

(Add after `backend: z.literal('in-process').optional(),` on line 100)

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/types.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/types/agent.ts tests/types.test.ts
git commit -m "feat: add observerAgent field to TeamConfig"
```

---

### Task 3: AgentRunParams.writeMemory

**Files:**
- Modify: `src/backends/types.ts:1-24`
- Test: `tests/backend-types.test.ts` (add to existing file)

**Step 1: Write the failing test**

Add to the end of `tests/backend-types.test.ts`:

```ts
import type { Triple } from '../src/types/provider.js'

it('AgentRunParams.writeMemory is optional and callable', () => {
  const triples: Triple[] = [{ subject: 'Alice', predicate: 'manages', object: 'Project' }]
  const params = {
    writeMemory: async (t: Triple[]) => { void t },
  } as unknown as import('../src/backends/types.js').AgentRunParams
  expect(params.writeMemory).toBeDefined()
  expect(typeof params.writeMemory).toBe('function')
})

it('AgentRunParams.writeMemory may be undefined', () => {
  const params = {} as unknown as import('../src/backends/types.js').AgentRunParams
  expect(params.writeMemory).toBeUndefined()
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/backend-types.test.ts 2>&1 | tail -10
```

Expected: TypeScript compile error — `writeMemory` does not exist on `AgentRunParams`

**Step 3: Modify `src/backends/types.ts`**

Add these two imports at the top of the file (after line 6):

```ts
import type { Triple } from '../types/provider.js'
export type { Triple } from '../types/provider.js'
```

Add to `AgentRunParams` interface (after `callMcpTool` on line 23):

```ts
writeMemory?: (triples: Triple[]) => Promise<void>
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/backend-types.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/backends/types.ts tests/backend-types.test.ts
git commit -m "feat: add writeMemory to AgentRunParams"
```

---

### Task 4: Mailbox CC logic

**Files:**
- Modify: `src/messaging/Mailbox.ts:5-59`
- Test: `tests/mailbox.test.ts` (add to existing file)

**Step 1: Write the failing test**

Add to the end of `tests/mailbox.test.ts`:

```ts
describe('Mailbox CC to observerAgent', () => {
  it('writes a copy to observerAgent inbox when set', async () => {
    const ccMailbox = new Mailbox({ teamsDir: tempDir, teamName: 'cc-team', observerAgent: 'kgc' })
    await ccMailbox.write('alice', { from: 'bob', text: 'Hello Alice' })

    const aliceMsgs = await ccMailbox.readAll('alice')
    const kgcMsgs = await ccMailbox.readAll('kgc')

    expect(aliceMsgs).toHaveLength(1)
    expect(aliceMsgs[0]?.text).toBe('Hello Alice')
    expect(kgcMsgs).toHaveLength(1)
    expect(kgcMsgs[0]?.text).toBe('Hello Alice')
  })

  it('does NOT CC when the recipient is the observerAgent itself', async () => {
    const ccMailbox = new Mailbox({ teamsDir: tempDir, teamName: 'cc-team2', observerAgent: 'kgc' })
    await ccMailbox.write('kgc', { from: 'bob', text: 'Direct to kgc' })

    const kgcMsgs = await ccMailbox.readAll('kgc')
    expect(kgcMsgs).toHaveLength(1) // not 2
  })

  it('no CC when observerAgent is not set', async () => {
    const normalMailbox = new Mailbox({ teamsDir: tempDir, teamName: 'no-cc-team' })
    await normalMailbox.write('alice', { from: 'bob', text: 'Hello' })

    const aliceMsgs = await normalMailbox.readAll('alice')
    expect(aliceMsgs).toHaveLength(1)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/mailbox.test.ts 2>&1 | tail -15
```

Expected: FAIL — `observerAgent` not accepted by `MailboxOptions`

**Step 3: Modify `src/messaging/Mailbox.ts`**

Change `MailboxOptions` (lines 5-8):

```ts
export interface MailboxOptions {
  teamsDir: string
  teamName: string
  observerAgent?: string
}
```

Add `private readonly observerAgent` field to the class (after line 24):

```ts
private readonly observerAgent: string | undefined
```

Add to constructor body (after `this.teamName = options.teamName`):

```ts
this.observerAgent = options.observerAgent
```

Replace `write()` method (lines 53-59) with:

```ts
async write(agentName: string, message: IncomingMessage): Promise<void> {
  await this.ensureInboxDir()
  await this._writeToInbox(agentName, message)
  if (this.observerAgent && agentName !== this.observerAgent) {
    await this._writeToInbox(this.observerAgent, message)
  }
}

private async _writeToInbox(agentName: string, message: IncomingMessage): Promise<void> {
  const path = this.getInboxPath(agentName)
  const all = await this.readAll(agentName)
  all.push({ ...message, timestamp: new Date().toISOString(), read: false })
  await writeFile(path, JSON.stringify(all, null, 2), 'utf-8')
}
```

(Remove the old inline body of `write()` and extract it into `_writeToInbox`.)

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/mailbox.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 5: Run the full test suite to make sure nothing regressed**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: all tests pass

**Step 6: Commit**

```bash
git add src/messaging/Mailbox.ts tests/mailbox.test.ts
git commit -m "feat: add observerAgent CC to Mailbox.write()"
```

---

### Task 5: FileProvider

**Files:**
- Create: `src/memory/FileProvider.ts`
- Modify: `src/memory/index.ts`
- Test: `tests/memory.test.ts` (add FileProvider describe block)

**Step 1: Write the failing test**

Add to the end of `tests/memory.test.ts`:

```ts
import { FileProvider } from '../src/memory/FileProvider.js'
import type { Triple } from '../src/types/provider.js'

describe('FileProvider', () => {
  it('buildSystemPromptInjection delegates to AgentMemory — returns empty when no memory', async () => {
    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'user-memory') })
    const result = await provider.buildSystemPromptInjection('researcher', 'project')
    expect(result).toBe('')
  })

  it('buildSystemPromptInjection returns wrapped content when memory exists', async () => {
    await memory.write('project', '# Memory\n- Existing fact')
    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'user-memory') })
    const result = await provider.buildSystemPromptInjection('researcher', 'project')
    expect(result).toContain('<agent-memory')
    expect(result).toContain('Existing fact')
  })

  it('write appends triples as markdown bullets', async () => {
    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'user-memory') })
    const triples: Triple[] = [
      { subject: 'Alice', predicate: 'manages', object: 'ProjectAlpha' },
      { subject: 'Bob', predicate: 'reports-to', object: 'Alice', weight: 0.9 },
    ]
    await provider.write('researcher', 'project', triples)

    const content = await memory.read('project')
    expect(content).toContain('- Alice manages ProjectAlpha')
    expect(content).toContain('- Bob reports-to Alice (weight: 0.9)')
  })

  it('write creates file if it does not exist', async () => {
    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'user-memory') })
    await provider.write('researcher', 'local', [{ subject: 'X', predicate: 'is', object: 'Y' }])
    const content = await memory.read('local')
    expect(content).toContain('- X is Y')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../src/memory/FileProvider.js'`

**Step 3: Create `src/memory/FileProvider.ts`**

```ts
import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { AgentMemoryScope } from '../types/agent.js'
import type { IMemoryProvider, Triple } from '../types/provider.js'
import { AgentMemory } from './AgentMemory.js'

export interface FileProviderOptions {
  cwd: string
  memoryBaseDir: string
}

export class FileProvider implements IMemoryProvider {
  constructor(private options: FileProviderOptions) {}

  async buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string> {
    return new AgentMemory({ agentType, cwd: this.options.cwd, memoryBaseDir: this.options.memoryBaseDir })
      .buildSystemPromptInjection(scope)
  }

  async write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void> {
    const mem = new AgentMemory({ agentType, cwd: this.options.cwd, memoryBaseDir: this.options.memoryBaseDir })
    const filePath = mem.getMemoryPath(scope)
    const lines = triples.map(t =>
      t.weight !== undefined
        ? `- ${t.subject} ${t.predicate} ${t.object} (weight: ${t.weight})`
        : `- ${t.subject} ${t.predicate} ${t.object}`
    )
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, '\n' + lines.join('\n'), 'utf-8')
  }
}
```

**Step 4: Update `src/memory/index.ts`**

Append:

```ts
export { FileProvider } from './FileProvider.js'
export type { FileProviderOptions } from './FileProvider.js'
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run tests/memory.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/memory/FileProvider.ts src/memory/index.ts tests/memory.test.ts
git commit -m "feat: add FileProvider (backward-compatible IMemoryProvider over AgentMemory)"
```

---

### Task 6: ObsidianProvider

**Files:**
- Create: `src/memory/ObsidianProvider.ts`
- Modify: `src/memory/index.ts`
- Test: `tests/memory.test.ts` (add ObsidianProvider describe block)

**Step 1: Write the failing test**

Add to the end of `tests/memory.test.ts`:

```ts
import { ObsidianProvider } from '../src/memory/ObsidianProvider.js'
import { existsSync, readFileSync } from 'fs'

describe('ObsidianProvider', () => {
  let vaultDir: string

  beforeEach(() => {
    vaultDir = join(tempDir, 'vault')
  })

  it('write creates one note per subject under scope subdirectory', async () => {
    const provider = new ObsidianProvider(vaultDir)
    const triples: Triple[] = [
      { subject: 'Alice', predicate: 'manages', object: 'ProjectAlpha' },
      { subject: 'Alice', predicate: 'reports-to', object: 'CEO' },
    ]
    await provider.write('researcher', 'project', triples)

    const alicePath = join(vaultDir, 'project', 'Alice.md')
    expect(existsSync(alicePath)).toBe(true)
    const content = readFileSync(alicePath, 'utf-8')
    expect(content).toContain('- manages: [[ProjectAlpha]]')
    expect(content).toContain('- reports-to: [[CEO]]')
  })

  it('write creates separate notes for different subjects', async () => {
    const provider = new ObsidianProvider(vaultDir)
    await provider.write('researcher', 'project', [
      { subject: 'Alice', predicate: 'manages', object: 'Project' },
      { subject: 'Bob', predicate: 'owns', object: 'Service' },
    ])
    expect(existsSync(join(vaultDir, 'project', 'Alice.md'))).toBe(true)
    expect(existsSync(join(vaultDir, 'project', 'Bob.md'))).toBe(true)
  })

  it('write includes weight as HTML comment when provided', async () => {
    const provider = new ObsidianProvider(vaultDir)
    await provider.write('researcher', 'project', [
      { subject: 'Alice', predicate: 'manages', object: 'Project', weight: 0.8 },
    ])
    const content = readFileSync(join(vaultDir, 'project', 'Alice.md'), 'utf-8')
    expect(content).toContain('<!-- weight: 0.8 -->')
  })

  it('buildSystemPromptInjection returns empty string when vault scope dir is empty', async () => {
    const provider = new ObsidianProvider(vaultDir)
    const result = await provider.buildSystemPromptInjection('researcher', 'project')
    expect(result).toBe('')
  })

  it('buildSystemPromptInjection returns wrapped content from all notes in scope', async () => {
    const provider = new ObsidianProvider(vaultDir)
    await provider.write('researcher', 'project', [
      { subject: 'Alice', predicate: 'manages', object: 'Project' },
    ])
    const result = await provider.buildSystemPromptInjection('researcher', 'project')
    expect(result).toContain('<agent-memory scope="project">')
    expect(result).toContain('[[Project]]')
    expect(result).toContain('</agent-memory>')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../src/memory/ObsidianProvider.js'`

**Step 3: Create `src/memory/ObsidianProvider.ts`**

```ts
import { appendFile, mkdir, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { AgentMemoryScope } from '../types/agent.js'
import type { IMemoryProvider, Triple } from '../types/provider.js'

export class ObsidianProvider implements IMemoryProvider {
  constructor(private vaultDir: string) {}

  async write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void> {
    const scopeDir = join(this.vaultDir, scope)
    await mkdir(scopeDir, { recursive: true })

    // group triples by subject
    const bySubject = new Map<string, Triple[]>()
    for (const t of triples) {
      const group = bySubject.get(t.subject) ?? []
      group.push(t)
      bySubject.set(t.subject, group)
    }

    for (const [subject, group] of bySubject) {
      const notePath = join(scopeDir, `${subject}.md`)
      const lines = group.map(t =>
        t.weight !== undefined
          ? `- ${t.predicate}: [[${t.object}]] <!-- weight: ${t.weight} -->`
          : `- ${t.predicate}: [[${t.object}]]`
      )
      await appendFile(notePath, '\n' + lines.join('\n'), 'utf-8')
    }
  }

  async buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string> {
    const scopeDir = join(this.vaultDir, scope)
    const files = await readdir(scopeDir).catch(() => [])
    const mdFiles = files.filter(f => f.endsWith('.md'))
    if (mdFiles.length === 0) return ''

    const contents = await Promise.all(
      mdFiles.map(f => readFile(join(scopeDir, f), 'utf-8'))
    )
    return `<agent-memory scope="${scope}">\n${contents.join('\n')}\n</agent-memory>`
  }
}
```

**Step 4: Update `src/memory/index.ts`**

Append:

```ts
export { ObsidianProvider } from './ObsidianProvider.js'
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run tests/memory.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/memory/ObsidianProvider.ts src/memory/index.ts tests/memory.test.ts
git commit -m "feat: add ObsidianProvider (vault-native wikilinks IMemoryProvider)"
```

---

### Task 7: TeamOrchestrator wiring

Wire `memoryProvider`, `observerAgent`, and `writeMemory` together in the orchestrator.

**Files:**
- Modify: `src/orchestrator/TeamOrchestrator.ts`
- Test: `tests/team-orchestrator.test.ts` (add two describe blocks)

**Step 1: Write the failing tests**

Add to the end of `tests/team-orchestrator.test.ts`:

```ts
import { FileProvider } from '../src/memory/FileProvider.js'
import type { Triple } from '../src/types/provider.js'
import { writeFileSync, mkdirSync } from 'fs'

describe('TeamOrchestrator with memoryProvider', () => {
  it('uses memoryProvider.buildSystemPromptInjection instead of AgentMemory when set', async () => {
    let capturedPrompt = ''
    const capturingRunner: AgentRunner = async (params) => {
      capturedPrompt = params.systemPrompt
      return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
    }

    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'memory') })
    // Write memory via provider
    const { AgentMemory } = await import('../src/memory/AgentMemory.js')
    const mem = new AgentMemory({ agentType: 'lead', cwd: tempDir, memoryBaseDir: join(tempDir, 'memory') })
    await mem.write('project', '# Memory\n- Provider injected fact')

    const teamWithProvider: TeamConfig = {
      name: 'provider-team',
      leadAgentName: 'lead',
      members: [{ name: 'lead', systemPrompt: 'Base.', memory: 'project' }],
    }
    const cfg = createConfig({ teamsDir: join(tempDir, 'teams'), memoryBaseDir: join(tempDir, 'memory') })
    const orch = new TeamOrchestrator({ team: teamWithProvider, runner: capturingRunner, config: cfg, cwd: tempDir, memoryProvider: provider })
    await orch.start()
    await new Promise(r => setTimeout(r, 50))
    await orch.stop()

    expect(capturedPrompt).toContain('Provider injected fact')
  })
})

describe('TeamOrchestrator observerAgent CC', () => {
  it('CCs all messages to observerAgent inbox', async () => {
    const teamWithObserver: TeamConfig = {
      name: 'observer-team',
      leadAgentName: 'lead',
      members: [
        { name: 'lead', systemPrompt: 'You lead.' },
        { name: 'kgc', systemPrompt: 'You observe.' },
      ],
      observerAgent: 'kgc',
    }
    const cfg = createConfig({ teamsDir: join(tempDir, 'teams') })
    const orch = new TeamOrchestrator({ team: teamWithObserver, runner: echoRunner, config: cfg, cwd: tempDir })
    await orch.start()
    await orch.sendMessage('lead', { from: 'user', text: 'Hello lead' })

    const mailbox = new Mailbox({ teamsDir: join(tempDir, 'teams'), teamName: 'observer-team' })
    const kgcMsgs = await mailbox.readAll('kgc')
    expect(kgcMsgs.some(m => m.text === 'Hello lead')).toBe(true)
    await orch.stop()
  })

  it('passes writeMemory to observerAgent runner params', async () => {
    let capturedWriteMemory: ((triples: Triple[]) => Promise<void>) | undefined

    const observerRunner: AgentRunner = async (params) => {
      capturedWriteMemory = params.writeMemory
      return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
    }

    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'memory') })
    const teamWithObserver: TeamConfig = {
      name: 'writememory-team',
      leadAgentName: 'lead',
      members: [
        { name: 'lead', systemPrompt: 'You lead.' },
        { name: 'kgc', systemPrompt: 'You observe.' },
      ],
      observerAgent: 'kgc',
    }
    const cfg = createConfig({ teamsDir: join(tempDir, 'teams') })
    const orch = new TeamOrchestrator({
      team: teamWithObserver,
      runner: (params) => params.agentId.startsWith('kgc') ? observerRunner(params) : echoRunner(params),
      config: cfg,
      cwd: tempDir,
      memoryProvider: provider,
    })
    await orch.start()
    await new Promise(r => setTimeout(r, 50))
    await orch.stop()

    expect(capturedWriteMemory).toBeDefined()
  })

  it('does NOT pass writeMemory to non-observer agents', async () => {
    let leadWriteMemory: unknown = 'not-checked'

    const provider = new FileProvider({ cwd: tempDir, memoryBaseDir: join(tempDir, 'memory') })
    const teamWithObserver: TeamConfig = {
      name: 'no-writememory-team',
      leadAgentName: 'lead',
      members: [
        { name: 'lead', systemPrompt: 'You lead.' },
        { name: 'kgc', systemPrompt: 'You observe.' },
      ],
      observerAgent: 'kgc',
    }
    const cfg = createConfig({ teamsDir: join(tempDir, 'teams') })
    const orch = new TeamOrchestrator({
      team: teamWithObserver,
      runner: async (params) => {
        if (params.agentId.startsWith('lead')) leadWriteMemory = params.writeMemory
        return { output: '', toolUseCount: 0, tokenCount: 0, stopReason: 'complete' }
      },
      config: cfg,
      cwd: tempDir,
      memoryProvider: provider,
    })
    await orch.start()
    await new Promise(r => setTimeout(r, 50))
    await orch.stop()

    expect(leadWriteMemory).toBeUndefined()
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/team-orchestrator.test.ts 2>&1 | tail -20
```

Expected: FAIL — `memoryProvider` not accepted, no CC to kgc

**Step 3: Modify `src/orchestrator/TeamOrchestrator.ts`**

**3a.** Add imports at the top (after existing imports):

```ts
import type { IMemoryProvider } from '../types/provider.js'
```

**3b.** Add `memoryProvider?` to `TeamOrchestratorOptions` (lines 13-19):

```ts
export interface TeamOrchestratorOptions {
  team: TeamConfig
  runner: AgentRunner
  config: TitwConfig
  cwd: string
  backend?: TeammateExecutor
  memoryProvider?: IMemoryProvider        // ADD THIS
}
```

**3c.** Add `private readonly memoryProvider` field to the class:

```ts
private readonly memoryProvider: IMemoryProvider | undefined
```

**3d.** In the constructor, set the field and pass `observerAgent` to `Mailbox`:

```ts
this.memoryProvider = options.memoryProvider
this.mailbox = new Mailbox({
  teamsDir: options.config.teamsDir,
  teamName: sanitizeName(options.team.name),
  observerAgent: options.team.observerAgent,   // ADD
})
```

**3e.** Replace `_spawnMember` (lines 77-115) with the new wired version:

```ts
private async _spawnMember(agentConfig: TeamConfig['members'][number]): Promise<void> {
  const model = this.loader.resolveModel(agentConfig, this.team)

  // Memory injection: use provider if set, else fall back to AgentMemory
  let memoryInjection = ''
  if (agentConfig.memory) {
    if (this.memoryProvider) {
      memoryInjection = await this.memoryProvider.buildSystemPromptInjection(agentConfig.name, agentConfig.memory)
    } else {
      memoryInjection = await new AgentMemory({
        agentType: agentConfig.name,
        cwd: this.cwd,
        memoryBaseDir: this.config.memoryBaseDir,
      }).buildSystemPromptInjection(agentConfig.memory)
    }
  }

  const skillInjection = agentConfig.skills?.length
    ? await SkillRegistry.load(agentConfig.skills, this.cwd)
    : ''

  const toolkit = await MCPToolkit.connect(agentConfig.mcpServers ?? [])

  const systemPrompt = agentConfig.systemPrompt + skillInjection + memoryInjection

  // writeMemory: only wired for the observer agent
  const isObserver = agentConfig.name === this.team.observerAgent
  const writeMemory =
    isObserver && this.memoryProvider
      ? (triples: import('../types/provider.js').Triple[]) =>
          this.memoryProvider!.write(agentConfig.name, agentConfig.memory ?? 'project', triples)
      : undefined

  const result = await this.backend.spawn({
    agentName: agentConfig.name,
    teamName: sanitizeName(this.team.name),
    agentConfig,
    prompt: '',
    systemPrompt,
    model,
    cwd: this.cwd,
    parentId: `team-${sanitizeName(this.team.name)}`,
    runner: this.runner,
    titwCfg: this.config,
    mcpTools: toolkit.tools,
    callMcpTool: (name, args) => toolkit.call(name, args),
    writeMemory,
    onIdle: () => {
      void toolkit.disconnect()
    },
  })

  if (result.success) {
    this.spawned.set(result.agentId, result)
  } else {
    console.error(`[TeamOrchestrator] Failed to spawn ${agentConfig.name}: ${result.error ?? 'unknown error'}`)
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/team-orchestrator.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 5: Run full suite**

```bash
npx vitest run 2>&1 | tail -15
```

Expected: all tests pass

**Step 6: Commit**

```bash
git add src/orchestrator/TeamOrchestrator.ts tests/team-orchestrator.test.ts
git commit -m "feat: wire memoryProvider and observerAgent into TeamOrchestrator"
```

---

### Task 8: Export updates

Export all new public types and classes from `src/index.ts`. Update `tests/public-api.test.ts`.

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/public-api.test.ts`

**Step 1: Write the failing tests**

Add to `tests/public-api.test.ts` (inside `describe('public API surface', ...)`):

```ts
it('exports IMemoryProvider type (structural check via FileProvider)', async () => {
  const { FileProvider } = await import('../src/index.js')
  expect(FileProvider).toBeDefined()
})

it('exports ObsidianProvider', async () => {
  const { ObsidianProvider } = await import('../src/index.js')
  expect(ObsidianProvider).toBeDefined()
})

it('exports FileProvider', async () => {
  const { FileProvider } = await import('../src/index.js')
  const provider = new FileProvider({ cwd: '/tmp', memoryBaseDir: '/tmp/mem' })
  expect(typeof provider.buildSystemPromptInjection).toBe('function')
  expect(typeof provider.write).toBe('function')
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/public-api.test.ts 2>&1 | tail -10
```

Expected: FAIL — `FileProvider`/`ObsidianProvider` not found in index

**Step 3: Update `src/index.ts`**

After the existing `AgentMemory` export lines (around line 63), add:

```ts
export { FileProvider } from './memory/FileProvider.js'
export type { FileProviderOptions } from './memory/FileProvider.js'
export { ObsidianProvider } from './memory/ObsidianProvider.js'
export type { IMemoryProvider, Triple } from './types/provider.js'
```

Also add `TeamOrchestratorOptions` export if not already present — check line 79:
```ts
export type { TeamOrchestratorOptions } from './orchestrator/TeamOrchestrator.js'
```
(already there — no change needed)

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/public-api.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 5: Run full suite**

```bash
npx vitest run 2>&1 | tail -15
```

Expected: all tests pass

**Step 6: Commit**

```bash
git add src/index.ts tests/public-api.test.ts
git commit -m "feat: export IMemoryProvider, Triple, FileProvider, ObsidianProvider from public API"
```

---

### Task 9: FalkorProvider (opt-in sub-path export)

Ship `FalkorProvider` as `@conducco/titw/falkor` — a separate export entry that only loads when explicitly imported. Users must install `falkordb` themselves.

**Files:**
- Create: `src/memory/falkor/FalkorProvider.ts`
- Create: `src/memory/falkor/index.ts`
- Modify: `package.json` (add `./falkor` export entry + `peerDependencies`)
- Modify: `tsconfig.json` (verify no changes needed)
- Test: `tests/falkor-provider.test.ts` (new file, mocks `falkordb`)

**Context:** `falkordb` is NOT installed — do not run `npm install falkordb`. Mock it in tests. The provider uses dynamic import inside `connect()` so it doesn't blow up if `falkordb` is absent at module load time.

**Step 1: Write the failing test**

Create `tests/falkor-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock falkordb BEFORE importing FalkorProvider
const mockQuery = vi.fn()
const mockClose = vi.fn()
const mockSelectGraph = vi.fn(() => ({ query: mockQuery, close: mockClose }))
const mockConnect = vi.fn(async () => ({ selectGraph: mockSelectGraph, close: mockClose }))

vi.mock('falkordb', () => ({
  default: { connect: mockConnect },
  FalkorDB: { connect: mockConnect },
}))

import { FalkorProvider } from '../src/memory/falkor/FalkorProvider.js'
import type { Triple } from '../src/types/provider.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockQuery.mockResolvedValue({ data: [] })
})

describe('FalkorProvider', () => {
  it('connect() calls FalkorDB.connect with the provided url', async () => {
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test' })
    await provider.connect()
    expect(mockConnect).toHaveBeenCalledWith('redis://localhost:6379')
  })

  it('write() executes a CREATE query for each triple', async () => {
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test' })
    await provider.connect()
    const triples: Triple[] = [
      { subject: 'Alice', predicate: 'manages', object: 'Project', weight: 0.9 },
    ]
    await provider.write('researcher', 'project', triples)
    expect(mockQuery).toHaveBeenCalledOnce()
    const [cypher, params] = mockQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('MERGE')
    expect(params.subject).toBe('Alice')
    expect(params.object).toBe('Project')
    expect(params.predicate).toBe('manages')
    expect(params.weight).toBe(0.9)
  })

  it('write() uses weight 1.0 when triple has no weight', async () => {
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test' })
    await provider.connect()
    await provider.write('researcher', 'project', [
      { subject: 'Alice', predicate: 'manages', object: 'Project' },
    ])
    const [, params] = mockQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.weight).toBe(1.0)
  })

  it('buildSystemPromptInjection returns empty string when no results', async () => {
    mockQuery.mockResolvedValue({ data: [] })
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test' })
    await provider.connect()
    const result = await provider.buildSystemPromptInjection('researcher', 'project')
    expect(result).toBe('')
  })

  it('buildSystemPromptInjection wraps results in agent-memory tag', async () => {
    mockQuery.mockResolvedValue({
      data: [{ 's.name': 'Alice', 'r.predicate': 'manages', 'o.name': 'Project', score: 0.9 }],
    })
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test' })
    await provider.connect()
    const result = await provider.buildSystemPromptInjection('researcher', 'project')
    expect(result).toContain('<agent-memory scope="project">')
    expect(result).toContain('- Alice manages Project')
    expect(result).toContain('</agent-memory>')
  })

  it('buildSystemPromptInjection uses custom lambda when provided', async () => {
    mockQuery.mockResolvedValue({ data: [] })
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test', lambda: 0.8 })
    await provider.connect()
    await provider.buildSystemPromptInjection('researcher', 'project')
    const [, params] = mockQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.lambda).toBe(0.8)
  })

  it('disconnect() calls graph.close()', async () => {
    const provider = new FalkorProvider({ url: 'redis://localhost:6379', graphName: 'test' })
    await provider.connect()
    await provider.disconnect()
    expect(mockClose).toHaveBeenCalled()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/falkor-provider.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../src/memory/falkor/FalkorProvider.js'`

**Step 3: Create `src/memory/falkor/FalkorProvider.ts`**

```ts
import type { AgentMemoryScope } from '../../types/agent.js'
import type { IMemoryProvider, Triple } from '../../types/provider.js'

export interface FalkorProviderOptions {
  url: string
  graphName: string
  lambda?: number
}

interface FalkorGraph {
  query(cypher: string, params?: Record<string, unknown>): Promise<{ data: Record<string, unknown>[] }>
  close(): Promise<void>
}

export class FalkorProvider implements IMemoryProvider {
  private graph: FalkorGraph | undefined

  constructor(private opts: FalkorProviderOptions) {}

  async connect(): Promise<void> {
    // Dynamic import so `falkordb` is only required when this provider is used
    const { default: FalkorDB } = await import('falkordb') as { default: { connect(url: string): Promise<{ selectGraph(name: string): FalkorGraph }> } }
    const client = await FalkorDB.connect(this.opts.url)
    this.graph = client.selectGraph(this.opts.graphName)
  }

  async disconnect(): Promise<void> {
    await this.graph?.close()
  }

  async write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void> {
    if (!this.graph) throw new Error('FalkorProvider: call connect() before write()')
    for (const t of triples) {
      await this.graph.query(
        `MERGE (s:Entity {name: $subject})
         MERGE (o:Entity {name: $object})
         CREATE (s)-[:RELATES_TO {
           predicate: $predicate,
           weight: $weight,
           createdAt: timestamp(),
           agentType: $agentType,
           scope: $scope
         }]->(o)`,
        {
          subject: t.subject,
          object: t.object,
          predicate: t.predicate,
          weight: t.weight ?? 1.0,
          agentType,
          scope,
        }
      )
    }
  }

  async buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string> {
    if (!this.graph) throw new Error('FalkorProvider: call connect() before buildSystemPromptInjection()')
    const lambda = this.opts.lambda ?? 0.95
    const result = await this.graph.query(
      `MATCH (s)-[r:RELATES_TO]->(o)
       WHERE r.scope = $scope
       RETURN s.name, r.predicate, o.name,
              r.weight * pow($lambda, (timestamp() - r.createdAt) / 86400000.0) AS score
       ORDER BY score DESC
       LIMIT 50`,
      { scope, lambda }
    )
    if (!result.data.length) return ''
    const lines = result.data.map(r => `- ${String(r['s.name'])} ${String(r['r.predicate'])} ${String(r['o.name'])}`)
    return `<agent-memory scope="${scope}">\n${lines.join('\n')}\n</agent-memory>`
  }
}
```

**Step 4: Create `src/memory/falkor/index.ts`**

```ts
export { FalkorProvider } from './FalkorProvider.js'
export type { FalkorProviderOptions } from './FalkorProvider.js'
```

**Step 5: Update `package.json` — add `./falkor` export entry and peer dep**

In the `"exports"` section, add after the `"."` entry:

```json
"./falkor": {
  "import": "./dist/memory/falkor/index.js",
  "require": "./dist/memory/falkor/index.js",
  "types": "./dist/memory/falkor/index.d.ts",
  "default": "./dist/memory/falkor/index.js"
}
```

Add peer dep section:

```json
"peerDependencies": {
  "falkordb": ">=4.0.0"
},
"peerDependenciesMeta": {
  "falkordb": {
    "optional": true
  }
}
```

**Step 6: Run test to verify it passes**

```bash
npx vitest run tests/falkor-provider.test.ts 2>&1 | tail -10
```

Expected: PASS

**Step 7: Run full suite**

```bash
npx vitest run 2>&1 | tail -15
```

Expected: all tests pass

**Step 8: Typecheck**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors

**Step 9: Commit**

```bash
git add src/memory/falkor/ tests/falkor-provider.test.ts package.json
git commit -m "feat: add FalkorProvider as opt-in @conducco/titw/falkor export"
```
