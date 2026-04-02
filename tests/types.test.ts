import { describe, it, expect } from 'vitest'
import { agentConfigSchema, teamConfigSchema, sanitizeName, formatAgentId, parseAgentId } from '../src/types/agent.js'

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
