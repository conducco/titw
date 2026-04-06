import { z } from 'zod'

export type ModelSpec = string | 'inherit'
export type PermissionMode = 'default' | 'plan' | 'bubble' | 'bypass'
export type AgentMemoryScope = 'user' | 'project' | 'local'

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

export interface AgentConfig {
  name: string
  systemPrompt: string
  model?: ModelSpec
  permissionMode?: PermissionMode
  tools?: string[]
  disallowedTools?: string[]
  mcpServers?: MCPServerConfig[]
  skills?: string[]
  memory?: AgentMemoryScope
  maxTurns?: number
  planModeRequired?: boolean
  color?: string
}

export interface TeamAllowedPath {
  path: string
  toolName: string
  addedBy: string
  addedAt: number
}

export interface TeamConfig {
  name: string
  description?: string
  leadAgentName: string
  members: AgentConfig[]
  defaultModel?: string
  allowedPaths?: TeamAllowedPath[]
  backend?: 'in-process'
}

const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  required: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

export const agentConfigSchema = z.object({
  name: z.string().min(1, 'Agent name cannot be empty'),
  systemPrompt: z.string().min(1, 'System prompt cannot be empty'),
  model: z.string().optional(),
  permissionMode: z.enum(['default', 'plan', 'bubble', 'bypass']).optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  mcpServers: z.array(mcpServerConfigSchema).optional(),
  skills: z.array(z.string()).optional(),
  memory: z.enum(['user', 'project', 'local']).optional(),
  maxTurns: z.number().int().positive().optional(),
  planModeRequired: z.boolean().optional(),
  color: z.string().optional(),
})

export const teamAllowedPathSchema = z.object({
  path: z.string(),
  toolName: z.string(),
  addedBy: z.string(),
  addedAt: z.number(),
})

export const teamConfigSchema = z
  .object({
    name: z.string().min(1, 'Team name cannot be empty'),
    description: z.string().optional(),
    leadAgentName: z.string(),
    members: z.array(agentConfigSchema).min(1, 'Team must have at least one member'),
    defaultModel: z.string().optional(),
    allowedPaths: z.array(teamAllowedPathSchema).optional(),
    backend: z.literal('in-process').optional(),
  })
  .refine(
    data => data.members.some(m => m.name === data.leadAgentName),
    {
      message: 'leadAgentName must match the name of one of the members',
      path: ['leadAgentName'],
    },
  )

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

export function parseAgentId(agentId: string): { agentName: string; teamName: string } | null {
  const atIdx = agentId.lastIndexOf('@')
  if (atIdx === -1) return null
  return {
    agentName: agentId.slice(0, atIdx),
    teamName: agentId.slice(atIdx + 1),
  }
}
