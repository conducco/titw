import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentMemory } from '../src/memory/AgentMemory.js'
import { FileProvider } from '../src/memory/FileProvider.js'
import { ObsidianProvider } from '../src/memory/ObsidianProvider.js'
import { readFileSync } from 'fs'
import type { Triple } from '../src/types/provider.js'

let tempDir: string
let memory: AgentMemory

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'titw-test-'))
  memory = new AgentMemory({
    agentType: 'researcher',
    cwd: tempDir,
    memoryBaseDir: join(tempDir, 'user-memory'),
  })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('AgentMemory', () => {
  it('returns correct user-scope path', () => {
    const path = memory.getMemoryPath('user')
    expect(path).toBe(join(tempDir, 'user-memory', 'agent-memory', 'researcher', 'MEMORY.md'))
  })

  it('returns correct project-scope path', () => {
    const path = memory.getMemoryPath('project')
    expect(path).toBe(join(tempDir, '.titw', 'agent-memory', 'researcher', 'MEMORY.md'))
  })

  it('returns correct local-scope path', () => {
    const path = memory.getMemoryPath('local')
    expect(path).toBe(join(tempDir, '.titw', 'agent-memory-local', 'researcher', 'MEMORY.md'))
  })

  it('sanitizes colons in agent type names', () => {
    const pluginMemory = new AgentMemory({
      agentType: 'my-plugin:my-agent',
      cwd: tempDir,
      memoryBaseDir: join(tempDir, 'user-memory'),
    })
    const path = pluginMemory.getMemoryPath('project')
    expect(path).not.toContain(':')
    expect(path).toContain('my-plugin-my-agent')
  })

  it('ensures memory directory exists on ensureDir', async () => {
    await memory.ensureDir('project')
    const dir = join(tempDir, '.titw', 'agent-memory', 'researcher')
    expect(existsSync(dir)).toBe(true)
  })

  it('reads empty string when memory file does not exist', async () => {
    const content = await memory.read('user')
    expect(content).toBe('')
  })

  it('writes and reads back memory content', async () => {
    await memory.write('project', '# Memory\n- Learned that X is Y')
    const content = await memory.read('project')
    expect(content).toContain('Learned that X is Y')
  })

  it('appends to existing memory', async () => {
    await memory.write('project', '# Memory\n- Fact 1')
    await memory.append('project', '\n- Fact 2')
    const content = await memory.read('project')
    expect(content).toContain('Fact 1')
    expect(content).toContain('Fact 2')
  })

  it('buildSystemPromptInjection returns empty string when no memory', async () => {
    const injection = await memory.buildSystemPromptInjection('project')
    expect(injection).toBe('')
  })

  it('buildSystemPromptInjection wraps content in XML tag', async () => {
    await memory.write('project', '# Memory\n- Fact 1')
    const injection = await memory.buildSystemPromptInjection('project')
    expect(injection).toContain('<agent-memory scope="project">')
    expect(injection).toContain('Fact 1')
    expect(injection).toContain('</agent-memory>')
  })
})

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
