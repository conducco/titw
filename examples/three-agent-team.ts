/**
 * Three-Agent Team Example
 *
 * Demonstrates a 3-agent team (Lead + Researcher + Coder) using conducco-agents.
 * The Anthropic SDK is wired as the AgentRunner.
 *
 * This is a reference implementation — it shows how to:
 * 1. Define a TeamConfig declaratively
 * 2. Implement an AgentRunner with the Anthropic SDK
 * 3. Start the team and send the initial task
 * 4. Read results from the mailbox
 *
 * Run (requires ANTHROPIC_API_KEY env var):
 *   npx tsx examples/three-agent-team.ts
 */

import type { AgentRunner, AgentRunParams, TeamConfig } from '../src/index.js'
import { TeamOrchestrator, createConfig, Mailbox } from '../src/index.js'

// ─── Team Definition ──────────────────────────────────────────────────────────

const team: TeamConfig = {
  name: 'problem-solver',
  description: 'Researches a topic then implements a code solution',
  leadAgentName: 'lead',
  defaultModel: 'claude-opus-4-6',
  members: [
    {
      name: 'lead',
      systemPrompt: `You are the team lead. Coordinate the team:
1. Delegate research tasks to the 'researcher' agent using SendMessage
2. Once research is complete, delegate implementation to the 'coder' agent
3. Review the final result and summarize for the user
Do not do research or coding yourself.`,
      tools: ['*'],
      memory: 'project',
    },
    {
      name: 'researcher',
      systemPrompt: `You are a researcher. Receive tasks from the lead, research thoroughly,
and send your findings back to 'lead'. Focus on implementation-relevant facts.`,
      model: 'claude-haiku-4-5-20251001',
      tools: ['Read'],
      permissionMode: 'bubble',
      memory: 'project',
      maxTurns: 15,
    },
    {
      name: 'coder',
      systemPrompt: `You are a software engineer. Receive tasks and research findings from the lead,
write clean TypeScript code, and send the completed code back to 'lead'.
Include type annotations and brief comments for non-obvious logic.`,
      tools: ['Read', 'Edit', 'Write'],
      permissionMode: 'plan',
      planModeRequired: true,
      maxTurns: 25,
    },
  ],
}

// ─── AgentRunner: Anthropic SDK ────────────────────────────────────────────────

/**
 * Creates an AgentRunner using the Anthropic SDK.
 *
 * This is a minimal implementation — a production runner would add:
 * - Tool use / function calling
 * - Streaming support
 * - Retry logic with exponential backoff
 * - Token budget management
 */
function createAnthropicRunner(): AgentRunner {
  // Dynamic import to keep the framework itself free of Anthropic dependency
  return async (params: AgentRunParams) => {
    let Anthropic: typeof import('@anthropic-ai/sdk').default
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Anthropic = (await import('@anthropic-ai/sdk')).default
    } catch {
      throw new Error(
        'Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk\n' +
        'This example requires the Anthropic SDK as a runtime dependency.',
      )
    }

    const client = new Anthropic()
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: params.prompt },
    ]

    let tokenCount = 0
    let lastOutput = ''
    let turns = 0

    while (turns < params.maxTurns && !params.abortSignal.aborted) {
      turns++

      // Inject mailbox messages as user turns
      const mailMessages = await params.readMailbox()
      for (const msg of mailMessages) {
        messages.push({ role: 'user', content: `[From ${msg.from}]: ${msg.text}` })
      }

      const response = await client.messages.create({
        model: params.model,
        max_tokens: 4096,
        system: params.systemPrompt,
        messages,
      })

      tokenCount += response.usage.input_tokens + response.usage.output_tokens

      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      messages.push({ role: 'assistant', content: text })
      lastOutput = text

      params.onProgress?.({ toolUseCount: 0, tokenCount, lastActivity: `Turn ${turns}` })

      if (response.stop_reason === 'end_turn') break
    }

    return {
      output: lastOutput,
      toolUseCount: 0,
      tokenCount,
      stopReason: params.abortSignal.aborted ? 'aborted' : 'complete',
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const config = createConfig({
    teamsDir: `${process.cwd()}/.conducco/teams`,
    memoryBaseDir: `${process.cwd()}/.conducco/memory`,
  })

  const runner = createAnthropicRunner()

  console.log('Starting three-agent team...')
  const orch = new TeamOrchestrator({ team, runner, config, cwd: process.cwd() })
  await orch.start()
  console.log(`Team "${orch.teamName}" running with members: ${orch.memberNames.join(', ')}\n`)

  const task = `
Research the best practices for implementing a retry mechanism with exponential backoff
in TypeScript, then write a production-ready implementation with:
- Configurable max retries and base delay
- Jitter to prevent thundering herd
- TypeScript generics (works with any async function)
`

  console.log('Sending task to lead agent...')
  await orch.sendMessage('lead', {
    from: 'user',
    text: task,
    summary: 'implement exponential backoff retry',
  })

  // Wait for agents to process (30 seconds for demonstration)
  console.log('Agents working... (waiting 30s)')
  await new Promise(resolve => setTimeout(resolve, 30_000))

  // Read what messages the lead received from workers
  const mailbox = new Mailbox({
    teamsDir: config.teamsDir,
    teamName: 'problem-solver',
  })
  const leadMessages = await mailbox.readAll('lead')
  if (leadMessages.length > 0) {
    console.log('\n--- Lead received ---')
    for (const msg of leadMessages) {
      console.log(`[${msg.from}] ${msg.summary ?? msg.text.slice(0, 120)}`)
    }
  }

  await orch.stop()
  console.log('\nTeam stopped.')
}

main().catch(console.error)
