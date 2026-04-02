import { randomUUID } from 'crypto'

export interface TeammateMessage {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string
}

export interface ShutdownRequest {
  type: 'shutdown_request'
  request_id: string
  reason?: string
}

export interface ShutdownResponse {
  type: 'shutdown_response'
  request_id: string
  approve: boolean
  reason?: string
}

export interface PlanApprovalRequest {
  type: 'plan_approval_request'
  request_id: string
  plan: string
}

export interface PlanApprovalResponse {
  type: 'plan_approval_response'
  request_id: string
  approve: boolean
  feedback?: string
}

export interface PermissionRequest {
  type: 'permission_request'
  request_id: string
  tool: string
  input: unknown
}

export interface PermissionResponse {
  type: 'permission_response'
  request_id: string
  approved: boolean
  reason?: string
}

export type StructuredMessage =
  | ShutdownRequest
  | ShutdownResponse
  | PlanApprovalRequest
  | PlanApprovalResponse
  | PermissionRequest
  | PermissionResponse

export const STRUCTURED_MESSAGE_TYPES = new Set<string>([
  'shutdown_request',
  'shutdown_response',
  'plan_approval_request',
  'plan_approval_response',
  'permission_request',
  'permission_response',
])

export function isStructuredMessage(value: unknown): value is StructuredMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>)['type'] === 'string' &&
    STRUCTURED_MESSAGE_TYPES.has((value as Record<string, unknown>)['type'] as string)
  )
}

export function parseStructuredMessage(text: string): StructuredMessage | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isStructuredMessage(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function createShutdownRequest(opts: { reason?: string } = {}): ShutdownRequest {
  return { type: 'shutdown_request', request_id: randomUUID(), ...opts }
}

export function createShutdownResponse(
  request_id: string,
  approve: boolean,
  reason?: string,
): ShutdownResponse {
  const msg: ShutdownResponse = { type: 'shutdown_response', request_id, approve }
  if (reason !== undefined) msg.reason = reason
  return msg
}

export function createPlanApprovalRequest(plan: string): PlanApprovalRequest {
  return { type: 'plan_approval_request', request_id: randomUUID(), plan }
}

export function createPlanApprovalResponse(
  request_id: string,
  approve: boolean,
  feedback?: string,
): PlanApprovalResponse {
  const msg: PlanApprovalResponse = { type: 'plan_approval_response', request_id, approve }
  if (feedback !== undefined) msg.feedback = feedback
  return msg
}

export function createPermissionRequest(tool: string, input: unknown): PermissionRequest {
  return { type: 'permission_request', request_id: randomUUID(), tool, input }
}

export function createPermissionResponse(
  request_id: string,
  approved: boolean,
  reason?: string,
): PermissionResponse {
  const msg: PermissionResponse = { type: 'permission_response', request_id, approved }
  if (reason !== undefined) msg.reason = reason
  return msg
}
