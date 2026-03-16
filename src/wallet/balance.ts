import { apiGet, resolveCredentials } from '../api-client.js'

interface WalletBalanceResponse {
	ok: boolean
	data: {
		address: string
		chainId: number
		chainType: string
		balance: string
		balanceFormatted: string
		currency?: string
		symbol?: string
		decimals?: number
		tokenAddress?: string
	} | null
	error?: string
}

export async function walletBalance(args: Record<string, string>): Promise<void> {
	const { instanceId } = resolveCredentials()

	const params = new URLSearchParams()
	params.set('balance', 'true')

	if (args.token) {
		params.set('token', args.token)
		params.set('chain_type', args['chain-type'] ?? 'ethereum')
	} else if (args['chain-type']) {
		params.set('chain_type', args['chain-type'])
	}

	if (args['chain-id']) {
		params.set('chain_id', args['chain-id'])
	}

	const query = params.toString()
	const res = await apiGet<WalletBalanceResponse>(`/v1/instances/${instanceId}/wallet?${query}`)

	if (!res.ok) {
		throw new Error(res.error ?? 'Failed to get wallet balance')
	}

	if (!res.data) {
		throw new Error('No wallet found. Use `purr wallet address` first to create one.')
	}

	console.log(JSON.stringify(res.data))
}
