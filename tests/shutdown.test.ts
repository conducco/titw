import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Mailbox } from '../src/messaging/Mailbox.js'
import { ShutdownNegotiator, SHUTDOWN_TIMEOUT_MS } from '../src/patterns/shutdown.js'

let tempDir: string
let mailbox: Mailbox

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'conducco-test-'))
  mailbox = new Mailbox({ teamsDir: tempDir, teamName: 'test-team' })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('ShutdownNegotiator', () => {
  it('SHUTDOWN_TIMEOUT_MS is a positive number', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('writes a shutdown_request to the target inbox', async () => {
    const negotiator = new ShutdownNegotiator({ mailbox, pollIntervalMs: 10, timeoutMs: 100 })
    // Do not respond — let it time out
    await negotiator.requestShutdown({ fromAgent: 'leader', toAgent: 'worker', reason: 'done' })

    const workerMail = await mailbox.readAll('worker')
    expect(workerMail.length).toBeGreaterThan(0)
    const parsed = JSON.parse(workerMail[0]!.text) as { type: string; reason: string }
    expect(parsed.type).toBe('shutdown_request')
    expect(parsed.reason).toBe('done')
  })

  it('times out with approved=false when no response', async () => {
    const negotiator = new ShutdownNegotiator({ mailbox, pollIntervalMs: 10, timeoutMs: 100 })
    const result = await negotiator.requestShutdown({ fromAgent: 'leader', toAgent: 'worker' })
    expect(result.approved).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  it('resolves with approved=true when worker responds via respondToShutdown', async () => {
    const negotiator = new ShutdownNegotiator({ mailbox, pollIntervalMs: 10, timeoutMs: 2000 })

    // Start request and response concurrently
    const [result] = await Promise.all([
      negotiator.requestShutdown({ fromAgent: 'leader', toAgent: 'worker' }),
      // Simulate worker: read the request, respond after a short delay
      (async () => {
        await new Promise(r => setTimeout(r, 30))
        const workerMail = await mailbox.readAll('worker')
        const msg = workerMail[0]
        if (msg) {
          const parsed = JSON.parse(msg.text) as { request_id: string }
          await negotiator.respondToShutdown({
            fromAgent: 'worker',
            toAgent: 'leader',
            requestId: parsed.request_id,
            approve: true,
            reason: 'all done',
          })
        }
      })(),
    ])
    expect(result.approved).toBe(true)
    expect(result.timedOut).toBeUndefined()
  })
})
