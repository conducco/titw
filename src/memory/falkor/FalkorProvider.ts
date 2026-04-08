import type { AgentMemoryScope } from '../../types/agent.js'
import type { IMemoryProvider, Triple } from '../../types/provider.js'

export interface FalkorProviderOptions {
  url: string
  graphName: string
  lambda?: number
}

interface FalkorGraph {
  query(cypher: string, params?: Record<string, unknown>): Promise<{ data: Record<string, unknown>[] }>
  close(): Promise<void>
}

export class FalkorProvider implements IMemoryProvider {
  private graph: FalkorGraph | undefined

  constructor(private opts: FalkorProviderOptions) {}

  async connect(): Promise<void> {
    // Dynamic import so `falkordb` is only required when this provider is used
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error falkordb is an optional peer dependency — not installed at typecheck time
    const falkordb = await import('falkordb') as {
      default?: { connect(url: string): Promise<{ selectGraph(name: string): FalkorGraph }> }
      FalkorDB?: { connect(url: string): Promise<{ selectGraph(name: string): FalkorGraph }> }
    }
    const FalkorDB = falkordb.default ?? falkordb.FalkorDB
    if (!FalkorDB) throw new Error('falkordb module did not export a default or FalkorDB export')
    const client = await FalkorDB.connect(this.opts.url)
    this.graph = client.selectGraph(this.opts.graphName)
  }

  async disconnect(): Promise<void> {
    await this.graph?.close()
  }

  async write(agentType: string, scope: AgentMemoryScope, triples: Triple[]): Promise<void> {
    if (!this.graph) throw new Error('FalkorProvider: call connect() before write()')
    for (const t of triples) {
      await this.graph.query(
        `MERGE (s:Entity {name: $subject})
         MERGE (o:Entity {name: $object})
         CREATE (s)-[:RELATES_TO {
           predicate: $predicate,
           weight: $weight,
           createdAt: timestamp(),
           agentType: $agentType,
           scope: $scope
         }]->(o)`,
        {
          subject: t.subject,
          object: t.object,
          predicate: t.predicate,
          weight: t.weight ?? 1.0,
          agentType,
          scope,
        }
      )
    }
  }

  async buildSystemPromptInjection(agentType: string, scope: AgentMemoryScope): Promise<string> {
    if (!this.graph) throw new Error('FalkorProvider: call connect() before buildSystemPromptInjection()')
    const lambda = this.opts.lambda ?? 0.95
    const result = await this.graph.query(
      `MATCH (s)-[r:RELATES_TO]->(o)
       WHERE r.scope = $scope
       RETURN s.name, r.predicate, o.name,
              r.weight * pow($lambda, (timestamp() - r.createdAt) / 86400000.0) AS score
       ORDER BY score DESC
       LIMIT 50`,
      { scope, lambda }
    )
    if (!result.data.length) return ''
    const lines = result.data.map(r => `- ${String(r['s.name'])} ${String(r['r.predicate'])} ${String(r['o.name'])}`)
    return `<agent-memory scope="${scope}">\n${lines.join('\n')}\n</agent-memory>`
  }
}
