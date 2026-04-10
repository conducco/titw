import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClickUpClient, ClickUpError } from '../../../src/mcp/clickup/client.js'

const mockFetch = vi.fn()

beforeEach(() => { vi.stubGlobal('fetch', mockFetch) })
afterEach(() => { vi.unstubAllGlobals() })

function okJson(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
}

function errJson(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

describe('ClickUpClient', () => {
  const client = new ClickUpClient('pk_test_token')

  it('sets Authorization header on GET', async () => {
    mockFetch.mockReturnValueOnce(okJson({ id: '1' }))
    await client.get('/task/1')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/task/1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'pk_test_token' }),
      }),
    )
  })

  it('appends query params on GET', async () => {
    mockFetch.mockReturnValueOnce(okJson([]))
    await client.get('/list/1/task', { archived: 'false', page: '0' })
    const url = mockFetch.mock.calls[0]?.[0] as string
    expect(url).toContain('archived=false')
    expect(url).toContain('page=0')
  })

  it('sends JSON body on POST', async () => {
    mockFetch.mockReturnValueOnce(okJson({ id: '2' }))
    await client.post('/list/1/task', { name: 'Test' })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/list/1/task',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Test' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
  })

  it('sends JSON body on PUT', async () => {
    mockFetch.mockReturnValueOnce(okJson({ id: '1' }))
    await client.put('/task/1', { status: 'done' })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/task/1',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('resolves void on DELETE 204', async () => {
    mockFetch.mockReturnValueOnce(Promise.resolve(new Response(null, { status: 204 })))
    await expect(client.delete('/task/1')).resolves.toBeUndefined()
  })

  it('throws ClickUpError on non-2xx', async () => {
    mockFetch.mockReturnValueOnce(errJson(404, { err: 'Task not found', ECODE: 'ITEM_404' }))
    await expect(client.get('/task/bad')).rejects.toBeInstanceOf(ClickUpError)
  })

  it('ClickUpError carries status and message', async () => {
    mockFetch.mockReturnValueOnce(errJson(401, { err: 'Token invalid', ECODE: 'OAUTH_014' }))
    try {
      await client.get('/task/1')
    } catch (e) {
      expect(e).toBeInstanceOf(ClickUpError)
      const err = e as ClickUpError
      expect(err.status).toBe(401)
      expect(err.message).toContain('Token invalid')
    }
  })
})
