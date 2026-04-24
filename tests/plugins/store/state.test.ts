import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'purr-state-test-'))

beforeAll(() => {
  process.env.PURR_STORE_HOME = scratch
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('state', () => {
  it('empty state returns { plugins: {} }', async () => {
    const { loadState } = await import('@pieverseio/purr-plugin-store/state')
    expect(loadState()).toEqual({ plugins: {} })
  })

  it('recordInstall persists entry with installed_at', async () => {
    const { recordInstall, getInstalled } = await import('@pieverseio/purr-plugin-store/state')
    recordInstall('okx:aave-v3-plugin', { source: 'okx', version: '0.2.3', agents: {} })
    const entry = getInstalled('okx:aave-v3-plugin')
    expect(entry).not.toBeNull()
    expect(entry!.source).toBe('okx')
    expect(entry!.version).toBe('0.2.3')
    expect(entry!.installed_at).toBeDefined()
  })

  it('findBySlug matches by bare slug across sources', async () => {
    const { recordInstall, findBySlug } = await import('@pieverseio/purr-plugin-store/state')
    recordInstall('pieverse:aave-v3-plugin', { source: 'pieverse', version: '1.0.0', agents: {} })
    const hits = findBySlug('aave-v3-plugin')
    expect(hits.length).toBe(2)
    expect(hits.map((h) => h.source).sort()).toEqual(['okx', 'pieverse'])
  })

  it('findInstallConflict ignores same-source reinstall and reports other sources', async () => {
    const { findInstallConflict, recordInstall } = await import(
      '@pieverseio/purr-plugin-store/state'
    )
    recordInstall('okx:conflict-skill', { source: 'okx', version: '1.0.0' })
    expect(findInstallConflict('okx:conflict-skill', 'conflict-skill')).toBeNull()

    recordInstall('pieverse:conflict-skill', { source: 'pieverse', version: '2.0.0' })
    const conflict = findInstallConflict('okx:conflict-skill', 'conflict-skill')
    expect(conflict?.qualified).toBe('pieverse:conflict-skill')
  })

  it('recordRemove deletes entry', async () => {
    const { recordRemove, getInstalled, findBySlug } = await import(
      '@pieverseio/purr-plugin-store/state'
    )
    recordRemove('okx:aave-v3-plugin')
    expect(getInstalled('okx:aave-v3-plugin')).toBeNull()
    const hits = findBySlug('aave-v3-plugin')
    expect(hits.length).toBe(1)
    expect(hits[0].source).toBe('pieverse')
  })
})
