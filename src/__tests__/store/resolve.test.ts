import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'purr-resolve-test-'))
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

describe('resolve', () => {
  it('parseQualifiedSlug detects source prefix', async () => {
    const { parseQualifiedSlug } = await import('../../store/resolve.js')
    expect(parseQualifiedSlug('okx:foo')).toEqual({ source: 'okx', slug: 'foo' })
    expect(parseQualifiedSlug('pieverse:bar')).toEqual({ source: 'pieverse', slug: 'bar' })
    expect(parseQualifiedSlug('bare-slug')).toEqual({ source: null, slug: 'bare-slug' })
    expect(parseQualifiedSlug('unknown-source:foo')).toEqual({
      source: null,
      slug: 'unknown-source:foo',
    })
  })

  it('resolveSlug returns unique when qualified slug is explicit', async () => {
    const { resolveSlug, SOURCES } = await import('../../store/resolve.js')
    const origPieverseInfo = SOURCES.pieverse.info
    SOURCES.pieverse.info = async () => null
    try {
      const r = await resolveSlug('okx:fixture-skill-only')
      expect(r.status).toBe('unique')
      expect((r as { source: string }).source).toBe('okx')
      expect((r as { slug: string }).slug).toBe('fixture-skill-only')
    } finally {
      SOURCES.pieverse.info = origPieverseInfo
    }
  })

  it('resolveSlug returns not_found for missing qualified slug', async () => {
    const { resolveSlug } = await import('../../store/resolve.js')
    const r = await resolveSlug('okx:does-not-exist')
    expect(r.status).toBe('not_found')
  })

  it('resolveSlug returns ambiguous when both sources match', async () => {
    const { resolveSlug, SOURCES } = await import('../../store/resolve.js')
    const origPieverseInfo = SOURCES.pieverse.info
    SOURCES.pieverse.info = async (slug: string) =>
      slug === 'fixture-skill-only'
        ? {
            slug,
            source: 'pieverse',
            qualified_slug: `pieverse:${slug}`,
            version: '9.9.9',
            description: 'stub',
            components: ['skill'],
          }
        : null
    try {
      const r = await resolveSlug('fixture-skill-only')
      expect(r.status).toBe('ambiguous')
      const candidates = (r as { candidates: { source: string }[] }).candidates
      expect(candidates.length).toBe(2)
      const sources = candidates.map((c) => c.source).sort()
      expect(sources).toEqual(['okx', 'pieverse'])
      for (const c of candidates) {
        expect(c.install_command).toContain(`${c.source}:fixture-skill-only`)
      }
    } finally {
      SOURCES.pieverse.info = origPieverseInfo
    }
  })

  it('resolveSlug returns unique when only one source matches', async () => {
    const { resolveSlug, SOURCES } = await import('../../store/resolve.js')
    const origPieverseInfo = SOURCES.pieverse.info
    SOURCES.pieverse.info = async () => null
    try {
      const r = await resolveSlug('fixture-with-binary')
      expect(r.status).toBe('unique')
      expect((r as { source: string }).source).toBe('okx')
    } finally {
      SOURCES.pieverse.info = origPieverseInfo
    }
  })
})
