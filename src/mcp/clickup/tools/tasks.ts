import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClickUpClient } from '../client.js'

// ─── Pure handler functions ────────────────────────────────────────────────────

export async function listTasks(
  client: ClickUpClient,
  list_id: string,
  filters: {
    archived?: boolean
    include_closed?: boolean
    subtasks?: boolean
    page?: number
  },
): Promise<unknown> {
  const params: Record<string, string> = {}
  if (filters.archived !== undefined) params['archived'] = String(filters.archived)
  if (filters.include_closed !== undefined) params['include_closed'] = String(filters.include_closed)
  if (filters.subtasks !== undefined) params['subtasks'] = String(filters.subtasks)
  if (filters.page !== undefined) params['page'] = String(filters.page)
  return client.get(`/list/${list_id}/task`, params)
}

export async function getTask(client: ClickUpClient, task_id: string): Promise<unknown> {
  return client.get(`/task/${task_id}`)
}

export async function createTask(
  client: ClickUpClient,
  list_id: string,
  data: {
    name: string
    description?: string
    status?: string
    priority?: number
    due_date?: number
    assignees?: number[]
    tags?: string[]
  },
): Promise<unknown> {
  return client.post(`/list/${list_id}/task`, data)
}

export async function updateTask(
  client: ClickUpClient,
  task_id: string,
  data: {
    name?: string
    description?: string
    status?: string
    priority?: number
    due_date?: number
  },
): Promise<unknown> {
  return client.put(`/task/${task_id}`, data)
}

export async function deleteTask(client: ClickUpClient, task_id: string): Promise<void> {
  return client.delete(`/task/${task_id}`)
}

// ─── MCP registration ──────────────────────────────────────────────────────────

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function registerTaskTools(server: McpServer, client: ClickUpClient): void {
  server.registerTool('list_tasks', {
    description: 'List tasks in a ClickUp list.',
    inputSchema: z.object({
      list_id: z.string().describe('List ID'),
      archived: z.boolean().optional().default(false),
      include_closed: z.boolean().optional().default(false),
      subtasks: z.boolean().optional().default(false),
      page: z.number().int().optional().default(0),
    }),
  }, async ({ list_id, archived, include_closed, subtasks, page }) =>
    text(await listTasks(client, list_id, { archived, include_closed, subtasks, page })))

  server.registerTool('get_task', {
    description: 'Get a ClickUp task by ID.',
    inputSchema: z.object({
      task_id: z.string().describe('Task ID'),
    }),
  }, async ({ task_id }) => text(await getTask(client, task_id)))

  server.registerTool('create_task', {
    description: 'Create a new task in a ClickUp list.',
    inputSchema: z.object({
      list_id: z.string().describe('List ID to create the task in'),
      name: z.string().describe('Task name'),
      description: z.string().optional().describe('Task description (markdown supported)'),
      status: z.string().optional().describe('Status name (e.g. "in progress")'),
      priority: z.number().int().min(1).max(4).optional().describe('1=urgent 2=high 3=normal 4=low'),
      due_date: z.number().int().optional().describe('Due date as Unix timestamp in milliseconds'),
      assignees: z.array(z.number().int()).optional().describe('Array of user IDs to assign'),
      tags: z.array(z.string()).optional().describe('Array of tag names'),
    }),
  }, async ({ list_id, name, description, status, priority, due_date, assignees, tags }) => {
    const data: { name: string; description?: string; status?: string; priority?: number; due_date?: number; assignees?: number[]; tags?: string[] } = { name }
    if (description !== undefined) data.description = description
    if (status !== undefined) data.status = status
    if (priority !== undefined) data.priority = priority
    if (due_date !== undefined) data.due_date = due_date
    if (assignees !== undefined) data.assignees = assignees
    if (tags !== undefined) data.tags = tags
    return text(await createTask(client, list_id, data))
  })

  server.registerTool('update_task', {
    description: 'Update an existing ClickUp task.',
    inputSchema: z.object({
      task_id: z.string().describe('Task ID to update'),
      name: z.string().optional().describe('New task name'),
      description: z.string().optional().describe('New description'),
      status: z.string().optional().describe('New status name'),
      priority: z.number().int().min(1).max(4).optional().describe('1=urgent 2=high 3=normal 4=low'),
      due_date: z.number().int().optional().describe('New due date as Unix timestamp in milliseconds'),
    }),
  }, async ({ task_id, name, description, status, priority, due_date }) => {
    const data: { name?: string; description?: string; status?: string; priority?: number; due_date?: number } = {}
    if (name !== undefined) data.name = name
    if (description !== undefined) data.description = description
    if (status !== undefined) data.status = status
    if (priority !== undefined) data.priority = priority
    if (due_date !== undefined) data.due_date = due_date
    return text(await updateTask(client, task_id, data))
  })

  server.registerTool('delete_task', {
    description: 'Permanently delete a ClickUp task.',
    inputSchema: z.object({
      task_id: z.string().describe('Task ID to delete'),
    }),
  }, async ({ task_id }) => {
    await deleteTask(client, task_id)
    return text({ deleted: true, task_id })
  })
}
