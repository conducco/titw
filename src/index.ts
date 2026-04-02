/**
 * conducco-agents — Multi-agent orchestration framework by Conducco
 *
 * A composable, LLM-provider-agnostic framework for building agent teams.
 * Handles team state, file-based messaging, 3-tier memory, and in-process
 * execution isolation. Inject any LLM runner via the AgentRunner type.
 *
 * @example
 * ```ts
 * import { TeamOrchestrator, createConfig } from 'conducco-agents'
 * import type { AgentRunner, TeamConfig } from 'conducco-agents'
 *
 * const runner: AgentRunner = async (params) => { ... }
 * const team: TeamConfig = { name: 'my-team', leadAgentName: 'lead', members: [...] }
 * const orch = new TeamOrchestrator({ team, runner, config: createConfig(), cwd: process.cwd() })
 * await orch.start()
 * await orch.sendMessage('worker', { from: 'lead', text: 'Do the work.' })
 * await orch.stop()
 * ```
 */

// Config
export { createConfig, DEFAULT_CONFIG } from './config.js'
export type { ConductoConfig } from './config.js'

// Types — Agent & Team
export {
  agentConfigSchema, teamConfigSchema, teamAllowedPathSchema,
  sanitizeName, formatAgentId, parseAgentId,
} from './types/agent.js'
export type {
  AgentConfig, TeamConfig, TeamAllowedPath,
  PermissionMode, AgentMemoryScope, AgentMcpServerSpec, ModelSpec,
} from './types/agent.js'

// Types — Messages
export {
  createShutdownRequest, createShutdownResponse,
  createPlanApprovalRequest, createPlanApprovalResponse,
  createPermissionRequest, createPermissionResponse,
  isStructuredMessage, parseStructuredMessage, STRUCTURED_MESSAGE_TYPES,
} from './types/message.js'
export type {
  TeammateMessage, StructuredMessage,
  ShutdownRequest, ShutdownResponse,
  PlanApprovalRequest, PlanApprovalResponse,
  PermissionRequest, PermissionResponse,
} from './types/message.js'

// Types — Tasks
export { isTerminalStatus, generateTaskId } from './types/task.js'
export type {
  TaskStatus, AgentProgress, AgentRunResult,
  BaseTask, AgentTask, TeammateTask, Task,
} from './types/task.js'

// Messaging
export { Mailbox } from './messaging/Mailbox.js'
export type { MailboxOptions, IncomingMessage } from './messaging/Mailbox.js'

// Memory
export { AgentMemory } from './memory/AgentMemory.js'
export type { AgentMemoryOptions } from './memory/AgentMemory.js'

// Backends
export { InProcessBackend } from './backends/InProcessBackend.js'
export type {
  AgentRunner, AgentRunParams,
  TeammateExecutor, TeammateSpawnConfig, TeammateSpawnResult,
} from './backends/types.js'

// Orchestrator
export { AgentLoader } from './orchestrator/AgentLoader.js'
export { TeamOrchestrator } from './orchestrator/TeamOrchestrator.js'
export type { TeamOrchestratorOptions } from './orchestrator/TeamOrchestrator.js'
export { PermissionBridge } from './orchestrator/PermissionBridge.js'
export type {
  ApprovalRequest, ApprovalResult, LeaderApprovalHandler, GrantedPath,
} from './orchestrator/PermissionBridge.js'

// Patterns
export {
  buildCacheablePrefix, isForkBoilerplatePresent, injectForkBoilerplate,
  FORK_BOILERPLATE_MARKER,
} from './patterns/cacheSharing.js'
export type { CacheablePrefix, ConversationMessage } from './patterns/cacheSharing.js'

export { ShutdownNegotiator, SHUTDOWN_TIMEOUT_MS } from './patterns/shutdown.js'
export type { ShutdownNegotiatorOptions, ShutdownResult } from './patterns/shutdown.js'
