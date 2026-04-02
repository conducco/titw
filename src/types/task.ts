export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export interface AgentProgress {
  toolUseCount: number
  tokenCount: number
  lastActivity?: string
  recentActivities?: string[]
}

export interface AgentRunResult {
  output: string
  toolUseCount: number
  tokenCount: number
  stopReason: 'complete' | 'max_turns' | 'aborted' | 'error'
}

export interface BaseTask {
  id: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

export interface AgentTask extends BaseTask {
  type: 'agent'
  agentId: string
  prompt: string
  isBackgrounded: boolean
  result?: AgentRunResult
  error?: string
  progress?: AgentProgress
}

export interface TeammateTask extends BaseTask {
  type: 'teammate'
  agentId: string
  teamName: string
  prompt: string
  isIdle: boolean
  awaitingPlanApproval: boolean
  abortController?: AbortController
  result?: AgentRunResult
  error?: string
  progress?: AgentProgress
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export type Task = AgentTask | TeammateTask

export function generateTaskId(prefix: 'agent' | 'teammate'): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const rand = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${prefix}-${rand}`
}
