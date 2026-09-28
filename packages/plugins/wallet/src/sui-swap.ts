import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { SUI_NETWORK, compactSuiSwapResult, suiFailure, suiIdempotencyKey } from './sui.js'

interface SuiSwapResponse {
  ok: boolean
  data: Record<string, unknown>
  error?: string
}

function requiredArg(args: Record<string, string>, name: string): string {
  const value = args[name]?.trim()
  if (!value) throw new Error(`Missing required argument: --${name}`)
  return value
}

export function buildSuiSwapBody(args: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chainType: 'sui',
    caip2: SUI_NETWORK,
    // SUI, USDC, or a full coin type; the platform resolves and verifies them.
    fromCoin: requiredArg(args, 'from'),
    toCoin: requiredArg(args, 'to'),
    amount: requiredArg(args, 'amount'),
  }
  if (args['slippage-bps'] !== undefined) {
    throw new Error('sui-swap takes --slippage as a percentage (e.g. 0.5), not --slippage-bps')
  }
  if (args.slippage !== undefined) {
    // A percentage like the other wallet swaps; the platform works in basis points.
    const slippage = args.slippage.trim()
    if (!/^\d+(\.\d{1,2})?$/.test(slippage) || Number(slippage) <= 0 || Number(slippage) > 50) {
      throw new Error(
        '--slippage must be a percentage above 0 and at most 50, with up to 2 decimals',
      )
    }
    body.slippageBps = Math.round(Number(slippage) * 100)
  }
  if (args['min-amount-out']) {
    if (!/^\d+$/.test(args['min-amount-out'])) {
      throw new Error('--min-amount-out is in base units of the output coin (an integer)')
    }
    body.minAmountOutBaseUnits = args['min-amount-out']
  }
  return body
}

/**
 * Quote a Sui swap through the Cetus aggregator, or execute it with
 * `--execute`. `--slippage` is a percentage (default 0.5). Execution
 * re-quotes, never accepts less than the fresh quote less the slippage (or
 * an optional `--min-amount-out` in base units, if higher), and reports the
 * confirmed `amountOut`.
 */
export async function walletSuiSwap(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const execute = args.execute === 'true'
  const endpoint = execute ? 'execute' : 'quote'
  const key = execute ? suiIdempotencyKey(args) : undefined
  const res = await apiPost<SuiSwapResponse>(
    `/v1/instances/${instanceId}/wallet/swap/${endpoint}`,
    buildSuiSwapBody(args),
    key ? { headers: { 'Idempotency-Key': key } } : {},
  )
  if (!res.ok) throw suiFailure(res, `Sui swap ${endpoint} failed`, key)
  console.log(JSON.stringify(execute ? compactSuiSwapResult(res.data) : res.data))
}
