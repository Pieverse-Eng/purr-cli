import { parseUnits } from 'viem'
import { buildApprovalStep, isNative, parseBigInt, requireAddress } from '../shared.js'
import type { StepOutput, TxStep } from '../types.js'
import type { SwapCalldataResult } from './bitget-api.js'
import { swapCalldata, swapQuote } from './bitget-api.js'

// ---------------------------------------------------------------------------
// Chain code mapping
// ---------------------------------------------------------------------------

const CHAIN_CODE_TO_ID: Record<string, number> = {
  eth: 1,
  bnb: 56,
  base: 8453,
  arbitrum: 42161,
  matic: 137,
  optimism: 10,
}

function resolveChain(chain: string): { chainCode: string; chainId: number } {
  const lower = chain.toLowerCase()
  if (CHAIN_CODE_TO_ID[lower]) {
    return { chainCode: lower, chainId: CHAIN_CODE_TO_ID[lower] }
  }
  const asNum = Number.parseInt(lower, 10)
  for (const [code, id] of Object.entries(CHAIN_CODE_TO_ID)) {
    if (id === asNum) return { chainCode: code, chainId: id }
  }
  throw new Error(
    `Unsupported chain "${chain}". Supported: ${Object.keys(CHAIN_CODE_TO_ID).join(', ')}`,
  )
}

/** Bitget uses empty string for native tokens */
function toBitgetContract(token: string): string {
  return isNative(token) ? '' : token
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full swap args — purr calls Bitget API, encodes, and outputs steps */
export interface BitgetSwapArgs {
  fromToken: string
  toToken: string
  fromAmount: string // human-readable (e.g. "0.05")
  chain: string // chain code or ID
  wallet: string // user wallet address (for quote + calldata)
  slippage?: number // 0-1, default 0.03
}

/** Legacy args — pre-fetched calldata JSON (kept for backward compat) */
export interface BitgetSwapFromCalldataArgs {
  calldata: string // JSON from Bitget API
  fromToken: string
  amountWei: string
  chainId: number
}

// ---------------------------------------------------------------------------
// Full flow: quote → calldata → steps
// ---------------------------------------------------------------------------

export async function buildBitgetSwapSteps(args: BitgetSwapArgs): Promise<StepOutput> {
  requireAddress(args.wallet, 'wallet')
  if (!isNative(args.fromToken)) requireAddress(args.fromToken, 'from-token')
  if (!isNative(args.toToken)) requireAddress(args.toToken, 'to-token')

  const { chainCode, chainId } = resolveChain(args.chain)
  const slippage = args.slippage ?? 0.03
  if (slippage < 0 || slippage > 1) {
    throw new Error('--slippage must be between 0 and 1')
  }

  const fromContract = toBitgetContract(args.fromToken)
  const toContract = toBitgetContract(args.toToken)

  // Step 1: Quote
  const quoteResult = await swapQuote({
    fromChain: chainCode,
    fromContract,
    toContract,
    fromAmount: args.fromAmount,
    fromAddress: args.wallet,
  })

  if (quoteResult.error) {
    throw new Error(`Bitget quote failed: ${quoteResult.error} — ${quoteResult.message ?? ''}`)
  }

  const quoteData = quoteResult.data as
    | { market?: string; routes?: Array<{ market?: string }> }
    | undefined
  const market = quoteData?.market ?? quoteData?.routes?.[0]?.market
  if (!market) {
    throw new Error('Bitget returned no swap route for this token pair')
  }

  // Step 2: Calldata
  const calldataResult = await swapCalldata({
    fromChain: chainCode,
    fromContract,
    toContract,
    fromAmount: args.fromAmount,
    fromAddress: args.wallet,
    toAddress: args.wallet,
    market,
    slippage: slippage * 100, // Bitget expects percentage
  })

  if (calldataResult.error) {
    throw new Error(
      `Bitget calldata failed: ${calldataResult.error} — ${calldataResult.message ?? ''}`,
    )
  }

  const calldataData = calldataResult.data as SwapCalldataResult | undefined

  // Compute amountWei for native token value (native tokens always have 18 decimals)
  const amountWei = isNative(args.fromToken)
    ? parseUnits(args.fromAmount, 18).toString()
    : undefined

  // Step 3: Normalize into steps
  return normalizeCalldataToSteps(calldataData, args.fromToken, chainId, amountWei)
}

// ---------------------------------------------------------------------------
// Legacy: pre-fetched calldata → steps
// ---------------------------------------------------------------------------

export function buildBitgetSwapStepsFromCalldata(args: BitgetSwapFromCalldataArgs): StepOutput {
  let parsed: SwapCalldataResult
  try {
    parsed = JSON.parse(args.calldata) as SwapCalldataResult
  } catch {
    throw new Error('Invalid --calldata: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid --calldata: expected a JSON object')
  }

  if (!isNative(args.fromToken)) {
    requireAddress(args.fromToken, 'from-token')
  }

  parseBigInt(args.amountWei, 'amount-wei') // validate

  return normalizeCalldataToSteps(parsed, args.fromToken, args.chainId, args.amountWei)
}

// ---------------------------------------------------------------------------
// Shared normalization
// ---------------------------------------------------------------------------

function normalizeCalldataToSteps(
  data: SwapCalldataResult | undefined,
  fromToken: string,
  chainId: number,
  amountWei?: string,
): StepOutput {
  let txs = data?.txs
  if ((!txs || txs.length === 0) && data?.contract && data?.calldata) {
    // Flat format (bgwevmaggregator)
    const gasLimit = data.computeUnits ? Math.ceil(data.computeUnits * 1.3).toString() : undefined
    const nativeValue =
      isNative(fromToken) && amountWei ? `0x${BigInt(amountWei).toString(16)}` : '0x0'

    if (!isNative(fromToken)) {
      return {
        steps: [
          buildApprovalStep(
            fromToken,
            data.contract,
            amountWei ?? '0',
            chainId,
            'Approve token for Bitget router',
          ),
          {
            to: data.contract,
            data: data.calldata,
            value: '0x0',
            chainId,
            label: 'Bitget swap',
            gasLimit,
          },
        ],
      }
    }

    txs = [
      {
        to: data.contract,
        data: data.calldata,
        value: nativeValue,
        gasLimit,
      },
    ]
  }

  if (!txs || txs.length === 0) {
    throw new Error('Bitget returned no transaction data')
  }

  const txsLen = txs.length
  const steps: TxStep[] = txs.map((tx, i) => ({
    to: tx.to,
    data: tx.data,
    value: tx.value ?? '0x0',
    chainId,
    label: i < txsLen - 1 ? `Bitget approval ${i + 1}` : 'Bitget swap',
    gasLimit: tx.gasLimit,
  }))

  return { steps }
}
