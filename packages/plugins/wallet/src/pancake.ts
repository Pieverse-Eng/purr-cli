import { executeStepsFromJson } from '@pieverseio/purr-core/executor'
import { NATIVE_EVM } from '@pieverseio/purr-core/shared'
import { resolveToken } from '@pieverseio/purr-core/token-registry'
import type { TxStep } from '@pieverseio/purr-core/types'
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { bsc } from 'viem/chains'
import { getWalletAddress } from './address.js'

const API = 'https://swap.pancakeswap.com/v1'
const ROUTER = '0x2f68417A18dA681589F4eA64B9Cc9839209acfF7' as const
const SWAP_ABI = parseAbi([
  'function swapExactIn(uint256,(address,address,uint256,uint256),uint256[],(uint256[],address[],uint256[],bytes[],address)[][],uint256,address) payable',
])
const SCALE = 10n ** 18n
const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const uint = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) < 2n ** 256n

interface Quote {
  chainId: number
  expiresAt: number
  inputAmount: string
  outputAmount: string
  slippageTolerance: number
  gasUseEstimateUsd?: string
  agg: { srcToken: string; dstToken: string; aggregatorAddress: string; routes: unknown[] }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`PancakeSwap API returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

/** Public quotes; only --execute accesses the managed wallet. */
export async function walletPancake(args: Record<string, string>): Promise<void> {
  for (const flag of [
    'fees',
    'fee',
    'router',
    'path',
    'wallet',
    'deadline',
    'amount-in-wei',
    'amount-out-min-wei',
    'min-amount-out',
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
  if (
    (args['chain-id'] !== undefined && args['chain-id'] !== '56') ||
    (args.chain !== undefined && !['bnb', 'bsc', '56'].includes(args.chain.toLowerCase()))
  )
    throw new Error('PancakeSwap supports BNB Chain (56) only')
  const token = (key: string): Address => {
    if (!args[key]?.trim()) throw new Error(`Missing required argument: --${key}`)
    const address = resolveToken(args[key], 56)
    if (!isAddress(address, { strict: false })) throw new Error('Invalid token address')
    return sameAddress(address, NATIVE_EVM) ? zeroAddress : address
  }
  const fromToken = token('from')
  const toToken = token('to')
  if (sameAddress(fromToken, toToken)) throw new Error('Swap tokens must differ')
  const amount = args.amount ?? ''
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('--amount must be a positive decimal amount')
  const slippage = args.slippage ?? '0.5'
  if (!/^\d+(\.\d{1,16})?$/.test(slippage) || Number(slippage) <= 0 || Number(slippage) >= 50)
    throw new Error('slippage must be a percentage greater than 0 and less than 50')
  const slippageFraction = Number(slippage) / 100
  const slippageUnits = parseUnits(slippage, 16)
  const client = createPublicClient({
    chain: bsc,
    transport: http(
      process.env.EVM_RPC_56 ||
        process.env.BNB_RPC_URL ||
        process.env.EVM_RPC_URL ||
        'https://bsc-rpc.publicnode.com',
      { timeout: 15_000, retryCount: 0 },
    ),
  })
  if ((await client.getChainId()) !== 56) throw new Error('PancakeSwap RPC must use BNB Chain (56)')
  const decimals = async (address: Address) =>
    address === zeroAddress
      ? 18
      : client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })
  const [inputDecimals, outputDecimals] = await Promise.all([
    decimals(fromToken),
    decimals(toToken),
  ])
  if ((amount.split('.')[1]?.length ?? 0) > inputDecimals)
    throw new Error('--amount exceeds input token precision')
  const inputAmount = parseUnits(amount, inputDecimals)
  if (inputAmount <= 0n || inputAmount >= 2n ** 256n) throw new Error('Invalid input amount')
  const execute = args.execute === 'true'
  const wallet = execute
    ? await getWalletAddress({ 'chain-type': 'ethereum', 'chain-id': '56' })
    : null
  if (wallet && (!isAddress(wallet.address) || wallet.chainId !== 56))
    throw new Error('Invalid instance wallet')
  const query = new URLSearchParams({
    chainId: '56',
    tokenIn: fromToken,
    tokenOut: toToken,
    amount: inputAmount.toString(),
    sources: 'agg',
    tradeType: 'exactIn',
    slippageTolerance: String(slippageFraction),
  })
  if (wallet) query.set('recipient', wallet.address)
  const { best } = await request<{ best?: Quote }>(`/quote?${query}`)
  if (
    !best ||
    best.chainId !== 56 ||
    !sameAddress(best.agg?.srcToken, fromToken) ||
    !sameAddress(best.agg?.dstToken, toToken) ||
    !sameAddress(best.agg?.aggregatorAddress, ROUTER) ||
    best.inputAmount !== inputAmount.toString() ||
    !uint(best.outputAmount) ||
    BigInt(best.outputAmount) <= 0n ||
    !Number.isSafeInteger(best.expiresAt) ||
    best.expiresAt <= Date.now() / 1000 ||
    best.slippageTolerance !== slippageFraction ||
    !Array.isArray(best.agg.routes) ||
    !best.agg.routes.length
  )
    throw new Error('PancakeSwap returned an invalid or expired quote')
  const minimum = (BigInt(best.outputAmount) * (SCALE - slippageUnits)) / SCALE
  if (minimum <= 0n) throw new Error('Swap minimum output rounds to zero')
  const quote = {
    provider: 'pancakeswap',
    chainId: 56,
    fromToken,
    toToken,
    fromAmount: amount,
    inputDecimals,
    outputDecimals,
    coverage: 'PancakeSwap Unified Swap API aggregator routes; may split across DEX pools',
    feeEstimateSource: 'PancakeSwap API gas estimate in USD',
    feeNote: 'Indicative swap gas only; wallet approval costs excluded. Requote before execution.',
    inputAmount: best.inputAmount,
    estimatedToAmount: best.outputAmount,
    estimatedToAmountFormatted: formatUnits(BigInt(best.outputAmount), outputDecimals),
    minimumToAmount: minimum.toString(),
    minimumToAmountFormatted: formatUnits(minimum, outputDecimals),
    slippageTolerance: Number(slippage),
    expiresAt: best.expiresAt,
    route: best.agg.routes,
    gasEstimateUsd: uint(best.gasUseEstimateUsd)
      ? formatUnits(BigInt(best.gasUseEstimateUsd), 18)
      : null,
  }
  if (!wallet) {
    console.log(JSON.stringify(quote))
    return
  }

  const call = await request<{ to: Address; calldata: Hex; value: Hex }>('/calldata', {
    method: 'POST',
    body: JSON.stringify({ ...best, recipient: wallet.address }),
  })
  if (
    !sameAddress(call.to, ROUTER) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(call.calldata) ||
    !/^0x[0-9a-fA-F]+$/.test(call.value)
  )
    throw new Error('Invalid PancakeSwap transaction')
  const { args: decoded } = decodeFunctionData({ abi: SWAP_ABI, data: call.calldata })
  const [, [src, dst, minOut, deadline], inputs, , , recipient] = decoded as readonly [
    bigint,
    readonly [Address, Address, bigint, bigint],
    readonly bigint[],
    unknown,
    bigint,
    Address,
  ]
  if (
    !sameAddress(src, fromToken) ||
    !sameAddress(dst, toToken) ||
    !sameAddress(recipient, wallet.address) ||
    inputs.reduce((sum, value) => sum + value, 0n) !== inputAmount ||
    minOut < minimum ||
    minOut > BigInt(best.outputAmount) ||
    deadline <= BigInt(Math.floor(Date.now() / 1000)) ||
    BigInt(call.value) !== (fromToken === zeroAddress ? inputAmount : 0n)
  )
    throw new Error('PancakeSwap transaction does not match the requested swap')
  const steps: TxStep[] = []
  if (fromToken !== zeroAddress) {
    const allowance = await client.readContract({
      address: fromToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.address as Address, ROUTER],
    })
    const approve = (value: bigint): TxStep => ({
      to: fromToken,
      chainId: 56,
      value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, value] }),
      label: value === 0n ? 'Reset PancakeSwap allowance' : 'Approve PancakeSwap input',
    })
    if (allowance < inputAmount) {
      if (allowance > 0n) steps.push(approve(0n))
      steps.push({
        ...approve(inputAmount),
        conditional: {
          type: 'allowance_lt',
          token: fromToken,
          spender: ROUTER,
          amount: inputAmount.toString(),
        },
      })
    }
  }
  steps.push({
    to: ROUTER,
    data: call.calldata,
    value: BigInt(call.value).toString(),
    chainId: 56,
    label: 'PancakeSwap swap',
  })
  console.log(
    JSON.stringify({ ...quote, execution: await executeStepsFromJson(JSON.stringify({ steps })) }),
  )
}
