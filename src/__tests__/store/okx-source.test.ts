import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'purr-test-'))
const fixturePath = join(__dirname, 'fixtures/okx-registry.json')
const cacheDir = join(scratch, 'cache')
mkdirSync(cacheDir, { recursive: true })
writeFileSync(join(cacheDir, 'okx-registry.json'), readFileSync(fixturePath, 'utf8'))

beforeAll(() => {
  process.env.PURR_STORE_HOME = scratch
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('okx source', () => {
  it('okx.list returns normalized rows with qualified_slug and components', async () => {
    const okx = await import('../../store/sources/okx.js')
    const res = await okx.list({ limit: 10 })
    expect(res.total).toBe(3)
    const slugs = res.skills.map((s) => s.slug).sort()
    expect(slugs).toEqual(['fixture-skill-only', 'fixture-with-binary', 'fixture-with-mcp'])

    for (const row of res.skills) {
      expect(row.source).toBe('okx')
      expect(row.qualified_slug).toBe(`okx:${row.slug}`)
      expect(row.components).toEqual(['skill'])
    }
  })

  it('okx.list honors search filter', async () => {
    const okx = await import('../../store/sources/okx.js')
    const res = await okx.list({ search: 'lending', limit: 10 })
    expect(res.total).toBe(1)
    expect(res.skills[0].slug).toBe('fixture-with-binary')
  })

  it('okx.list honors category filter', async () => {
    const okx = await import('../../store/sources/okx.js')
    const res = await okx.list({ category: 'defi-protocol', limit: 10 })
    expect(res.total).toBe(1)
    expect(res.skills[0].slug).toBe('fixture-with-binary')
  })

  it('okx.info returns null for unknown plugin', async () => {
    const okx = await import('../../store/sources/okx.js')
    const res = await okx.info('does-not-exist')
    expect(res).toBeNull()
  })

  it('okx.info returns normalized meta for known plugin', async () => {
    const okx = await import('../../store/sources/okx.js')
    const res = await okx.info('fixture-with-binary')
    expect(res).not.toBeNull()
    expect(res!.source).toBe('okx')
    expect(res!.qualified_slug).toBe('okx:fixture-with-binary')
    expect(res!.components).toEqual(['skill'])
  })
})
