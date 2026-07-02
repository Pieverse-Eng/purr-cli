import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { parseChainId } from '@pieverseio/purr-core/shared'
import { SOLANA_CHAIN_ID, chainNameToId, resolveToken } from '@pieverseio/purr-core/token-registry'

export interface WalletTransferData {
  from: string
  to: string
  amount: string
  hash: string
  chainId?: number
  chainType: string
  assetType: string
}

interface WalletTransferResponse {
  ok: boolean
  data: WalletTransferData
  error?: string
}

export async function executeWalletTransfer(
  args: Record<string, string>,
): Promise<WalletTransferData> {
  const { instanceId } = resolveCredentials()

  const to = args.to
  if (!to) {
    throw new Error('Missing required argument: --to')
  }
  const amount = args.amount
  if (!amount) {
    throw new Error('Missing required argument: --amount')
  }

  const chainNameId = args.chain ? chainNameToId(args.chain) : undefined
  const chainType = args['chain-type'] ?? (chainNameId === SOLANA_CHAIN_ID ? 'solana' : 'ethereum')
  const isSolana = chainType === 'solana'

  // chain-id or a known chain alias is required for EVM, not needed for Solana.
  if (!isSolana && !args['chain-id'] && !args.chain) {
    throw new Error(
      'Missing required argument: --chain-id or --chain (not required for --chain-type solana)',
    )
  }
  const parsedChainId = isSolana
    ? undefined
    : args['chain-id']
      ? parseChainId(args['chain-id'])
      : chainNameId
  if (!isSolana && parsedChainId === undefined) {
    throw new Error(`Unknown --chain: ${args.chain}`)
  }

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

  return res.data
}

export async function walletTransfer(args: Record<string, string>): Promise<void> {
  const data = await executeWalletTransfer(args)
  console.log(JSON.stringify(data))
}
