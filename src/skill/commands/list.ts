import pc from 'picocolors'
import { listSkills } from '../api.js'

export async function skillList(args: Record<string, string>): Promise<void> {
	const isRemote = args.remote === 'true'
	const isJson = args.json === 'true'

	if (isRemote) {
		await listRemoteSkills(args, isJson)
		return
	}

	// Installed mode will be implemented in US-007
	console.log('purr skill list: installed mode not implemented yet')
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
