import { apiPost, resolveCredentials } from '../api-client.js'

export interface DflowSwapParams {
	fromToken: string
	toToken: string
	amount: string
	wallet: string
	slippage?: number
}

interface DflowSwapApiResponse {
	ok: boolean
	data: {
		hash: string
		from: string
		fromToken: string
		toToken: string
		fromAmount: string
		fromAmountBaseUnits: string
		estimatedToAmount: string
		estimatedToAmountFormatted?: string
		actualToAmount?: string
		actualToAmountFormatted?: string
		toTokenSymbol: string
		toTokenDecimals: number
		chainId: number
		chainType: string
		provider: string
		executionMode: string
		transactionId?: string
	}
	error?: string
}

export async function dflowSwap(params: DflowSwapParams): Promise<DflowSwapApiResponse> {
	const { instanceId } = resolveCredentials()
	const path = `/v1/instances/${instanceId}/wallet/dflow/swap`

	const body = {
		fromToken: params.fromToken,
		toToken: params.toToken,
		fromAmount: params.amount,
		chain: 'SOL',
		slippage: params.slippage,
	}

	return apiPost<DflowSwapApiResponse>(path, body)
}
