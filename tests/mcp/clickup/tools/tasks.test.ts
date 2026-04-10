import { describe, it, expect, vi } from 'vitest'
import type { ClickUpClient } from '../../../../src/mcp/clickup/client.js'
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  addTag,
  removeTag,
} from '../../../../src/mcp/clickup/tools/tasks.js'

function mockClient(overrides: Partial<ClickUpClient> = {}): ClickUpClient {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    postEmpty: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ClickUpClient
}

describe('task tools', () => {
  it('listTasks calls GET /list/:id/task', async () => {
    const client = mockClient()
    const result = await listTasks(client, 'list1', {})
    expect(client.get).toHaveBeenCalledWith('/list/list1/task', expect.any(Object))
    expect(result).toEqual({})
  })

  it('listTasks passes include_closed param', async () => {
    const client = mockClient()
    await listTasks(client, 'list1', { include_closed: true })
    expect(client.get).toHaveBeenCalledWith(
      '/list/list1/task',
      expect.objectContaining({ include_closed: 'true' }),
    )
  })

  it('getTask calls GET /task/:id', async () => {
    const client = mockClient({ get: vi.fn().mockResolvedValue({ id: 'task1' }) })
    const result = await getTask(client, 'task1')
    expect(client.get).toHaveBeenCalledWith('/task/task1')
    expect(result).toEqual({ id: 'task1' })
  })

  it('createTask calls POST /list/:id/task', async () => {
    const client = mockClient({ post: vi.fn().mockResolvedValue({ id: 'new1' }) })
    const result = await createTask(client, 'list1', { name: 'New task' })
    expect(client.post).toHaveBeenCalledWith('/list/list1/task', { name: 'New task' })
    expect(result).toEqual({ id: 'new1' })
  })

  it('updateTask calls PUT /task/:id', async () => {
    const client = mockClient({ put: vi.fn().mockResolvedValue({ id: 'task1', status: 'in progress' }) })
    const result = await updateTask(client, 'task1', { status: 'in progress' })
    expect(client.put).toHaveBeenCalledWith('/task/task1', { status: 'in progress' })
    expect(result).toEqual({ id: 'task1', status: 'in progress' })
  })

  it('deleteTask calls DELETE /task/:id', async () => {
    const client = mockClient()
    const result = await deleteTask(client, 'task1')
    expect(client.delete).toHaveBeenCalledWith('/task/task1')
    expect(result).toBeUndefined()
  })

  it('addTag calls POST /task/:id/tag/:name with no body', async () => {
    const client = mockClient()
    const result = await addTag(client, 'task1', 'ready')
    expect(client.postEmpty).toHaveBeenCalledWith('/task/task1/tag/ready')
    expect(result).toBeUndefined()
  })

  it('removeTag calls DELETE /task/:id/tag/:name', async () => {
    const client = mockClient()
    const result = await removeTag(client, 'task1', 'ready')
    expect(client.delete).toHaveBeenCalledWith('/task/task1/tag/ready')
    expect(result).toBeUndefined()
  })
})
