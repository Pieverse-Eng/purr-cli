import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AgentDefinition {
	readonly name: string
	readonly slug: string
	localSkillPath(projectRoot: string, slug: string): string
	globalSkillPath(slug: string): string
}

const home = homedir()

const agents: readonly AgentDefinition[] = [
	{
		name: 'OpenClaw',
		slug: 'openclaw',
		localSkillPath: (projectRoot, slug) =>
			join(projectRoot, '.openclaw', 'workspace', 'skills', slug),
		globalSkillPath: (slug) => join(home, '.openclaw', 'workspace', 'skills', slug),
	},
	{
		name: 'Claude Code',
		slug: 'claude-code',
		localSkillPath: (projectRoot, slug) => join(projectRoot, '.claude', 'skills', slug),
		globalSkillPath: (slug) => join(home, '.claude', 'skills', slug),
	},
	{
		name: 'Cursor',
		slug: 'cursor',
		localSkillPath: (projectRoot, slug) => join(projectRoot, '.cursor', 'skills', slug),
		globalSkillPath: (slug) => join(home, '.cursor', 'skills', slug),
	},
	{
		name: 'Windsurf',
		slug: 'windsurf',
		localSkillPath: (projectRoot, slug) => join(projectRoot, '.windsurf', 'skills', slug),
		globalSkillPath: (slug) => join(home, '.windsurf', 'skills', slug),
	},
	{
		name: 'Cline',
		slug: 'cline',
		localSkillPath: (projectRoot, slug) => join(projectRoot, '.cline', 'skills', slug),
		globalSkillPath: (slug) => join(home, '.cline', 'skills', slug),
	},
	{
		name: 'GitHub Copilot',
		slug: 'github-copilot',
		localSkillPath: (projectRoot, slug) =>
			join(projectRoot, '.github', 'copilot', 'skills', slug),
		globalSkillPath: (slug) => join(home, '.github', 'copilot', 'skills', slug),
	},
]

/** Config directory markers used to detect if an agent is installed on the system. */
const agentConfigDirs: Record<string, string> = {
	openclaw: join(home, '.openclaw'),
	'claude-code': join(home, '.claude'),
	cursor: join(home, '.cursor'),
	windsurf: join(home, '.windsurf'),
	cline: join(home, '.cline'),
	'github-copilot': join(home, '.github', 'copilot'),
}

/**
 * Detect which agents are installed on the current system by probing their config directories.
 */
export function detectInstalled(): AgentDefinition[] {
	return agents.filter((agent) => {
		const configDir = agentConfigDirs[agent.slug]
		return configDir !== undefined && existsSync(configDir)
	})
}

/**
 * Look up a single agent by slug.
 */
export function getAgent(slug: string): AgentDefinition | undefined {
	return agents.find((a) => a.slug === slug)
}

/**
 * Get all registered agent definitions.
 */
export function getAllAgents(): readonly AgentDefinition[] {
	return agents
}
