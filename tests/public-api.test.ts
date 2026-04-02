import { describe, it, expect } from 'vitest'
import {
  createConfig, DEFAULT_CONFIG,
  agentConfigSchema, teamConfigSchema, teamAllowedPathSchema,
  sanitizeName, formatAgentId, parseAgentId,
  createShutdownRequest, createShutdownResponse,
  createPlanApprovalRequest, createPlanApprovalResponse,
  createPermissionRequest, createPermissionResponse,
  isStructuredMessage, parseStructuredMessage, STRUCTURED_MESSAGE_TYPES,
  isTerminalStatus, generateTaskId,
  Mailbox,
  AgentMemory,
  InProcessBackend,
  AgentLoader,
  TeamOrchestrator,
  PermissionBridge,
  buildCacheablePrefix, isForkBoilerplatePresent, injectForkBoilerplate, FORK_BOILERPLATE_MARKER,
  ShutdownNegotiator, SHUTDOWN_TIMEOUT_MS,
} from '../src/index.js'

describe('public API surface', () => {
  it('exports createConfig', () => expect(typeof createConfig).toBe('function'))
  it('exports DEFAULT_CONFIG', () => expect(DEFAULT_CONFIG).toBeDefined())
  it('exports agentConfigSchema', () => expect(agentConfigSchema).toBeDefined())
  it('exports teamConfigSchema', () => expect(teamConfigSchema).toBeDefined())
  it('exports teamAllowedPathSchema', () => expect(teamAllowedPathSchema).toBeDefined())
  it('exports sanitizeName', () => expect(typeof sanitizeName).toBe('function'))
  it('exports formatAgentId', () => expect(typeof formatAgentId).toBe('function'))
  it('exports parseAgentId', () => expect(typeof parseAgentId).toBe('function'))
  it('exports createShutdownRequest', () => expect(typeof createShutdownRequest).toBe('function'))
  it('exports createShutdownResponse', () => expect(typeof createShutdownResponse).toBe('function'))
  it('exports createPlanApprovalRequest', () => expect(typeof createPlanApprovalRequest).toBe('function'))
  it('exports createPlanApprovalResponse', () => expect(typeof createPlanApprovalResponse).toBe('function'))
  it('exports createPermissionRequest', () => expect(typeof createPermissionRequest).toBe('function'))
  it('exports createPermissionResponse', () => expect(typeof createPermissionResponse).toBe('function'))
  it('exports isStructuredMessage', () => expect(typeof isStructuredMessage).toBe('function'))
  it('exports parseStructuredMessage', () => expect(typeof parseStructuredMessage).toBe('function'))
  it('exports STRUCTURED_MESSAGE_TYPES', () => expect(STRUCTURED_MESSAGE_TYPES).toBeDefined())
  it('exports isTerminalStatus', () => expect(typeof isTerminalStatus).toBe('function'))
  it('exports generateTaskId', () => expect(typeof generateTaskId).toBe('function'))
  it('exports Mailbox class', () => expect(Mailbox).toBeDefined())
  it('exports AgentMemory class', () => expect(AgentMemory).toBeDefined())
  it('exports InProcessBackend class', () => expect(InProcessBackend).toBeDefined())
  it('exports AgentLoader class', () => expect(AgentLoader).toBeDefined())
  it('exports TeamOrchestrator class', () => expect(TeamOrchestrator).toBeDefined())
  it('exports PermissionBridge class', () => expect(PermissionBridge).toBeDefined())
  it('exports buildCacheablePrefix', () => expect(typeof buildCacheablePrefix).toBe('function'))
  it('exports isForkBoilerplatePresent', () => expect(typeof isForkBoilerplatePresent).toBe('function'))
  it('exports injectForkBoilerplate', () => expect(typeof injectForkBoilerplate).toBe('function'))
  it('exports FORK_BOILERPLATE_MARKER', () => expect(typeof FORK_BOILERPLATE_MARKER).toBe('string'))
  it('exports ShutdownNegotiator class', () => expect(ShutdownNegotiator).toBeDefined())
  it('exports SHUTDOWN_TIMEOUT_MS', () => expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0))
})
