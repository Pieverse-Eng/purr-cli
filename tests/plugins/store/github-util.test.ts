import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const scratch = mkdtempSync(join(tmpdir(), 'purr-gh-test-'))

beforeAll(() => {
  process.env.PURR_STORE_HOME = scratch
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('github util', () => {
  it('resolveCommitSha passes through a plain SHA without hitting the network', async () => {
    const { resolveCommitSha } = await import('@pieverseio/purr-plugin-store/util/github')
    const sha = 'a'.repeat(40)
    const got = await resolveCommitSha({ owner: 'x', repo: 'y', ref: sha })
    expect(got).toBe(sha)
  })

  it('resolveCommitSha rejects unsafe refs', async () => {
    const { resolveCommitSha } = await import('@pieverseio/purr-plugin-store/util/github')
    await expect(
      resolveCommitSha({ owner: 'x', repo: 'y', ref: 'main; rm -rf /' }),
    ).rejects.toThrow(/Unsafe ref/)
    await expect(
      resolveCommitSha({ owner: 'x', repo: 'y', ref: '../../etc/passwd' }),
    ).rejects.toThrow(/Unsafe ref/)
  })

  it('assertNoPathEscape passes for a clean tree', async () => {
    const { assertNoPathEscape } = await import('@pieverseio/purr-plugin-store/util/github')
    const dir = mkdtempSync(join(tmpdir(), 'purr-safe-'))
    try {
      mkdirSync(join(dir, 'a'))
      writeFileSync(join(dir, 'a/b.txt'), 'hi')
      assertNoPathEscape(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('assertNoPathEscape catches a symlink that points outside the base', async () => {
    if (process.platform === 'win32') return // symlinks require admin on Windows
    const { assertNoPathEscape } = await import('@pieverseio/purr-plugin-store/util/github')
    const dir = mkdtempSync(join(tmpdir(), 'purr-escape-'))
    const outside = mkdtempSync(join(tmpdir(), 'purr-outside-'))
    try {
      try {
        execFileSync('ln', ['-s', outside, join(dir, 'escape')])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('EPERM') || message.includes('operation not permitted')) return
        throw error
      }
      expect(() => assertNoPathEscape(dir)).toThrow(/Path traversal/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fetchRepoSubpath rejects `..` subpaths before making any network call', async () => {
    const { fetchRepoSubpath } = await import('@pieverseio/purr-plugin-store/util/github')
    await expect(
      fetchRepoSubpath({ owner: 'x', repo: 'y', ref: 'a'.repeat(40), subpath: '../../etc' }),
    ).rejects.toThrow(/escapes repo root/)
    await expect(
      fetchRepoSubpath({ owner: 'x', repo: 'y', ref: 'a'.repeat(40), subpath: '/absolute' }),
    ).rejects.toThrow(/must be relative/)
  })
})
