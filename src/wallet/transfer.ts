import { apiPost, resolveCredentials } from '../api-client.js'
import { parseChainId } from '../shared.js'
import { SOLANA_CHAIN_ID, resolveToken } from '../token-registry.js'

interface WalletTransferResponse {
  ok: boolean
  data: {
    from: string
    to: string
    amount: string
    hash: string
    chainId?: number
    chainType: string
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

  const chainType = args['chain-type'] ?? 'ethereum'
  const isSolana = chainType === 'solana'

  // chain-id is required for EVM, not needed for Solana
  if (!isSolana && !args['chain-id']) {
    throw new Error('Missing required argument: --chain-id (not required for --chain-type solana)')
  }
  const parsedChainId = args['chain-id'] ? parseChainId(args['chain-id']) : undefined

  const body: Record<string, unknown> = {
    to,
    amount,
    chainType,
  }

  if (parsedChainId !== undefined) {
    body.chainId = parsedChainId
  }

  if (args.token) {
    body.assetType = isSolana ? 'spl' : 'erc20'
    const tokenChainId = isSolana ? SOLANA_CHAIN_ID : (parsedChainId as number)
    body.tokenAddress = resolveToken(args.token, tokenChainId)
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
