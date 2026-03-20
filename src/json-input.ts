export function parseJsonCliArg<T>(raw: string, flagName: string): T {
	if (raw === '-') {
		throw new Error(`Invalid --${flagName}: pass a JSON string on the command line`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(`Invalid --${flagName}: expected valid JSON`)
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Invalid --${flagName}: expected a JSON object`)
	}

	return parsed as T
}
