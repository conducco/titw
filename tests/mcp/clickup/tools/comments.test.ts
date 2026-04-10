import { describe, it, expect, vi } from 'vitest'
import type { ClickUpClient } from '../../../../src/mcp/clickup/client.js'
import {
  listComments,
  createComment,
  updateComment,
  deleteComment,
} from '../../../../src/mcp/clickup/tools/comments.js'

function mockClient(overrides: Partial<ClickUpClient> = {}): ClickUpClient {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ClickUpClient
}

describe('comment tools', () => {
  it('listComments calls GET /task/:id/comment', async () => {
    const client = mockClient({ get: vi.fn().mockResolvedValue({ comments: [] }) })
    const result = await listComments(client, 'task1')
    expect(client.get).toHaveBeenCalledWith('/task/task1/comment')
    expect(result).toEqual({ comments: [] })
  })

  it('createComment calls POST /task/:id/comment', async () => {
    const client = mockClient({ post: vi.fn().mockResolvedValue({ id: 'c1' }) })
    const result = await createComment(client, 'task1', { comment_text: 'hello', notify_all: true })
    expect(client.post).toHaveBeenCalledWith('/task/task1/comment', {
      comment_text: 'hello',
      notify_all: true,
    })
    expect(result).toEqual({ id: 'c1' })
  })

  it('updateComment calls PUT /comment/:id', async () => {
    const client = mockClient({ put: vi.fn().mockResolvedValue({ id: 123 }) })
    const result = await updateComment(client, 123, { comment_text: 'updated', resolved: false })
    expect(client.put).toHaveBeenCalledWith('/comment/123', {
      comment_text: 'updated',
      resolved: false,
    })
    expect(result).toEqual({ id: 123 })
  })

  it('deleteComment calls DELETE /comment/:id', async () => {
    const client = mockClient()
    const result = await deleteComment(client, 123)
    expect(client.delete).toHaveBeenCalledWith('/comment/123')
    expect(result).toBeUndefined()
  })
})
