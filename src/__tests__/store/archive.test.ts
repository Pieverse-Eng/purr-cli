import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('archive extraction', () => {
  it('extracts regular tar archives', async () => {
    const { extractArchive } = await import('../../store/util/archive.js')
    const dir = mkdtempSync(join(tmpdir(), 'purr-archive-safe-'))
    const src = join(dir, 'src')
    const target = join(dir, 'target')
    const archive = join(dir, 'safe.tgz')
    try {
      mkdirSync(src)
      mkdirSync(target)
      writeFileSync(join(src, 'SKILL.md'), 'safe')
      execFileSync('python3', [
        '-c',
        `import tarfile,sys
archive,src=sys.argv[1:3]
with tarfile.open(archive,'w:gz') as t:
    t.add(src, arcname='SKILL.md')`,
        archive,
        join(src, 'SKILL.md'),
      ])

      extractArchive(archive, target)

      expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('safe')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects tar entries that would write outside the target directory', async () => {
    const { extractArchive } = await import('../../store/util/archive.js')
    const dir = mkdtempSync(join(tmpdir(), 'purr-archive-tar-slip-'))
    const src = join(dir, 'src')
    const target = join(dir, 'target')
    const archive = join(dir, 'evil.tgz')
    try {
      mkdirSync(src)
      mkdirSync(target)
      writeFileSync(join(src, 'payload.txt'), 'owned')
      execFileSync('python3', [
        '-c',
        `import tarfile,sys
archive,payload=sys.argv[1:3]
with tarfile.open(archive,'w:gz') as t:
    t.add(payload, arcname='../outside.txt')`,
        archive,
        join(src, 'payload.txt'),
      ])

      expect(() => extractArchive(archive, target)).toThrow(/Unsafe archive entry path/)
      expect(existsSync(join(dir, 'outside.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects zip entries that would write outside the target directory', async () => {
    const { extractArchive } = await import('../../store/util/archive.js')
    const dir = mkdtempSync(join(tmpdir(), 'purr-archive-zip-slip-'))
    const target = join(dir, 'target')
    const archive = join(dir, 'evil.zip')
    try {
      mkdirSync(target)
      execFileSync('python3', [
        '-c',
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
    z.writestr('../outside.txt','owned')`,
        archive,
      ])

      expect(() => extractArchive(archive, target)).toThrow(/Unsafe archive entry path/)
      expect(existsSync(join(dir, 'outside.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
