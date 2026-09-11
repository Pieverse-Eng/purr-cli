import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { resolveToken } from '@pieverseio/purr-core/token-registry'

/** Like wallet uniswap: the platform owns quoting, route selection and custody. */
export async function walletPancake(args: Record<string, string>): Promise<void> {
  for (const flag of [
    'fees',
    'router',
    'path',
    'wallet',
    'deadline',
    'amount-in-wei',
    'amount-out-min-wei',
    'slippage-bps',
    'rpc-url',
    'recipient',
    'protocols',
  ]) {
    if (args[flag] !== undefined)
      throw new Error(
        `pancake swap does not accept --${flag}; use --from, --to, --amount and optional --slippage`,
      )
  }
  if (args['chain-id'] !== undefined && args['chain-id'] !== '56')
    throw new Error('PancakeSwap supports BNB Chain (56) only')
  if (args.chain !== undefined && !['bnb', 'bsc', '56'].includes(args.chain.toLowerCase()))
    throw new Error('PancakeSwap supports BNB Chain (56) only')
  const required = (key: string) => {
    if (!args[key]?.trim()) throw new Error(`Missing required argument: --${key}`)
    return args[key]
  }
  const body: Record<string, unknown> = {
    fromToken: resolveToken(required('from'), 56),
    toToken: resolveToken(required('to'), 56),
    fromAmount: required('amount'),
    chainId: 56,
  }
  if (args.slippage !== undefined) {
    const slippage = Number(args.slippage)
    if (!args.slippage.trim() || !Number.isFinite(slippage) || slippage < 0 || slippage >= 100)
      throw new Error('slippage must be a percentage from 0 to less than 100')
    body.slippageTolerance = slippage
  }
  if (args['min-amount-out'] !== undefined) body.minAmountOut = args['min-amount-out']
  const { instanceId } = resolveCredentials()
  const endpoint = args.execute === 'true' ? 'execute' : 'quote'
  const response = await apiPost<{ ok: boolean; data?: Record<string, unknown>; error?: string }>(
    `/v1/instances/${instanceId}/wallet/pancake/${endpoint}`,
    body,
  )
  if (!response.ok || !response.data)
    throw new Error(response.error ?? `PancakeSwap ${endpoint} failed`)
  console.log(JSON.stringify(response.data))
}
