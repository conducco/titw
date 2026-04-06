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
