import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_FILE = join(homedir(), '.purrfectclaw', 'config.json')
const DEFAULT_BASE_URL = 'https://marketplace.pieverse.io/api'

export interface SkillMeta {
	readonly slug: string
	readonly name: string
	readonly description: string
	readonly category: string
	readonly download_url: string
}

export interface SkillListResponse {
	readonly skills: readonly SkillMeta[]
	readonly total: number
}

export interface SkillDownloadResult {
	readonly buffer: Buffer
	readonly sha256: string
}

function loadConfig(): Record<string, string> {
	if (!existsSync(CONFIG_FILE)) return {}
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, string>
	} catch {
		return {}
	}
}

function resolveBaseUrl(): string {
	const fromEnv = process.env.SKILL_MARKETPLACE_URL
	if (fromEnv) return fromEnv.replace(/\/$/, '')

	const config = loadConfig()
	const fromConfig = config['skill-marketplace-url']
	if (fromConfig) return fromConfig.replace(/\/$/, '')

	return DEFAULT_BASE_URL
}

/**
 * List skills from the marketplace, with optional filtering.
 */
export async function listSkills(options?: {
	search?: string
	category?: string
	offset?: number
	limit?: number
}): Promise<SkillListResponse> {
	const baseUrl = resolveBaseUrl()
	const params = new URLSearchParams()

	if (options?.search) params.set('search', options.search)
	if (options?.category) params.set('category', options.category)
	if (options?.offset !== undefined) params.set('offset', String(options.offset))
	if (options?.limit !== undefined) params.set('limit', String(options.limit))

	const qs = params.toString()
	const url = `${baseUrl}/skills${qs ? `?${qs}` : ''}`

	let res: Response
	try {
		res = await fetch(url)
	} catch (err) {
		throw new Error(
			`Failed to connect to skill marketplace at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`Marketplace API error ${res.status} GET /skills: ${body}`)
	}

	return (await res.json()) as SkillListResponse
}

/**
 * Get full detail for a single skill by slug.
 */
export async function getSkill(slug: string): Promise<SkillMeta> {
	const baseUrl = resolveBaseUrl()
	const url = `${baseUrl}/skills/${encodeURIComponent(slug)}`

	let res: Response
	try {
		res = await fetch(url)
	} catch (err) {
		throw new Error(
			`Failed to connect to skill marketplace at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	if (res.status === 404) {
		throw new Error(`Skill "${slug}" not found on the marketplace`)
	}

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`Marketplace API error ${res.status} GET /skills/${slug}: ${body}`)
	}

	return (await res.json()) as SkillMeta
}

/**
 * Download a skill archive by slug. Returns the raw buffer and its SHA256 hash
 * (from the X-Skill-SHA256 response header).
 */
export async function downloadSkill(slug: string): Promise<SkillDownloadResult> {
	const baseUrl = resolveBaseUrl()
	const url = `${baseUrl}/skills/${encodeURIComponent(slug)}/download`

	let res: Response
	try {
		res = await fetch(url)
	} catch (err) {
		throw new Error(
			`Failed to connect to skill marketplace at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	if (res.status === 404) {
		throw new Error(`Skill "${slug}" not found on the marketplace`)
	}

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`Marketplace API error ${res.status} GET /skills/${slug}/download: ${body}`)
	}

	const sha256 = res.headers.get('X-Skill-SHA256')
	if (!sha256) {
		throw new Error(
			`Marketplace response for "${slug}" is missing the X-Skill-SHA256 header — cannot verify integrity`,
		)
	}

	const arrayBuffer = await res.arrayBuffer()
	const buffer = Buffer.from(arrayBuffer)

	return { buffer, sha256 }
}
