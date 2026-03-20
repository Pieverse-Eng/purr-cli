import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || 'onchainos'

async function runOnchainosJson(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(ONCHAINOS_BIN, args, {
      maxBuffer: 10 * 1024 * 1024,
    })
    const trimmed = stdout.trim()
    if (!trimmed) {
      throw new Error(`onchainos returned no output for: ${args.join(' ')}`)
    }
    try {
      return JSON.parse(trimmed)
    } catch {
      throw new Error(`onchainos returned non-JSON output for: ${args.join(' ')}`)
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stderr?: string
      stdout?: string
    }
    if (err.code === 'ENOENT') {
      throw new Error(
        'onchainos binary not found. Install onchainos or set ONCHAINOS_BIN to the binary path.',
      )
    }
    const details = err.stderr?.trim() || err.stdout?.trim() || err.message
    throw new Error(`onchainos ${args.join(' ')} failed: ${details}`)
  }
}

interface OkxCliEnvelope<T> {
  ok?: boolean
  error?: string
  data?: T
}

function unwrapOkxResponse<T>(raw: unknown, context: string): T {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Unexpected onchainos response for ${context}`)
  }
  const response = raw as OkxCliEnvelope<T>
  if (!response.ok) {
    throw new Error(response.error || `onchainos ${context} failed`)
  }
  if (response.data === undefined) {
    throw new Error(`onchainos ${context} returned no data`)
  }
  return response.data
}

function unwrapFirstItem<T>(raw: unknown, context: string): T {
  const data = unwrapOkxResponse<unknown>(raw, context)
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`onchainos ${context} returned no items`)
  }
  return data[0] as T
}

export interface OkxSupportedChain {
  chainId: number
  chainIndex: number
  chainName: string
  dexTokenApproveAddress: string
}

export async function swapChains(): Promise<OkxSupportedChain[]> {
  return unwrapOkxResponse<OkxSupportedChain[]>(
    await runOnchainosJson(['swap', 'chains']),
    'swap chains',
  )
}

export interface OkxLiquiditySource {
  id: string
  logo: string
  name: string
}

export async function swapLiquidity(params: { chain: string }): Promise<OkxLiquiditySource[]> {
  return unwrapOkxResponse<OkxLiquiditySource[]>(
    await runOnchainosJson(['swap', 'liquidity', '--chain', params.chain]),
    'swap liquidity',
  )
}

export interface OkxSwapQuoteParams {
  fromToken: string
  toToken: string
  amount: string
  chain: string
  swapMode?: 'exactIn' | 'exactOut'
}

export interface OkxSwapQuoteResult {
  chainIndex?: string
  dexRouterList?: Array<{
    dexProtocol?: {
      dexName?: string
      percent?: string
    }
  }>
  estimateGasFee?: string
  fromToken?: {
    decimal?: string
    isHoneyPot?: boolean
    taxRate?: string
    tokenContractAddress?: string
    tokenSymbol?: string
    tokenUnitPrice?: string
  }
  fromTokenAmount?: string
  priceImpactPercent?: string
  router?: string
  swapMode?: 'exactIn' | 'exactOut' | string
  toToken?: {
    decimal?: string
    isHoneyPot?: boolean
    taxRate?: string
    tokenContractAddress?: string
    tokenSymbol?: string
    tokenUnitPrice?: string
  }
  toTokenAmount?: string
  tradeFee?: string
}

export async function swapQuote(params: OkxSwapQuoteParams): Promise<OkxSwapQuoteResult> {
  const args = [
    'swap',
    'quote',
    '--from',
    params.fromToken,
    '--to',
    params.toToken,
    '--amount',
    params.amount,
    '--chain',
    params.chain,
  ]
  if (params.swapMode) {
    args.push('--swap-mode', params.swapMode)
  }
  return unwrapFirstItem<OkxSwapQuoteResult>(await runOnchainosJson(args), 'swap quote')
}

export interface OkxSwapApproveParams {
  token: string
  amount: string
  chain: string
}

export interface OkxSwapApproveResult {
  data?: string
  dexContractAddress?: string
  gasLimit?: string
  gasPrice?: string
}

export async function swapApprove(params: OkxSwapApproveParams): Promise<OkxSwapApproveResult> {
  return unwrapFirstItem<OkxSwapApproveResult>(
    await runOnchainosJson([
      'swap',
      'approve',
      '--token',
      params.token,
      '--amount',
      params.amount,
      '--chain',
      params.chain,
    ]),
    'swap approve',
  )
}

export interface OkxSwapSwapParams {
  fromToken: string
  toToken: string
  amount: string
  chain: string
  wallet: string
  slippagePercent?: number
  swapMode?: 'exactIn' | 'exactOut'
  gasLevel?: 'slow' | 'average' | 'fast'
  maxAutoSlippagePercent?: number
}

export interface OkxSwapTxResult {
  routerResult?: {
    fromTokenAmount?: string
    toTokenAmount?: string
    priceImpactPercent?: string
  }
  tx?: {
    from?: string
    to?: string
    data?: string
    gas?: string
    gasPrice?: string
    value?: string
    minReceiveAmount?: string
    maxSpendAmount?: string
    slippagePercent?: string
  }
}

export async function swapSwap(params: OkxSwapSwapParams): Promise<OkxSwapTxResult> {
  const args = [
    'swap',
    'swap',
    '--from',
    params.fromToken,
    '--to',
    params.toToken,
    '--amount',
    params.amount,
    '--chain',
    params.chain,
    '--wallet',
    params.wallet,
  ]
  if (params.slippagePercent !== undefined) {
    args.push('--slippage', String(params.slippagePercent))
  }
  if (params.swapMode) {
    args.push('--swap-mode', params.swapMode)
  }
  if (params.gasLevel) {
    args.push('--gas-level', params.gasLevel)
  }
  if (params.maxAutoSlippagePercent !== undefined) {
    args.push('--max-auto-slippage', String(params.maxAutoSlippagePercent))
  }
  return unwrapFirstItem<OkxSwapTxResult>(await runOnchainosJson(args), 'swap swap')
}
