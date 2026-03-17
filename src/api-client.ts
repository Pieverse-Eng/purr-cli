import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.purrfectclaw')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const VALID_KEYS = ['api-url', 'api-token', 'instance-id'] as const
type ConfigKey = (typeof VALID_KEYS)[number]

function isValidKey(key: string): key is ConfigKey {
	return (VALID_KEYS as readonly string[]).includes(key)
}

function readConfigFile(): Record<string, string> {
	if (!existsSync(CONFIG_FILE)) return {}
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, string>
	} catch {
		return {}
	}
}

function writeConfigFile(data: Record<string, string>): void {
	mkdirSync(CONFIG_DIR, { recursive: true })
	writeFileSync(CONFIG_FILE, JSON.stringify(data, null, '\t'), { mode: 0o600 })
	// Ensure permissions even if file existed
	chmodSync(CONFIG_FILE, 0o600)
}

export function configSet(key: string, value: string): void {
	if (!isValidKey(key)) {
		throw new Error(`Invalid config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`)
	}
	const config = readConfigFile()
	writeConfigFile({ ...config, [key]: value })
}

export function configGet(key: string): string | undefined {
	if (!isValidKey(key)) {
		throw new Error(`Invalid config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`)
	}
	const config = readConfigFile()
	return config[key]
}

export function configList(): Record<string, string> {
	const config = readConfigFile()
	const masked: Record<string, string> = {}
	for (const [key, value] of Object.entries(config)) {
		if (key === 'api-token' && value.length > 8) {
			masked[key] = `${value.slice(0, 8)}${'*'.repeat(value.length - 8)}`
		} else {
			masked[key] = value
		}
	}
	return masked
}

export interface Credentials {
	apiUrl: string
	apiToken: string
	instanceId: string
}

export function resolveCredentials(): Credentials {
	const config = readConfigFile()

	const apiUrl = process.env.WALLET_API_URL ?? config['api-url']
	const apiToken = process.env.WALLET_API_TOKEN ?? config['api-token']
	const instanceId = process.env.WALLET_INSTANCE_ID ?? config['instance-id']

	const missing: string[] = []
	if (!apiUrl) missing.push('WALLET_API_URL env var or api-url config')
	if (!apiToken) missing.push('WALLET_API_TOKEN env var or api-token config')
	if (!instanceId) missing.push('WALLET_INSTANCE_ID env var or instance-id config')

	if (missing.length > 0) {
		throw new Error(
			`Missing required credentials:\n${missing.map((m) => `  - ${m}`).join('\n')}\n\nSet via env vars or run: purr config set <key> <value>`,
		)
	}

	// TypeScript narrowing: missing.length === 0 guarantees all three are truthy
	return { apiUrl: apiUrl!, apiToken: apiToken!, instanceId: instanceId! }
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
	const { apiUrl, apiToken } = resolveCredentials()
	const url = `${apiUrl.replace(/\/$/, '')}${path}`

	const res = await fetch(url, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
	})

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`API error ${res.status} GET ${path}: ${body}`)
	}

	return (await res.json()) as T
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
	const { apiUrl, apiToken } = resolveCredentials()
	const url = `${apiUrl.replace(/\/$/, '')}${path}`

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const respBody = await res.text()
		throw new Error(`API error ${res.status} POST ${path}: ${respBody}`)
	}

	return (await res.json()) as T
}
