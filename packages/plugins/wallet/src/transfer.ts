import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { isNative, parseChainId } from '@pieverseio/purr-core/shared'
import { SOLANA_CHAIN_ID, chainNameToId, resolveToken } from '@pieverseio/purr-core/token-registry'
import {
  SUI_NETWORK,
  isSuiSelection,
  resolveSuiCoin,
  suiFailure,
  suiIdempotencyKey,
  withoutRedundantSuiFields,
} from './sui.js'

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

  if (isSuiSelection(args)) return executeSuiTransfer(instanceId, args, to, amount)

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
    const tokenChainId = isSolana ? SOLANA_CHAIN_ID : (parsedChainId as number)
    const tokenAddress = resolveToken(args.token, tokenChainId)
    if (!isSolana && isNative(tokenAddress)) {
      body.assetType = 'native'
    } else {
      body.assetType = isSolana ? 'spl' : 'erc20'
      body.tokenAddress = tokenAddress
    }
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

/**
 * Sui transfers name the network, take decimals from chain metadata and carry
 * an Idempotency-Key, so an unresolved send can be retried safely with
 * `--idempotency-key <operationId>`.
 */
async function executeSuiTransfer(
  instanceId: string,
  args: Record<string, string>,
  to: string,
  amount: string,
): Promise<WalletTransferData> {
  if (args.decimals || args['chain-id']) {
    throw new Error(
      'Sui transfers take decimals from chain metadata; omit --decimals and --chain-id',
    )
  }
  const key = suiIdempotencyKey(args)
  const res = await apiPost<WalletTransferResponse>(
    `/v1/instances/${instanceId}/wallet/transfer`,
    { chainType: 'sui', caip2: SUI_NETWORK, to, amount, ...resolveSuiCoin(args.token) },
    { headers: { 'Idempotency-Key': key } },
  )
  if (!res.ok) throw suiFailure(res, 'Transfer failed', key)
  return withoutRedundantSuiFields({ ...res.data })
}

export async function walletTransfer(args: Record<string, string>): Promise<void> {
  const data = await executeWalletTransfer(args)
  console.log(JSON.stringify(data))
}
