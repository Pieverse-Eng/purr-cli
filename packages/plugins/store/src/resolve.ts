import * as pieverse from './sources/pieverse.js'
import * as okx from './sources/okx.js'
import type { SkillInfo, InstallResult, RemoveResult, ListResult } from './types.js'

export type SourceId = 'pieverse' | 'okx'

export interface Source {
  list: (opts?: {
    search?: string
    category?: string
    limit?: number
    offset?: number
  }) => Promise<ListResult>
  info: (slug: string) => Promise<SkillInfo | null>
  install: (slug: string, opts?: { isGlobal?: boolean; meta?: SkillInfo }) => Promise<InstallResult>
  remove: (slug: string, record: object, opts?: { isGlobal?: boolean }) => Promise<RemoveResult>
}

export const SOURCES: Record<SourceId, Source> = {
  pieverse: {
    list: pieverse.list,
    info: pieverse.info,
    install: pieverse.install,
    remove: pieverse.remove,
  } as Source,
  okx: { list: okx.list, info: okx.info, install: okx.install, remove: okx.remove } as Source,
}

const SOURCE_IDS = Object.keys(SOURCES) as SourceId[]

export function parseQualifiedSlug(raw: string): { source: SourceId | null; slug: string } {
  const m = String(raw || '').match(/^([a-z0-9-]+):(.+)$/)
  if (m && SOURCE_IDS.includes(m[1] as SourceId)) return { source: m[1] as SourceId, slug: m[2] }
  return { source: null, slug: String(raw) }
}

interface Candidate {
  source: string
  qualified_slug: string
  slug: string
  version: string
  description: string
  components: string[]
  install_command: string
}

interface ResolveResult {
  status: 'unique' | 'not_found' | 'ambiguous'
  slug: string
  source?: string
  meta?: SkillInfo
  candidates?: Candidate[]
  warnings: string[]
}

function candidateFrom(source: SourceId, meta: SkillInfo): Candidate {
  return {
    source,
    qualified_slug: `${source}:${meta.slug}`,
    slug: meta.slug,
    version: meta.version,
    description: meta.description,
    components: meta.components || ['skill'],
    install_command: `purr store install ${source}:${meta.slug}`,
  }
}

export async function resolveSlug(rawSlug: string): Promise<ResolveResult> {
  const { source, slug } = parseQualifiedSlug(rawSlug)

  if (source) {
    const meta = await SOURCES[source].info(slug)
    if (!meta) return { status: 'not_found', slug: rawSlug, warnings: [] }
    return {
      status: 'unique',
      slug,
      source,
      meta,
      candidates: [candidateFrom(source, meta)],
      warnings: [],
    }
  }

  const probes = await Promise.all(
    SOURCE_IDS.map(async (id) => {
      try {
        const meta = await SOURCES[id].info(slug)
        return { id, meta, error: null as Error | null }
      } catch (err) {
        return { id, meta: null, error: err as Error }
      }
    }),
  )
  const hits = probes.filter((p): p is typeof p & { meta: SkillInfo } => Boolean(p.meta))
  const warnings = probes
    .filter((p): p is typeof p & { error: Error } => Boolean(p.error))
    .map((p) => `source ${p.id} unavailable: ${p.error.message || p.error}`)

  if (hits.length === 0) return { status: 'not_found', slug: rawSlug, warnings }
  if (hits.length === 1) {
    const { id, meta } = hits[0]
    return {
      status: 'unique',
      slug,
      source: id,
      meta,
      candidates: [candidateFrom(id, meta)],
      warnings,
    }
  }
  return {
    status: 'ambiguous',
    slug,
    candidates: hits.map(({ id, meta }) => candidateFrom(id, meta)),
    warnings,
  }
}
