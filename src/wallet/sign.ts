import { apiPost, resolveCredentials } from '../api-client.js'

interface WalletSignResponse {
	ok: boolean
	data: {
		address: string
		signature: string
		chainType: string
		message: string
	}
	error?: string
}

export async function walletSign(args: Record<string, string>): Promise<void> {
	const { instanceId } = resolveCredentials()

	const address = args.address
	if (!address) {
		throw new Error('Missing required argument: --address')
	}
	const message = args.message
	if (!message) {
		throw new Error('Missing required argument: --message')
	}

	const body: Record<string, unknown> = { message }
	if (args['chain-type']) {
		body.chainType = args['chain-type']
	}

	const res = await apiPost<WalletSignResponse>(`/v1/instances/${instanceId}/wallet/sign`, body)

	if (!res.ok) {
		throw new Error(res.error ?? 'Failed to sign message')
	}

	console.log(JSON.stringify(res.data))
}
