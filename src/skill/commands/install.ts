import pc from 'picocolors'
import { downloadSkill, getSkill, listSkills } from '../api.js'
import { getAgent, detectInstalled, getAllAgents } from '../agents.js'
import { installSkill } from '../installer.js'
import { getLockEntry, upsertLockEntry } from '../lock.js'
import type { LockEntry } from '../lock.js'

function isTTY(): boolean {
	return process.stdin.isTTY === true
}

/**
 * Interactively search and select a skill slug from the marketplace.
 */
async function promptSkillSlug(): Promise<string> {
	const { text, select, isCancel } = await import('@clack/prompts')

	const searchInput = await text({
		message: 'Search for a skill on the marketplace',
		placeholder: 'e.g. code-review, linting...',
	})

	if (isCancel(searchInput)) {
		process.exit(0)
	}

	const searchTerm = (searchInput as string).trim()

	let skills: Awaited<ReturnType<typeof listSkills>>
	try {
		skills = await listSkills({ search: searchTerm || undefined, limit: 20 })
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	if (skills.skills.length === 0) {
		console.error(`No skills found${searchTerm ? ` matching "${searchTerm}"` : ''}.`)
		process.exit(1)
	}

	const selected = await select({
		message: 'Select a skill to install',
		options: skills.skills.map((s) => ({
			value: s.slug,
			label: `${s.name} ${pc.dim(`(${s.slug})`)}`,
			hint: s.description,
		})),
	})

	if (isCancel(selected)) {
		process.exit(0)
	}

	return selected as string
}

/**
 * Interactively select target agents from detected installed agents.
 */
async function promptAgentSelection(): Promise<string[]> {
	const { multiselect, isCancel } = await import('@clack/prompts')

	const detected = detectInstalled()

	if (detected.length === 0) {
		console.error('No agents detected on this system.')
		console.error('Specify target agent(s) manually with --agent <name>')
		console.error(
			`Valid agents: ${getAllAgents()
				.map((a) => a.slug)
				.join(', ')}`,
		)
		process.exit(1)
	}

	const selected = await multiselect({
		message: 'Select target agent(s) to install the skill to',
		options: detected.map((a) => ({
			value: a.slug,
			label: a.name,
		})),
		required: true,
	})

	if (isCancel(selected)) {
		process.exit(0)
	}

	return selected as string[]
}

export async function skillInstall(
	args: Record<string, string>,
	positional: string[],
): Promise<void> {
	let slug = positional[0]
	const isJson = args.json === 'true'
	const isGlobal = args.global === 'true'
	const isCopy = args.copy === 'true'
	const isForce = args.force === 'true'
	const scope = isGlobal ? 'global' : ('local' as const)

	// Interactive skill search if no slug provided
	if (!slug) {
		if (!isTTY()) {
			console.error(
				'Usage: purr skill install <slug> --agent <name> [--global] [--copy] [--force] [--json]',
			)
			console.error('  --agent   Target agent(s), comma-separated (e.g. claude-code,cursor)')
			console.error('  --global  Install to global scope')
			console.error('  --copy    Force copy mode instead of symlink')
			console.error('  --force   Overwrite if already installed')
			console.error('  --json    Output result as JSON')
			process.exit(1)
		}
		slug = await promptSkillSlug()
	}

	// Interactive agent selection if no --agent provided
	let agentSlugs: string[]
	const agentArg = args.agent
	if (!agentArg) {
		if (!isTTY()) {
			console.error(
				'Error: --agent flag is required. Specify target agent(s), e.g. --agent claude-code',
			)
			console.error('Use comma-separated values for multiple agents: --agent claude-code,cursor')
			process.exit(1)
		}
		agentSlugs = await promptAgentSelection()
	} else {
		agentSlugs = agentArg
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)

		// Validate all agent names
		for (const agentSlug of agentSlugs) {
			const agent = getAgent(agentSlug)
			if (!agent) {
				console.error(
					`Error: Unknown agent "${agentSlug}". Valid agents: ${getAllAgents()
						.map((a) => a.slug)
						.join(', ')}`,
				)
				process.exit(1)
			}
		}
	}

	// Check if already installed (unless --force)
	if (!isForce) {
		const existing = getLockEntry(scope, slug)
		if (existing) {
			console.error(`Skill "${slug}" is already installed (${scope}). Use --force to overwrite.`)
			process.exit(1)
		}
	}

	// Fetch skill metadata for display name (also validates slug exists)
	let skillName = slug
	try {
		const meta = await getSkill(slug)
		skillName = meta.name
	} catch (err) {
		// 404 means skill doesn't exist — re-throw as clear error
		if (err instanceof Error && err.message.includes('not found')) {
			console.error(err.message)
			process.exit(1)
		}
		// Other network errors are non-fatal: fall back to slug as name
	}

	// Download from marketplace
	if (!isJson) {
		console.log(`Downloading skill "${skillName}" from marketplace...`)
	}

	let downloadResult: Awaited<ReturnType<typeof downloadSkill>>
	try {
		downloadResult = await downloadSkill(slug)
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	// Install (extract, symlink/copy to agents)
	if (!isJson) {
		console.log(`Installing to ${agentSlugs.join(', ')}...`)
	}

	let result: ReturnType<typeof installSkill>
	try {
		result = installSkill({
			slug,
			buffer: downloadResult.buffer,
			sha256: downloadResult.sha256,
			scope,
			agents: agentSlugs,
			copyMode: isCopy,
		})
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	// Determine primary install method for lock entry
	const methods = Object.values(result.agentInstalls).map((a) => a.method)
	const primaryMethod: 'symlink' | 'copy' = methods.includes('copy') ? 'copy' : 'symlink'

	// Update lock file
	const lockEntry: LockEntry = {
		slug,
		name: skillName,
		sha256: downloadResult.sha256,
		installed_at: new Date().toISOString(),
		install_method: primaryMethod,
		canonical_path: result.canonicalPath,
		agent_installs: result.agentInstalls,
	}

	upsertLockEntry(scope, lockEntry)

	// Output
	if (isJson) {
		console.log(JSON.stringify({ success: true, slug, scope, ...result }, null, 2))
		return
	}

	console.log(pc.green(`\nSkill "${slug}" installed successfully!`))
	console.log(`  ${pc.dim('Scope:')}     ${scope}`)
	console.log(`  ${pc.dim('Canonical:')} ${result.canonicalPath}`)
	for (const [agentSlug, info] of Object.entries(result.agentInstalls)) {
		console.log(`  ${pc.yellow(agentSlug)}: ${pc.dim(info.path)} (${info.method})`)
	}
}
