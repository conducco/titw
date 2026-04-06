import type { TeammateMessage } from '../types/message.js'
import type { AgentConfig, MCPToolSchema } from '../types/agent.js'
import type { AgentRunResult, AgentProgress } from '../types/task.js'
import type { TitwConfig } from '../config.js'

/**
 * Parameters passed to an AgentRunner on each invocation.
 * The runner is the ONLY place where LLM API calls happen.
 */
export interface AgentRunParams {
  agentId: string
  systemPrompt: string
  prompt: string
  model: string
  maxTurns: number
  abortSignal: AbortSignal
  readMailbox: () => Promise<TeammateMessage[]>
  sendMessage: (to: string, message: Omit<TeammateMessage, 'timestamp' | 'read'>) => Promise<void>
  onProgress?: (progress: AgentProgress) => void
  mcpTools: MCPToolSchema[]
  callMcpTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Injectable LLM runner. Implement this with your provider (Anthropic, OpenAI, etc).
 * The framework never calls an LLM directly — it only calls this function.
 */
export type AgentRunner = (params: AgentRunParams) => Promise<AgentRunResult>

export interface TeammateSpawnConfig {
  agentName: string
  teamName: string
  agentConfig: AgentConfig
  prompt: string
  systemPrompt: string
  model: string
  cwd: string
  parentId: string
  runner: AgentRunner
  mcpTools?: MCPToolSchema[]
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  titwCfg: TitwConfig
  onIdle?: () => void
  onProgress?: (progress: AgentProgress) => void
}

export interface TeammateSpawnResult {
  success: boolean
  agentId: string
  taskId?: string
  error?: string
  abortController?: AbortController
}

/**
 * Common interface for teammate execution backends.
 * Currently only InProcessBackend is shipped.
 * Extend for container, remote, or tmux backends.
 */
export interface TeammateExecutor {
  readonly type: string
  isAvailable(): Promise<boolean>
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>
  sendMessage(agentId: string, message: Omit<TeammateMessage, 'timestamp' | 'read'>): Promise<void>
  terminate(agentId: string, reason?: string): Promise<boolean>
  kill(agentId: string): Promise<boolean>
  isActive(agentId: string): Promise<boolean>
}
