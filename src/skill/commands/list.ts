import pc from 'picocolors'
import { listSkills } from '../api.js'
import { readLock } from '../lock.js'

export async function skillList(args: Record<string, string>): Promise<void> {
	const isRemote = args.remote === 'true'
	const isJson = args.json === 'true'

	if (isRemote) {
		await listRemoteSkills(args, isJson)
		return
	}

	listInstalledSkills(args, isJson)
}

function listInstalledSkills(args: Record<string, string>, json: boolean): void {
	const scope = args.global === 'true' ? 'global' : 'local'
	const lock = readLock(scope)

	if (json) {
		console.log(JSON.stringify(lock, null, 2))
		return
	}

	if (lock.skills.length === 0) {
		console.log(
			scope === 'global'
				? 'No skills installed globally. Use `purr skill install` to get started.'
				: 'No skills installed in this project. Use `purr skill install` to get started.',
		)
		return
	}

	console.log(
		pc.bold(
			`${lock.skills.length} skill${lock.skills.length !== 1 ? 's' : ''} installed (${scope}):\n`,
		),
	)

	for (const entry of lock.skills) {
		console.log(`  ${pc.cyan(pc.bold(entry.slug))}  ${entry.name}`)
		console.log(`  ${pc.dim('Installed:')} ${entry.installed_at}`)
		console.log(`  ${pc.dim('Path:')}      ${entry.canonical_path}`)

		const agentSlugs = Object.keys(entry.agent_installs)
		if (agentSlugs.length > 0) {
			console.log(`  ${pc.dim('Agents:')}`)
			for (const agentSlug of agentSlugs) {
				const info = entry.agent_installs[agentSlug]
				console.log(`    ${pc.yellow(agentSlug)}  ${pc.dim(info.path)}  (${info.method})`)
			}
		}

		console.log()
	}
}

async function listRemoteSkills(args: Record<string, string>, json: boolean): Promise<void> {
	const search = args.search
	const category = args.category

	let result: Awaited<ReturnType<typeof listSkills>>
	try {
		result = await listSkills({ search, category })
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	if (json) {
		console.log(JSON.stringify(result, null, 2))
		return
	}

	if (result.skills.length === 0) {
		console.log('No skills found.')
		return
	}

	console.log(pc.bold(`Found ${result.total} skill${result.total !== 1 ? 's' : ''}:\n`))

	for (const skill of result.skills) {
		console.log(`  ${pc.cyan(pc.bold(skill.slug))}  ${skill.name}`)
		console.log(`  ${pc.dim(skill.description)}`)
		console.log(`  ${pc.yellow(skill.category)}`)
		console.log()
	}
}
