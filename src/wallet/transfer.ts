import { apiPost, resolveCredentials } from '../api-client.js'

interface WalletTransferResponse {
	ok: boolean
	data: {
		from: string
		to: string
		amount: string
		hash: string
		chainId: number
		assetType: string
	}
	error?: string
}

export async function walletTransfer(args: Record<string, string>): Promise<void> {
	const { instanceId } = resolveCredentials()

	const to = args.to
	if (!to) {
		throw new Error('Missing required argument: --to')
	}
	const amount = args.amount
	if (!amount) {
		throw new Error('Missing required argument: --amount')
	}
	const chainId = args['chain-id']
	if (!chainId) {
		throw new Error('Missing required argument: --chain-id')
	}

	const body: Record<string, unknown> = {
		to,
		amount,
		chainId: Number.parseInt(chainId, 10),
	}

	if (args.token) {
		body.assetType = 'erc20'
		body.tokenAddress = args.token
	} else {
		body.assetType = 'native'
	}

	if (args.decimals) {
		body.decimals = Number.parseInt(args.decimals, 10)
	}

	const res = await apiPost<WalletTransferResponse>(
		`/v1/instances/${instanceId}/wallet/transfer`,
		body,
	)

	if (!res.ok) {
		throw new Error(res.error ?? 'Transfer failed')
	}

	console.log(JSON.stringify(res.data))
}
