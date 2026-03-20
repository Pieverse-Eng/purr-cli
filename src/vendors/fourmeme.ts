import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseEther,
  parseAbi,
  parseUnits,
  isAddress,
} from 'viem'
import { bsc } from 'viem/chains'
import { buildApprovalStep, isNative, requireAddress } from '../shared.js'
import type { StepOutput, TxStep } from '../types.js'
import {
  buildFourMemeLoginMessage,
  createFourMemeApiClient,
  DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG,
  type FourMemeApiClient,
  type FourMemeCreateTokenPayload,
  FOUR_MEME_SUPPORTED_LABELS,
  type FourMemeTokenTaxInfo,
} from './fourmeme-api.js'

const BSC_CHAIN_ID = 56
const BSC_RPC_URL = process.env.BNB_RPC_URL || 'https://bsc-rpc.publicnode.com'

const DEFAULT_TOKEN_MANAGER_V1 = '0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC'
const DEFAULT_TOKEN_MANAGER_V2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b'
const DEFAULT_TOKEN_MANAGER_HELPER3 = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034'
const DEFAULT_FOUR_MEME_CREATE_TOKEN_FEE = '0.01'

const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)'])

const FOUR_MEME_HELPER_ABI = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
])

const FOUR_MEME_V1_ABI = parseAbi([
  'function purchaseToken(uint256 origin, address token, address to, uint256 amount, uint256 maxFunds) payable',
  'function purchaseTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
  'function saleToken(address tokenAddress, uint256 amount)',
])

const FOUR_MEME_V2_ABI = parseAbi([
  'function _tokenInfos(address token) view returns (address base, address quote, uint256 template, uint256 totalSupply, uint256 maxOffers, uint256 maxRaising, uint256 launchTime, uint256 offers, uint256 funds, uint256 lastPrice, uint256 K, uint256 T, uint256 status)',
  'function _tokenInfoEx1s(address token) view returns (uint256 launchFee, uint256 pcFee, uint256 feeSetting, uint256 blockNumber, uint256 extraFee)',
  'function buyToken(bytes args, uint256 time, bytes signature) payable',
  'function buyToken(uint256 origin, address token, address to, uint256 amount, uint256 maxFunds) payable',
  'function buyTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
  'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)',
  'function createToken(bytes createArg, bytes signature) payable',
])

const VALID_TAX_FEE_RATES = new Set([1, 3, 5, 10])

