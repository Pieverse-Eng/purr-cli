import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoPathEscape } from '../util/github.js'
import { extractArchive } from '../util/archive.js'
import { installToAgents, removeFromAgents } from '../skill-dirs.js'

const STORE = process.env.SKILL_STORE_URL || 'https://www.pieverse.io/api/skill-store/cli'
const MAX_ZIP_SIZE = 50 * 1024 * 1024

interface SkillMeta {
  slug: string
  name: string
  version: string
  category: string
  description: string
}

interface ListResult {
  total: number
  skills: {
    slug: string
    source: string
    qualified_slug: string
    name: string
    version: string
    category: string
    description: string
    components: string[]
  }[]
}

async function api(path: string): Promise<Response> {
  try {
    return await fetch(`${STORE}${path}`, { signal: AbortSignal.timeout(15000) })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    const msg =
      e.name === 'TimeoutError'
        ? 'Store API request timed out (15s)'
        : `Network error: ${e.message}`
    throw new Error(msg)
  }
}

export async function list({
  search,
  category,
  limit = 20,
  offset = 0,
}: {
  search?: string
  category?: string
  limit?: number
  offset?: number
} = {}): Promise<ListResult> {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (category) params.set('category', category)
  params.set('limit', String(limit))
  if (offset) params.set('offset', String(offset))
  const res = await api(`/skills?${params}`)
  if (!res.ok) throw new Error(`Store API error: ${res.status}`)
  const data = (await res.json()) as { total?: number; skills?: SkillMeta[] }
  if (!Array.isArray(data.skills)) throw new Error('Unexpected API response shape')

  return {
    total: data.total ?? data.skills.length,
    skills: data.skills.map((s) => ({
      slug: s.slug,
      source: 'pieverse',
      qualified_slug: `pieverse:${s.slug}`,
      name: s.name,
      version: s.version,
      category: s.category,
      description: s.description,
      components: ['skill'],
    })),
  }
}

export async function info(slug: string): Promise<{
  slug: string
  source: string
  qualified_slug: string
  name: string
  version: string
  category: string
  description: string
  components: string[]
  raw: SkillMeta
} | null> {
  const res = await api(`/skills/${encodeURIComponent(slug)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Store API error: ${res.status}`)
  const meta = (await res.json()) as SkillMeta
  return {
    slug: meta.slug,
    source: 'pieverse',
    qualified_slug: `pieverse:${meta.slug}`,
    name: meta.name,
    version: meta.version,
    category: meta.category,
    description: meta.description,
    components: ['skill'],
    raw: meta,
  }
}

export async function install(
  slug: string,
  { isGlobal = false } = {},
): Promise<{
  slug: string
  qualified_slug: string
  source: string
  name: string
  version: string
  sha256: string
  skill: {
    installed: { agent: string; path: string }[]
    skipped: string[]
    errors: { agent: string; reason: string }[]
  }
}> {
  const metaRes = await api(`/skills/${encodeURIComponent(slug)}`)
  if (metaRes.status === 404) {
    throw Object.assign(new Error(`Skill "${slug}" not found in Pieverse store`), {
      code: 'NOT_FOUND',
    })
  }
  if (!metaRes.ok) throw new Error(`Store API error: ${metaRes.status}`)
  const meta = (await metaRes.json()) as SkillMeta

  const dlRes = await api(`/skills/${encodeURIComponent(slug)}/download`)
  if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`)

  const expectedSha = dlRes.headers.get('X-Skill-SHA256')
  if (!expectedSha) {
    throw Object.assign(
      new Error(
        'Server did not provide X-Skill-SHA256 header; refusing to install unverified archive',
      ),
      { code: 'NO_CHECKSUM' },
    )
  }

  const contentLength = parseInt(dlRes.headers.get('content-length') || '0', 10)
  if (contentLength > MAX_ZIP_SIZE) {
    throw new Error(`Archive is ${contentLength} bytes, exceeds ${MAX_ZIP_SIZE} byte limit`)
  }
  const buffer = Buffer.from(await dlRes.arrayBuffer())
  if (buffer.length > MAX_ZIP_SIZE) {
    throw new Error(`Downloaded ${buffer.length} bytes, exceeds ${MAX_ZIP_SIZE} byte limit`)
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== expectedSha) {
    throw Object.assign(
      new Error(`Integrity check failed: expected ${expectedSha}, got ${sha256}`),
      { code: 'SHA256_MISMATCH' },
    )
  }

  const tmp = mkdtempSync(join(tmpdir(), `purr-store-${slug}-`))
  try {
    const zipPath = join(tmp, `${slug}.zip`)
    const extractDir = join(tmp, 'out')
    mkdirSync(extractDir)
    writeFileSync(zipPath, buffer)
    extractArchive(zipPath, extractDir)
    assertNoPathEscape(extractDir)

    const { installed, skipped, errors } = installToAgents(slug, extractDir, isGlobal)
    return {
      slug: meta.slug,
      qualified_slug: `pieverse:${meta.slug}`,
      source: 'pieverse',
      name: meta.name,
      version: meta.version,
      sha256,
      skill: { installed, skipped, errors },
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export async function remove(
  slug: string,
  _record: object,
  { isGlobal = false } = {},
): Promise<{ skill: { removed: { agent: string; path: string }[]; notFound: string[] } }> {
  const { removed, notFound } = removeFromAgents(slug, isGlobal)
  return { skill: { removed, notFound } }
}
