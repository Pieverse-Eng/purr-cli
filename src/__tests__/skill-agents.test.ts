import { describe, expect, it } from 'vitest'
import { detectInstalled, getAgent, getAllAgents } from '../skill/agents.js'

describe('agent registry', () => {
	const expectedSlugs = [
		'openclaw',
		'claude-code',
		'cursor',
		'windsurf',
		'cline',
		'github-copilot',
	]

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

	it('path functions return strings containing the slug', () => {
		const agents = getAllAgents()
		for (const agent of agents) {
			const localPath = agent.localSkillPath('/project', 'my-skill')
			const globalPath = agent.globalSkillPath('my-skill')
			expect(localPath).toContain('my-skill')
			expect(globalPath).toContain('my-skill')
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
	it('returns an array', () => {
		const installed = detectInstalled()
		expect(Array.isArray(installed)).toBe(true)
	})

	it('each detected agent has the AgentDefinition shape', () => {
		const installed = detectInstalled()
		for (const agent of installed) {
			expect(agent.name).toBeTruthy()
			expect(agent.slug).toBeTruthy()
			expect(typeof agent.localSkillPath).toBe('function')
			expect(typeof agent.globalSkillPath).toBe('function')
		}
	})

	it('only returns agents that are a subset of all agents', () => {
		const all = getAllAgents()
		const allSlugs = all.map((a) => a.slug)
		const installed = detectInstalled()
		for (const agent of installed) {
			expect(allSlugs).toContain(agent.slug)
		}
	})
})
