import { appendFile, mkdir, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { AgentMemoryScope } from '../types/agent.js'
import type { IMemoryProvider, Triple } from '../types/provider.js'

export class ObsidianProvider implements IMemoryProvider {
  constructor(private vaultDir: string) {}

  async write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void> {
    const scopeDir = join(this.vaultDir, scope)
    await mkdir(scopeDir, { recursive: true })

    // group triples by subject
    const bySubject = new Map<string, Triple[]>()
    for (const t of triples) {
      const group = bySubject.get(t.subject) ?? []
      group.push(t)
      bySubject.set(t.subject, group)
    }

    for (const [subject, group] of bySubject) {
      const notePath = join(scopeDir, `${subject}.md`)
      const lines = group.map(t =>
        t.weight !== undefined
          ? `- ${t.predicate}: [[${t.object}]] <!-- weight: ${t.weight} -->`
          : `- ${t.predicate}: [[${t.object}]]`
      )
      await appendFile(notePath, '\n' + lines.join('\n'), 'utf-8')
    }
  }

  async buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string> {
    const scopeDir = join(this.vaultDir, scope)
    const files = await readdir(scopeDir).catch(() => [])
    const mdFiles = files.filter(f => f.endsWith('.md'))
    if (mdFiles.length === 0) return ''

    const contents = await Promise.all(
      mdFiles.map(f => readFile(join(scopeDir, f), 'utf-8'))
    )
    return `<agent-memory scope="${scope}">\n${contents.join('\n')}\n</agent-memory>`
  }
}
