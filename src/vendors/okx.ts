import { createPublicClient, http, parseAbi, parseUnits } from 'viem'
import { buildApprovalStep, isNative, NATIVE_EVM, requireAddress } from '../shared.js'
import { resolveToken } from '../token-registry.js'
import type { StepOutput } from '../types.js'
import {
  swapApprove,
  swapChains,
  swapLiquidity,
  swapQuote,
  swapSwap,
  type OkxLiquiditySource,
  type OkxSupportedChain,
  type OkxSwapApproveResult,
  type OkxSwapQuoteResult,
  type OkxSwapSwapParams,
  type OkxSwapTxResult,
} from './okx-api.js'

const OKX_NATIVE_EVM = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const ERC20_DECIMALS_ABI = parseAbi(['function decimals() view returns (uint8)'])

type SwapMode = 'exactIn' | 'exactOut'
type GasLevel = 'slow' | 'average' | 'fast'

const SUPPORTED_OKX_CHAINS: Record<
  string,
  { chain: string; chainId: number; rpcUrl: string; nativeTickers: string[] }
> = {
  ethereum: {
    chain: 'ethereum',
    chainId: 1,
    rpcUrl: process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  eth: {
    chain: 'ethereum',
    chainId: 1,
    rpcUrl: process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  '1': {
    chain: 'ethereum',
    chainId: 1,
    rpcUrl: process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  bsc: {
    chain: 'bsc',
    chainId: 56,
    rpcUrl: process.env.BNB_RPC_URL || 'https://bsc-rpc.publicnode.com',
    nativeTickers: ['BNB'],
  },
  bnb: {
    chain: 'bsc',
    chainId: 56,
    rpcUrl: process.env.BNB_RPC_URL || 'https://bsc-rpc.publicnode.com',
    nativeTickers: ['BNB'],
  },
  '56': {
    chain: 'bsc',
    chainId: 56,
    rpcUrl: process.env.BNB_RPC_URL || 'https://bsc-rpc.publicnode.com',
    nativeTickers: ['BNB'],
  },
  base: {
    chain: 'base',
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  '8453': {
    chain: 'base',
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  arbitrum: {
    chain: 'arbitrum',
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  '42161': {
    chain: 'arbitrum',
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  polygon: {
    chain: 'polygon',
    chainId: 137,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
    nativeTickers: ['MATIC', 'POL'],
  },
  matic: {
    chain: 'polygon',
    chainId: 137,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
    nativeTickers: ['MATIC', 'POL'],
  },
  '137': {
    chain: 'polygon',
    chainId: 137,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
    nativeTickers: ['MATIC', 'POL'],
  },
  optimism: {
    chain: 'optimism',
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  op: {
    chain: 'optimism',
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  '10': {
    chain: 'optimism',
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com',
    nativeTickers: ['ETH'],
  },
  xlayer: {
    chain: 'xlayer',
    chainId: 196,
    rpcUrl: process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech',
    nativeTickers: ['OKB'],
  },
  '196': {
    chain: 'xlayer',
    chainId: 196,
    rpcUrl: process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech',
    nativeTickers: ['OKB'],
  },
}

const SUPPORTED_OKX_CHAIN_IDS = new Set(
  Object.values(SUPPORTED_OKX_CHAINS).map((chain) => chain.chainId),
)

const XLAYER_TOKENS: Record<string, `0x${string}`> = {
  OKB: NATIVE_EVM,
  USDC: '0x74b7f16337b8972027f6196a17a631ac6de26d22',
}

export interface OkxSwapArgs {
  fromToken: string
  toToken: string
  amount: string
  chain: string
  wallet: string
  slippage?: number
  swapMode?: SwapMode
  gasLevel?: GasLevel
  maxAutoSlippage?: number
}

export interface OkxQuoteArgs {
  fromToken: string
  toToken: string
  amount: string
  chain: string
  swapMode?: SwapMode
}

export interface OkxApproveArgs {
  token: string
  amount: string
  chain: string
}

export interface OkxLiquidityArgs {
  chain: string
}

export interface OkxCommonDeps {
  getTokenDecimals?: (token: string, chainId: number, rpcUrl: string) => Promise<number>
}

export interface OkxQuoteDeps extends OkxCommonDeps {
  swapQuote?: (params: {
    fromToken: string
    toToken: string
    amount: string
    chain: string
    swapMode?: SwapMode
  }) => Promise<OkxSwapQuoteResult>
}

export interface OkxApproveDeps extends OkxCommonDeps {
  swapApprove?: (params: { token: string; amount: string; chain: string }) => Promise<OkxSwapApproveResult>
}

export interface OkxSwapDeps extends OkxApproveDeps {
  swapSwap?: (params: OkxSwapSwapParams) => Promise<OkxSwapTxResult>
}

export interface OkxReadDeps {
  listChains?: () => Promise<OkxSupportedChain[]>
  listLiquidity?: (params: { chain: string }) => Promise<OkxLiquiditySource[]>
}

function resolveChain(chain: string) {
  const lower = chain.toLowerCase()
  if (lower === 'solana' || lower === 'sol') {
    throw new Error('Solana swaps are routed through dflow. Use: purr dflow swap ...')
  }
  const resolved = SUPPORTED_OKX_CHAINS[lower]
  if (resolved) return resolved
  throw new Error(
    `Unsupported OKX chain "${chain}". Supported: ethereum, bsc, base, arbitrum, polygon, optimism, xlayer`,
  )
}

function resolveOkxToken(input: string, chainId: number, nativeTickers: string[]): string {
  const upper = input.toUpperCase()
  if (nativeTickers.includes(upper)) return NATIVE_EVM
  if (chainId === 196 && XLAYER_TOKENS[upper]) return XLAYER_TOKENS[upper]
  return resolveToken(input, chainId)
}

function toOkxTokenAddress(token: string): string {
  return isNative(token) ? OKX_NATIVE_EVM : token
}

function normalizeSlippagePercentInput(
  value: number | undefined,
  name: '--slippage' | '--max-auto-slippage',
): number | undefined {
  if (value === undefined) return undefined
  if (value < 0) {
    throw new Error(`${name} must be greater than or equal to 0`)
  }
  if (value <= 1) return Number((value * 100).toFixed(6))
  if (value <= 100) return Number(value.toFixed(6))
  throw new Error(`${name} must be between 0 and 1, or between 0 and 100 as a percentage`)
}

function normalizePercentLiteral(
  value: number | undefined,
  name: '--max-auto-slippage',
): number | undefined {
  if (value === undefined) return undefined
  if (value < 0 || value > 100) {
    throw new Error(`${name} must be between 0 and 100 as a percentage`)
  }
  return Number(value.toFixed(6))
}

function normalizeSwapMode(value: string | undefined): SwapMode {
  if (!value) return 'exactIn'
  if (value === 'exactIn' || value === 'exactOut') return value
  throw new Error(`Invalid --swap-mode: "${value}". Use exactIn or exactOut`)
}

function normalizeGasLevel(value: string | undefined): GasLevel | undefined {
  if (!value) return undefined
  if (value === 'slow' || value === 'average' || value === 'fast') return value
  throw new Error(`Invalid --gas-level: "${value}". Use slow, average, or fast`)
}

async function getTokenDecimals(token: string, _chainId: number, rpcUrl: string): Promise<number> {
  if (isNative(token)) return 18
  const address = requireAddress(token, 'token')
  const client = createPublicClient({ transport: http(rpcUrl) })
  const decimals = await client.readContract({
    address,
    abi: ERC20_DECIMALS_ABI,
    functionName: 'decimals',
  })
  return Number(decimals)
}

function toHexValue(value?: string): string {
  if (!value || value === '0') return '0x0'
  return `0x${BigInt(value).toString(16)}`
}

async function resolveAmountWei(
  args: { fromToken: string; toToken: string; amount: string; swapMode?: SwapMode; chain: string },
  deps: OkxCommonDeps = {},
): Promise<{
  chain: ReturnType<typeof resolveChain>
  resolvedFromToken: string
  resolvedToToken: string
  amountWei: string
  swapMode: SwapMode
}> {
  const chain = resolveChain(args.chain)
  const swapMode = normalizeSwapMode(args.swapMode)
  const resolvedFromToken = resolveOkxToken(args.fromToken, chain.chainId, chain.nativeTickers)
  const resolvedToToken = resolveOkxToken(args.toToken, chain.chainId, chain.nativeTickers)

  if (!isNative(resolvedFromToken)) requireAddress(resolvedFromToken, 'from-token')
  if (!isNative(resolvedToToken)) requireAddress(resolvedToToken, 'to-token')

  const decimalsResolver = deps.getTokenDecimals ?? getTokenDecimals
  const amountToken = swapMode === 'exactOut' ? resolvedToToken : resolvedFromToken
  const amountWei = parseUnits(
    args.amount,
    await decimalsResolver(amountToken, chain.chainId, chain.rpcUrl),
  ).toString()

  return { chain, resolvedFromToken, resolvedToToken, amountWei, swapMode }
}

export async function getOkxSwapChains(deps: OkxReadDeps = {}): Promise<OkxSupportedChain[]> {
  const listChains = deps.listChains ?? swapChains
  const chains = await listChains()
  return chains.filter((chain) => SUPPORTED_OKX_CHAIN_IDS.has(chain.chainId))
}

export async function getOkxSwapLiquidity(
  args: OkxLiquidityArgs,
  deps: OkxReadDeps = {},
): Promise<OkxLiquiditySource[]> {
  const chain = resolveChain(args.chain)
  const listLiquidity = deps.listLiquidity ?? swapLiquidity
  return listLiquidity({ chain: chain.chain })
}

export async function quoteOkxSwap(
  args: OkxQuoteArgs,
  deps: OkxQuoteDeps = {},
): Promise<OkxSwapQuoteResult> {
  const { chain, resolvedFromToken, resolvedToToken, amountWei, swapMode } = await resolveAmountWei(
    args,
    deps,
  )
  const quote = deps.swapQuote ?? swapQuote
  return quote({
    fromToken: toOkxTokenAddress(resolvedFromToken),
    toToken: toOkxTokenAddress(resolvedToToken),
    amount: amountWei,
    chain: chain.chain,
    swapMode,
  })
}

export async function buildOkxApproveSteps(
  args: OkxApproveArgs,
  deps: OkxApproveDeps = {},
): Promise<StepOutput> {
  const chain = resolveChain(args.chain)
  const token = resolveOkxToken(args.token, chain.chainId, chain.nativeTickers)
  if (isNative(token)) {
    throw new Error('Native tokens do not require OKX approval')
  }
  requireAddress(token, 'token')

  const decimalsResolver = deps.getTokenDecimals ?? getTokenDecimals
  const amountWei = parseUnits(
    args.amount,
    await decimalsResolver(token, chain.chainId, chain.rpcUrl),
  ).toString()
  const approve = deps.swapApprove ?? swapApprove
  const approval = await approve({
    token,
    amount: amountWei,
    chain: chain.chain,
  })
  if (!approval.dexContractAddress) {
    throw new Error('OKX approve returned no dexContractAddress')
  }

  const step = buildApprovalStep(
    token,
    requireAddress(approval.dexContractAddress, 'okx dexContractAddress'),
    amountWei,
    chain.chainId,
    'Approve token for OKX router',
  )
  if (approval.gasLimit) {
    step.gasLimit = approval.gasLimit
  }
  return { steps: [step] }
}

export async function buildOkxSwapSteps(
  args: OkxSwapArgs,
  deps: OkxSwapDeps = {},
): Promise<StepOutput> {
  requireAddress(args.wallet, 'wallet')

  const { chain, resolvedFromToken, resolvedToToken, amountWei, swapMode } = await resolveAmountWei(
    args,
    deps,
  )
  const slippagePercent = normalizeSlippagePercentInput(args.slippage, '--slippage')
  const maxAutoSlippagePercent = normalizePercentLiteral(args.maxAutoSlippage, '--max-auto-slippage')
  const gasLevel = normalizeGasLevel(args.gasLevel)
  const doSwap = deps.swapSwap ?? swapSwap

  const swap = await doSwap({
    fromToken: toOkxTokenAddress(resolvedFromToken),
    toToken: toOkxTokenAddress(resolvedToToken),
    amount: amountWei,
    chain: chain.chain,
    wallet: args.wallet,
    slippagePercent,
    swapMode,
    gasLevel,
    maxAutoSlippagePercent,
  })

  if (!swap.tx?.to || !swap.tx.data) {
    throw new Error('OKX swap returned incomplete transaction data')
  }

  const steps = []

  if (!isNative(resolvedFromToken)) {
    const requiredApprovalAmount =
      swap.tx.maxSpendAmount || swap.routerResult?.fromTokenAmount || amountWei
    const approve = deps.swapApprove ?? swapApprove
    const approval = await approve({
      token: resolvedFromToken,
      amount: requiredApprovalAmount,
      chain: chain.chain,
    })
    if (!approval.dexContractAddress) {
      throw new Error('OKX approve returned no dexContractAddress')
    }
    const step = buildApprovalStep(
      resolvedFromToken,
      requireAddress(approval.dexContractAddress, 'okx dexContractAddress'),
      requiredApprovalAmount,
      chain.chainId,
      'Approve token for OKX router',
    )
    if (approval.gasLimit) {
      step.gasLimit = approval.gasLimit
    }
    steps.push(step)
  }

  steps.push({
    to: requireAddress(swap.tx.to, 'okx swap tx.to'),
    data: swap.tx.data,
    value: toHexValue(swap.tx.value),
    chainId: chain.chainId,
    label: 'OKX swap',
    gasLimit: swap.tx.gas,
  })

  return { steps }
}
