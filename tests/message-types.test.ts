import { describe, it, expect } from 'vitest'
import {
  createShutdownRequest,
  createShutdownResponse,
  createPlanApprovalRequest,
  createPlanApprovalResponse,
  isStructuredMessage,
  STRUCTURED_MESSAGE_TYPES,
} from '../src/types/message.js'
import { isTerminalStatus } from '../src/types/task.js'

describe('structured messages', () => {
  it('creates a shutdown request with a unique request_id', () => {
    const req = createShutdownRequest({ reason: 'task complete' })
    expect(req.type).toBe('shutdown_request')
    expect(req.reason).toBe('task complete')
    expect(typeof req.request_id).toBe('string')
    expect(req.request_id.length).toBeGreaterThan(0)
  })

  it('creates a shutdown response that references the request', () => {
    const req = createShutdownRequest()
    const res = createShutdownResponse(req.request_id, true, 'done')
    expect(res.type).toBe('shutdown_response')
    expect(res.request_id).toBe(req.request_id)
    expect(res.approve).toBe(true)
    expect(res.reason).toBe('done')
  })

  it('creates plan approval round-trip', () => {
    const req = createPlanApprovalRequest('## Plan\n1. Do X\n2. Do Y')
    const res = createPlanApprovalResponse(req.request_id, false, 'Too risky')
    expect(res.approve).toBe(false)
    expect(res.feedback).toBe('Too risky')
    expect(res.request_id).toBe(req.request_id)
  })

  it('correctly identifies structured messages', () => {
    const req = createShutdownRequest()
    expect(isStructuredMessage(req)).toBe(true)
    expect(isStructuredMessage({ type: 'unknown', foo: 'bar' })).toBe(false)
    expect(isStructuredMessage('plain text')).toBe(false)
  })

  it('STRUCTURED_MESSAGE_TYPES contains expected types', () => {
    expect(STRUCTURED_MESSAGE_TYPES.has('shutdown_request')).toBe(true)
    expect(STRUCTURED_MESSAGE_TYPES.has('plan_approval_request')).toBe(true)
    expect(STRUCTURED_MESSAGE_TYPES.has('permission_request')).toBe(true)
  })
})

describe('task status', () => {
  it('identifies terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('killed')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('pending')).toBe(false)
  })
})
