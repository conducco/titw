import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillRegistry } from '../src/skills/SkillRegistry.js'

let tempDir: string

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'titw-skill-')) })
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('SkillRegistry.load', () => {
  it('returns empty string when no skills given', async () => {
    const result = await SkillRegistry.load([], tempDir)
    expect(result).toBe('')
  })

  it('loads a skill from a local markdown file', async () => {
    writeFileSync(join(tempDir, 'my-skill.md'), [
      '---',
      'name: my-skill',
      'description: Test skill',
      '---',
      '',
      'Always be concise.',
    ].join('\n'))
    const result = await SkillRegistry.load([join(tempDir, 'my-skill.md')], tempDir)
    expect(result).toContain('<skill name="my-skill">')
    expect(result).toContain('Always be concise.')
    expect(result).toContain('</skill>')
  })

  it('uses filename as skill name when frontmatter is absent', async () => {
    writeFileSync(join(tempDir, 'no-frontmatter.md'), 'Be helpful.')
    const result = await SkillRegistry.load([join(tempDir, 'no-frontmatter.md')], tempDir)
    expect(result).toContain('<skill name="no-frontmatter">')
    expect(result).toContain('Be helpful.')
  })

  it('warns and skips a missing file without throwing', async () => {
    const result = await SkillRegistry.load(['/nonexistent/skill.md'], tempDir)
    expect(result).toBe('')
  })

  it('deduplicates skills with the same name', async () => {
    writeFileSync(join(tempDir, 'dup.md'), '---\nname: same\n---\nContent.')
    const result = await SkillRegistry.load(
      [join(tempDir, 'dup.md'), join(tempDir, 'dup.md')],
      tempDir
    )
    const count = (result.match(/<skill name="same">/g) ?? []).length
    expect(count).toBe(1)
  })

  it('truncates skills larger than 50KB', async () => {
    const big = 'x'.repeat(51 * 1024)
    writeFileSync(join(tempDir, 'big.md'), `---\nname: big\n---\n${big}`)
    const result = await SkillRegistry.load([join(tempDir, 'big.md')], tempDir)
    expect(result).toContain('<!-- skill truncated -->')
  })

  it('composes multiple skills in order', async () => {
    writeFileSync(join(tempDir, 'a.md'), '---\nname: alpha\n---\nAlpha content.')
    writeFileSync(join(tempDir, 'b.md'), '---\nname: beta\n---\nBeta content.')
    const result = await SkillRegistry.load(
      [join(tempDir, 'a.md'), join(tempDir, 'b.md')],
      tempDir
    )
    expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('beta'))
  })
})
