import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix as posixPath } from 'node:path'
import { fetchJson, fetchRepoSubpath, resolveCommitSha } from '../util/github.js'
import { readCache, writeCache } from '../util/cache.js'
import { installToAgents, removeFromAgents } from '../skill-dirs.js'

const OWNER = 'okx'
const REPO = 'plugin-store'
const REGISTRY_URL = process.env.OKX_REGISTRY_URL ||
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/registry.json`
const CACHE_KEY = 'okx-registry.json'
const SHA_CACHE_KEY = 'okx-main-sha.json'
const CACHE_TTL = 12 * 60 * 60 * 1000

let pendingRegistry: Promise<Registry> | null = null
let pendingSha: Promise<string> | null = null

interface Registry {
  plugins?: Plugin[]
}

interface Plugin {
  name: string
  version: string
  category: string
  description: string
  tags?: string[]
  type?: string
  components?: {
    skill?: {
      dir?: string
    }
  }
}

interface Normalized {
  slug: string
  source: string
  qualified_slug: string
  name: string
  version: string
  category: string
  description: string
  components: string[]
  type?: string
  raw: Plugin
}

async function getRegistry(): Promise<Registry> {
  const cached = readCache<Registry>(CACHE_KEY, CACHE_TTL)
  if (cached) return cached
  if (pendingRegistry) return pendingRegistry
  pendingRegistry = fetchJson<Registry>(REGISTRY_URL)
    .then((r) => { writeCache(CACHE_KEY, r); return r })
    .finally(() => { pendingRegistry = null })
  return pendingRegistry
}

async function getHeadSha(): Promise<string> {
  const cached = readCache<{ sha: string }>(SHA_CACHE_KEY, CACHE_TTL)
  if (cached?.sha) return cached.sha
  if (pendingSha) return pendingSha
  pendingSha = resolveCommitSha({ owner: OWNER, repo: REPO, ref: 'main' })
    .then((sha) => { writeCache(SHA_CACHE_KEY, { sha, resolved_at: Date.now() }); return sha })
    .finally(() => { pendingSha = null })
  return pendingSha
}

function normalize(p: Plugin): Normalized {
  return {
    slug: p.name,
    source: 'okx',
    qualified_slug: `okx:${p.name}`,
    name: p.name,
    version: p.version,
    category: p.category,
    description: p.description,
    components: ['skill'],
    type: p.type,
    raw: p,
  }
}

function matchesSearch(p: Plugin, q: string): boolean {
  const hay = [p.name, p.description, p.category, ...(p.tags || [])].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

export async function list({ search, category, limit = 20, offset = 0 }: { search?: string; category?: string; limit?: number; offset?: number } = {}) {
  const reg = await getRegistry()
  let plugins = reg.plugins || []
  if (search) plugins = plugins.filter((p) => matchesSearch(p, search))
  if (category) plugins = plugins.filter((p) => p.category === category)
  const total = plugins.length
  const skills = plugins.slice(offset, offset + limit)
    .map(normalize)
    .map(({ raw, ...row }) => row)
  return { total, skills }
}

export async function info(slug: string): Promise<Normalized | null> {
  const reg = await getRegistry()
  const p = (reg.plugins || []).find((x) => x.name === slug)
  return p ? normalize(p) : null
}

export async function install(slug: string, { isGlobal = false, meta }: { isGlobal?: boolean; meta?: { raw?: Plugin } } = {}) {
  const raw = meta?.raw
  let plugin = raw
  if (!plugin) {
    const reg = await getRegistry()
    plugin = (reg.plugins || []).find((p) => p.name === slug)
  }
  if (!plugin) {
    throw Object.assign(new Error(`Plugin "${slug}" not found in OKX registry`), { code: 'NOT_FOUND' })
  }

  const sha = await getHeadSha()
  const skillDir = plugin.components?.skill?.dir || '.'
  const subpath = posixPath.normalize(`skills/${plugin.name}/${skillDir}`).replace(/\/$/, '')

  const { dir, cleanup } = await fetchRepoSubpath({
    owner: OWNER,
    repo: REPO,
    ref: sha,
    subpath,
  })
  try {
    const skill = installToAgents(plugin.name, dir, isGlobal)
    return {
      slug: plugin.name,
      qualified_slug: `okx:${plugin.name}`,
      source: 'okx',
      name: plugin.name,
      version: plugin.version,
      category: plugin.category,
      description: plugin.description,
      commit: sha,
      skill,
    }
  } finally {
    cleanup()
  }
}

function cleanOkxArtifacts(slug: string): string[] {
  const home = homedir()
  const paths = [
    join(home, '.local/bin', slug),
    join(home, '.local/bin', `.${slug}-core`),
    join(home, '.plugin-store/managed', slug),
    join(home, '.plugin-store/reported', slug),
    join(home, '.plugin-store/update-cache', slug),
  ]
  const cleaned: string[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      rmSync(path, { recursive: true, force: true })
      cleaned.push(path)
    } catch {
      // ignore
    }
  }
  return cleaned
}

export async function remove(slug: string, _record: object, { isGlobal = false } = {}) {
  const { removed, notFound } = removeFromAgents(slug, isGlobal)
  const artifactsRemoved = cleanOkxArtifacts(slug)
  return {
    skill: { removed, notFound },
    ...(artifactsRemoved.length ? { artifacts_removed: artifactsRemoved } : {}),
  }
}
