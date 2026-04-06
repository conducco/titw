import { readFile } from 'fs/promises'
import { join, basename, extname } from 'path'
import { createRequire } from 'module'

const SKILL_SIZE_LIMIT = 50 * 1024 // 50 KB
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/

interface ParsedSkill {
  name: string
  content: string
}

function parseFrontmatter(raw: string, fallbackName: string): ParsedSkill {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { name: fallbackName, content: raw.trim() }

  const [, front, body] = match
  const nameLine = front!.split('\n').find(l => l.startsWith('name:'))
  const name = nameLine ? nameLine.replace('name:', '').trim() : fallbackName
  return { name, content: body!.trim() }
}

async function loadFromPath(skillPath: string): Promise<ParsedSkill | null> {
  try {
    const raw = await readFile(skillPath, 'utf-8')
    const fallbackName = basename(skillPath, extname(skillPath))
    return parseFrontmatter(raw, fallbackName)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      console.warn(`[SkillRegistry] Skill file not found, skipping: ${skillPath}`)
      return null
    }
    throw err
  }
}

async function loadFromPackage(packageName: string, cwd: string): Promise<ParsedSkill | null> {
  try {
    const require = createRequire(join(cwd, 'package.json'))
    const mod = require(packageName) as { name?: string; content?: string }
    if (mod.content) {
      return { name: mod.name ?? packageName, content: mod.content }
    }
    // Fall back to skill.md at package root
    const pkgPath = require.resolve(packageName + '/skill.md')
    return loadFromPath(pkgPath)
  } catch {
    console.warn(`[SkillRegistry] Skill package not found, skipping: ${packageName}`)
    return null
  }
}

function wrapSkill(skill: ParsedSkill): string {
  let content = skill.content
  if (Buffer.byteLength(content, 'utf-8') > SKILL_SIZE_LIMIT) {
    console.warn(`[SkillRegistry] Skill "${skill.name}" exceeds 50KB, truncating.`)
    content = content.slice(0, SKILL_SIZE_LIMIT) + '\n<!-- skill truncated -->'
  }
  return `<skill name="${skill.name}">\n${content}\n</skill>`
}

export class SkillRegistry {
  /**
   * Load and compose skills from local paths or npm package names.
   * Returns a string of <skill> tags ready to append to a system prompt.
   * Never throws — missing or malformed skills are warned and skipped.
   */
  static async load(skills: string[], cwd: string): Promise<string> {
    if (skills.length === 0) return ''

    const loaded: ParsedSkill[] = []
    const seenNames = new Set<string>()

    for (const spec of skills) {
      const isPath = spec.startsWith('.') || spec.startsWith('/')
      const skillPath = spec.startsWith('/') ? spec : join(cwd, spec)
      const skill = isPath
        ? await loadFromPath(skillPath)
        : await loadFromPackage(spec, cwd)

      if (!skill) continue

      if (seenNames.has(skill.name)) {
        console.warn(`[SkillRegistry] Duplicate skill "${skill.name}", skipping second occurrence.`)
        continue
      }

      seenNames.add(skill.name)
      loaded.push(skill)
    }

    return loaded.map(wrapSkill).join('\n')
  }
}
