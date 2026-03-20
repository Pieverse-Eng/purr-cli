/**
 * Verification tests for code review findings.
 * Each test proves whether a reported issue actually exists.
 * Tests that PASS = issue confirmed. Tests that FAIL = issue was a false alarm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync } from 'fflate'
import { extractZip, installSkill } from '../skill/installer.js'
import { detectInstalled } from '../skill/agents.js'

let testDir: string

beforeEach(() => {
	testDir = join(tmpdir(), `purr-review-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
	vi.restoreAllMocks()
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true })
	}
})

function makeZip(entries: Record<string, string>): Buffer {
	const zipEntries: Record<string, Uint8Array> = {}
	for (const [name, content] of Object.entries(entries)) {
		zipEntries[name] = new TextEncoder().encode(content)
	}
	return Buffer.from(zipSync(zipEntries))
}

function sha256hex(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex')
}

// ============================================================
// CRITICAL 1: SHA256 empty string — confusing error when header absent
// ============================================================
describe('CRITICAL 1: SHA256 empty hash produces misleading error', () => {
	it('empty sha256 causes "SHA256 mismatch" instead of a clear "header missing" error', () => {
		vi.spyOn(process, 'cwd').mockReturnValue(testDir)

		const zipBuffer = makeZip({ 'skill.md': '# Test' })

		// Simulate what happens when X-Skill-SHA256 header is absent:
		// api.ts line 137: const sha256 = res.headers.get('X-Skill-SHA256') ?? ''
		const emptySha256 = ''

		let thrownError: Error | undefined
		try {
			installSkill({
				slug: 'test',
				buffer: zipBuffer,
				sha256: emptySha256,
				scope: 'local',
				agents: [],
			})
		} catch (e) {
			thrownError = e as Error
		}

		// Issue confirmed if: error says "SHA256 mismatch" with "expected ,"
		// instead of something like "header missing"
		expect(thrownError).toBeDefined()
		expect(thrownError!.message).toContain('SHA256 mismatch')
		expect(thrownError!.message).toMatch(/expected\s*,/) // "expected , got ..." — empty expected
	})
})

// ============================================================
// CRITICAL 2: path traversal — verify on macOS
// ============================================================
describe('CRITICAL 2: path traversal checks', () => {
	it('absolute POSIX path is correctly rejected', () => {
		const buffer = makeZip({ '/etc/passwd': 'bad' })
		expect(() => extractZip(buffer, join(testDir, 'safe'))).toThrow()
	})

	it('on macOS, backslash in filename is caught by includes("..") — overly strict but safe', () => {
		// On macOS/Linux, backslash is a valid filename char, not a separator.
		// `foo\..\..\secret` is NOT a real traversal on macOS — it's a literal filename.
		// But name.includes('..') catches the substring anyway.
		// This means the review's CRITICAL concern about posix.isAbsolute is NOT
		// a security hole on macOS/Linux. It's at most a false positive rejection.
		const buffer = makeZip({ 'foo\\..\\..\\secret': 'data' })
		expect(() => extractZip(buffer, join(testDir, 'safe'))).toThrow(/path traversal/)
	})

	it('standard traversal is caught', () => {
		const buffer = makeZip({ '../escape.txt': 'bad' })
		expect(() => extractZip(buffer, join(testDir, 'safe'))).toThrow(/path traversal/)
	})
})

// ============================================================
// HIGH 3: lock entry name — FIXED: now uses skillName from API
// ============================================================
describe('HIGH 3: lock entry name field (FIXED)', () => {
	it('install.ts now uses skillName (from API) instead of raw slug', () => {
		const source = readFileSync(
			join(process.cwd(), 'src', 'skill', 'commands', 'install.ts'),
			'utf-8',
		)

		const lockEntryMatch = source.match(/const lockEntry.*?=\s*\{([\s\S]*?)\}/m)
		expect(lockEntryMatch).toBeTruthy()

		const lockEntryBody = lockEntryMatch![1]
		// Should now use skillName (fetched from getSkill API) instead of slug
		expect(lockEntryBody).toContain('name: skillName')
		expect(lockEntryBody).not.toContain('name: slug')
	})
})

// ============================================================
// HIGH 5: delete mutation in remove.ts
// ============================================================
describe('HIGH 5: delete mutation in remove.ts', () => {
	it('original entry.agent_installs is NOT mutated — spread protects it', () => {
		// The code does: const remainingInstalls = { ...entry.agent_installs }; delete remainingInstalls[agentSlug]
		// The spread creates a new object, so the original is safe.
		// This is a STYLE issue, not a correctness bug.
		const original: Record<string, { path: string; method: 'symlink' | 'copy' }> = {
			a: { path: '/a', method: 'symlink' },
			b: { path: '/b', method: 'copy' },
		}
		const copy = { ...original }
		delete copy.a

		// Original is intact — proves spread protects it
		expect(original.a).toBeDefined()
		expect(Object.keys(original)).toHaveLength(2)
		expect(Object.keys(copy)).toHaveLength(1)
	})

	it('source code confirms delete is used on a spread copy', () => {
		const source = readFileSync(
			join(process.cwd(), 'src', 'skill', 'commands', 'remove.ts'),
			'utf-8',
		)
		expect(source).toContain('const remainingInstalls = { ...entry.agent_installs }')
		expect(source).toContain('delete remainingInstalls[agentSlug]')
	})
})

// ============================================================
// MEDIUM: symlink type — FIXED: now uses 'dir' instead of 'junction'
// ============================================================
describe('MEDIUM: symlink type (FIXED)', () => {
	it('installer.ts now uses dir type instead of junction', () => {
		const source = readFileSync(
			join(process.cwd(), 'src', 'skill', 'installer.ts'),
			'utf-8',
		)
		expect(source).toContain("symlinkSync(canonical, targetDir, 'dir')")
		expect(source).not.toContain("'junction'")
	})
})

// ============================================================
// TEST QUALITY: SHA256 "passes" test has weak assertion
// ============================================================
describe('TEST QUALITY: SHA256 pass test pattern is fragile', () => {
	it('the try/catch pattern lets non-SHA256 errors pass silently', () => {
		// Reproduce the exact pattern from skill-installer.test.ts lines 81-93:
		//   try { installSkill(...) } catch (e) { expect(String(e)).not.toContain('SHA256 mismatch') }
		// Demonstrate: ANY error that isn't SHA256 would make the test "pass".

		let testWouldPass = true
		try {
			throw new Error('Completely unrelated filesystem error')
		} catch (e) {
			// Exact same assertion as the existing test
			const passes = !String(e).includes('SHA256 mismatch')
			testWouldPass = passes
		}
		// The test "passes" even though the function threw an unrelated error
		expect(testWouldPass).toBe(true)
	})

	it('correct approach: installSkill with matching hash and agents=[] should NOT throw', () => {
		vi.spyOn(process, 'cwd').mockReturnValue(testDir)

		const zipBuffer = makeZip({ 'skill.md': '# Test' })
		const hash = sha256hex(zipBuffer)

		// This is how the test SHOULD be written: assert no throw
		expect(() =>
			installSkill({
				slug: 'test-skill',
				buffer: zipBuffer,
				sha256: hash,
				scope: 'local',
				agents: [],
			}),
		).not.toThrow()
	})
})

// ============================================================
// TEST QUALITY: detectInstalled doesn't mock existsSync
// ============================================================
describe('TEST QUALITY: detectInstalled is environment-dependent', () => {
	it('without mocking, result depends entirely on machine state', () => {
		// On this dev machine, some agents may be installed (.claude/, .cursor/, etc.)
		// On CI, none would be. The existing tests only assert:
		//   - "returns an array" (always true)
		//   - "each has shape" (true for any agent)
		//   - "subset of all" (true by construction)
		// None of these can ever fail — they test nothing about the detection logic.
		const result = detectInstalled()
		expect(Array.isArray(result)).toBe(true) // this can NEVER fail
	})

	it('cannot mock existsSync with vi.spyOn in ESM — proves existing tests need vi.mock', async () => {
		// ESM modules are not configurable — vi.spyOn doesn't work on node:fs exports.
		// To properly test detectInstalled, the test file must use vi.mock('node:fs', ...) at top level.
		// The existing skill-agents.test.ts does neither — it just accepts whatever the machine returns.
		// This confirms the test quality issue: detectInstalled is effectively untested.
		const fs = await import('node:fs')
		expect(() => {
			vi.spyOn(fs, 'existsSync')
		}).toThrow(/Cannot spy/)
	})
})
