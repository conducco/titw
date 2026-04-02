import type { Mailbox } from '../messaging/Mailbox.js'
import { createShutdownRequest, createShutdownResponse, parseStructuredMessage } from '../types/message.js'

export const SHUTDOWN_TIMEOUT_MS = 5_000

export interface ShutdownNegotiatorOptions {
  mailbox: Mailbox
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface ShutdownResult {
  approved: boolean
  timedOut?: boolean
  reason?: string
}

/**
 * Graceful shutdown negotiation protocol via the mailbox.
 *
 * Protocol:
 * 1. Leader sends shutdown_request to worker's inbox
 * 2. Worker sends shutdown_response back to leader's inbox
 * 3. Leader polls its own inbox until it gets the matching response or times out
 *
 * Extracted from cc_code's structured message shutdown pattern.
 */
export class ShutdownNegotiator {
  private readonly mailbox: Mailbox
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(options: ShutdownNegotiatorOptions) {
    this.mailbox = options.mailbox
    this.pollIntervalMs = options.pollIntervalMs ?? 200
    this.timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  }

  async requestShutdown(opts: {
    fromAgent: string
    toAgent: string
    reason?: string
  }): Promise<ShutdownResult> {
    const request = createShutdownRequest(opts.reason !== undefined ? { reason: opts.reason } : {})

    await this.mailbox.write(opts.toAgent, {
      from: opts.fromAgent,
      text: JSON.stringify(request),
      summary: 'shutdown request',
    })

    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      const messages = await this.mailbox.readAll(opts.fromAgent)
      for (const msg of messages) {
        const parsed = parseStructuredMessage(msg.text)
        if (parsed?.type === 'shutdown_response' && parsed.request_id === request.request_id) {
          await this.mailbox.markAllRead(opts.fromAgent)
          const result: ShutdownResult = { approved: parsed.approve }
          if (parsed.reason !== undefined) result.reason = parsed.reason
          return result
        }
      }
      await sleep(this.pollIntervalMs)
    }

    return { approved: false, timedOut: true }
  }

  async respondToShutdown(opts: {
    fromAgent: string
    toAgent: string
    requestId: string
    approve: boolean
    reason?: string
  }): Promise<void> {
    const response = createShutdownResponse(opts.requestId, opts.approve, opts.reason)
    await this.mailbox.write(opts.toAgent, {
      from: opts.fromAgent,
      text: JSON.stringify(response),
      summary: opts.approve ? 'shutdown approved' : 'shutdown rejected',
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
