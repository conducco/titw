import { describe, it, expect } from 'vitest'
import { createConfig, DEFAULT_CONFIG } from '../src/config.js'

describe('createConfig', () => {
  it('returns defaults when called with no arguments', () => {
    const cfg = createConfig()
    expect(cfg.teamsDir).toContain('.conducco/teams')
    expect(cfg.memoryBaseDir).toContain('.conducco/memory')
    expect(cfg.defaultModel).toBe('claude-opus-4-6')
    expect(cfg.defaultMaxTurns).toBe(50)
    expect(cfg.mailboxPollIntervalMs).toBe(500)
  })

  it('merges overrides with defaults', () => {
    const cfg = createConfig({ defaultModel: 'claude-haiku-4-5-20251001' })
    expect(cfg.defaultModel).toBe('claude-haiku-4-5-20251001')
    expect(cfg.defaultMaxTurns).toBe(50)
  })

  it('allows fully custom paths', () => {
    const cfg = createConfig({ teamsDir: '/tmp/my-teams', memoryBaseDir: '/tmp/my-memory' })
    expect(cfg.teamsDir).toBe('/tmp/my-teams')
    expect(cfg.memoryBaseDir).toBe('/tmp/my-memory')
  })
})
