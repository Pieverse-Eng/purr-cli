import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { SUI_NETWORK, suiFailure, suiIdempotencyKey } from './sui.js'

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
    const slippageBps = Number(args['slippage-bps'])
    if (!Number.isInteger(slippageBps) || slippageBps < 0) {
      throw new Error(`Invalid --slippage-bps: "${args['slippage-bps']}"`)
    }
    body.slippageBps = slippageBps
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
 * `--execute`. Execution re-quotes, keeps the accepted minimum output
 * (`--min-amount-out`, base units, e.g. a quote's `minAmountOutBaseUnits`),
 * and reports the confirmed `amountOut`.
 */
export async function walletSuiSwap(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const execute = args.execute === 'true'
  const endpoint = execute ? 'execute' : 'quote'
  const res = await apiPost<SuiSwapResponse>(
    `/v1/instances/${instanceId}/wallet/swap/${endpoint}`,
    buildSuiSwapBody(args),
    execute ? { headers: { 'Idempotency-Key': suiIdempotencyKey(args) } } : {},
  )
  if (!res.ok) throw suiFailure(res, `Sui swap ${endpoint} failed`)
  console.log(JSON.stringify(res.data))
}
