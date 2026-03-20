import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAllAgents, getAgent } from '../skill/agents.js'

// Mutable flag that controls existsSync behavior in the mock
let existsSyncImpl: (p: string) => boolean = () => false

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		existsSync: (p: string | Buffer | URL) => existsSyncImpl(String(p)),
	}
})

describe('agent registry', () => {
	const expectedSlugs = ['openclaw', 'claude-code', 'cursor', 'windsurf', 'cline', 'github-copilot']

	it('has all expected agents registered', () => {
		const agents = getAllAgents()
		const slugs = agents.map((a) => a.slug)
		for (const expected of expectedSlugs) {
			expect(slugs).toContain(expected)
		}
	})

	it('each agent has name, slug, and path functions', () => {
		const agents = getAllAgents()
		for (const agent of agents) {
			expect(agent.name).toBeTruthy()
			expect(agent.slug).toBeTruthy()
			expect(typeof agent.localSkillPath).toBe('function')
			expect(typeof agent.globalSkillPath).toBe('function')
		}
	})

	it('path functions return correct directory structures', () => {
		const expectedPaths: Record<string, { localContains: string; globalContains: string }> = {
			openclaw: {
				localContains: '.openclaw/workspace/skills/my-skill',
				globalContains: '.openclaw/workspace/skills/my-skill',
			},
			'claude-code': {
				localContains: '.claude/skills/my-skill',
				globalContains: '.claude/skills/my-skill',
			},
			cursor: {
				localContains: '.cursor/skills/my-skill',
				globalContains: '.cursor/skills/my-skill',
			},
			windsurf: {
				localContains: '.windsurf/skills/my-skill',
				globalContains: '.windsurf/skills/my-skill',
			},
			cline: {
				localContains: '.cline/skills/my-skill',
				globalContains: '.cline/skills/my-skill',
			},
			'github-copilot': {
				localContains: '.github/copilot/skills/my-skill',
				globalContains: '.github/copilot/skills/my-skill',
			},
		}

		const agents = getAllAgents()
		for (const agent of agents) {
			const expected = expectedPaths[agent.slug]
			expect(expected, `Missing expected paths for ${agent.slug}`).toBeDefined()

			const localPath = agent.localSkillPath('/project', 'my-skill')
			const globalPath = agent.globalSkillPath('my-skill')

			expect(localPath).toContain(expected.localContains)
			expect(localPath).toMatch(/^\/project\//)
			expect(globalPath).toContain(expected.globalContains)
		}
	})
})

describe('getAgent', () => {
	it('returns the correct agent for a valid slug', () => {
		const agent = getAgent('claude-code')
		expect(agent).toBeDefined()
		expect(agent?.name).toBe('Claude Code')
		expect(agent?.slug).toBe('claude-code')
	})

	it('returns undefined for an unknown slug', () => {
		const agent = getAgent('nonexistent-agent')
		expect(agent).toBeUndefined()
	})

	it('returns correct agent for each known slug', () => {
		const slugToName: Record<string, string> = {
			openclaw: 'OpenClaw',
			'claude-code': 'Claude Code',
			cursor: 'Cursor',
			windsurf: 'Windsurf',
			cline: 'Cline',
			'github-copilot': 'GitHub Copilot',
		}
		for (const [slug, name] of Object.entries(slugToName)) {
			const agent = getAgent(slug)
			expect(agent?.name).toBe(name)
		}
	})
})

describe('detectInstalled', () => {
	// Need to dynamically import since the module uses the mocked existsSync
	async function importDetect() {
		const mod = await import('../skill/agents.js')
		return mod.detectInstalled
	}

	afterEach(() => {
		existsSyncImpl = () => false
	})

	it('returns only agents whose config directory exists', async () => {
		existsSyncImpl = (p) => p.includes('.claude')
		const detectInstalled = await importDetect()
		const result = detectInstalled()

		expect(result).toHaveLength(1)
		expect(result[0].slug).toBe('claude-code')
	})

	it('returns empty array when no agent directories exist', async () => {
		existsSyncImpl = () => false
		const detectInstalled = await importDetect()
		const result = detectInstalled()

		expect(result).toHaveLength(0)
	})

	it('returns multiple agents when multiple directories exist', async () => {
		existsSyncImpl = (p) => p.includes('.claude') || p.includes('.cursor')
		const detectInstalled = await importDetect()
		const result = detectInstalled()
		const slugs = result.map((a) => a.slug)

		expect(slugs).toContain('claude-code')
		expect(slugs).toContain('cursor')
		expect(result).toHaveLength(2)
	})
})
