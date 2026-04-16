import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './fs.js'

export const PURR_HOME = process.env.PURR_STORE_HOME || join(homedir(), '.purr-store')
export const CACHE_DIR = join(PURR_HOME, 'cache')

export function cachePath(name: string): string {
  return join(CACHE_DIR, name)
}

export function readCache<T>(name: string, ttlMs: number): T | null {
  const path = cachePath(name)
  if (!existsSync(path)) return null
  try {
    const age = Date.now() - statSync(path).mtimeMs
    if (age > ttlMs) return null
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeCache<T>(name: string, data: T): void {
  writeAtomic(cachePath(name), JSON.stringify(data))
}
