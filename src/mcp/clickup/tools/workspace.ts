import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClickUpClient } from '../client.js'

// ─── Pure handler functions (testable) ────────────────────────────────────────

export async function listWorkspaces(client: ClickUpClient): Promise<unknown> {
  return client.get('/team')
}

export async function listSpaces(
  client: ClickUpClient,
  team_id: string,
  archived: boolean,
): Promise<unknown> {
  return client.get(`/team/${team_id}/space`, { archived: String(archived) })
}

export async function listFolders(
  client: ClickUpClient,
  space_id: string,
  archived: boolean,
): Promise<unknown> {
  return client.get(`/space/${space_id}/folder`, { archived: String(archived) })
}

export async function listLists(
  client: ClickUpClient,
  input: { folder_id?: string; space_id?: string; archived: boolean },
): Promise<unknown> {
  const { folder_id, space_id, archived } = input
  if (folder_id) {
    return client.get(`/folder/${folder_id}/list`, { archived: String(archived) })
  }
  if (space_id) {
    return client.get(`/space/${space_id}/list`, { archived: String(archived) })
  }
  throw new Error('Either folder_id or space_id is required')
}

// ─── MCP registration ──────────────────────────────────────────────────────────

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function registerWorkspaceTools(server: McpServer, client: ClickUpClient): void {
  server.registerTool('list_workspaces', {
    description: 'List all ClickUp workspaces (teams) accessible with the current token.',
    inputSchema: z.object({}),
  }, async () => text(await listWorkspaces(client)))

  server.registerTool('list_spaces', {
    description: 'List spaces in a ClickUp workspace.',
    inputSchema: z.object({
      team_id: z.string().describe('Workspace (team) ID'),
      archived: z.boolean().optional().default(false).describe('Include archived spaces'),
    }),
  }, async ({ team_id, archived }) => text(await listSpaces(client, team_id, archived)))

  server.registerTool('list_folders', {
    description: 'List folders in a ClickUp space.',
    inputSchema: z.object({
      space_id: z.string().describe('Space ID'),
      archived: z.boolean().optional().default(false).describe('Include archived folders'),
    }),
  }, async ({ space_id, archived }) => text(await listFolders(client, space_id, archived)))

  server.registerTool('list_lists', {
    description: 'List lists inside a folder (pass folder_id) or folderless lists in a space (pass space_id).',
    inputSchema: z.object({
      folder_id: z.string().optional().describe('Folder ID (mutually exclusive with space_id)'),
      space_id: z.string().optional().describe('Space ID for folderless lists (mutually exclusive with folder_id)'),
      archived: z.boolean().optional().default(false).describe('Include archived lists'),
    }),
  }, async (input) => text(await listLists(client, {
    folder_id: input.folder_id,
    space_id: input.space_id,
    archived: input.archived,
  })))
}
