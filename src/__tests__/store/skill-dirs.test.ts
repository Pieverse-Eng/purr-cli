import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('skill directory installs', () => {
  it('replaces stale files when reinstalling a skill', async () => {
    const { installToAgents } = await import('../../store/skill-dirs.js')
    const dir = mkdtempSync(join(tmpdir(), 'purr-skill-dirs-'))
    const oldCwd = process.cwd()
    try {
      const src1 = join(dir, 'src1')
      const src2 = join(dir, 'src2')
      const work = join(dir, 'work')
      mkdirSync(src1)
      mkdirSync(src2)
      mkdirSync(work)
      writeFileSync(join(src1, 'old.txt'), 'old')
      writeFileSync(join(src2, 'new.txt'), 'new')

      process.chdir(work)
      installToAgents('same-slug', src1, false)
      installToAgents('same-slug', src2, false)

      const target = join(work, '.agents/skills/same-slug')
      expect(readdirSync(target).sort()).toEqual(['new.txt'])
      expect(existsSync(join(target, 'old.txt'))).toBe(false)
    } finally {
      process.chdir(oldCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
