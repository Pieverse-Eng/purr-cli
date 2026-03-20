import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface LockEntry {
	readonly slug: string
	readonly name: string
	readonly sha256: string
	readonly installed_at: string
	readonly install_method: 'symlink' | 'copy'
	readonly canonical_path: string
	readonly agent_installs: Record<string, { path: string; method: 'symlink' | 'copy' }>
}

export interface LockFile {
	readonly skills: readonly LockEntry[]
}

const home = homedir()

const LOCK_FILENAME = 'skills-lock.json'

function lockFilePath(scope: 'local' | 'global'): string {
	if (scope === 'global') {
		return join(home, '.purrfectclaw', LOCK_FILENAME)
	}
	return join(process.cwd(), LOCK_FILENAME)
}

/**
 * Read the lock file for the given scope. Returns empty `{ skills: [] }` if the file does not exist.
 */
export function readLock(scope: 'local' | 'global'): LockFile {
	const filePath = lockFilePath(scope)
	if (!existsSync(filePath)) {
		return { skills: [] }
	}
	try {
		const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as LockFile
		return { skills: raw.skills ?? [] }
	} catch {
		console.error(`Warning: ${filePath} is corrupted and could not be parsed. Treating as empty.`)
		return { skills: [] }
	}
}

/**
 * Write the lock file atomically (write to .tmp then rename).
 */
export function writeLock(scope: 'local' | 'global', lockFile: LockFile): void {
	const filePath = lockFilePath(scope)
	const dir = dirname(filePath)
	mkdirSync(dir, { recursive: true })

	const tmpPath = `${filePath}.tmp`
	writeFileSync(tmpPath, JSON.stringify(lockFile, null, '\t') + '\n', 'utf-8')
	renameSync(tmpPath, filePath)
}

/**
 * Add or update a skill entry in the lock file.
 */
export function upsertLockEntry(scope: 'local' | 'global', entry: LockEntry): void {
	const lock = readLock(scope)
	const idx = lock.skills.findIndex((s) => s.slug === entry.slug)
	const skills = [...lock.skills]
	if (idx >= 0) {
		skills[idx] = entry
	} else {
		skills.push(entry)
	}
	writeLock(scope, { skills })
}

/**
 * Remove a skill entry by slug from the lock file.
 */
export function removeLockEntry(scope: 'local' | 'global', slug: string): void {
	const lock = readLock(scope)
	const skills = lock.skills.filter((s) => s.slug !== slug)
	writeLock(scope, { skills })
}

/**
 * Get a single lock entry by slug, or undefined if not found.
 */
export function getLockEntry(scope: 'local' | 'global', slug: string): LockEntry | undefined {
	const lock = readLock(scope)
	return lock.skills.find((s) => s.slug === slug)
}
