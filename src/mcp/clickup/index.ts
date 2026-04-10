#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ClickUpClient } from './client.js'
import { registerWorkspaceTools } from './tools/workspace.js'
import { registerTaskTools } from './tools/tasks.js'
import { registerCommentTools } from './tools/comments.js'
import { registerAttachmentTools } from './tools/attachments.js'

const token = process.env['CLICKUP_API_TOKEN']
if (!token) {
  process.stderr.write(
    'Error: CLICKUP_API_TOKEN environment variable is not set.\n' +
    'Get your personal API token from: ClickUp Settings → Apps → API Token\n',
  )
  process.exit(1)
}

const client = new ClickUpClient(token)
const server = new McpServer({ name: 'clickup', version: '1.0.0' })

registerWorkspaceTools(server, client)
registerTaskTools(server, client)
registerCommentTools(server, client)
registerAttachmentTools(server, client)

const transport = new StdioServerTransport()
await server.connect(transport)
