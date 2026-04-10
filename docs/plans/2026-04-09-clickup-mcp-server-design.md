# ClickUp MCP Server Design

**Date:** 2026-04-09
**Status:** Approved

## Overview

A built-in ClickUp MCP server shipped as part of `@conducco/titw` at the export path `@conducco/titw/mcp-clickup`. It runs as a stdio MCP server, wraps the ClickUp REST API, and authenticates via `CLICKUP_API_TOKEN` env var — no OAuth, no browser interaction, suitable for production/headless environments.

## Package Integration

New export in `conducco-agents/package.json`:
```json
"./mcp-clickup": {
  "import": "./dist/mcp/clickup/index.js",
  "types": "./dist/mcp/clickup/index.d.ts"
}
```

No new peer dependencies — `@modelcontextprotocol/sdk` is already a direct dependency.

Invocation in a `TeamConfig`:
```ts
{
  type: 'stdio',
  command: 'node',
  args: ['node_modules/@conducco/titw/dist/mcp/clickup/index.js'],
  env: { CLICKUP_API_TOKEN: process.env['CLICKUP_API_TOKEN'] ?? '' },
  required: false,
}
```

## File Structure

```
src/mcp/clickup/
  index.ts          ← stdio server entry point
  client.ts         ← ClickUp REST client (fetch + auth)
  tools/
    workspace.ts    ← list_spaces, list_folders, list_lists
    tasks.ts        ← list_tasks, get_task, create_task, update_task, delete_task
    comments.ts     ← list_comments, create_comment, update_comment, delete_comment
    attachments.ts  ← create_attachment

tests/mcp/clickup/
  client.test.ts
  tools/
    workspace.test.ts
    tasks.test.ts
    comments.test.ts
```

## ClickUp REST Client (`client.ts`)

Thin fetch wrapper with token injection. No external HTTP library.

```ts
export class ClickUpClient {
  private readonly baseUrl = 'https://api.clickup.com/api/v2'
  private readonly token: string

  constructor(token: string) { this.token = token }

  async get<T>(path: string, params?: Record<string, string>): Promise<T>
  async post<T>(path: string, body: unknown): Promise<T>
  async put<T>(path: string, body: unknown): Promise<T>
  async delete(path: string): Promise<void>
}
```

**Auth header**: `Authorization: <token>` (ClickUp personal token format — no "Bearer" prefix).

**Error handling**: non-2xx responses throw `ClickUpError` with `{ status, message, code }` extracted from ClickUp's error body. Tool handlers catch these and return MCP error results instead of crashing the server.

**Startup guard**: `index.ts` checks `CLICKUP_API_TOKEN` at startup — exits with code 1 and a clear stderr message if missing.

## Tools

### `workspace.ts`
| Tool | Method | Endpoint |
|---|---|---|
| `list_spaces` | GET | `/team/{team_id}/space` |
| `list_folders` | GET | `/space/{space_id}/folder` |
| `list_lists` | GET | `/folder/{folder_id}/list` + `/space/{space_id}/list` |

### `tasks.ts`
| Tool | Method | Endpoint |
|---|---|---|
| `list_tasks` | GET | `/list/{list_id}/task` |
| `get_task` | GET | `/task/{task_id}` |
| `create_task` | POST | `/list/{list_id}/task` |
| `update_task` | PUT | `/task/{task_id}` |
| `delete_task` | DELETE | `/task/{task_id}` |

### `comments.ts`
| Tool | Method | Endpoint |
|---|---|---|
| `list_comments` | GET | `/task/{task_id}/comment` |
| `create_comment` | POST | `/task/{task_id}/comment` |
| `update_comment` | PUT | `/comment/{comment_id}` |
| `delete_comment` | DELETE | `/comment/{comment_id}` |

### `attachments.ts`
| Tool | Method | Endpoint |
|---|---|---|
| `create_attachment` | POST | `/task/{task_id}/attachment` (multipart/form-data, base64 content input) |

## Server Entry Point (`index.ts`)

1. Read `CLICKUP_API_TOKEN` — exit 1 with clear message if missing
2. Create `ClickUpClient(token)`
3. Merge all tool arrays from the 4 modules
4. Create `McpServer({ name: 'clickup', version: '1.0.0' })`
5. Register each tool via `server.tool(name, description, schema, handler)`
6. Connect `StdioServerTransport` and start

Uses `McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk/server` — the high-level API that handles the MCP protocol loop automatically.

## Testing

Unit tests mock `fetch` globally via `vi.stubGlobal`. No real HTTP calls.

| File | Covers |
|---|---|
| `client.test.ts` | fetch calls, correct auth header, `ClickUpError` on non-2xx |
| `tools/tasks.test.ts` | correct endpoint, input mapping, error passthrough |
| `tools/comments.test.ts` | same pattern |
| `tools/workspace.test.ts` | same pattern |

Attachments module is tested via manual/integration test only — multipart form-data mocking is brittle.
