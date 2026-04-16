import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PURR_HOME } from './util/cache.js'
import { writeAtomic } from './util/fs.js'
import type { PluginRecord } from './types.js'

const STATE_PATH = join(PURR_HOME, 'installed.json')
const EMPTY = () => ({ plugins: {} as Record<string, PluginRecord> })

function load(): { plugins: Record<string, PluginRecord> } {
  if (!existsSync(STATE_PATH)) return EMPTY()
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { plugins: Record<string, PluginRecord> }
  } catch {
    return EMPTY()
  }
}

function save(state: { plugins: Record<string, PluginRecord> }): void {
  writeAtomic(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

export function recordInstall(qualifiedSlug: string, record: Omit<PluginRecord, 'installed_at'>): void {
  const state = load()
  state.plugins[qualifiedSlug] = { ...record, installed_at: new Date().toISOString() }
  save(state)
}

export function recordRemove(qualifiedSlug: string): void {
  const state = load()
  delete state.plugins[qualifiedSlug]
  save(state)
}

export function getInstalled(qualifiedSlug: string): PluginRecord | null {
  return load().plugins[qualifiedSlug] || null
}

export function findBySlug(bareSlug: string): (PluginRecord & { qualified: string })[] {
  const state = load()
  return Object.entries(state.plugins)
    .filter(([q]) => q.endsWith(`:${bareSlug}`))
    .map(([qualified, record]) => ({ qualified, ...record }))
}

export function loadState(): { plugins: Record<string, PluginRecord> } {
  return load()
}
