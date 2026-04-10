import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClickUpClient } from '../client.js'

// ─── Pure handler functions ────────────────────────────────────────────────────

export async function listComments(client: ClickUpClient, task_id: string): Promise<unknown> {
  return client.get(`/task/${task_id}/comment`)
}

export async function createComment(
  client: ClickUpClient,
  task_id: string,
  data: { comment_text: string; assignee?: number; notify_all?: boolean },
): Promise<unknown> {
  return client.post(`/task/${task_id}/comment`, data)
}

export async function updateComment(
  client: ClickUpClient,
  comment_id: number,
  data: { comment_text: string; resolved?: boolean },
): Promise<unknown> {
  return client.put(`/comment/${comment_id}`, data)
}

export async function deleteComment(client: ClickUpClient, comment_id: number): Promise<void> {
  return client.delete(`/comment/${comment_id}`)
}

// ─── MCP registration ──────────────────────────────────────────────────────────

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function registerCommentTools(server: McpServer, client: ClickUpClient): void {
  server.registerTool('list_comments', {
    description: 'List all comments on a ClickUp task.',
    inputSchema: z.object({
      task_id: z.string().describe('Task ID'),
    }),
  }, async ({ task_id }) => text(await listComments(client, task_id)))

  server.registerTool('create_comment', {
    description: 'Add a comment to a ClickUp task.',
    inputSchema: z.object({
      task_id: z.string().describe('Task ID'),
      comment_text: z.string().describe('Comment text (markdown supported)'),
      assignee: z.number().int().optional().describe('User ID to assign the comment to'),
      notify_all: z.boolean().optional().default(false).describe('Notify all assignees'),
    }),
  }, async ({ task_id, comment_text, assignee, notify_all }) => {
    const data: { comment_text: string; assignee?: number; notify_all?: boolean } = { comment_text }
    if (assignee !== undefined) data.assignee = assignee
    if (notify_all !== undefined) data.notify_all = notify_all
    return text(await createComment(client, task_id, data))
  })

  server.registerTool('update_comment', {
    description: 'Update an existing ClickUp comment.',
    inputSchema: z.object({
      comment_id: z.number().int().describe('Comment ID'),
      comment_text: z.string().describe('New comment text'),
      resolved: z.boolean().optional().describe('Mark the comment as resolved/unresolved'),
    }),
  }, async ({ comment_id, comment_text, resolved }) => {
    const data: { comment_text: string; resolved?: boolean } = { comment_text }
    if (resolved !== undefined) data.resolved = resolved
    return text(await updateComment(client, comment_id, data))
  })

  server.registerTool('delete_comment', {
    description: 'Delete a ClickUp comment.',
    inputSchema: z.object({
      comment_id: z.number().int().describe('Comment ID'),
    }),
  }, async ({ comment_id }) => {
    await deleteComment(client, comment_id)
    return text({ deleted: true, comment_id })
  })
}
