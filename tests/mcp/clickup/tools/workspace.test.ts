import { describe, it, expect, vi } from 'vitest'
import type { ClickUpClient } from '../../../../src/mcp/clickup/client.js'
import {
  listWorkspaces,
  listSpaces,
  listFolders,
  listLists,
} from '../../../../src/mcp/clickup/tools/workspace.js'

function mockClient(result: unknown): ClickUpClient {
  return { get: vi.fn().mockResolvedValue(result) } as unknown as ClickUpClient
}

describe('workspace tools', () => {
  it('listWorkspaces calls GET /team', async () => {
    const client = mockClient({ teams: [{ id: '1', name: 'Conducco' }] })
    const result = await listWorkspaces(client)
    expect(client.get).toHaveBeenCalledWith('/team')
    expect(result).toEqual({ teams: [{ id: '1', name: 'Conducco' }] })
  })

  it('listSpaces calls GET /team/:id/space', async () => {
    const client = mockClient({ spaces: [] })
    await listSpaces(client, 'team1', false)
    expect(client.get).toHaveBeenCalledWith('/team/team1/space', { archived: 'false' })
  })

  it('listFolders calls GET /space/:id/folder', async () => {
    const client = mockClient({ folders: [] })
    await listFolders(client, 'space1', false)
    expect(client.get).toHaveBeenCalledWith('/space/space1/folder', { archived: 'false' })
  })

  it('listLists with folder_id calls GET /folder/:id/list', async () => {
    const client = mockClient({ lists: [] })
    await listLists(client, { folder_id: 'folder1', archived: false })
    expect(client.get).toHaveBeenCalledWith('/folder/folder1/list', { archived: 'false' })
  })

  it('listLists with space_id calls GET /space/:id/list (folderless)', async () => {
    const client = mockClient({ lists: [] })
    await listLists(client, { space_id: 'space1', archived: false })
    expect(client.get).toHaveBeenCalledWith('/space/space1/list', { archived: 'false' })
  })
})
