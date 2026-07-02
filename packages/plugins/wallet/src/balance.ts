import { apiGet, resolveCredentials } from '@pieverseio/purr-core/api-client'
import {
  SOLANA_CHAIN_ID,
  chainNameToId,
  inferChainId,
  resolveToken,
} from '@pieverseio/purr-core/token-registry'

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

  const chainNameId = args.chain ? chainNameToId(args.chain) : undefined
  if (args.chain && chainNameId === undefined) {
    throw new Error(`Unknown --chain: ${args.chain}`)
  }
  const inferredChainId = args['chain-type'] === 'solana' ? SOLANA_CHAIN_ID : inferChainId(args)
  const chainType =
    args['chain-type'] ?? (inferredChainId === SOLANA_CHAIN_ID ? 'solana' : 'ethereum')

  if (args.token) {
    const tokenChainId = chainType === 'solana' ? SOLANA_CHAIN_ID : inferredChainId
    params.set('token', resolveToken(args.token, tokenChainId))
    params.set('chain_type', chainType)
  } else if (args['chain-type'] || args.chain) {
    params.set('chain_type', chainType)
  }

  if (args['chain-id']) {
    params.set('chain_id', args['chain-id'])
  } else if (chainType === 'ethereum' && chainNameId !== undefined) {
    params.set('chain_id', String(chainNameId))
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
