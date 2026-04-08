import { describe, it, expect } from 'vitest'
import { isTerminalStatus } from '../src/types/task.js'
import type { AgentRunner, AgentRunParams } from '../src/backends/types.js'
import type { Triple } from '../src/types/provider.js'

it('AgentRunParams has mcpTools defaulting to empty array shape', () => {
  // Type-level check — if this compiles the shape is correct.
  const noop = async () => undefined
  const params = {
    mcpTools: [],
    callMcpTool: noop,
  } as unknown as AgentRunParams
  const tools: unknown[] = params.mcpTools
  const call: (n: string, a: Record<string, unknown>) => Promise<unknown> = params.callMcpTool
  expect(tools).toBeDefined()
  expect(call).toBeDefined()
})

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

describe('AgentRunner interface contract', () => {
  it('accepts a valid AgentRunner implementation', () => {
    const runner: AgentRunner = async (_params: AgentRunParams) => ({
      output: 'done',
      toolUseCount: 0,
      tokenCount: 42,
      stopReason: 'complete',
    })
    expect(typeof runner).toBe('function')
  })

  it('terminal status checks work', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
  })
})