interface ReadClient {
  readContract(args: {
    address: `0x${string}`
    abi: unknown
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

interface FourMemeContext {
  version: number
  tokenManager: `0x${string}`
  quote: `0x${string}`
  liquidityAdded: boolean
  isExclusive: boolean
  isTaxToken: boolean
  hasAntiSniper: boolean
  isAgentCreated: boolean
}

interface FourMemeBuyQuote {
  tokenManager: `0x${string}`
  quote: `0x${string}`
  estimatedAmount: bigint
  estimatedCost: bigint
  estimatedFee: bigint
  amountMsgValue: bigint
  amountApproval: bigint
  amountFunds: bigint
}

interface FourMemeSellQuote {
  tokenManager: `0x${string}`
  quote: `0x${string}`
  funds: bigint
  fee: bigint
}

export interface FourMemeBuyArgs {
  token: string
  wallet: string
  amount?: string
  funds?: string
  slippage?: number
}

export interface FourMemeSellArgs {
  token: string
  wallet: string
  amount: string
  slippage?: number
}

export interface FourMemeLoginChallenge {
  wallet: `0x${string}`
  nonce: string
  message: string
}

export interface FourMemeLoginChallengeArgs {
  wallet: string
}

export interface FourMemeCreateTokenArgs {
  wallet: string
  loginNonce: string
  loginSignature: `0x${string}`
  name: string
  symbol: string
  description: string
  label: string
  imageUrl?: string
  imageFile?: string
  website?: string
  twitter?: string
  telegram?: string
  preSale?: string
  xMode?: boolean
  antiSniper?: boolean
  launchTime?: number
  taxFeeRate?: number
  taxBurnRate?: number
  taxDivideRate?: number
  taxLiquidityRate?: number
  taxRecipientRate?: number
  taxRecipientAddress?: string
  taxMinSharing?: string
  creationFee?: string
}

function getClient(client?: ReadClient): ReadClient {
  if (client) return client
  const publicClient = createPublicClient({
    chain: bsc,
    transport: http(BSC_RPC_URL),
  })
  return {
    readContract(args) {
      return publicClient.readContract(args as never)
    },
  }
}

function getHelperAddress(): `0x${string}` {
  return requireAddress(process.env.FOUR_MEME_HELPER3 || DEFAULT_TOKEN_MANAGER_HELPER3, 'helper')
}

function getV2ManagerAddress(): `0x${string}` {
  return requireAddress(
    process.env.FOUR_MEME_TOKEN_MANAGER_V2 || DEFAULT_TOKEN_MANAGER_V2,
    'v2-manager',
  )
}

function parseSlippage(slippage?: number): number {
  const resolved = slippage ?? 0.03
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error('--slippage must be between 0 and 1')
  }
  return resolved
}

function nativeValueHex(quote: `0x${string}`, msgValue: bigint, maxFunds?: bigint): string {
  if (!isNative(quote)) return '0x0'
  const value = maxFunds !== undefined && maxFunds > msgValue ? maxFunds : msgValue
  return `0x${value.toString(16)}`
}

function toBps(slippage: number): bigint {
  return BigInt(Math.round(slippage * 10_000))
}

function withPositiveSlippage(value: bigint, slippage: number): bigint {
  const bps = toBps(slippage)
  return (value * (10_000n + bps) + 9_999n) / 10_000n
}

function withNegativeSlippage(value: bigint, slippage: number): bigint {
  const bps = toBps(slippage)
  return (value * (10_000n - bps)) / 10_000n
}

function parseHumanAmount(value: string, decimals: number, name: string): bigint {
  let parsed: bigint
  try {
    parsed = parseUnits(value, decimals)
  } catch {
    throw new Error(`Invalid ${name}: "${value}"`)
  }
  if (parsed <= 0n) {
    throw new Error(`${name} must be greater than 0`)
  }
  return parsed
}

function parseDecimalAmount(value: string, name: string): bigint {
  try {
    const parsed = parseEther(value)
    if (parsed < 0n) throw new Error('negative')
    return parsed
  } catch {
    throw new Error(`Invalid ${name}: "${value}"`)
  }
}

function requireNonEmptyString(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

function validateUrl(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol')
    }
    return url.toString()
  } catch {
    throw new Error(`Invalid ${name}: "${value}"`)
  }
}

function normalizeLabel(label: string): (typeof FOUR_MEME_SUPPORTED_LABELS)[number] {
  const trimmed = label.trim()
  const exact = FOUR_MEME_SUPPORTED_LABELS.find((candidate) => candidate === trimmed)
  if (exact) return exact
  const insensitive = FOUR_MEME_SUPPORTED_LABELS.find(
    (candidate) => candidate.toLowerCase() === trimmed.toLowerCase(),
  )
  if (insensitive) return insensitive
  throw new Error(
    `Unsupported label: "${label}". Supported labels: ${FOUR_MEME_SUPPORTED_LABELS.join(', ')}`,
  )
}

function parseOptionalRate(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be an integer between 0 and 100`)
  }
  return value
}

function validateMinSharing(value: string): string {
  // Must be d × 10^n where d ∈ [1-9] and n >= 5 (e.g. 100000, 5000000)
  if (!/^[1-9]0{5,}$/.test(value)) {
    throw new Error('taxMinSharing must be a base-10 integer matching d × 10^n with n >= 5')
  }
  return value
}

function buildTokenTaxInfo(args: FourMemeCreateTokenArgs): FourMemeTokenTaxInfo | undefined {
  const feeRate = parseOptionalRate(args.taxFeeRate, 'taxFeeRate')
  const burnRate = parseOptionalRate(args.taxBurnRate, 'taxBurnRate')
  const divideRate = parseOptionalRate(args.taxDivideRate, 'taxDivideRate')
  const liquidityRate = parseOptionalRate(args.taxLiquidityRate, 'taxLiquidityRate')
  const recipientRate = parseOptionalRate(args.taxRecipientRate, 'taxRecipientRate')
  const hasAnyTaxField = [
    feeRate,
    burnRate,
    divideRate,
    liquidityRate,
    recipientRate,
    args.taxRecipientAddress,
    args.taxMinSharing,
  ].some((value) => value !== undefined && value !== '')

  if (!hasAnyTaxField) return undefined

  if (!feeRate || !VALID_TAX_FEE_RATES.has(feeRate)) {
    throw new Error('taxFeeRate must be one of 1, 3, 5, or 10')
  }
  if (
    burnRate === undefined ||
    divideRate === undefined ||
    liquidityRate === undefined ||
    recipientRate === undefined ||
    !args.taxMinSharing
  ) {
    throw new Error(
      'Tax token creation requires taxBurnRate, taxDivideRate, taxLiquidityRate, taxRecipientRate, and taxMinSharing',
    )
  }

  const totalAllocation = burnRate + divideRate + liquidityRate + recipientRate
  if (totalAllocation !== 100) {
    throw new Error('tax allocation rates must sum to 100')
  }

  const recipientAddress = args.taxRecipientAddress?.trim() || ''
  if (recipientRate > 0 && !isAddress(recipientAddress)) {
    throw new Error('taxRecipientAddress must be a valid EVM address when taxRecipientRate > 0')
  }
  if (recipientRate === 0 && recipientAddress !== '') {
    throw new Error('taxRecipientAddress must be empty when taxRecipientRate is 0')
  }

  return {
    feeRate: feeRate as 1 | 3 | 5 | 10,
    burnRate,
    divideRate,
    liquidityRate,
    minSharing: validateMinSharing(args.taxMinSharing),
    recipientAddress,
    recipientRate,
  }
}

function resolveImageSource(args: FourMemeCreateTokenArgs): {
  imageUrl?: string
  imageFile?: string
} {
  const imageUrl = validateUrl(args.imageUrl, 'imageUrl')
  const imageFile = args.imageFile?.trim()
  if (imageUrl && imageFile) {
    throw new Error('Provide only one of --image-url or --image-file')
  }
  return { imageUrl, imageFile }
}

function isFourMemeCdnUrl(url: string): boolean {
  return url.startsWith('https://static.four.meme/')
}

function extFromContentType(ct: string | null): string {
  if (!ct) return '.png'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('webp')) return '.webp'
  return '.png'
}

async function downloadToTempFile(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download image from ${url}: HTTP ${res.status}`)
  const ext = extFromContentType(res.headers.get('content-type'))
  const filePath = join(tmpdir(), `fourmeme-upload-${Date.now()}${ext}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  await writeFile(filePath, bytes)
  return filePath
}

function buildCreateTokenPayload(
  args: FourMemeCreateTokenArgs,
  imgUrl: string,
  raisedToken = DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG,
): FourMemeCreateTokenPayload {
  if (!args.loginNonce.trim()) throw new Error('loginNonce is required')
  if (!args.loginSignature.startsWith('0x')) {
    throw new Error('loginSignature must be a hex string')
  }

  const taxInfo = buildTokenTaxInfo(args)
  const launchTime = args.launchTime ?? Date.now()
  if (!Number.isInteger(launchTime) || launchTime <= 0) {
    throw new Error('launchTime must be a positive unix timestamp in milliseconds')
  }

  const preSale = args.preSale?.trim() || '0'
  parseDecimalAmount(preSale, 'preSale')

  return {
    name: requireNonEmptyString(args.name, 'name'),
    shortName: requireNonEmptyString(args.symbol, 'symbol'),
    symbol: raisedToken.symbol,
    desc: requireNonEmptyString(args.description, 'description'),
    imgUrl,
    launchTime,
    label: normalizeLabel(args.label),
    lpTradingFee: 0.0025,
    webUrl: validateUrl(args.website, 'website'),
    twitterUrl: validateUrl(args.twitter, 'twitter'),
    telegramUrl: validateUrl(args.telegram, 'telegram'),
    preSale,
    raisedAmount: preSale,
    onlyMPC: Boolean(args.xMode),
    feePlan: Boolean(args.antiSniper),
    raisedToken,
    ...(taxInfo ? { tokenTaxInfo: taxInfo } : {}),
  }
}

function getCreateTokenValueWei(
  args: FourMemeCreateTokenArgs,
  payload: FourMemeCreateTokenPayload,
): bigint {
  const creationFee =
    args.creationFee ?? process.env.FOUR_MEME_CREATE_TOKEN_FEE ?? DEFAULT_FOUR_MEME_CREATE_TOKEN_FEE
  return (
    parseDecimalAmount(creationFee, 'creationFee') + parseDecimalAmount(payload.preSale, 'preSale')
  )
}

async function getTokenDecimals(client: ReadClient, token: `0x${string}`): Promise<number> {
  if (isNative(token)) return 18
  const decimals = (await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'decimals',
  })) as number
  return Number(decimals)
}

async function getFourMemeContext(
  client: ReadClient,
  token: `0x${string}`,
): Promise<FourMemeContext> {
  const [helperInfo, rawInfo, rawInfoEx1] = await Promise.all([
    client.readContract({
      address: getHelperAddress(),
      abi: FOUR_MEME_HELPER_ABI,
      functionName: 'getTokenInfo',
      args: [token],
    }),
    client.readContract({
      address: getV2ManagerAddress(),
      abi: FOUR_MEME_V2_ABI,
      functionName: '_tokenInfos',
      args: [token],
    }),
    client.readContract({
      address: getV2ManagerAddress(),
      abi: FOUR_MEME_V2_ABI,
      functionName: '_tokenInfoEx1s',
      args: [token],
    }),
  ])

  const [
    version,
    tokenManager,
    quote,
    _lastPrice,
    _tradingFeeRate,
    _minTradingFee,
    _launchTime,
    _offers,
    _maxOffers,
    _funds,
    _maxFunds,
    liquidityAdded,
  ] = helperInfo as [
    bigint,
    `0x${string}`,
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
  ]

  const [, , template] = rawInfo as [`0x${string}`, `0x${string}`, bigint, ...bigint[]]
  const [, , feeSetting] = rawInfoEx1 as [bigint, bigint, bigint, bigint, bigint]

  const templateBits = BigInt(template)
  const creatorType = Number((templateBits >> 10n) & 0x3fn)

  return {
    version: Number(version),
    tokenManager,
    quote,
    liquidityAdded,
    isExclusive: (templateBits & 0x10000n) !== 0n,
    isTaxToken: creatorType === 5,
    hasAntiSniper: BigInt(feeSetting) > 0n,
    isAgentCreated: (templateBits & (1n << 85n)) !== 0n,
  }
}

async function getBuyQuote(
  client: ReadClient,
  token: `0x${string}`,
  amount: bigint,
  funds: bigint,
): Promise<FourMemeBuyQuote> {
  const result = (await client.readContract({
    address: getHelperAddress(),
    abi: FOUR_MEME_HELPER_ABI,
    functionName: 'tryBuy',
    args: [token, amount, funds],
  })) as [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, bigint, bigint]

  return {
    tokenManager: result[0],
    quote: result[1],
    estimatedAmount: result[2],
    estimatedCost: result[3],
    estimatedFee: result[4],
    amountMsgValue: result[5],
    amountApproval: result[6],
    amountFunds: result[7],
  }
}

async function getSellQuote(
  client: ReadClient,
  token: `0x${string}`,
  amount: bigint,
): Promise<FourMemeSellQuote> {
  const result = (await client.readContract({
    address: getHelperAddress(),
    abi: FOUR_MEME_HELPER_ABI,
    functionName: 'trySell',
    args: [token, amount],
  })) as [`0x${string}`, `0x${string}`, bigint, bigint]

  return {
    tokenManager: result[0],
    quote: result[1],
    funds: result[2],
    fee: result[3],
  }
}

function describeMode(context: FourMemeContext): string {
  const flags = []
  if (context.version === 1) flags.push('V1')
  if (context.version === 2) flags.push('V2')
  if (context.isExclusive) flags.push('X Mode')
  if (context.isTaxToken) flags.push('TaxToken')
  if (context.hasAntiSniper) flags.push('AntiSniper')
  if (context.isAgentCreated) flags.push('AgentCreated')
  return flags.join(', ')
}

export async function buildFourMemeLoginChallenge(
  args: FourMemeLoginChallengeArgs,
  apiClient: FourMemeApiClient = createFourMemeApiClient(),
): Promise<FourMemeLoginChallenge> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const nonce = await apiClient.generateNonce(wallet)
  return {
    wallet,
    nonce,
    message: buildFourMemeLoginMessage(nonce),
  }
}

export async function buildFourMemeBuySteps(
  args: FourMemeBuyArgs,
  client?: ReadClient,
): Promise<StepOutput> {
  const token = requireAddress(args.token, 'token')
  const wallet = requireAddress(args.wallet, 'wallet')
  const slippage = parseSlippage(args.slippage)

  if ((args.amount ? 1 : 0) + (args.funds ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --amount or --funds')
  }

  const rpc = getClient(client)
  const context = await getFourMemeContext(rpc, token)
  const [tokenDecimals, quoteDecimals] = await Promise.all([
    getTokenDecimals(rpc, token),
    getTokenDecimals(rpc, context.quote),
  ])

  const amountWei = args.amount ? parseHumanAmount(args.amount, tokenDecimals, 'amount') : 0n
  const fundsWei = args.funds ? parseHumanAmount(args.funds, quoteDecimals, 'funds') : 0n

  const quote = await getBuyQuote(rpc, token, amountWei, fundsWei)
  const steps: TxStep[] = []
  const labelSuffix = describeMode(context)

  if (!isNative(context.quote) && quote.amountApproval > 0n) {
    steps.push(
      buildApprovalStep(
        context.quote,
        quote.tokenManager,
        quote.amountApproval.toString(),
        BSC_CHAIN_ID,
        `Approve four.meme quote token (${labelSuffix})`,
      ),
    )
  }

  if (context.version === 1) {
    if (args.amount) {
      const maxFunds = withPositiveSlippage(quote.estimatedCost + quote.estimatedFee, slippage)
      steps.push({
        to: quote.tokenManager,
        data: encodeFunctionData({
          abi: FOUR_MEME_V1_ABI,
          functionName: 'purchaseToken',
          args: [0n, token, wallet, amountWei, maxFunds],
        }),
        value: nativeValueHex(context.quote, quote.amountMsgValue, maxFunds),
        chainId: BSC_CHAIN_ID,
        label: `four.meme buy (${labelSuffix})`,
      })
      return { steps }
    }

    const minAmount = withNegativeSlippage(quote.estimatedAmount, slippage)
    steps.push({
      to: quote.tokenManager,
      data: encodeFunctionData({
        abi: FOUR_MEME_V1_ABI,
        functionName: 'purchaseTokenAMAP',
        args: [0n, token, wallet, quote.amountFunds, minAmount],
      }),
      value: nativeValueHex(context.quote, quote.amountMsgValue),
      chainId: BSC_CHAIN_ID,
      label: `four.meme buy AMAP (${labelSuffix})`,
    })
    return { steps }
  }

  if (context.isExclusive) {
    const maxFunds = args.amount
      ? withPositiveSlippage(quote.estimatedCost + quote.estimatedFee, slippage)
      : 0n
    const minAmount = args.funds ? withNegativeSlippage(quote.estimatedAmount, slippage) : 0n
    const encodedArgs = encodeAbiParameters(
      [
        { type: 'uint256', name: 'origin' },
        { type: 'address', name: 'token' },
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'amount' },
        { type: 'uint256', name: 'maxFunds' },
        { type: 'uint256', name: 'funds' },
        { type: 'uint256', name: 'minAmount' },
      ],
      [0n, token, wallet, amountWei, maxFunds, quote.amountFunds, minAmount],
    )
    steps.push({
      to: quote.tokenManager,
      data: encodeFunctionData({
        abi: FOUR_MEME_V2_ABI,
        functionName: 'buyToken',
        args: [encodedArgs, 0n, '0x'],
      }),
      value: nativeValueHex(
        context.quote,
        quote.amountMsgValue,
        args.amount ? maxFunds : undefined,
      ),
      chainId: BSC_CHAIN_ID,
      label: `four.meme X Mode buy (${labelSuffix})`,
    })
    return { steps }
  }

  if (args.amount) {
    const maxFunds = withPositiveSlippage(quote.estimatedCost + quote.estimatedFee, slippage)
    steps.push({
      to: quote.tokenManager,
      data: encodeFunctionData({
        abi: FOUR_MEME_V2_ABI,
        functionName: 'buyToken',
        args: [0n, token, wallet, amountWei, maxFunds],
      }),
      value: nativeValueHex(context.quote, quote.amountMsgValue, maxFunds),
      chainId: BSC_CHAIN_ID,
      label: `four.meme buy (${labelSuffix})`,
    })
    return { steps }
  }

  const minAmount = withNegativeSlippage(quote.estimatedAmount, slippage)
  steps.push({
    to: quote.tokenManager,
    data: encodeFunctionData({
      abi: FOUR_MEME_V2_ABI,
      functionName: 'buyTokenAMAP',
      args: [0n, token, wallet, quote.amountFunds, minAmount],
    }),
    value: nativeValueHex(context.quote, quote.amountMsgValue),
    chainId: BSC_CHAIN_ID,
    label: `four.meme buy AMAP (${labelSuffix})`,
  })
  return { steps }
}

export async function buildFourMemeSellSteps(
  args: FourMemeSellArgs,
  client?: ReadClient,
): Promise<StepOutput> {
  const token = requireAddress(args.token, 'token')
  requireAddress(args.wallet, 'wallet')
  const slippage = parseSlippage(args.slippage)
  const rpc = getClient(client)
  const context = await getFourMemeContext(rpc, token)
  const tokenDecimals = await getTokenDecimals(rpc, token)
  const amountWei = parseHumanAmount(args.amount, tokenDecimals, 'amount')
  const quote = await getSellQuote(rpc, token, amountWei)
  const minFunds = withNegativeSlippage(quote.funds, slippage)
  const labelSuffix = describeMode(context)

  const steps: TxStep[] = [
    buildApprovalStep(
      token,
      quote.tokenManager,
      amountWei.toString(),
      BSC_CHAIN_ID,
      `Approve four.meme token sale (${labelSuffix})`,
    ),
  ]

  if (context.version === 1) {
    const data = encodeFunctionData({
      abi: FOUR_MEME_V1_ABI,
      functionName: 'saleToken',
      args: [token, amountWei],
    })
    steps.push({
      to: quote.tokenManager,
      data,
      value: '0x0',
      chainId: BSC_CHAIN_ID,
      label: `four.meme sell (${labelSuffix}, min quote ${minFunds})`,
    })
    return { steps }
  }

  const data = encodeFunctionData({
    abi: FOUR_MEME_V2_ABI,
    functionName: 'sellToken',
    args: [0n, token, amountWei, minFunds],
  })
  steps.push({
    to: quote.tokenManager,
    data,
    value: '0x0',
    chainId: BSC_CHAIN_ID,
    label: `four.meme sell (${labelSuffix})`,
  })
  return { steps }
}

export async function buildFourMemeCreateTokenSteps(
  args: FourMemeCreateTokenArgs,
  apiClient: FourMemeApiClient = createFourMemeApiClient(),
): Promise<StepOutput> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const { imageUrl, imageFile } = resolveImageSource(args)
  // Validate payload eagerly (before any API calls)
  buildCreateTokenPayload({ ...args, wallet }, imageUrl || imageFile || 'placeholder')
  const [accessToken, raisedToken] = await Promise.all([
    apiClient.loginDex({
      wallet,
      nonce: args.loginNonce,
      signature: args.loginSignature,
    }),
    apiClient.getRaisedTokenConfig(),
  ])
  let imgUrl: string
  if (imageUrl && isFourMemeCdnUrl(imageUrl)) {
    imgUrl = imageUrl
  } else if (imageUrl) {
    // External URL — download and upload to four.meme
    const tempPath = await downloadToTempFile(imageUrl)
    imgUrl = await apiClient.uploadTokenImage({ filePath: tempPath, accessToken })
  } else if (imageFile) {
    imgUrl = await apiClient.uploadTokenImage({ filePath: imageFile, accessToken })
  } else {
    throw new Error('An image is required: provide --image-url or --image-file')
  }
  const payload = buildCreateTokenPayload({ ...args, wallet }, imgUrl, raisedToken)
  const create = await apiClient.createToken({ payload, accessToken })
  const value = getCreateTokenValueWei(args, payload)
  const modeFlags: string[] = [payload.label]
  if (payload.onlyMPC) modeFlags.push('X Mode')
  if (payload.feePlan) modeFlags.push('AntiSniper')
  if (payload.tokenTaxInfo) modeFlags.push('TaxToken')

  const data = encodeFunctionData({
    abi: FOUR_MEME_V2_ABI,
    functionName: 'createToken',
    args: [create.createArg, create.signature],
  })

  return {
    steps: [
      {
        to: getV2ManagerAddress(),
        data,
        value: `0x${value.toString(16)}`,
        chainId: BSC_CHAIN_ID,
        label: `four.meme create token (${modeFlags.join(', ')})`,
      },
    ],
  }
}

export const FOUR_MEME_TEST_CONSTANTS = {
  BSC_CHAIN_ID,
  DEFAULT_TOKEN_MANAGER_HELPER3,
  DEFAULT_TOKEN_MANAGER_V1,
  DEFAULT_TOKEN_MANAGER_V2,
  DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG,
  FOUR_MEME_SUPPORTED_LABELS,
}
