import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync } from 'fflate'
import { extractZip, installSkill } from '../skill/installer.js'

let testDir: string

beforeEach(() => {
	testDir = join(tmpdir(), `purr-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true })
	}
})

/** Create a small valid ZIP buffer with the given entries. */
function makeZip(entries: Record<string, string>): Buffer {
	const zipEntries: Record<string, Uint8Array> = {}
	for (const [name, content] of Object.entries(entries)) {
		zipEntries[name] = new TextEncoder().encode(content)
	}
	const zipped = zipSync(zipEntries)
	return Buffer.from(zipped)
}

function sha256(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex')
}

describe('extractZip', () => {
	it('extracts files to the target directory', () => {
		const buffer = makeZip({
			'readme.md': '# Hello',
			'src/index.ts': 'export default {}',
		})
		const target = join(testDir, 'output')

		extractZip(buffer, target)

		expect(existsSync(join(target, 'readme.md'))).toBe(true)
		expect(readFileSync(join(target, 'readme.md'), 'utf-8')).toBe('# Hello')
		expect(existsSync(join(target, 'src', 'index.ts'))).toBe(true)
		expect(readFileSync(join(target, 'src', 'index.ts'), 'utf-8')).toBe('export default {}')
	})

	it('rejects entries with path traversal (..)', () => {
		const buffer = makeZip({ '../escape.txt': 'malicious' })
		const target = join(testDir, 'safe')

		expect(() => extractZip(buffer, target)).toThrow(/path traversal/)
	})

	it('rejects entries with embedded .. segments', () => {
		const buffer = makeZip({ 'foo/../../etc/passwd': 'bad' })
		const target = join(testDir, 'safe')

		expect(() => extractZip(buffer, target)).toThrow(/path traversal/)
	})
})

describe('SHA256 verification', () => {
	it('passes when hash matches', () => {
		vi.spyOn(process, 'cwd').mockReturnValue(testDir)

		const zipBuffer = makeZip({ 'skill.md': '# My Skill' })
		const hash = sha256(zipBuffer)

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

	it('fails when hash does not match', () => {
		vi.spyOn(process, 'cwd').mockReturnValue(testDir)

		const zipBuffer = makeZip({ 'skill.md': '# My Skill' })

		expect(() =>
			installSkill({
				slug: 'test-skill',
				buffer: zipBuffer,
				sha256: 'wrong-hash-value',
				scope: 'local',
				agents: [],
			}),
		).toThrow(/SHA256 mismatch/)
	})
})
