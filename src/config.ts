import { homedir } from 'os'
import { join } from 'path'

/**
 * Global configuration for the Conducco framework.
 *
 * All file-based persistence paths are configurable so the framework
 * can run in CI, Docker, or alongside other tools without collision.
 * Defaults mirror the original cc_code paths but under `.conducco/`
 * to avoid conflicts with Claude Code installations.
 */
export interface ConductoConfig {
  /**
   * Root directory for team state files.
   * Each team gets a subdirectory: `{teamsDir}/{teamName}/`
   * Default: `~/.conducco/teams`
   */
  teamsDir: string

  /**
   * Root directory for agent memory files.
   * Default: `~/.conducco/memory`
   */
  memoryBaseDir: string

  /**
   * Default LLM model identifier passed to the AgentRunner.
   * Default: `claude-opus-4-6`
   */
  defaultModel: string

  /**
   * Default maximum conversation turns for agents.
   * Default: 50
   */
  defaultMaxTurns: number

  /**
   * How often in-process teammates poll their mailbox (ms).
   * Default: 500ms
   */
  mailboxPollIntervalMs: number

  /**
   * Maximum messages to keep in UI transcript per teammate.
   * Default: 50
   */
  maxMessageHistory: number
}

export const DEFAULT_CONFIG: ConductoConfig = {
  teamsDir: join(homedir(), '.conducco', 'teams'),
  memoryBaseDir: join(homedir(), '.conducco', 'memory'),
  defaultModel: 'claude-opus-4-6',
  defaultMaxTurns: 50,
  mailboxPollIntervalMs: 500,
  maxMessageHistory: 50,
}

/**
 * Creates a `ConductoConfig` by merging provided overrides with defaults.
 *
 * @example
 * ```ts
 * const config = createConfig({ defaultModel: 'claude-haiku-4-5-20251001' })
 * ```
 */
export function createConfig(overrides: Partial<ConductoConfig> = {}): ConductoConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}
