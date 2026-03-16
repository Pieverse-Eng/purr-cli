import { apiPost, resolveCredentials } from '../api-client.js'

interface WalletAddressResponse {
	ok: boolean
	data: {
		address: string
		chainId: number
		chainType: string
		createdNow: boolean
	}
	error?: string
}

export async function walletAddress(args: Record<string, string>): Promise<void> {
	const { instanceId } = resolveCredentials()
	const body: Record<string, unknown> = {}

	if (args['chain-type']) {
		body.chainType = args['chain-type']
	}
	if (args['chain-id']) {
		body.chainId = Number.parseInt(args['chain-id'], 10)
	}

	const res = await apiPost<WalletAddressResponse>(
		`/v1/instances/${instanceId}/wallet/ensure`,
		body,
	)

	if (!res.ok) {
		throw new Error(res.error ?? 'Failed to get wallet address')
	}

	console.log(JSON.stringify(res.data))
}
