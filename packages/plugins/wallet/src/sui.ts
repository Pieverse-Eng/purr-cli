import { randomUUID } from 'node:crypto'

/**
 * Sui through the platform wallet. The platform supports Sui mainnet only and
 * names it explicitly on every request; it builds, policy-checks and journals
 * each send, and the TEE signs and broadcasts it (there is no raw-signing path
 * for hosted agents).
 */
export const SUI_NETWORK = 'sui:mainnet'

/** Circle's native USDC on Sui mainnet. */
export const SUI_USDC_COIN_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

const SUI_NATIVE_COIN_TYPE = /^0x0*2::sui::SUI$/

/** Whether a wallet command targets the Sui wallet (`--chain-type sui` or `--chain sui`). */
export function isSuiSelection(args: Record<string, string>): boolean {
  return args['chain-type'] === 'sui' || args.chain?.toLowerCase() === 'sui'
}

export type SuiAsset = { assetType: 'native' } | { assetType: 'sui_coin'; tokenAddress: string }

/** SUI (native), USDC, or any full Move coin type such as `0x…::module::NAME`. */
export function resolveSuiCoin(token: string | undefined): SuiAsset {
  const value = token?.trim()
  if (!value || value.toUpperCase() === 'SUI' || SUI_NATIVE_COIN_TYPE.test(value)) {
    return { assetType: 'native' }
  }
  if (value.toUpperCase() === 'USDC')
    return { assetType: 'sui_coin', tokenAddress: SUI_USDC_COIN_TYPE }
  if (value.includes('::')) return { assetType: 'sui_coin', tokenAddress: value }
  throw new Error(
    `Unknown Sui coin "${value}": use SUI, USDC, or a full coin type such as 0x…::module::NAME`,
  )
}

/**
 * The Idempotency-Key naming one Sui send: the caller's, or a fresh one. The
 * platform returns it as `operationId`; retrying an unresolved send
 * (`SUI_SUBMISSION_UNKNOWN`) with the same key reconciles it instead of
 * sending again.
 */
export function suiIdempotencyKey(args: Record<string, string>): string {
  return args['idempotency-key']?.trim() || randomUUID()
}

interface SuiFailureBody {
  ok: boolean
  code?: string
  error?: string
  reason?: string
  requestId?: string
  hash?: string
  operationId?: string
}

/**
 * An `ok: false` body that arrived with a 2xx status, such as a policy
 * deferral (202 `POLICY_DEFERRED` with its approval `requestId`). Keep every
 * id the caller needs to follow up, including the Idempotency-Key the send
 * used: rerunning with `--idempotency-key` resumes the same operation (for
 * example once the approval is granted).
 */
export function suiFailure(body: SuiFailureBody, fallback: string, idempotencyKey?: string): Error {
  const { ok: _ok, ...detail } = body
  return new Error(
    `${fallback}: ${JSON.stringify(idempotencyKey ? { ...detail, idempotencyKey } : detail)}`,
  )
}

/**
 * Drop fields that carry nothing for Sui: `chainId` is always 0 (Sui is named
 * by `caip2`), `transactionId` repeats `hash`, and `id` is a platform row id.
 */
export function withoutRedundantSuiFields<T extends Record<string, unknown>>(data: T): T {
  const { chainId: _chainId, transactionId: _transactionId, id: _id, ...rest } = data
  return rest as T
}

interface SuiSwapCoin {
  coinType?: string
  symbol?: string
}

/**
 * A confirmed swap in the shape of `wallet uniswap` results: what went in, what
 * came out, and the gas paid, plus the ids a caller needs. The actual output
 * is omitted rather than null when the fullnode had not reported it yet.
 */
export function compactSuiSwapResult(data: Record<string, unknown>): Record<string, unknown> {
  const coin = (value: unknown, amount: unknown) => {
    const { coinType, symbol } = (value ?? {}) as SuiSwapCoin
    return { coinType, symbol, ...(typeof amount === 'string' ? { amount } : {}) }
  }
  return {
    hash: data.hash,
    explorerUrl: data.explorerUrl,
    status: data.status,
    operationId: data.operationId,
    replayed: data.replayed,
    input: coin(data.fromCoin, data.amountIn),
    output: coin(data.toCoin, data.amountOut),
    ...(typeof data.gasUsedSui === 'string'
      ? { gas: { amount: data.gasUsedSui, symbol: 'SUI' } }
      : {}),
  }
}
