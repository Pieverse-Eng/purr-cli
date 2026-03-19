import pc from 'picocolors'
import { downloadSkill } from '../api.js'
import { getAgent } from '../agents.js'
import { installSkill } from '../installer.js'
import { getLockEntry, upsertLockEntry } from '../lock.js'
import type { LockEntry } from '../lock.js'

export async function skillInstall(args: Record<string, string>, positional: string[]): Promise<void> {
	const slug = positional[0]
	const isJson = args.json === 'true'
	const isGlobal = args.global === 'true'
	const isCopy = args.copy === 'true'
	const isForce = args.force === 'true'
	const scope = isGlobal ? 'global' : 'local' as const

	if (!slug) {
		console.error('Usage: purr skill install <slug> --agent <name> [--global] [--copy] [--force] [--json]')
		console.error('  --agent   Target agent(s), comma-separated (e.g. claude-code,cursor)')
		console.error('  --global  Install to global scope')
		console.error('  --copy    Force copy mode instead of symlink')
		console.error('  --force   Overwrite if already installed')
		console.error('  --json    Output result as JSON')
		process.exit(1)
	}

	const agentArg = args.agent
	if (!agentArg) {
		console.error('Error: --agent flag is required. Specify target agent(s), e.g. --agent claude-code')
		console.error('Use comma-separated values for multiple agents: --agent claude-code,cursor')
		process.exit(1)
	}

	const agentSlugs = agentArg.split(',').map(s => s.trim()).filter(Boolean)

	// Validate all agent names
	for (const agentSlug of agentSlugs) {
		const agent = getAgent(agentSlug)
		if (!agent) {
			console.error(`Error: Unknown agent "${agentSlug}". Valid agents: openclaw, claude-code, cursor, windsurf, cline, github-copilot`)
			process.exit(1)
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

	// Download from marketplace
	if (!isJson) {
		console.log(`Downloading skill "${slug}" from marketplace...`)
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
	const methods = Object.values(result.agentInstalls).map(a => a.method)
	const primaryMethod: 'symlink' | 'copy' = methods.includes('copy') ? 'copy' : 'symlink'

	// Update lock file
	const lockEntry: LockEntry = {
		slug,
		name: slug,
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
