/**
 * dflow-ows swap — Solana DFlow swap with OWS local-custody signing.
 *
 * Drop-in replacement for `purr dflow swap`: same CLI args, same output JSON
 * schema, same DFlow `/order` flow. The only difference is step 5 (sign +
 * broadcast + confirm) — runs locally with OWS instead of via the platform
 * signer.
 *
 * 6-step flow (mirrors api-server services/dflow-swap.ts):
 *   1. Resolve OWS Solana wallet address + input token decimals
 *   2. amount × 10^decimals → base units
 *   3. GET DFlow /order
 *   4. Parse response → base64 serialized tx
 *   5. Sign (OWS) + broadcast (Solana RPC) + confirm  ← OWS-specific
 *   6. (executionMode=async) DFlow /order-status poll for actualToAmount
 */

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { parseUnits } from 'viem'

import { owsWalletSignTransaction } from '../wallet/ows-sign-transaction.js'

// ---------------------------------------------------------------------------
// Constants — match api-server services/dflow-swap.ts where applicable.
// ---------------------------------------------------------------------------

const DFLOW_BASE =
  process.env.DFLOW_QUOTE_API_BASE_URL ||
  process.env.DFLOW_API_BASE_URL ||
  'https://dev-quote-api.dflow.net'
const DFLOW_ORDER_PATH = '/order'
const DFLOW_ORDER_STATUS_PATH = '/order-status'
const DFLOW_FETCH_TIMEOUT_MS = 15_000
const DFLOW_STATUS_POLL_MS = 2_000
const DFLOW_STATUS_MAX_ATTEMPTS = 30

const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com'

const SOL_SYSTEM_PROGRAM_ALIAS = '11111111111111111111111111111111'
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'

const SOLANA_CHAIN_ID = 501

// Hardcoded decimals for well-known mints — saves an RPC call. RPC is the
// fallback for unknown mints.
const KNOWN_MINT_DECIMALS: Record<string, number> = {
  [NATIVE_SOL_MINT]: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK
}

// ---------------------------------------------------------------------------
// HTTP / DFlow helpers — mirror api-server fetchJson / extractRoot pattern.
// ---------------------------------------------------------------------------

function dflowHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (process.env.DFLOW_API_KEY) h['x-api-key'] = process.env.DFLOW_API_KEY
  return h
}

