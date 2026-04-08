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
