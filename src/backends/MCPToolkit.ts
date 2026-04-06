import type { MCPServerConfig, MCPToolSchema } from '../types/agent.js'
import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
export type { MCPToolSchema } from '../types/agent.js'

const RESERVED_TOOL_NAMES = new Set(['send_message'])
const DEFAULT_TIMEOUT_MS = 10_000

interface ConnectedServer {
  config: MCPServerConfig
  client: MCPClient
  tools: MCPToolSchema[]
}

export class MCPToolkit {
  private constructor(private readonly servers: ConnectedServer[]) {}

  static async connect(configs: MCPServerConfig[]): Promise<MCPToolkit> {
    if (configs.length === 0) {
      return new MCPToolkit([])
    }

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

    const connected: ConnectedServer[] = []

    for (const config of configs) {
      const label = config.command ?? config.url ?? 'unknown'
      const client = new Client({ name: 'titw', version: '1.0' }, { capabilities: {} })

      let transport: Transport
      if (config.type === 'sse') {
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
        transport = new SSEClientTransport(new URL(config.url!))
      } else {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        transport = new StdioClientTransport({
          command: config.command!,
          ...(config.args !== undefined ? { args: config.args } : {}),
          ...(config.env !== undefined ? { env: { ...process.env, ...config.env } as Record<string, string> } : {}),
        })
      }

      try {
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`MCP server "${label}" timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)),
            config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          )
        })
        try {
          await Promise.race([client.connect(transport), timeoutPromise])
        } finally {
          clearTimeout(timeoutId)
        }
      } catch (err: unknown) {
        const msg = `[MCPToolkit] Failed to connect to MCP server "${label}": ${(err as Error).message}`
        if (config.required) {
          await Promise.allSettled(connected.map(s => s.client.close()))
          throw new Error(msg)
        }
        console.warn(msg)
        continue
      }

      const { tools: rawTools } = await client.listTools()

      const serverTools: MCPToolSchema[] = []
      for (const raw of rawTools) {
        if (RESERVED_TOOL_NAMES.has(raw.name)) {
          // Disconnect already-connected servers before throwing
          await Promise.allSettled(connected.map(s => s.client.close()))
          await Promise.allSettled([client.close()])
          throw new Error(
            `MCP tool name "${raw.name}" is reserved and cannot be used by an MCP server`,
          )
        }
        serverTools.push({
          name: raw.name,
          ...(raw.description !== undefined ? { description: raw.description } : {}),
          inputSchema: raw.inputSchema as MCPToolSchema['inputSchema'],
        })
      }

      connected.push({ config, client, tools: serverTools })
    }

    return new MCPToolkit(connected)
  }

  get tools(): MCPToolSchema[] {
    const seen = new Map<string, MCPToolSchema>()
    for (const server of this.servers) {
      for (const tool of server.tools) {
        if (seen.has(tool.name)) {
          console.warn(`[MCPToolkit] Tool name collision: "${tool.name}" — last writer wins`)
        }
        seen.set(tool.name, tool)
      }
    }
    return Array.from(seen.values())
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    // Find the last server that owns this tool (last-writer-wins, same as get tools)
    let ownerServer: ConnectedServer | undefined
    for (const server of this.servers) {
      if (server.tools.some(t => t.name === toolName)) {
        ownerServer = server
      }
    }

    if (ownerServer === undefined) {
      throw new Error(`[MCPToolkit] Unknown tool: "${toolName}"`)
    }

    try {
      const result = await ownerServer.client.callTool({ name: toolName, arguments: args })
      return (result as { content: unknown }).content
    // Returns a structured error result (never throws) so the LLM can receive it as a tool_result
    // and react to the failure gracefully, rather than causing an unhandled exception.
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[MCPToolkit] Tool call "${toolName}" failed: ${message}`)
      return { error: true, message }
    }
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(this.servers.map(s => s.client.close()))
  }
}