async function fetchJson(
  url: string,
): Promise<{ ok: boolean; status: number; body?: unknown; text?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DFLOW_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: dflowHeaders(), signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, text }
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) }
    } catch {
      return { ok: false, status: res.status, text: 'Invalid JSON from DFlow API' }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, text: msg }
  } finally {
    clearTimeout(timer)
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function extractRoot(payload: unknown): Record<string, unknown> {
  const obj = asObject(payload)
  if (Object.keys(obj).length === 0) return obj
  const data = asObject(obj.data)
  return Object.keys(data).length > 0 ? data : obj
}

function normalizeSolMint(token: string): string {
  return token === SOL_SYSTEM_PROGRAM_ALIAS ? NATIVE_SOL_MINT : token
}

function isNativeSol(token: string): boolean {
  return token === NATIVE_SOL_MINT || token === SOL_SYSTEM_PROGRAM_ALIAS
}

// ---------------------------------------------------------------------------
// Step 1: SPL token decimals
// ---------------------------------------------------------------------------

async function resolveDecimals(mint: string, connection: Connection): Promise<number> {
  if (isNativeSol(mint)) return 9
  if (KNOWN_MINT_DECIMALS[mint] !== undefined) return KNOWN_MINT_DECIMALS[mint]
  const info = await connection.getParsedAccountInfo(new PublicKey(mint))
  const value = info.value
  if (
    value &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'parsed' in value.data
  ) {
    const parsed = (value.data as { parsed?: unknown }).parsed
    if (parsed && typeof parsed === 'object' && 'info' in parsed) {
      const decimals = (parsed as { info?: { decimals?: number } }).info?.decimals
      if (typeof decimals === 'number') return decimals
    }
  }
  throw new Error(`Failed to resolve SPL token decimals for mint ${mint}`)
}

// ---------------------------------------------------------------------------
// Step 5: broadcast + confirm via Solana RPC
// ---------------------------------------------------------------------------

async function broadcastAndConfirm(
  connection: Connection,
  signedB58: string,
  timeoutMs = 60_000,
): Promise<string> {
  const txBytes = bs58.decode(signedB58)
  const sig = await connection.sendRawTransaction(txBytes, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  const startedAt = Date.now()
  const pollMs = 2_000
  while (Date.now() - startedAt < timeoutMs) {
    const status = await connection.getSignatureStatuses([sig], { searchTransactionHistory: false })
    const v = status.value[0]
    if (v) {
      if (v.err) throw new Error(`Solana tx failed on-chain: ${JSON.stringify(v.err)}`)
      if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') return sig
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(`Solana tx confirmation timed out after ${timeoutMs}ms (sig=${sig})`)
}

// ---------------------------------------------------------------------------
// Step 6: DFlow /order-status polling for executionMode=async
// Mirrors api-server services/dflow-swap.ts pollDflowOrderStatus.
// ---------------------------------------------------------------------------

async function pollDflowOrderStatus(args: {
  signature: string
  lastValidBlockHeight?: number
}): Promise<{ status?: string; outAmount?: string }> {
  const url = new URL(`${DFLOW_BASE}${DFLOW_ORDER_STATUS_PATH}`)
  url.searchParams.set('signature', args.signature)
  if (args.lastValidBlockHeight !== undefined) {
    url.searchParams.set('lastValidBlockHeight', String(args.lastValidBlockHeight))
  }

  for (let i = 0; i < DFLOW_STATUS_MAX_ATTEMPTS; i++) {
    const res = await fetchJson(url.toString())
    if (res.ok) {
      const root = extractRoot(res.body)
      const status = asString(root.status)
      const outAmount = asString(root.outAmount) ?? asString(root.outputAmount)
      if (status === 'closed') return { status, outAmount }
      if (status === 'failed' || status === 'expired') {
        throw new Error(`DFlow order ${status}`)
      }
    }
    await new Promise((r) => setTimeout(r, DFLOW_STATUS_POLL_MS))
  }
  return {}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DflowOwsSwapInput {
  fromToken: string
  toToken: string
  amount: string // human-readable, e.g. "0.1"
  owsWallet: string
  owsToken?: string
  slippage?: number
  rpcUrl?: string
}

export interface DflowOwsSwapResult {
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
  chainType: 'solana'
  provider: 'dflow'
  executionMode: 'sync' | 'async'
  transactionId?: string
}

function slippageToBps(slippage?: number): string {
  if (slippage === undefined) return 'auto'
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 1) {
    throw new Error('slippage must be between 0 and 1')
  }
  return String(Math.round(slippage * 10_000))
}

function formatBaseUnits(baseUnits: string, decimals: number): string {
  const big = BigInt(baseUnits)
  if (decimals === 0) return big.toString()
  const divisor = 10n ** BigInt(decimals)
  const intPart = big / divisor
  const fracPart = big % divisor
  const fracStr = fracPart.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString()
}

export async function dflowOwsSwap(input: DflowOwsSwapInput): Promise<DflowOwsSwapResult> {
  const fromMint = normalizeSolMint(input.fromToken)
  const toMint = normalizeSolMint(input.toToken)
  const rpcUrl = input.rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC
  const connection = new Connection(rpcUrl, 'confirmed')

  // Step 1: address + decimals
  const fromDecimals = await resolveDecimals(fromMint, connection)

  // Step 2: amount → base units
  let fromAmountBaseUnits: string
  try {
    fromAmountBaseUnits = parseUnits(input.amount, fromDecimals).toString()
  } catch {
    throw new Error(`Invalid amount "${input.amount}" for ${fromDecimals} decimals`)
  }
  if (BigInt(fromAmountBaseUnits) <= 0n) {
    throw new Error('amount must be greater than 0')
  }

  // Need user pubkey for DFlow /order; pull it from the OWS wallet via
  // owsWalletSignTransaction's internal getWallet. To avoid signing now, we
  // peek via a minimal getWallet call here. owsWalletSignTransaction will
  // re-fetch when signing — slightly redundant, simple to reason about.
  const ows = await import('@open-wallet-standard/core')
  const wallet = ows.getWallet(input.owsWallet)
  const solanaAccount = wallet.accounts.find((a) => a.chainId.startsWith('solana:'))
  if (!solanaAccount) {
    throw new Error(`OWS wallet "${input.owsWallet}" has no Solana account`)
  }
  const userPubkey = solanaAccount.address

  // Step 3: GET DFlow /order
  const orderUrl = new URL(`${DFLOW_BASE}${DFLOW_ORDER_PATH}`)
  orderUrl.searchParams.set('inputMint', fromMint)
  orderUrl.searchParams.set('outputMint', toMint)
  orderUrl.searchParams.set('amount', fromAmountBaseUnits)
  orderUrl.searchParams.set('userPublicKey', userPubkey)
  orderUrl.searchParams.set('slippageBps', slippageToBps(input.slippage))
  orderUrl.searchParams.set('wrapAndUnwrapSol', 'true')
  const orderRes = await fetchJson(orderUrl.toString())
  if (!orderRes.ok) {
    throw new Error(
      `DFlow /order failed: ${orderRes.status} - ${(orderRes.text ?? '').slice(0, 240)}`,
    )
  }

  // Step 4: parse response
  const root = extractRoot(orderRes.body)
  const dflowTxBase64 =
    asString(root.transaction) ||
    asString(root.swapTransaction) ||
    asString(root.serializedTransaction)
  if (!dflowTxBase64) {
    throw new Error('DFlow /order response missing transaction')
  }
  const estimatedToAmount = asString(root.outAmount) || asString(root.outputAmount) || '0'
  const toTokenSymbol = asString(root.outputSymbol) || asString(root.outSymbol) || toMint
  const executionMode = asString(root.executionMode) === 'async' ? 'async' : 'sync'
  const lastValidBlockHeight = asNumber(root.lastValidBlockHeight)

  // Step 5: sign with OWS + broadcast + confirm
  // Convert base64 → base58 to fit owsWalletSignTransaction's BGW envelope shape.
  const txBytes = Buffer.from(dflowTxBase64, 'base64')
  const txBase58 = bs58.encode(new Uint8Array(txBytes))
  const signed = await owsWalletSignTransaction(
    JSON.stringify({
      txs: [
        {
          chainId: SOLANA_CHAIN_ID,
          data: { serializedTx: txBase58 },
        },
      ],
    }),
    undefined,
    { owsWallet: input.owsWallet, owsToken: input.owsToken },
  )
  const signedTxB58 = signed.txs[0].sig as string
  if (!signedTxB58 || typeof signedTxB58 !== 'string') {
    throw new Error('OWS sign-transaction returned no sig')
  }
  // Sanity: the patched tx should still parse as a valid Solana tx.
  try {
    VersionedTransaction.deserialize(bs58.decode(signedTxB58))
  } catch (err) {
    throw new Error(
      `Signed Solana tx failed to deserialize: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const hash = await broadcastAndConfirm(connection, signedTxB58)

  // Step 6: async polling — only when DFlow flagged the order async. Same
  // behavior as api-server services/dflow-swap.ts: errors during polling are
  // swallowed because the on-chain swap already succeeded; the field just
  // stays undefined (agent can resolve actualToAmount from explorer).
  let actualToAmount: string | undefined
  if (executionMode === 'async') {
    try {
      const status = await pollDflowOrderStatus({ signature: hash, lastValidBlockHeight })
      actualToAmount = status.outAmount
    } catch {
      // Intentionally swallowed — see comment above.
    }
  }

  // Output formatting (match api-server schema)
  const toDecimals = await resolveDecimals(toMint, connection)
  return {
    hash,
    from: userPubkey,
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.amount,
    fromAmountBaseUnits,
    estimatedToAmount,
    estimatedToAmountFormatted:
      estimatedToAmount !== '0' ? formatBaseUnits(estimatedToAmount, toDecimals) : undefined,
    actualToAmount,
    actualToAmountFormatted: actualToAmount
      ? formatBaseUnits(actualToAmount, toDecimals)
      : undefined,
    toTokenSymbol,
    toTokenDecimals: toDecimals,
    chainId: 0,
    chainType: 'solana',
    provider: 'dflow',
    executionMode,
    // `transactionId` in the api-server path is Privy's INTERNAL request ID,
    // distinct from the on-chain Solana signature (`hash`). OWS local custody
    // has no equivalent concept — the Solana sig IS the canonical identifier.
    // We surface it as `transactionId` too, keeping the field useful instead
    // of always-null.
    transactionId: hash,
  }
}

/**
 * Wrap `dflowOwsSwap`'s flat result in the same `{ ok, data }` envelope that
 * `purr dflow swap` returns from the platform API. Kept here (not inlined in
 * main.ts) so the envelope contract is test-covered — a refactor that drops
 * the wrap will break the test below, not just silently diverge from the
 * Privy drop-in guarantee.
 */
export function wrapDflowOwsResponse(result: DflowOwsSwapResult): {
  ok: true
  data: DflowOwsSwapResult
} {
  return { ok: true, data: result }
}

// Internal exports for tests (not part of public API).
export const __testing = {
  resolveDecimals,
  slippageToBps,
  formatBaseUnits,
  extractRoot,
  normalizeSolMint,
  isNativeSol,
  asString,
  asNumber,
}

// Re-export for any caller that wants to discriminate later.
export { asNumber as _asNumber, asString as _asString }
