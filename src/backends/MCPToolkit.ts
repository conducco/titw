import type { MCPServerConfig, MCPToolSchema } from '../types/agent.js'
export type { MCPToolSchema } from '../types/agent.js'

const RESERVED_TOOL_NAMES = new Set(['send_message'])
const DEFAULT_TIMEOUT_MS = 10_000

interface ConnectedServer {
  config: MCPServerConfig
  client: {
    connect: (transport: unknown) => Promise<void>
    close: () => Promise<void>
    listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown } }> }>
    callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>
  }
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
      const client = new Client({ name: 'titw', version: '1.0' }, { capabilities: {} })

      let transport: unknown
      if (config.type === 'sse') {
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
        transport = new SSEClientTransport(new URL(config.url!))
      } else {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        transport = new StdioClientTransport({
          command: config.command!,
          args: config.args,
          env: { ...process.env, ...config.env } as Record<string, string>,
        })
      }

      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`MCP server timed out`)),
              config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            )
          ),
        ])
      } catch (err: unknown) {
        if (config.required === true) {
          throw err
        }
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[MCPToolkit] Skipping non-required MCP server (${config.command ?? config.url}): ${msg}`)
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
          description: raw.description,
          inputSchema: raw.inputSchema,
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
