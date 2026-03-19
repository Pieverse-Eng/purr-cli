import pc from 'picocolors'
import { readLock, getLockEntry, removeLockEntry, upsertLockEntry } from '../lock.js'
import type { LockEntry } from '../lock.js'
import { uninstallSkill } from '../installer.js'
import { getAgent, getAllAgents } from '../agents.js'

function isTTY(): boolean {
	return process.stdin.isTTY === true
}

/**
 * Interactively select a skill slug from installed skills.
 */
async function promptSkillSlug(scope: 'local' | 'global'): Promise<string> {
	const { select, isCancel } = await import('@clack/prompts')

	const lock = readLock(scope)

	if (lock.skills.length === 0) {
		console.error(
			scope === 'global'
				? 'No skills installed globally.'
				: 'No skills installed in this project.',
		)
		process.exit(1)
	}

	const selected = await select({
		message: 'Select a skill to remove',
		options: lock.skills.map((s) => ({
			value: s.slug,
			label: `${s.name} ${pc.dim(`(${s.slug})`)}`,
			hint: `Installed: ${s.installed_at}`,
		})),
	})

	if (isCancel(selected)) {
		process.exit(0)
	}

	return selected as string
}

/**
 * Show confirmation prompt listing what will be deleted.
 */
async function promptConfirmation(entry: LockEntry, agentSlug?: string): Promise<boolean> {
	const { confirm, isCancel } = await import('@clack/prompts')

	const lines: string[] = []
	if (agentSlug) {
		const info = entry.agent_installs[agentSlug]
		lines.push(`Agent: ${agentSlug} → ${info?.path ?? 'unknown'}`)
	} else {
		lines.push(`Canonical: ${entry.canonical_path}`)
		for (const [slug, info] of Object.entries(entry.agent_installs)) {
			lines.push(`Agent: ${slug} → ${info.path}`)
		}
	}

	console.log(pc.yellow('\nThe following will be removed:'))
	for (const line of lines) {
		console.log(`  ${pc.dim(line)}`)
	}
	console.log()

	const result = await confirm({
		message: `Remove skill "${entry.slug}"${agentSlug ? ` from ${agentSlug}` : ''}?`,
	})

	if (isCancel(result)) {
		process.exit(0)
	}

	return result === true
}

export async function skillRemove(args: Record<string, string>, positional: string[]): Promise<void> {
	let slug = positional[0]
	const isJson = args.json === 'true'
	const isGlobal = args.global === 'true'
	const isYes = args.yes === 'true'
	const scope = isGlobal ? 'global' : 'local' as const
	const agentSlug = args.agent

	// Validate --agent if provided
	if (agentSlug) {
		const agent = getAgent(agentSlug)
		if (!agent) {
			console.error(`Error: Unknown agent "${agentSlug}". Valid agents: ${getAllAgents().map(a => a.slug).join(', ')}`)
			process.exit(1)
		}
	}

	// Interactive slug selection if none provided
	if (!slug) {
		if (!isTTY()) {
			console.error('Usage: purr skill remove <slug> [--agent <name>] [--global] [--yes] [--json]')
			console.error('  --agent   Remove only from a specific agent')
			console.error('  --global  Remove from global scope')
			console.error('  --yes     Skip confirmation prompt')
			console.error('  --json    Output result as JSON')
			process.exit(1)
		}
		slug = await promptSkillSlug(scope)
	}

	// Look up the lock entry
	const entry = getLockEntry(scope, slug)
	if (!entry) {
		console.error(`Skill "${slug}" is not installed (${scope}).`)
		process.exit(1)
	}

	// Validate that the specified agent is actually in the lock entry
	if (agentSlug && !entry.agent_installs[agentSlug]) {
		console.error(`Skill "${slug}" is not installed for agent "${agentSlug}".`)
		process.exit(1)
	}

	// Confirmation prompt (unless --yes or --json)
	if (!isYes && !isJson) {
		if (!isTTY()) {
			console.error('Confirmation required. Use --yes to skip, or run in an interactive terminal.')
			process.exit(1)
		}
		const confirmed = await promptConfirmation(entry, agentSlug)
		if (!confirmed) {
			console.log('Aborted.')
			return
		}
	}

	// Perform removal
	if (agentSlug) {
		// Remove from a single agent
		uninstallSkill({ slug, scope, agentSlug })

		// Update lock entry: remove this agent from agent_installs
		const remainingInstalls = { ...entry.agent_installs }
		delete remainingInstalls[agentSlug]

		if (Object.keys(remainingInstalls).length === 0) {
			// Last agent removed — clean up canonical and remove lock entry
			uninstallSkill({ slug, scope })
			removeLockEntry(scope, slug)
		} else {
			// Other agents remain — update the lock entry
			const updatedEntry: LockEntry = {
				...entry,
				agent_installs: remainingInstalls,
			}
			upsertLockEntry(scope, updatedEntry)
		}
	} else {
		// Remove from all agents
		for (const agentKey of Object.keys(entry.agent_installs)) {
			uninstallSkill({ slug, scope, agentSlug: agentKey })
		}
		// Remove canonical directory
		uninstallSkill({ slug, scope })
		// Remove lock entry
		removeLockEntry(scope, slug)
	}

	// Output
	if (isJson) {
		console.log(JSON.stringify({
			success: true,
			slug,
			scope,
			removed_agent: agentSlug ?? null,
		}, null, 2))
		return
	}

	if (agentSlug) {
		console.log(pc.green(`\nSkill "${slug}" removed from agent "${agentSlug}".`))
	} else {
		console.log(pc.green(`\nSkill "${slug}" removed successfully.`))
	}
}
