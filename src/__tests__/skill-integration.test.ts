/**
 * Integration tests for skill management.
 * Spins up a mock Marketplace HTTP server and tests the full
 * list → install → list installed → remove → verify cleanup flow.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync } from 'fflate'

// ---------------------------------------------------------------------------
// Mock Marketplace server
// ---------------------------------------------------------------------------

const SKILLS_DB = [
	{
		slug: 'code-review',
		name: 'Code Review Helper',
		description: 'AI-powered code review assistant',
		category: 'Development',
		download_url: '/skills/code-review/download',
	},
	{
		slug: 'dune-analytics',
		name: 'Dune Analytics',
		description: 'Query blockchain data with DuneSQL',
		category: 'Crypto',
		download_url: '/skills/dune-analytics/download',
	},
]

function makeSkillZip(slug: string): Buffer {
	const skillMd = [
		'---',
		`name: ${slug}`,
		`description: "Skill ${slug}"`,
		'metadata:',
		'  author: test',
		'  version: "1.0.0"',
		'---',
		'',
		`# ${slug}`,
		'',
		'This is a test skill.',
	].join('\n')

	const entries: Record<string, Uint8Array> = {
		'SKILL.md': new TextEncoder().encode(skillMd),
		'references/guide.md': new TextEncoder().encode('# Guide\n\nSome reference docs.'),
	}

	return Buffer.from(zipSync(entries))
}

function sha256hex(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex')
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

	// GET /skills — list
	if (url.pathname === '/skills' && req.method === 'GET') {
		let skills = [...SKILLS_DB]
		const search = url.searchParams.get('search')
		const category = url.searchParams.get('category')

		if (search) {
			const q = search.toLowerCase()
			skills = skills.filter(
				(s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
			)
		}
		if (category) {
			skills = skills.filter((s) => s.category === category)
		}

		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ skills, total: skills.length }))
		return
	}

	// GET /skills/:slug/download — download ZIP
	const downloadMatch = url.pathname.match(/^\/skills\/([^/]+)\/download$/)
	if (downloadMatch && req.method === 'GET') {
		const slug = downloadMatch[1]
		const skill = SKILLS_DB.find((s) => s.slug === slug)
		if (!skill) {
			res.writeHead(404, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'Not found' }))
			return
		}

		const zip = makeSkillZip(slug)
		const hash = sha256hex(zip)

		res.writeHead(200, {
			'Content-Type': 'application/zip',
			'X-Skill-SHA256': hash,
		})
		res.end(zip)
		return
	}

	// GET /skills/:slug — detail
	const detailMatch = url.pathname.match(/^\/skills\/([^/]+)$/)
	if (detailMatch && req.method === 'GET') {
		const slug = detailMatch[1]
		const skill = SKILLS_DB.find((s) => s.slug === slug)
		if (!skill) {
			res.writeHead(404, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'Not found' }))
			return
		}

		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify(skill))
		return
	}

	// Fallback
	res.writeHead(404)
	res.end('Not found')
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let server: Server
let serverUrl: string
let testDir: string

beforeAll(async () => {
	server = createServer(handleRequest)
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve())
	})
	const addr = server.address()
	if (addr && typeof addr === 'object') {
		serverUrl = `http://127.0.0.1:${addr.port}`
	}
})

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve())
	})
})

beforeEach(() => {
	testDir = join(tmpdir(), `purr-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	mkdirSync(testDir, { recursive: true })

	// Point CLI at mock server and our temp directory
	process.env.SKILL_MARKETPLACE_URL = serverUrl
	vi.spyOn(process, 'cwd').mockReturnValue(testDir)
})

afterEach(() => {
	vi.restoreAllMocks()
	delete process.env.SKILL_MARKETPLACE_URL
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Marketplace API integration', () => {
	it('listSkills returns all skills', async () => {
		const { listSkills } = await import('../skill/api.js')
		const result = await listSkills()

		expect(result.total).toBe(2)
		expect(result.skills).toHaveLength(2)
		expect(result.skills[0].slug).toBe('code-review')
		expect(result.skills[1].slug).toBe('dune-analytics')
	})

	it('listSkills with search filter', async () => {
		const { listSkills } = await import('../skill/api.js')
		const result = await listSkills({ search: 'blockchain' })

		expect(result.total).toBe(1)
		expect(result.skills[0].slug).toBe('dune-analytics')
	})

	it('listSkills with category filter', async () => {
		const { listSkills } = await import('../skill/api.js')
		const result = await listSkills({ category: 'Development' })

		expect(result.total).toBe(1)
		expect(result.skills[0].slug).toBe('code-review')
	})

	it('getSkill returns skill detail', async () => {
		const { getSkill } = await import('../skill/api.js')
		const result = await getSkill('code-review')

		expect(result.slug).toBe('code-review')
		expect(result.name).toBe('Code Review Helper')
	})

	it('getSkill throws 404 for unknown slug', async () => {
		const { getSkill } = await import('../skill/api.js')
		await expect(getSkill('nonexistent')).rejects.toThrow(/not found/)
	})

	it('downloadSkill returns buffer and sha256', async () => {
		const { downloadSkill } = await import('../skill/api.js')
		const result = await downloadSkill('code-review')

		expect(result.buffer).toBeInstanceOf(Buffer)
		expect(result.buffer.length).toBeGreaterThan(0)
		expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)

		// Verify sha256 matches
		const actual = sha256hex(result.buffer)
		expect(result.sha256).toBe(actual)
	})
})

describe('Full install → list → remove flow', () => {
	it('install skill, verify files and lock, then remove cleanly', async () => {
		const { downloadSkill, getSkill } = await import('../skill/api.js')
		const { installSkill, uninstallSkill } = await import('../skill/installer.js')
		const { readLock, upsertLockEntry, removeLockEntry, getLockEntry } = await import('../skill/lock.js')
		const { getAgent } = await import('../skill/agents.js')

		const slug = 'code-review'

		// --- Step 1: Download from mock marketplace ---
		const [meta, download] = await Promise.all([getSkill(slug), downloadSkill(slug)])

		expect(meta.name).toBe('Code Review Helper')
		expect(download.sha256).toBeTruthy()

		// --- Step 2: Install to local scope with claude-code agent ---
		const agent = getAgent('claude-code')!
		const result = installSkill({
			slug,
			buffer: download.buffer,
			sha256: download.sha256,
			scope: 'local',
			agents: ['claude-code'],
		})

		// Verify canonical directory exists with skill files
		expect(existsSync(result.canonicalPath)).toBe(true)
		expect(existsSync(join(result.canonicalPath, 'SKILL.md'))).toBe(true)
		expect(existsSync(join(result.canonicalPath, 'references', 'guide.md'))).toBe(true)

		// Verify SKILL.md content
		const skillMd = readFileSync(join(result.canonicalPath, 'SKILL.md'), 'utf-8')
		expect(skillMd).toContain('name: code-review')

		// Verify agent symlink exists and points to canonical
		const agentPath = result.agentInstalls['claude-code'].path
		expect(existsSync(agentPath)).toBe(true)
		expect(result.agentInstalls['claude-code'].method).toBe('symlink')

		// Verify it's actually a symlink
		const stat = lstatSync(agentPath)
		expect(stat.isSymbolicLink()).toBe(true)

		// --- Step 3: Write lock entry ---
		const lockEntry = {
			slug,
			name: meta.name,
			sha256: download.sha256,
			installed_at: new Date().toISOString(),
			install_method: 'symlink' as const,
			canonical_path: result.canonicalPath,
			agent_installs: result.agentInstalls,
		}
		upsertLockEntry('local', lockEntry)

		// Verify lock file exists and contains entry
		const lock = readLock('local')
		expect(lock.skills).toHaveLength(1)
		expect(lock.skills[0].slug).toBe('code-review')
		expect(lock.skills[0].name).toBe('Code Review Helper')
		expect(lock.skills[0].sha256).toMatch(/^[a-f0-9]{64}$/)

		// Verify lock file is on disk
		const lockPath = join(testDir, 'skills-lock.json')
		expect(existsSync(lockPath)).toBe(true)

		// --- Step 4: List installed shows our skill ---
		const entry = getLockEntry('local', 'code-review')
		expect(entry).toBeDefined()
		expect(entry!.agent_installs['claude-code']).toBeDefined()

		// --- Step 5: Remove agent install ---
		uninstallSkill({ slug, scope: 'local', agentSlug: 'claude-code' })
		expect(existsSync(agentPath)).toBe(false)

		// Canonical should still exist
		expect(existsSync(result.canonicalPath)).toBe(true)

		// --- Step 6: Remove canonical ---
		uninstallSkill({ slug, scope: 'local' })
		expect(existsSync(result.canonicalPath)).toBe(false)

		// --- Step 7: Clean up lock ---
		removeLockEntry('local', 'code-review')
		const finalLock = readLock('local')
		expect(finalLock.skills).toHaveLength(0)
	})
})

describe('Multi-agent install', () => {
	it('installs to multiple agents via symlink sharing canonical', async () => {
		const { downloadSkill } = await import('../skill/api.js')
		const { installSkill, uninstallSkill } = await import('../skill/installer.js')

		const slug = 'dune-analytics'
		const download = await downloadSkill(slug)

		const result = installSkill({
			slug,
			buffer: download.buffer,
			sha256: download.sha256,
			scope: 'local',
			agents: ['claude-code', 'cursor'],
		})

		// Both agents should have installs
		expect(Object.keys(result.agentInstalls)).toHaveLength(2)
		expect(result.agentInstalls['claude-code']).toBeDefined()
		expect(result.agentInstalls['cursor']).toBeDefined()

		// Both should be symlinks to the same canonical
		const claudePath = result.agentInstalls['claude-code'].path
		const cursorPath = result.agentInstalls['cursor'].path
		expect(existsSync(claudePath)).toBe(true)
		expect(existsSync(cursorPath)).toBe(true)
		expect(lstatSync(claudePath).isSymbolicLink()).toBe(true)
		expect(lstatSync(cursorPath).isSymbolicLink()).toBe(true)

		// SKILL.md accessible through both symlinks
		expect(readFileSync(join(claudePath, 'SKILL.md'), 'utf-8')).toContain('name: dune-analytics')
		expect(readFileSync(join(cursorPath, 'SKILL.md'), 'utf-8')).toContain('name: dune-analytics')

		// Remove one agent — other and canonical survive
		uninstallSkill({ slug, scope: 'local', agentSlug: 'claude-code' })
		expect(existsSync(claudePath)).toBe(false)
		expect(existsSync(cursorPath)).toBe(true)
		expect(existsSync(result.canonicalPath)).toBe(true)

		// Remove other agent
		uninstallSkill({ slug, scope: 'local', agentSlug: 'cursor' })
		expect(existsSync(cursorPath)).toBe(false)

		// Clean up canonical
		uninstallSkill({ slug, scope: 'local' })
		expect(existsSync(result.canonicalPath)).toBe(false)
	})
})

describe('Copy mode install', () => {
	it('uses copy instead of symlink when copyMode is true', async () => {
		const { downloadSkill } = await import('../skill/api.js')
		const { installSkill } = await import('../skill/installer.js')

		const slug = 'code-review'
		const download = await downloadSkill(slug)

		const result = installSkill({
			slug,
			buffer: download.buffer,
			sha256: download.sha256,
			scope: 'local',
			agents: ['claude-code'],
			copyMode: true,
		})

		const agentPath = result.agentInstalls['claude-code'].path
		expect(result.agentInstalls['claude-code'].method).toBe('copy')
		expect(existsSync(agentPath)).toBe(true)

		// Should NOT be a symlink — it's a real directory
		expect(lstatSync(agentPath).isSymbolicLink()).toBe(false)
		expect(lstatSync(agentPath).isDirectory()).toBe(true)

		// Files should exist in the copy
		expect(readFileSync(join(agentPath, 'SKILL.md'), 'utf-8')).toContain('name: code-review')
	})
})

describe('SHA256 integrity check', () => {
	it('rejects install when hash does not match (tampered download)', async () => {
		const { downloadSkill } = await import('../skill/api.js')
		const { installSkill } = await import('../skill/installer.js')

		const download = await downloadSkill('code-review')

		// Tamper with the hash
		expect(() =>
			installSkill({
				slug: 'code-review',
				buffer: download.buffer,
				sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				scope: 'local',
				agents: ['claude-code'],
			}),
		).toThrow(/SHA256 mismatch/)
	})
})

describe('Error handling', () => {
	it('downloadSkill throws for nonexistent skill', async () => {
		const { downloadSkill } = await import('../skill/api.js')
		await expect(downloadSkill('nonexistent-skill')).rejects.toThrow(/not found/)
	})

	it('installSkill throws for unknown agent', async () => {
		const { downloadSkill } = await import('../skill/api.js')
		const { installSkill } = await import('../skill/installer.js')

		const download = await downloadSkill('code-review')

		expect(() =>
			installSkill({
				slug: 'code-review',
				buffer: download.buffer,
				sha256: download.sha256,
				scope: 'local',
				agents: ['totally-fake-agent'],
			}),
		).toThrow(/Unknown agent/)
	})
})

describe('Lock file isolation between scopes', () => {
	it('local and global lock files are independent', async () => {
		const { upsertLockEntry, readLock, getLockEntry } = await import('../skill/lock.js')

		const localEntry = {
			slug: 'local-skill',
			name: 'Local Skill',
			sha256: 'abc',
			installed_at: new Date().toISOString(),
			install_method: 'symlink' as const,
			canonical_path: '/fake/local',
			agent_installs: {},
		}

		upsertLockEntry('local', localEntry)

		// Local should have the entry
		const local = readLock('local')
		expect(local.skills).toHaveLength(1)
		expect(local.skills[0].slug).toBe('local-skill')

		// Global should be empty (different file)
		const globalEntry = getLockEntry('global', 'local-skill')
		expect(globalEntry).toBeUndefined()
	})
})
