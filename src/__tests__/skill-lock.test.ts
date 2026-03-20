import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Use a temp directory so tests don't pollute the real filesystem
let testDir: string

beforeEach(() => {
	testDir = join(tmpdir(), `purr-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	mkdirSync(testDir, { recursive: true })
	// Mock process.cwd() to point to our temp directory for local scope
	vi.spyOn(process, 'cwd').mockReturnValue(testDir)
})

afterEach(() => {
	vi.restoreAllMocks()
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true })
	}
})

// Dynamic import to pick up mocked cwd
async function importLock() {
	// Clear module cache so each test gets fresh module with mocked cwd
	const mod = await import('../skill/lock.js')
	return mod
}

function makeLockEntry(slug: string, overrides: Record<string, unknown> = {}) {
	return {
		slug,
		name: slug,
		sha256: 'abc123',
		installed_at: '2026-01-01T00:00:00Z',
		install_method: 'symlink' as const,
		canonical_path: `/fake/.skills/${slug}`,
		agent_installs: {},
		...overrides,
	}
}

describe('readLock', () => {
	it('returns empty skills array when file does not exist', async () => {
		const { readLock } = await importLock()
		const lock = readLock('local')
		expect(lock).toEqual({ skills: [] })
	})

	it('returns empty skills array when file is corrupt JSON', async () => {
		const { readLock } = await importLock()
		const lockPath = join(testDir, 'skills-lock.json')
		const { writeFileSync } = await import('node:fs')
		writeFileSync(lockPath, 'not-json!!!', 'utf-8')
		const lock = readLock('local')
		expect(lock).toEqual({ skills: [] })
	})
})

describe('writeLock + readLock roundtrip', () => {
	it('writes and reads back the same data', async () => {
		const { writeLock, readLock } = await importLock()
		const entry = makeLockEntry('test-skill')
		const lockFile = { skills: [entry] }

		writeLock('local', lockFile)
		const result = readLock('local')

		expect(result.skills).toHaveLength(1)
		expect(result.skills[0].slug).toBe('test-skill')
		expect(result.skills[0].sha256).toBe('abc123')
	})

	it('uses atomic write (tmp file then rename)', async () => {
		const { writeLock } = await importLock()
		const lockFile = { skills: [makeLockEntry('atomic-test')] }

		writeLock('local', lockFile)

		// The .tmp file should not remain after write
		const tmpPath = join(testDir, 'skills-lock.json.tmp')
		expect(existsSync(tmpPath)).toBe(false)

		// The actual file should exist
		const lockPath = join(testDir, 'skills-lock.json')
		expect(existsSync(lockPath)).toBe(true)

		// Content should be valid JSON
		const raw = JSON.parse(readFileSync(lockPath, 'utf-8'))
		expect(raw.skills[0].slug).toBe('atomic-test')
	})
})

describe('upsertLockEntry', () => {
	it('adds a new entry when none exists', async () => {
		const { upsertLockEntry, readLock } = await importLock()
		const entry = makeLockEntry('new-skill')

		upsertLockEntry('local', entry)
		const lock = readLock('local')

		expect(lock.skills).toHaveLength(1)
		expect(lock.skills[0].slug).toBe('new-skill')
	})

	it('updates an existing entry with the same slug', async () => {
		const { upsertLockEntry, readLock } = await importLock()
		const entry1 = makeLockEntry('my-skill', { sha256: 'hash-v1' })
		const entry2 = makeLockEntry('my-skill', { sha256: 'hash-v2' })

		upsertLockEntry('local', entry1)
		upsertLockEntry('local', entry2)
		const lock = readLock('local')

		expect(lock.skills).toHaveLength(1)
		expect(lock.skills[0].sha256).toBe('hash-v2')
	})

	it('preserves other entries when updating', async () => {
		const { upsertLockEntry, readLock } = await importLock()

		upsertLockEntry('local', makeLockEntry('skill-a'))
		upsertLockEntry('local', makeLockEntry('skill-b'))
		upsertLockEntry('local', makeLockEntry('skill-a', { sha256: 'updated' }))

		const lock = readLock('local')
		expect(lock.skills).toHaveLength(2)
		expect(lock.skills.find((s) => s.slug === 'skill-a')?.sha256).toBe('updated')
		expect(lock.skills.find((s) => s.slug === 'skill-b')?.sha256).toBe('abc123')
	})
})

describe('removeLockEntry', () => {
	it('removes an entry by slug', async () => {
		const { upsertLockEntry, removeLockEntry, readLock } = await importLock()

		upsertLockEntry('local', makeLockEntry('keep-me'))
		upsertLockEntry('local', makeLockEntry('remove-me'))
		removeLockEntry('local', 'remove-me')

		const lock = readLock('local')
		expect(lock.skills).toHaveLength(1)
		expect(lock.skills[0].slug).toBe('keep-me')
	})

	it('does nothing when slug does not exist', async () => {
		const { upsertLockEntry, removeLockEntry, readLock } = await importLock()

		upsertLockEntry('local', makeLockEntry('existing'))
		removeLockEntry('local', 'nonexistent')

		const lock = readLock('local')
		expect(lock.skills).toHaveLength(1)
	})
})

describe('getLockEntry', () => {
	it('returns the entry when found', async () => {
		const { upsertLockEntry, getLockEntry } = await importLock()
		upsertLockEntry('local', makeLockEntry('findme'))

		const entry = getLockEntry('local', 'findme')
		expect(entry).toBeDefined()
		expect(entry?.slug).toBe('findme')
	})

	it('returns undefined when not found', async () => {
		const { getLockEntry } = await importLock()
		const entry = getLockEntry('local', 'nope')
		expect(entry).toBeUndefined()
	})
})
