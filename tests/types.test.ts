import { describe, it, expect } from 'vitest'
import { agentConfigSchema, teamConfigSchema, sanitizeName, formatAgentId, parseAgentId } from '../src/types/agent.js'

it('AgentConfig accepts mcpServers with stdio type', () => {
  const result = agentConfigSchema.safeParse({
    name: 'agent',
    systemPrompt: 'You help.',
    mcpServers: [{ type: 'stdio', command: 'npx', args: ['-y', '@mcp/server'], required: true }],
  })
  expect(result.success).toBe(true)
})

it('AgentConfig accepts mcpServers with sse type', () => {
  const result = agentConfigSchema.safeParse({
    name: 'agent',
    systemPrompt: 'You help.',
    mcpServers: [{ type: 'sse', url: 'http://localhost:3000/sse' }],
  })
  expect(result.success).toBe(true)
})

it('AgentConfig accepts skills array', () => {
  const result = agentConfigSchema.safeParse({
    name: 'agent',
    systemPrompt: 'You help.',
    skills: ['./skills/researcher.md', '@titw/skill-writer'],
  })
  expect(result.success).toBe(true)
})

describe('agentConfigSchema', () => {
  it('requires name and systemPrompt', () => {
    const result = agentConfigSchema.safeParse({ name: 'researcher', systemPrompt: 'You are a researcher.' })
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = agentConfigSchema.safeParse({ name: '', systemPrompt: 'You are a researcher.' })
    expect(result.success).toBe(false)
  })

  it('accepts optional fields', () => {
    const result = agentConfigSchema.safeParse({
      name: 'coder',
      systemPrompt: 'You write code.',
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'plan',
      tools: ['Read', 'Edit', 'Bash'],
      memory: 'project',
      maxTurns: 30,
      planModeRequired: true,
    })
    expect(result.success).toBe(true)
  })
})

describe('teamConfigSchema', () => {
  it('requires name, leadAgentName, and members', () => {
    const result = teamConfigSchema.safeParse({
      name: 'my-team',
      leadAgentName: 'lead',
      members: [
        { name: 'lead', systemPrompt: 'You are the lead.' },
        { name: 'worker', systemPrompt: 'You do the work.' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects when leadAgentName is not in members', () => {
    const result = teamConfigSchema.safeParse({
      name: 'my-team',
      leadAgentName: 'missing-lead',
      members: [{ name: 'worker', systemPrompt: 'You do the work.' }],
    })
    expect(result.success).toBe(false)
    const err = result as { success: false; error: { issues: { message: string }[] } }
    expect(err.error.issues[0]?.message).toContain('leadAgentName')
  })
})

describe('sanitizeName', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(sanitizeName('My Team Name!')).toBe('my-team-name-')
    expect(sanitizeName('researcher_v2')).toBe('researcher-v2')
  })
})

describe('formatAgentId', () => {
  it('formats as name@team', () => {
    expect(formatAgentId('researcher', 'analytics-team')).toBe('researcher@analytics-team')
  })
})

describe('parseAgentId', () => {
  it('parses name@team format', () => {
    expect(parseAgentId('researcher@analytics-team')).toEqual({ agentName: 'researcher', teamName: 'analytics-team' })
  })
  it('returns null for invalid format', () => {
    expect(parseAgentId('no-at-sign')).toBeNull()
  })
})

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

  it('accepts a team with observerAgent set to a non-member name', () => {
    const team = { ...baseTeam, observerAgent: 'kgc' }
    expect(teamConfigSchema.safeParse(team).success).toBe(true)
  })

  it('preserves observerAgent in parsed output', () => {
    const team = { ...baseTeam, observerAgent: 'kgc' }
    const result = teamConfigSchema.safeParse(team)
    expect(result.success).toBe(true)
    expect((result.data as { observerAgent?: string }).observerAgent).toBe('kgc')
  })
})

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
