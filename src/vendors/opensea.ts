import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import { apiPost, resolveCredentials } from '../api-client.js'
import { executeStepsFromJson, type ExecuteResult } from '../executor.js'
import { buildApprovalStep, isNative, requireAddress } from '../shared.js'
import type { StepOutput, TxStep } from '../types.js'
import {
  cancelOrder,
  submitOrder,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  OPENSEA_SEAPORT_V1_6,
  getCollection,
  getNft,
  getOrder,
  getSwapQuote,
  normalizeOpenSeaChain,
  type OpenSeaAdvancedOrder,
  type OpenSeaBestListingResponse,
  type OpenSeaBestOfferResponse,
  type OpenSeaCollectionResponse,
  type OpenSeaCriteriaResolver,
  type OpenSeaFulfillmentMatch,
  type OpenSeaFulfillmentResponse,
  type OpenSeaOrderResponse,
  type OpenSeaOrderParametersWithCounter,
  type OpenSeaSwapQuoteResponse,
  type OpenSeaSwapTransaction,
} from './opensea-api.js'

export class OpenSeaCliError extends Error {
  code: string
  details?: Record<string, string>

  constructor(message: string, code: string, details?: Record<string, string>) {
    super(message)
    this.name = 'OpenSeaCliError'
    this.code = code
    this.details = details
  }
}

const BASIC_ORDER_FUNCTION =
  'fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))'
const MATCH_ADVANCED_ORDERS_FUNCTION =
  'matchAdvancedOrders(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)'
const FULFILL_ADVANCED_ORDER_FUNCTION =
  'fulfillAdvancedOrder(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData),(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[],bytes32,address)'

const BASIC_ORDER_ABI = parseAbi([`function ${BASIC_ORDER_FUNCTION}`])
const ERC721_APPROVE_ABI = parseAbi(['function approve(address to, uint256 tokenId)'])
const SET_APPROVAL_FOR_ALL_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
])
const ERC721_OWNER_OF_ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)'])
const ERC1155_BALANCE_OF_ABI = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
])
const SEAPORT_CANCEL_ABI = parseAbi([
  'function cancel((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems,uint256 counter)[] orders) returns (bool cancelled)',
])
const SEAPORT_COUNTER_ABI = parseAbi([
  'function getCounter(address offerer) view returns (uint256)',
])
const execFileAsync = promisify(execFile)
const MATCH_ADVANCED_ORDERS_SELECTOR = toFunctionSelector(MATCH_ADVANCED_ORDERS_FUNCTION)
const FULFILL_ADVANCED_ORDER_SELECTOR = toFunctionSelector(FULFILL_ADVANCED_ORDER_FUNCTION)
const OPENSEA_SIGNED_ZONES = new Set([
  '0x000056f7000000ece9003ca63978907a00ffd100',
  '0x000000e7ec00e7b300774b00001314b8610022b8',
])
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

interface WalletEnsureResponse {
  ok: boolean
  data: {
    address: string
    chainId: number
    chainType: string
    createdNow: boolean
  }
  error?: string
}
const MATCH_ADVANCED_ORDERS_PARAMETERS = [
  {
    name: 'orders',
    type: 'tuple[]',
    components: [
      {
        name: 'parameters',
        type: 'tuple',
        components: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          {
            name: 'offer',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
            ],
          },
          {
            name: 'consideration',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
              { name: 'recipient', type: 'address' },
            ],
          },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'totalOriginalConsiderationItems', type: 'uint256' },
        ],
      },
      { name: 'numerator', type: 'uint120' },
      { name: 'denominator', type: 'uint120' },
      { name: 'signature', type: 'bytes' },
      { name: 'extraData', type: 'bytes' },
    ],
  },
  {
    name: 'criteriaResolvers',
    type: 'tuple[]',
    components: [
      { name: 'orderIndex', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'index', type: 'uint256' },
      { name: 'identifier', type: 'uint256' },
      { name: 'criteriaProof', type: 'bytes32[]' },
    ],
  },
  {
    name: 'fulfillments',
    type: 'tuple[]',
    components: [
      {
        name: 'offerComponents',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'itemIndex', type: 'uint256' },
        ],
      },
      {
        name: 'considerationComponents',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'itemIndex', type: 'uint256' },
        ],
      },
    ],
  },
  { name: 'recipient', type: 'address' },
] as const
const FULFILL_ADVANCED_ORDER_PARAMETERS = [
  {
    name: 'advancedOrder',
    type: 'tuple',
    components: [
      {
        name: 'parameters',
        type: 'tuple',
        components: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          {
            name: 'offer',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
            ],
          },
          {
            name: 'consideration',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
              { name: 'recipient', type: 'address' },
            ],
          },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'totalOriginalConsiderationItems', type: 'uint256' },
        ],
      },
      { name: 'numerator', type: 'uint120' },
      { name: 'denominator', type: 'uint120' },
      { name: 'signature', type: 'bytes' },
      { name: 'extraData', type: 'bytes' },
    ],
  },
  {
    name: 'criteriaResolvers',
    type: 'tuple[]',
    components: [
      { name: 'orderIndex', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'index', type: 'uint256' },
      { name: 'identifier', type: 'uint256' },
      { name: 'criteriaProof', type: 'bytes32[]' },
    ],
  },
  { name: 'fulfillerConduitKey', type: 'bytes32' },
  { name: 'recipient', type: 'address' },
] as const

export interface OpenSeaBuyArgs {
  wallet: string
  fulfillment: OpenSeaFulfillmentResponse
}

export interface OpenSeaSellArgs {
  wallet: string
  fulfillment: OpenSeaFulfillmentResponse
}

export interface OpenSeaOfferArgs {
  chain: string
  collection: string
  tokenId: string
  wallet: string
  amount: string
  protocolAddress?: string
  startTime?: number
  endTime?: number
  durationSeconds?: number
}

export interface OpenSeaListingArgs {
  chain: string
  collection: string
  tokenId: string
  wallet: string
  amount: string
  protocolAddress?: string
  startTime?: number
  endTime?: number
  durationSeconds?: number
}

export interface OpenSeaSwapArgs {
  fromChain: string
  fromAddress: string
  toChain: string
  toAddress: string
  quantity: string
  wallet: string
  slippage?: number
  recipient?: string
}

export interface OpenSeaCancelArgs {
  chain: string
  orderHash: string
  wallet: string
  protocolAddress?: string
}

export interface OpenSeaOfferPreview {
  steps: TxStep[]
  typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }
  submission: {
    protocol_address: string
    parameters: OpenSeaOrderParametersWithCounter
  }
  metadata: {
    collection: string
    contract: string
    tokenId: string
    paymentToken: string
    paymentAmount: string
    chainId: number
  }
}

export interface OpenSeaOfferExecutionResult {
  approval?: ExecuteResult
  typedData: OpenSeaOfferPreview['typedData']
  submission: unknown
  metadata: OpenSeaOfferPreview['metadata']
}

export interface OpenSeaListingPreview {
  steps: TxStep[]
  typedData: OpenSeaOfferPreview['typedData']
  submission: {
    protocol_address: string
    parameters: OpenSeaOrderParametersWithCounter
  }
  metadata: {
    collection: string
    contract: string
    tokenId: string
    paymentToken: string
    paymentAmount: string
    paymentItemType: 0 | 1
    chainId: number
  }
}

export interface OpenSeaListingExecutionResult {
  approval?: ExecuteResult
  typedData: OpenSeaListingPreview['typedData']
  submission: unknown
  metadata: OpenSeaListingPreview['metadata']
}

export interface OpenSeaCancelPreview {
  mode: 'official-first' | 'onchain-only'
  steps: TxStep[]
  official?: {
    path: string
    method: 'POST'
  }
  metadata: {
    orderHash: string
    orderKind: 'offer' | 'listing'
    offerer: string
    protocolAddress: string
    chainId: number
    signedZone: boolean
    status?: string
  }
}

export interface OpenSeaCancelExecutionResult {
  mode: 'official' | 'onchain' | 'official-fallback-onchain'
  official?: unknown
  execution?: ExecuteResult
  metadata: OpenSeaCancelPreview['metadata']
}

interface PaymentDetails {
  itemType: number
  token: string
  totalAmount: bigint
}

const ERC20_APPROVE_SELECTOR = '0x095ea7b3'
const SUPPORTED_OPENSEA_CHAIN_IDS = new Set([
  1, 10, 137, 8453, 42161, 43114, 8217, 7777777, 81457, 11155111,
])

function openSeaError(
  message: string,
  code: string,
  details?: Record<string, string>,
): OpenSeaCliError {
  return new OpenSeaCliError(message, code, details)
}

interface OpenSeaCancelContext {
  chain: ReturnType<typeof normalizeOpenSeaChain>
  order: OpenSeaOrderResponse
  orderKind: 'offer' | 'listing'
  protocolAddress: string
  offerer: `0x${string}`
  signedZone: boolean
  steps: TxStep[]
}

function isSignedZoneAddress(zone: string | undefined): boolean {
  if (!zone) return false
  return OPENSEA_SIGNED_ZONES.has(zone.toLowerCase())
}

function isMakerIdentityMismatch(message: string): boolean {
  return message.toLowerCase().includes('api key account does not match the expected maker')
}

function isSignedZoneUnsupported(message: string): boolean {
  return message.toLowerCase().includes('not under a signed zone')
}

function getRpcUrl(chainId: number): string {
  switch (chainId) {
    case 1:
      return process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'
    case 10:
      return process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com'
    case 137:
      return process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'
    case 8453:
      return process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com'
    case 42161:
      return process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com'
    case 43114:
      return process.env.AVALANCHE_RPC_URL || 'https://avalanche-c-chain-rpc.publicnode.com'
    case 7777777:
      return process.env.ZORA_RPC_URL || 'https://rpc.zora.energy'
    case 81457:
      return process.env.BLAST_RPC_URL || 'https://rpc.blast.io'
    case 8217:
      return process.env.KLAYTN_RPC_URL || 'https://public-en-cypress.klaytn.net'
    case 11155111:
      return process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
    default:
      throw new Error(`Unsupported chainId ${chainId} for OpenSea ownership check`)
  }
}

async function ethCall(
  chainId: number,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<`0x${string}`> {
  const rpcUrl = getRpcUrl(chainId)
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  })

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: AbortSignal.timeout(12000),
    })
    const parsed = (await res.json()) as {
      result?: string
      error?: { message?: string }
    }
    if (parsed.error) {
      throw new Error(parsed.error.message || 'Unknown RPC error')
    }
    if (!parsed.result || typeof parsed.result !== 'string' || !parsed.result.startsWith('0x')) {
      throw new Error('RPC returned no result')
    }
    return parsed.result as `0x${string}`
  } catch {
    // Fall back to curl for environments where fetch cannot reach the RPC directly.
  }

  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sS',
        '--connect-timeout',
        '10',
        '--max-time',
        '30',
        '-H',
        'Content-Type: application/json',
        '--data',
        payload,
        rpcUrl,
      ],
      { maxBuffer: 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout) as {
      result?: string
      error?: { message?: string }
    }
    if (parsed.error) {
      throw new Error(parsed.error.message || 'Unknown RPC error')
    }
    if (!parsed.result || typeof parsed.result !== 'string' || !parsed.result.startsWith('0x')) {
      throw new Error('RPC returned no result')
    }
    return parsed.result as `0x${string}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`RPC call failed for chain ${chainId}: ${message}`)
  }
}

function parseTokenId(tokenId: string): string {
  const trimmed = tokenId.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid --token-id: "${tokenId}" — must be a positive integer`)
  }
  return trimmed
}

function parseUintString(value: string, flagName: string): string {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid --${flagName}: "${value}" — must be a non-negative integer`)
  }
  return trimmed
}

function parseSlippage(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0 || value > 0.5) {
    throw new Error(`Invalid OpenSea slippage: ${value}. Expected a number between 0 and 0.5`)
  }
  return value
}

function _getPaymentDetails(listing: OpenSeaBestListingResponse): PaymentDetails {
  const consideration = listing.protocol_data?.parameters?.consideration ?? []
  if (consideration.length === 0) {
    throw new Error('OpenSea listing response did not include consideration items')
  }

  const first = consideration[0]
  for (const item of consideration) {
    if (
      item.itemType !== first.itemType ||
      item.token.toLowerCase() !== first.token.toLowerCase()
    ) {
      throw new Error('Unsupported OpenSea listing: mixed payment assets are not supported')
    }
  }

  if (first.itemType !== 0 && first.itemType !== 1) {
    throw new Error(
      `Unsupported OpenSea payment itemType: ${first.itemType}. Only native and ERC20 listings are supported`,
    )
  }

  return {
    itemType: first.itemType,
    token: first.token,
    totalAmount: consideration.reduce((sum, item) => sum + BigInt(item.endAmount), 0n),
  }
}

function _ensureListingIsActive(listing: OpenSeaBestListingResponse): void {
  if (listing.status && listing.status !== 'ACTIVE') {
    throw new Error(`OpenSea listing is not active: ${listing.status}`)
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const startTime = listing.protocol_data?.parameters?.startTime
  const endTime = listing.protocol_data?.parameters?.endTime
  if (startTime && BigInt(startTime) > now) {
    throw new Error('OpenSea listing is not active yet')
  }
  if (endTime && BigInt(endTime) <= now) {
    throw new Error('OpenSea listing has expired')
  }
}

function _ensureOfferIsActive(offer: OpenSeaBestOfferResponse): void {
  if (offer.status && offer.status !== 'ACTIVE') {
    throw new Error(`OpenSea offer is not active: ${offer.status}`)
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const startTime = offer.protocol_data?.parameters?.startTime
  const endTime = offer.protocol_data?.parameters?.endTime
  if (startTime && BigInt(startTime) > now) {
    throw new Error('OpenSea offer is not active yet')
  }
  if (endTime && BigInt(endTime) <= now) {
    throw new Error('OpenSea offer has expired')
  }
}

function requireHexData(value: string, fieldName: string): `0x${string}` {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new Error(`Invalid ${fieldName}: "${value}" — must be 0x-prefixed hex calldata`)
  }
  return trimmed as `0x${string}`
}

function parseNonNegativeUintString(value: string | undefined, fieldName: string): bigint {
  if (value === undefined) return 0n
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: "${value}" — must be a non-negative integer`)
  }
  return BigInt(trimmed)
}

function extractTransaction(fulfillment: OpenSeaFulfillmentResponse) {
  return fulfillment.fulfillment_data?.transaction
}

function extractSwapTransactions(response: OpenSeaSwapQuoteResponse): OpenSeaSwapTransaction[] {
  if (Array.isArray(response.transactions) && response.transactions.length > 0) {
    return response.transactions
  }

  const fallback = response.swap?.actions
    ?.map((action) => action.transactionSubmissionData)
    .filter((tx): tx is NonNullable<typeof tx> => Boolean(tx))
    .map((tx) => ({
      chain: tx.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    }))

  if (fallback && fallback.length > 0) {
    return fallback
  }

  throw new Error('OpenSea swap quote did not include executable transactions')
}

function resolveSwapTransactionChainId(
  chain: OpenSeaSwapTransaction['chain'],
  fallbackChainId: number,
): number {
  if (typeof chain === 'string' && chain.trim() !== '') {
    return normalizeOpenSeaChain(chain).chainId
  }
  if (chain && typeof chain === 'object') {
    if (
      typeof chain.networkId === 'number' &&
      Number.isFinite(chain.networkId) &&
      chain.networkId > 0
    ) {
      return chain.networkId
    }
    if (typeof chain.identifier === 'string' && chain.identifier.trim() !== '') {
      return normalizeOpenSeaChain(chain.identifier).chainId
    }
  }
  return fallbackChainId
}

function getSwapStepLabel(
  transaction: OpenSeaSwapTransaction,
  index: number,
  total: number,
): string {
  if (transaction.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
    return 'Approve token for OpenSea swap'
  }
  if (total === 1 || index === total - 1) {
    return 'OpenSea swap'
  }
  return `OpenSea swap step ${index + 1}`
}

function _getOfferContractAddress(offer: OpenSeaBestOfferResponse): `0x${string}` {
  const criteriaContract = offer.criteria?.contract?.address
  if (criteriaContract) return requireAddress(criteriaContract, 'offer contract')

  const nftItem = offer.protocol_data?.parameters?.consideration?.find((item) =>
    [2, 3, 4, 5].includes(item.itemType),
  )
  if (!nftItem) {
    throw new Error('OpenSea offer response did not include an NFT contract')
  }

  return requireAddress(nftItem.token, 'offer contract')
}

function getErc20ApprovalAmount(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
): bigint {
  const parameters = transaction.input_data?.parameters
  if (parameters) {
    return (
      BigInt(parameters.considerationAmount) +
      parameters.additionalRecipients.reduce((sum, recipient) => sum + BigInt(recipient.amount), 0n)
    )
  }

  return BigInt(transaction.value ?? '0')
}

function getErc20ApprovalSpender(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
): `0x${string}` {
  return getOperatorFromConduitKey(
    transaction.input_data?.parameters?.fulfillerConduitKey ??
      transaction.input_data?.fulfillerConduitKey,
    transaction.to,
  )
}

function requireFulfillmentTransaction(
  fulfillment: OpenSeaFulfillmentResponse,
  action: 'buy' | 'sell',
): NonNullable<ReturnType<typeof extractTransaction>> {
  const transaction = extractTransaction(fulfillment)
  if (!transaction) {
    throw new Error(`OpenSea ${action} fulfillment response did not include a transaction`)
  }
  return transaction
}

function requireFulfillmentChainId(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  action: 'buy' | 'sell',
): number {
  const chainId = transaction.chain
  if (!Number.isFinite(chainId) || !chainId || chainId <= 0) {
    throw new Error(`OpenSea ${action} fulfillment response did not include a valid chain`)
  }
  if (!SUPPORTED_OPENSEA_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `OpenSea ${action} fulfillment response did not include a supported OpenSea chain`,
    )
  }
  return chainId
}

function ensureFulfillmentRecipientMatchesWallet(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  wallet: `0x${string}`,
): void {
  const recipient = transaction.input_data?.recipient
  if (!recipient) return
  const normalizedRecipient = requireAddress(recipient, 'fulfillment recipient')
  if (normalizedRecipient.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(
      `OpenSea buy fulfillment recipient does not match wallet ${wallet}: ${normalizedRecipient}`,
    )
  }
}

function getListingOrderFromFulfillment(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
): OpenSeaAdvancedOrder {
  const advancedOrder = transaction.input_data?.advancedOrder
  if (advancedOrder) return advancedOrder

  const orders = transaction.input_data?.orders
  if (orders && orders.length > 0) {
    return (
      orders.find((order) =>
        order.parameters.offer.some((item) => [2, 3, 4, 5].includes(item.itemType)),
      ) ?? orders[0]
    )
  }

  throw new Error('OpenSea buy fulfillment response did not include listing order details')
}

function getBuyPaymentDetails(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
): PaymentDetails {
  const parameters = transaction.input_data?.parameters
  if (parameters) {
    const paymentToken = requireAddress(parameters.considerationToken, 'consideration token')
    return {
      itemType: paymentToken.toLowerCase() === ZERO_ADDRESS ? 0 : 1,
      token: paymentToken,
      totalAmount: getErc20ApprovalAmount(transaction),
    }
  }

  const listingOrder = getListingOrderFromFulfillment(transaction)
  const paymentItems = listingOrder.parameters.consideration.filter(
    (item) => item.itemType === 0 || item.itemType === 1,
  )
  if (paymentItems.length === 0) {
    throw new Error('OpenSea buy fulfillment response did not include payment consideration items')
  }

  const first = paymentItems[0]
  for (const item of paymentItems) {
    if (
      item.itemType !== first.itemType ||
      item.token.toLowerCase() !== first.token.toLowerCase()
    ) {
      throw new Error('Unsupported OpenSea buy fulfillment: mixed payment assets are not supported')
    }
  }

  return {
    itemType: first.itemType,
    token: requireAddress(first.token, 'payment token'),
    totalAmount: paymentItems.reduce((sum, item) => sum + BigInt(item.endAmount), 0n),
  }
}

function encodeFulfillmentCalldata(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
): `0x${string}` {
  const functionName = transaction.function?.split('(')[0]

  if (transaction.data) return requireHexData(transaction.data, 'fulfillment transaction.data')

  const rawData = transaction.input_data?.data
  if (typeof rawData === 'string' && rawData.startsWith('0x')) {
    return requireHexData(rawData, 'fulfillment transaction.input_data.data')
  }

  if (transaction.function !== BASIC_ORDER_FUNCTION) {
    if (functionName === 'matchAdvancedOrders') {
      const encodedParameters = encodeAbiParameters(MATCH_ADVANCED_ORDERS_PARAMETERS, [
        (transaction.input_data?.orders ?? []).map((order: OpenSeaAdvancedOrder) => ({
          parameters: {
            offerer: requireAddress(order.parameters.offerer, 'advanced order offerer'),
            zone: requireAddress(order.parameters.zone, 'advanced order zone'),
            offer: order.parameters.offer.map((item) => ({
              itemType: item.itemType,
              token: requireAddress(item.token, 'advanced order offer token'),
              identifierOrCriteria: BigInt(item.identifierOrCriteria),
              startAmount: BigInt(item.startAmount),
              endAmount: BigInt(item.endAmount),
            })),
            consideration: order.parameters.consideration.map((item) => ({
              itemType: item.itemType,
              token: requireAddress(item.token, 'advanced order consideration token'),
              identifierOrCriteria: BigInt(item.identifierOrCriteria),
              startAmount: BigInt(item.startAmount),
              endAmount: BigInt(item.endAmount),
              recipient: requireAddress(item.recipient, 'advanced order recipient'),
            })),
            orderType: order.parameters.orderType,
            startTime: BigInt(order.parameters.startTime),
            endTime: BigInt(order.parameters.endTime),
            zoneHash: order.parameters.zoneHash as `0x${string}`,
            salt: BigInt(order.parameters.salt),
            conduitKey: order.parameters.conduitKey as `0x${string}`,
            totalOriginalConsiderationItems: BigInt(
              order.parameters.totalOriginalConsiderationItems,
            ),
          },
          numerator: BigInt(order.numerator),
          denominator: BigInt(order.denominator),
          signature: order.signature as `0x${string}`,
          extraData: order.extraData as `0x${string}`,
        })),
        (transaction.input_data?.criteriaResolvers ?? []).map(
          (resolver: OpenSeaCriteriaResolver) => ({
            orderIndex: BigInt(resolver.orderIndex),
            side: Number(resolver.side),
            index: BigInt(resolver.index),
            identifier: BigInt(resolver.identifier),
            criteriaProof: resolver.criteriaProof as `0x${string}`[],
          }),
        ),
        (transaction.input_data?.fulfillments ?? []).map((match: OpenSeaFulfillmentMatch) => ({
          offerComponents: match.offerComponents.map((component) => ({
            orderIndex: BigInt(component.orderIndex),
            itemIndex: BigInt(component.itemIndex),
          })),
          considerationComponents: match.considerationComponents.map((component) => ({
            orderIndex: BigInt(component.orderIndex),
            itemIndex: BigInt(component.itemIndex),
          })),
        })),
        requireAddress(transaction.input_data?.recipient ?? transaction.to, 'recipient'),
      ])
      return `${MATCH_ADVANCED_ORDERS_SELECTOR}${encodedParameters.slice(2)}` as `0x${string}`
    }

    if (functionName === 'fulfillAdvancedOrder') {
      const advancedOrder = transaction.input_data?.advancedOrder
      if (!advancedOrder) {
        throw new Error('OpenSea fulfillAdvancedOrder response did not include advancedOrder')
      }
      const encodedParameters = encodeAbiParameters(FULFILL_ADVANCED_ORDER_PARAMETERS, [
        {
          parameters: {
            offerer: requireAddress(advancedOrder.parameters.offerer, 'advanced order offerer'),
            zone: requireAddress(advancedOrder.parameters.zone, 'advanced order zone'),
            offer: advancedOrder.parameters.offer.map((item) => ({
              itemType: item.itemType,
              token: requireAddress(item.token, 'advanced order offer token'),
              identifierOrCriteria: BigInt(item.identifierOrCriteria),
              startAmount: BigInt(item.startAmount),
              endAmount: BigInt(item.endAmount),
            })),
            consideration: advancedOrder.parameters.consideration.map((item) => ({
              itemType: item.itemType,
              token: requireAddress(item.token, 'advanced order consideration token'),
              identifierOrCriteria: BigInt(item.identifierOrCriteria),
              startAmount: BigInt(item.startAmount),
              endAmount: BigInt(item.endAmount),
              recipient: requireAddress(item.recipient, 'advanced order recipient'),
            })),
            orderType: advancedOrder.parameters.orderType,
            startTime: BigInt(advancedOrder.parameters.startTime),
            endTime: BigInt(advancedOrder.parameters.endTime),
            zoneHash: advancedOrder.parameters.zoneHash as `0x${string}`,
            salt: BigInt(advancedOrder.parameters.salt),
            conduitKey: advancedOrder.parameters.conduitKey as `0x${string}`,
            totalOriginalConsiderationItems: BigInt(
              advancedOrder.parameters.totalOriginalConsiderationItems,
            ),
          },
          numerator: BigInt(advancedOrder.numerator),
          denominator: BigInt(advancedOrder.denominator),
          signature: advancedOrder.signature as `0x${string}`,
          extraData: advancedOrder.extraData as `0x${string}`,
        },
        (transaction.input_data?.criteriaResolvers ?? []).map(
          (resolver: OpenSeaCriteriaResolver) => ({
            orderIndex: BigInt(resolver.orderIndex),
            side: Number(resolver.side),
            index: BigInt(resolver.index),
            identifier: BigInt(resolver.identifier),
            criteriaProof: resolver.criteriaProof as `0x${string}`[],
          }),
        ),
        (transaction.input_data?.fulfillerConduitKey ?? ZERO_BYTES32) as `0x${string}`,
        requireAddress(transaction.input_data?.recipient ?? transaction.to, 'recipient'),
      ])
      return `${FULFILL_ADVANCED_ORDER_SELECTOR}${encodedParameters.slice(2)}` as `0x${string}`
    }

    throw new Error(
      `Unsupported OpenSea fulfillment function: ${transaction.function ?? 'missing function signature'}`,
    )
  }

  const parameters = transaction.input_data?.parameters
  if (!parameters) {
    throw new Error('OpenSea fulfillment response did not include calldata parameters')
  }

  return encodeFunctionData({
    abi: BASIC_ORDER_ABI,
    functionName: 'fulfillBasicOrder_efficient_6GL6yc',
    args: [
      [
        requireAddress(parameters.considerationToken, 'consideration token'),
        BigInt(parameters.considerationIdentifier),
        BigInt(parameters.considerationAmount),
        requireAddress(parameters.offerer, 'offerer'),
        requireAddress(parameters.zone, 'zone'),
        requireAddress(parameters.offerToken, 'offer token'),
        BigInt(parameters.offerIdentifier),
        BigInt(parameters.offerAmount),
        parameters.basicOrderType,
        BigInt(parameters.startTime),
        BigInt(parameters.endTime),
        parameters.zoneHash as `0x${string}`,
        BigInt(parameters.salt),
        parameters.offererConduitKey as `0x${string}`,
        parameters.fulfillerConduitKey as `0x${string}`,
        BigInt(parameters.totalOriginalAdditionalRecipients),
        parameters.additionalRecipients.map((recipient): readonly [bigint, `0x${string}`] => [
          BigInt(recipient.amount),
          requireAddress(recipient.recipient, 'additional recipient'),
        ]),
        parameters.signature as `0x${string}`,
      ],
    ],
  })
}

async function ensureInstanceWalletMatches(wallet: `0x${string}`, chainId: number): Promise<void> {
  const { instanceId } = resolveCredentials()
  const res = await apiPost<WalletEnsureResponse>(`/v1/instances/${instanceId}/wallet/ensure`, {
    chainType: 'ethereum',
    chainId,
  })
  if (!res.ok) {
    throw new Error(res.error ?? 'Failed to resolve instance wallet for OpenSea execution')
  }

  const instanceWallet = requireAddress(res.data.address, 'instance wallet')
  if (instanceWallet.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(
      `OpenSea instance wallet does not match requested wallet ${wallet}: ${instanceWallet}`,
    )
  }
}

export async function ensureOpenSeaExecutionWalletMatches(
  wallet: string,
  steps: TxStep[],
): Promise<void> {
  const normalizedWallet = requireAddress(wallet, 'wallet')
  const chainIds = [...new Set(steps.map((step) => step.chainId).filter(Number.isFinite))]
  for (const chainId of chainIds) {
    await ensureInstanceWalletMatches(normalizedWallet, chainId)
  }
}

function getOfferSellerOrder(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  wallet: `0x${string}`,
): OpenSeaAdvancedOrder {
  const orders = transaction.input_data?.orders
  if (orders && orders.length > 0) {
    const walletLower = wallet.toLowerCase()
    return (
      orders.find((order) => order.parameters.offerer.toLowerCase() === walletLower) ??
      orders[orders.length - 1]
    )
  }

  const advancedOrder = transaction.input_data?.advancedOrder
  if (advancedOrder) return advancedOrder

  throw new Error('OpenSea offer fulfillment response did not include advanced orders')
}

function getSellNftItem(transaction: NonNullable<ReturnType<typeof extractTransaction>>): {
  itemType: number
  token: `0x${string}`
  tokenId: string
} {
  const advancedOrder = transaction.input_data?.advancedOrder
  const nftItem = advancedOrder
    ? advancedOrder.parameters.consideration.find((item) => [2, 3, 4, 5].includes(item.itemType))
    : getOfferSellerOrder(
        transaction,
        requireAddress(transaction.input_data?.recipient ?? transaction.to, 'recipient'),
      ).parameters.offer[0]
  if (!nftItem) {
    throw new Error('OpenSea offer fulfillment response did not include an NFT to transfer')
  }

  const tokenId =
    (nftItem.itemType === 4 || nftItem.itemType === 5) &&
    BigInt(nftItem.identifierOrCriteria) === 0n &&
    transaction.input_data?.criteriaResolvers?.[0]?.identifier
      ? transaction.input_data.criteriaResolvers[0].identifier
      : nftItem.identifierOrCriteria.toString()

  return {
    itemType: nftItem.itemType,
    token: requireAddress(nftItem.token, 'NFT contract'),
    tokenId,
  }
}

function getOperatorFromConduitKey(
  conduitKey: string | undefined,
  fallbackTarget: string,
): `0x${string}` {
  const normalized = conduitKey?.toLowerCase()
  if (
    !normalized ||
    normalized === '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) {
    return requireAddress(fallbackTarget, 'seaport target')
  }
  if (normalized === OPENSEA_CONDUIT_KEY.toLowerCase()) {
    return requireAddress(OPENSEA_CONDUIT_ADDRESS, 'OpenSea conduit')
  }
  throw new Error(`Unsupported OpenSea conduit key: ${normalized}`)
}

function _buildNftApprovalStep(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  wallet: `0x${string}`,
  chainId: number,
): TxStep {
  const sellerOrder = getOfferSellerOrder(transaction, wallet)
  const nft = getSellNftItem(transaction)
  const operator = getOperatorFromConduitKey(
    transaction.input_data?.fulfillerConduitKey ?? sellerOrder.parameters.conduitKey,
    transaction.to,
  )

  if (nft.itemType === 2 || nft.itemType === 4) {
    return {
      to: nft.token,
      data: encodeFunctionData({
        abi: ERC721_APPROVE_ABI,
        functionName: 'approve',
        args: [operator, BigInt(nft.tokenId)],
      }),
      value: '0x0',
      chainId,
      label: 'Approve NFT for OpenSea',
    }
  }

  if (nft.itemType === 3 || nft.itemType === 5) {
    return {
      to: nft.token,
      data: encodeFunctionData({
        abi: SET_APPROVAL_FOR_ALL_ABI,
        functionName: 'setApprovalForAll',
        args: [operator, true],
      }),
      value: '0x0',
      chainId,
      label: 'Approve NFT collection for OpenSea',
    }
  }

  throw new Error(`Unsupported NFT itemType for OpenSea sell flow: ${nft.itemType}`)
}

async function getSeaportCounter(chainId: number, wallet: `0x${string}`): Promise<string> {
  const result = await ethCall(
    chainId,
    requireAddress(OPENSEA_SEAPORT_V1_6, 'Seaport contract'),
    encodeFunctionData({
      abi: SEAPORT_COUNTER_ABI,
      functionName: 'getCounter',
      args: [wallet],
    }),
  )
  const [counter] = decodeAbiParameters([{ type: 'uint256' }], result) as [bigint]
  return counter.toString()
}

function getCollectionContractAddress(
  collection: OpenSeaCollectionResponse,
  chainApiName: string,
): `0x${string}` {
  const contract = collection.contracts?.find(
    (item) => item.chain.toLowerCase() === chainApiName.toLowerCase(),
  )
  if (!contract) {
    throw new Error(
      `OpenSea collection ${collection.collection} does not expose a contract for chain ${chainApiName}`,
    )
  }
  return requireAddress(contract.address, 'collection contract')
}

function getOfferCurrencyToken(collection: OpenSeaCollectionResponse): `0x${string}` {
  const currency = collection.pricing_currencies?.offer_currency
  if (!currency?.address || currency.address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(
      `OpenSea collection ${collection.collection} does not expose an ERC20 offer currency`,
    )
  }
  return requireAddress(currency.address, 'offer currency')
}

function getNftItemTypeFromTokenStandard(tokenStandard: string | undefined): 2 | 3 {
  const normalized = tokenStandard?.trim().toLowerCase()
  if (normalized === 'erc721') return 2
  if (normalized === 'erc1155') return 3
  throw new Error(
    `Unsupported NFT token standard for OpenSea offer flow: ${tokenStandard ?? 'missing'}`,
  )
}

function getTokenStandardFromItemType(itemType: number): 'erc721' | 'erc1155' {
  if (itemType === 2 || itemType === 4) return 'erc721'
  if (itemType === 3 || itemType === 5) return 'erc1155'
  throw new Error(`Unsupported OpenSea NFT itemType: ${itemType}`)
}

function getListingCurrencyDetails(collection: OpenSeaCollectionResponse): {
  itemType: 0 | 1
  token: `0x${string}`
} {
  const currency = collection.pricing_currencies?.listing_currency
  if (!currency?.address) {
    throw new Error(
      `OpenSea collection ${collection.collection} does not expose a listing currency`,
    )
  }
  const token = requireAddress(currency.address, 'listing currency')
  return {
    itemType: token.toLowerCase() === ZERO_ADDRESS.toLowerCase() ? 0 : 1,
    token,
  }
}

function feeToBasisPoints(feePercent: number): bigint {
  if (!Number.isFinite(feePercent) || feePercent < 0) {
    throw new Error(`Invalid OpenSea fee percentage: ${feePercent}`)
  }
  return BigInt(Math.round(feePercent * 100))
}

function computeFeeAmount(amount: bigint, feePercent: number): string {
  return ((amount * feeToBasisPoints(feePercent)) / 10_000n).toString()
}

function makeSalt(): string {
  return BigInt(`0x${randomBytes(16).toString('hex')}`).toString()
}

function resolveOfferTimes(args: OpenSeaOfferArgs): { startTime: string; endTime: string } {
  const now = Math.floor(Date.now() / 1000)
  const start = args.startTime ?? now
  const end = args.endTime ?? start + (args.durationSeconds ?? 7 * 24 * 60 * 60)
  if (end <= start) {
    throw new Error('OpenSea offer end time must be later than start time')
  }
  return {
    startTime: start.toString(),
    endTime: end.toString(),
  }
}

function resolveListingTimes(args: OpenSeaListingArgs): { startTime: string; endTime: string } {
  const now = Math.floor(Date.now() / 1000)
  const start = args.startTime ?? now
  const end = args.endTime ?? start + (args.durationSeconds ?? 7 * 24 * 60 * 60)
  if (end <= start) {
    throw new Error('OpenSea listing end time must be later than start time')
  }
  return {
    startTime: start.toString(),
    endTime: end.toString(),
  }
}

async function buildPreparedOfferOrder(args: OpenSeaOfferArgs): Promise<{
  chain: ReturnType<typeof normalizeOpenSeaChain>
  protocolAddress: string
  parameters: OpenSeaOrderParametersWithCounter
  metadata: OpenSeaOfferPreview['metadata']
}> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const tokenId = parseTokenId(args.tokenId)
  const amount = parseUintString(args.amount, 'amount')
  if (amount === '0') {
    throw new Error('Invalid --amount: "0" — must be greater than 0')
  }
  const chain = normalizeOpenSeaChain(args.chain)
  const protocolAddress = args.protocolAddress ?? OPENSEA_SEAPORT_V1_6
  const collection = await getCollection({ collection: args.collection })
  const contract = getCollectionContractAddress(collection, chain.apiName)
  const nft = await getNft({ chain: chain.input, contract, tokenId })
  const itemType = getNftItemTypeFromTokenStandard(nft.nft?.token_standard)
  const paymentToken = getOfferCurrencyToken(collection)
  const { startTime, endTime } = resolveOfferTimes(args)
  const counter = await getSeaportCounter(chain.chainId, wallet)
  const requiredFees = (collection.fees ?? []).filter((fee) => fee.required)

  const parameters: OpenSeaOrderParametersWithCounter = {
    offerer: wallet,
    zone: ZERO_ADDRESS,
    offer: [
      {
        itemType: 1,
        token: paymentToken,
        identifierOrCriteria: '0',
        startAmount: amount,
        endAmount: amount,
      },
    ],
    consideration: [
      {
        itemType,
        token: contract,
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1',
        recipient: wallet,
      },
      ...requiredFees.map((fee) => ({
        itemType: 1,
        token: paymentToken,
        identifierOrCriteria: '0',
        startAmount: computeFeeAmount(BigInt(amount), fee.fee),
        endAmount: computeFeeAmount(BigInt(amount), fee.fee),
        recipient: requireAddress(fee.recipient, 'OpenSea fee recipient'),
      })),
    ],
    orderType: 0,
    startTime,
    endTime,
    zoneHash: ZERO_BYTES32,
    salt: makeSalt(),
    conduitKey: OPENSEA_CONDUIT_KEY,
    totalOriginalConsiderationItems: String(1 + requiredFees.length),
    counter,
  }

  return {
    chain,
    protocolAddress,
    parameters,
    metadata: {
      collection: args.collection,
      contract,
      tokenId,
      paymentToken,
      paymentAmount: amount,
      chainId: chain.chainId,
    },
  }
}

async function buildPreparedListingOrder(args: OpenSeaListingArgs): Promise<{
  chain: ReturnType<typeof normalizeOpenSeaChain>
  protocolAddress: string
  parameters: OpenSeaOrderParametersWithCounter
  metadata: OpenSeaListingPreview['metadata']
}> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const tokenId = parseTokenId(args.tokenId)
  const amount = BigInt(parseUintString(args.amount, 'amount'))
  if (amount <= 0n) {
    throw new Error(`Invalid --amount: "${args.amount}" — must be greater than 0`)
  }
  const chain = normalizeOpenSeaChain(args.chain)
  const protocolAddress = args.protocolAddress ?? OPENSEA_SEAPORT_V1_6
  const collection = await getCollection({ collection: args.collection })
  const contract = getCollectionContractAddress(collection, chain.apiName)
  const nft = await getNft({ chain: chain.input, contract, tokenId })
  const tokenStandard = nft.nft?.token_standard
  const itemType = getNftItemTypeFromTokenStandard(tokenStandard)
  const currency = getListingCurrencyDetails(collection)
  const { startTime, endTime } = resolveListingTimes(args)
  const counter = await getSeaportCounter(chain.chainId, wallet)
  const requiredFees = (collection.fees ?? []).filter((fee) => fee.required)
  const feeItems = requiredFees.map((fee) => ({
    itemType: currency.itemType,
    token: currency.token,
    identifierOrCriteria: '0',
    startAmount: computeFeeAmount(amount, fee.fee),
    endAmount: computeFeeAmount(amount, fee.fee),
    recipient: requireAddress(fee.recipient, 'OpenSea fee recipient'),
  }))
  const totalFees = feeItems.reduce((sum, item) => sum + BigInt(item.endAmount), 0n)
  const sellerProceeds = amount - totalFees
  if (sellerProceeds <= 0n) {
    throw new Error(`OpenSea listing amount ${amount} is not enough to cover required fees`)
  }

  const parameters: OpenSeaOrderParametersWithCounter = {
    offerer: wallet,
    zone: ZERO_ADDRESS,
    offer: [
      {
        itemType,
        token: contract,
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1',
      },
    ],
    consideration: [
      {
        itemType: currency.itemType,
        token: currency.token,
        identifierOrCriteria: '0',
        startAmount: sellerProceeds.toString(),
        endAmount: sellerProceeds.toString(),
        recipient: wallet,
      },
      ...feeItems,
    ],
    orderType: 0,
    startTime,
    endTime,
    zoneHash: ZERO_BYTES32,
    salt: makeSalt(),
    conduitKey: OPENSEA_CONDUIT_KEY,
    totalOriginalConsiderationItems: String(1 + feeItems.length),
    counter,
  }

  return {
    chain,
    protocolAddress,
    parameters,
    metadata: {
      collection: args.collection,
      contract,
      tokenId,
      paymentToken: currency.token,
      paymentAmount: amount.toString(),
      paymentItemType: currency.itemType,
      chainId: chain.chainId,
    },
  }
}

function buildOfferTypedData(
  chainId: number,
  parameters: OpenSeaOrderParametersWithCounter,
): OpenSeaOfferPreview['typedData'] {
  return {
    domain: {
      name: 'Seaport',
      version: '1.6',
      chainId,
      verifyingContract: OPENSEA_SEAPORT_V1_6,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      OfferItem: [
        { name: 'itemType', type: 'uint8' },
        { name: 'token', type: 'address' },
        { name: 'identifierOrCriteria', type: 'uint256' },
        { name: 'startAmount', type: 'uint256' },
        { name: 'endAmount', type: 'uint256' },
      ],
      ConsiderationItem: [
        { name: 'itemType', type: 'uint8' },
        { name: 'token', type: 'address' },
        { name: 'identifierOrCriteria', type: 'uint256' },
        { name: 'startAmount', type: 'uint256' },
        { name: 'endAmount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
      ],
      OrderComponents: [
        { name: 'offerer', type: 'address' },
        { name: 'zone', type: 'address' },
        { name: 'offer', type: 'OfferItem[]' },
        { name: 'consideration', type: 'ConsiderationItem[]' },
        { name: 'orderType', type: 'uint8' },
        { name: 'startTime', type: 'uint256' },
        { name: 'endTime', type: 'uint256' },
        { name: 'zoneHash', type: 'bytes32' },
        { name: 'salt', type: 'uint256' },
        { name: 'conduitKey', type: 'bytes32' },
        { name: 'counter', type: 'uint256' },
      ],
    },
    primaryType: 'OrderComponents',
    message: {
      offerer: parameters.offerer,
      zone: parameters.zone,
      offer: parameters.offer,
      consideration: parameters.consideration,
      orderType: parameters.orderType,
      startTime: parameters.startTime,
      endTime: parameters.endTime,
      zoneHash: parameters.zoneHash,
      salt: parameters.salt,
      conduitKey: parameters.conduitKey,
      counter: parameters.counter,
    },
  }
}

function buildOfferApprovalStepsFromOrder(
  parameters: OpenSeaOrderParametersWithCounter,
  chainId: number,
): TxStep[] {
  const paymentItem = parameters.offer[0]
  if (!paymentItem) {
    throw new Error('Prepared OpenSea offer order did not include payment offer item')
  }
  if (paymentItem.itemType !== 1) return []

  return [
    buildApprovalStep(
      requireAddress(paymentItem.token, 'offer payment token'),
      getOperatorFromConduitKey(parameters.conduitKey, OPENSEA_SEAPORT_V1_6),
      paymentItem.endAmount,
      chainId,
      'Approve offer payment token for OpenSea',
    ),
  ]
}

async function buildListingApprovalStepsFromOrder(
  parameters: OpenSeaOrderParametersWithCounter,
  wallet: `0x${string}`,
  chainId: number,
): Promise<TxStep[]> {
  const nftItem = parameters.offer[0]
  if (!nftItem) {
    throw new Error('Prepared OpenSea listing order did not include NFT offer item')
  }

  const tokenStandard = getTokenStandardFromItemType(nftItem.itemType)
  const contract = requireAddress(nftItem.token, 'listing NFT contract')
  const tokenId = nftItem.identifierOrCriteria

  await ensureWalletOwnsTokenStandardNft(tokenStandard, wallet, chainId, tokenId, contract)

  return [
    buildDirectNftApprovalStep({
      tokenStandard,
      contract,
      tokenId,
      operator: getOperatorFromConduitKey(parameters.conduitKey, OPENSEA_SEAPORT_V1_6),
      chainId,
    }),
  ]
}

interface SignTypedDataResponse {
  ok: boolean
  data: { address: string; signature: string }
  error?: string
}

async function signAndSubmitOrder(
  wallet: `0x${string}`,
  typedData: OpenSeaOfferPreview['typedData'],
  submissionPath: string,
  submissionBody: {
    parameters: OpenSeaOrderParametersWithCounter
    protocol_address: string
  },
): Promise<unknown> {
  const { instanceId } = resolveCredentials()

  // Sign the EIP-712 typed data via wallet API
  const signRes = await apiPost<SignTypedDataResponse>(
    `/v1/instances/${instanceId}/wallet/sign-typed-data`,
    {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    },
  )
  if (!signRes.ok) {
    throw new Error(signRes.error ?? 'Failed to sign typed data for OpenSea order')
  }
  if (signRes.data.address.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(`Signature address mismatch: got ${signRes.data.address}, expected ${wallet}`)
  }

  // Submit the signed order to OpenSea
  return submitOrder(submissionPath, {
    ...submissionBody,
    signature: signRes.data.signature,
  })
}

async function ensureWalletOwnsTokenStandardNft(
  tokenStandard: string | undefined,
  wallet: `0x${string}`,
  chainId: number,
  tokenId: string,
  contractAddress: `0x${string}`,
): Promise<void> {
  const assetTokenId = BigInt(tokenId)
  const normalized = tokenStandard?.trim().toLowerCase()

  if (normalized === 'erc721') {
    let owner: `0x${string}`
    try {
      const result = await ethCall(
        chainId,
        contractAddress,
        encodeFunctionData({
          abi: ERC721_OWNER_OF_ABI,
          functionName: 'ownerOf',
          args: [assetTokenId],
        }),
      )
      ;[owner] = decodeAbiParameters([{ type: 'address' }], result) as [`0x${string}`]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to verify ERC721 ownership for ${contractAddress} #${assetTokenId}: ${message}`,
      )
    }

    if (owner.toLowerCase() !== wallet.toLowerCase()) {
      throw openSeaError(
        `Wallet ${wallet} is not the owner of NFT ${contractAddress} #${assetTokenId}`,
        'NFT_OWNERSHIP_MISMATCH',
        {
          wallet,
          contract: contractAddress,
          tokenId: assetTokenId.toString(),
        },
      )
    }
    return
  }

  if (normalized === 'erc1155') {
    let balance: bigint
    try {
      const result = await ethCall(
        chainId,
        contractAddress,
        encodeFunctionData({
          abi: ERC1155_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [wallet, assetTokenId],
        }),
      )
      ;[balance] = decodeAbiParameters([{ type: 'uint256' }], result) as [bigint]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to verify ERC1155 balance for ${contractAddress} #${assetTokenId}: ${message}`,
      )
    }

    if (balance <= 0n) {
      throw openSeaError(
        `Wallet ${wallet} has zero balance for NFT ${contractAddress} #${assetTokenId}`,
        'NFT_BALANCE_EMPTY',
        {
          wallet,
          contract: contractAddress,
          tokenId: assetTokenId.toString(),
        },
      )
    }
    return
  }

  throw new Error(
    `Unsupported NFT token standard for OpenSea listing flow: ${tokenStandard ?? 'missing'}`,
  )
}

function buildDirectNftApprovalStep(args: {
  tokenStandard: string | undefined
  contract: `0x${string}`
  tokenId: string
  operator: `0x${string}`
  chainId: number
}): TxStep {
  const normalized = args.tokenStandard?.trim().toLowerCase()
  if (normalized === 'erc721') {
    return {
      to: args.contract,
      data: encodeFunctionData({
        abi: ERC721_APPROVE_ABI,
        functionName: 'approve',
        args: [args.operator, BigInt(args.tokenId)],
      }),
      value: '0x0',
      chainId: args.chainId,
      label: 'Approve NFT for OpenSea',
    }
  }

  if (normalized === 'erc1155') {
    return {
      to: args.contract,
      data: encodeFunctionData({
        abi: SET_APPROVAL_FOR_ALL_ABI,
        functionName: 'setApprovalForAll',
        args: [args.operator, true],
      }),
      value: '0x0',
      chainId: args.chainId,
      label: 'Approve NFT collection for OpenSea',
    }
  }

  throw new Error(
    `Unsupported NFT token standard for OpenSea listing flow: ${args.tokenStandard ?? 'missing'}`,
  )
}

function inferOrderKind(order: OpenSeaOrderResponse): 'offer' | 'listing' {
  const paymentItem = order.protocol_data?.parameters?.offer?.[0]
  if (paymentItem?.itemType === 1) return 'offer'
  return 'listing'
}

function encodeSeaportCancelCalldata(parameters: OpenSeaOrderParametersWithCounter): `0x${string}` {
  return encodeFunctionData({
    abi: SEAPORT_CANCEL_ABI,
    functionName: 'cancel',
    args: [
      [
        {
          offerer: requireAddress(parameters.offerer, 'order offerer'),
          zone: requireAddress(parameters.zone, 'order zone'),
          offer: parameters.offer.map((item) => ({
            itemType: item.itemType,
            token: requireAddress(item.token, 'order offer token'),
            identifierOrCriteria: BigInt(item.identifierOrCriteria),
            startAmount: BigInt(item.startAmount),
            endAmount: BigInt(item.endAmount),
          })),
          consideration: parameters.consideration.map((item) => ({
            itemType: item.itemType,
            token: requireAddress(item.token, 'order consideration token'),
            identifierOrCriteria: BigInt(item.identifierOrCriteria),
            startAmount: BigInt(item.startAmount),
            endAmount: BigInt(item.endAmount),
            recipient: requireAddress(item.recipient, 'order recipient'),
          })),
          orderType: parameters.orderType,
          startTime: BigInt(parameters.startTime),
          endTime: BigInt(parameters.endTime),
          zoneHash: parameters.zoneHash as `0x${string}`,
          salt: BigInt(parameters.salt),
          conduitKey: parameters.conduitKey as `0x${string}`,
          totalOriginalConsiderationItems: BigInt(parameters.totalOriginalConsiderationItems),
          counter: BigInt(parameters.counter),
        },
      ],
    ],
  })
}

async function resolveCancelContext(args: OpenSeaCancelArgs): Promise<OpenSeaCancelContext> {
  const chain = normalizeOpenSeaChain(args.chain)
  const wallet = requireAddress(args.wallet, 'wallet')
  const order = await getOrder({
    chain: chain.input,
    orderHash: args.orderHash,
    protocolAddress: args.protocolAddress,
  })
  const protocolAddress = order.protocol_address ?? args.protocolAddress ?? OPENSEA_SEAPORT_V1_6
  const parameters = order.protocol_data?.parameters

  if (!parameters) {
    throw openSeaError(
      `OpenSea order ${args.orderHash} did not include order parameters`,
      'ORDER_PARAMETERS_MISSING',
      { orderHash: args.orderHash },
    )
  }

  const offerer = requireAddress(parameters.offerer, 'order offerer')
  if (offerer.toLowerCase() !== wallet.toLowerCase()) {
    throw openSeaError(
      `Order offerer ${offerer} does not match wallet ${wallet}`,
      'ORDER_OFFERER_MISMATCH',
      {
        orderHash: args.orderHash,
        offerer,
        wallet,
      },
    )
  }

  if (order.status && order.status !== 'ACTIVE') {
    throw openSeaError(
      `OpenSea order ${args.orderHash} is not active: ${order.status}`,
      'ORDER_NOT_ACTIVE',
      {
        orderHash: args.orderHash,
        status: order.status,
      },
    )
  }

  const orderKind = inferOrderKind(order)
  const signedZone = isSignedZoneAddress(parameters.zone)
  const steps: TxStep[] = [
    {
      to: requireAddress(protocolAddress, 'Seaport contract'),
      data: encodeSeaportCancelCalldata(parameters),
      value: '0x0',
      chainId: chain.chainId,
      label:
        orderKind === 'offer' ? 'Cancel OpenSea offer on-chain' : 'Cancel OpenSea listing on-chain',
    },
  ]

  return {
    chain,
    order,
    orderKind,
    protocolAddress,
    offerer,
    signedZone,
    steps,
  }
}

async function buildOpenSeaCancelPreview(
  args: OpenSeaCancelArgs,
  expectedKind: 'offer' | 'listing',
): Promise<OpenSeaCancelPreview> {
  const context = await resolveCancelContext(args)
  if (context.orderKind !== expectedKind) {
    throw openSeaError(
      `Order ${args.orderHash} is a ${context.orderKind}, not a ${expectedKind}`,
      'ORDER_KIND_MISMATCH',
      {
        orderHash: args.orderHash,
        expectedKind,
        actualKind: context.orderKind,
      },
    )
  }

  return {
    mode: context.signedZone ? 'official-first' : 'onchain-only',
    steps: context.steps,
    official: context.signedZone
      ? {
          path: `/api/v2/orders/chain/${context.chain.apiName}/protocol/${context.protocolAddress}/${args.orderHash}/cancel`,
          method: 'POST',
        }
      : undefined,
    metadata: {
      orderHash: args.orderHash,
      orderKind: context.orderKind,
      offerer: context.offerer,
      protocolAddress: context.protocolAddress,
      chainId: context.chain.chainId,
      signedZone: context.signedZone,
      status: context.order.status,
    },
  }
}

async function executeOpenSeaCancel(
  args: OpenSeaCancelArgs,
  expectedKind: 'offer' | 'listing',
): Promise<OpenSeaCancelExecutionResult> {
  const preview = await buildOpenSeaCancelPreview(args, expectedKind)

  if (preview.mode === 'official-first' && preview.official) {
    try {
      const official = await cancelOrder({
        chain: args.chain,
        orderHash: args.orderHash,
        protocolAddress: preview.metadata.protocolAddress,
      })
      return {
        mode: 'official',
        official,
        metadata: preview.metadata,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isMakerIdentityMismatch(message) && !isSignedZoneUnsupported(message)) {
        throw error
      }
    }
  }

  await ensureOpenSeaExecutionWalletMatches(args.wallet, preview.steps)
  const execution = await executeStepsFromJson(JSON.stringify({ steps: preview.steps }))
  return {
    mode: preview.mode === 'official-first' ? 'official-fallback-onchain' : 'onchain',
    execution,
    metadata: preview.metadata,
  }
}

export async function buildOpenSeaCancelOfferPreview(
  args: OpenSeaCancelArgs,
): Promise<OpenSeaCancelPreview> {
  return buildOpenSeaCancelPreview(args, 'offer')
}

export async function buildOpenSeaCancelOfferSteps(args: OpenSeaCancelArgs): Promise<StepOutput> {
  const preview = await buildOpenSeaCancelOfferPreview(args)
  return { steps: preview.steps }
}

export async function buildOpenSeaCancelListingPreview(
  args: OpenSeaCancelArgs,
): Promise<OpenSeaCancelPreview> {
  return buildOpenSeaCancelPreview(args, 'listing')
}

export async function buildOpenSeaCancelListingSteps(args: OpenSeaCancelArgs): Promise<StepOutput> {
  const preview = await buildOpenSeaCancelListingPreview(args)
  return { steps: preview.steps }
}

export async function cancelOpenSeaOffer(
  args: OpenSeaCancelArgs,
): Promise<OpenSeaCancelExecutionResult> {
  return executeOpenSeaCancel(args, 'offer')
}

export async function cancelOpenSeaListing(
  args: OpenSeaCancelArgs,
): Promise<OpenSeaCancelExecutionResult> {
  return executeOpenSeaCancel(args, 'listing')
}

export async function buildOpenSeaOfferPreview(
  args: OpenSeaOfferArgs,
): Promise<OpenSeaOfferPreview> {
  const prepared = await buildPreparedOfferOrder(args)
  return buildOfferPreviewFromPrepared(prepared)
}

function buildOfferPreviewFromPrepared(
  prepared: Awaited<ReturnType<typeof buildPreparedOfferOrder>>,
): OpenSeaOfferPreview {
  const paymentItem = prepared.parameters.offer[0]
  if (!paymentItem) {
    throw new Error('Prepared OpenSea offer order did not include a payment offer item')
  }

  return {
    steps: buildOfferApprovalStepsFromOrder(prepared.parameters, prepared.chain.chainId),
    typedData: buildOfferTypedData(prepared.chain.chainId, prepared.parameters),
    submission: {
      protocol_address: prepared.protocolAddress,
      parameters: prepared.parameters,
    },
    metadata: prepared.metadata,
  }
}

export async function createOpenSeaOffer(
  args: OpenSeaOfferArgs,
): Promise<OpenSeaOfferExecutionResult> {
  const prepared = await buildPreparedOfferOrder(args)
  const preview = buildOfferPreviewFromPrepared(prepared)
  const wallet = requireAddress(args.wallet, 'wallet')
  const approval =
    preview.steps.length > 0
      ? (await ensureOpenSeaExecutionWalletMatches(wallet, preview.steps),
        await executeStepsFromJson(JSON.stringify({ steps: preview.steps })))
      : undefined
  const submissionPath = `/api/v2/orders/${prepared.chain.apiName}/seaport/offers`
  const submissionBody = {
    parameters: preview.submission.parameters,
    protocol_address: preview.submission.protocol_address,
  }

  const orderResult = await signAndSubmitOrder(
    wallet,
    preview.typedData,
    submissionPath,
    submissionBody,
  )

  return {
    approval,
    typedData: preview.typedData,
    submission: orderResult,
    metadata: preview.metadata,
  }
}

export async function buildOpenSeaListingPreview(
  args: OpenSeaListingArgs,
): Promise<OpenSeaListingPreview> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const prepared = await buildPreparedListingOrder(args)
  return buildListingPreviewFromPrepared(prepared, wallet)
}

async function buildListingPreviewFromPrepared(
  prepared: Awaited<ReturnType<typeof buildPreparedListingOrder>>,
  wallet: `0x${string}`,
): Promise<OpenSeaListingPreview> {
  const steps = await buildListingApprovalStepsFromOrder(
    prepared.parameters,
    wallet,
    prepared.chain.chainId,
  )

  return {
    steps,
    typedData: buildOfferTypedData(prepared.chain.chainId, prepared.parameters),
    submission: {
      protocol_address: prepared.protocolAddress,
      parameters: prepared.parameters,
    },
    metadata: prepared.metadata,
  }
}

export async function createOpenSeaListing(
  args: OpenSeaListingArgs,
): Promise<OpenSeaListingExecutionResult> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const prepared = await buildPreparedListingOrder(args)
  const preview = await buildListingPreviewFromPrepared(prepared, wallet)
  const approval =
    preview.steps.length > 0
      ? (await ensureOpenSeaExecutionWalletMatches(wallet, preview.steps),
        await executeStepsFromJson(JSON.stringify({ steps: preview.steps })))
      : undefined
  const submissionPath = `/api/v2/orders/${prepared.chain.apiName}/seaport/listings`
  const submissionBody = {
    parameters: preview.submission.parameters,
    protocol_address: preview.submission.protocol_address,
  }

  const orderResult = await signAndSubmitOrder(
    wallet,
    preview.typedData,
    submissionPath,
    submissionBody,
  )

  return {
    approval,
    typedData: preview.typedData,
    submission: orderResult,
    metadata: preview.metadata,
  }
}

export async function buildOpenSeaBuySteps(args: OpenSeaBuyArgs): Promise<StepOutput> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const transaction = requireFulfillmentTransaction(args.fulfillment, 'buy')
  const chainId = requireFulfillmentChainId(transaction, 'buy')
  ensureFulfillmentRecipientMatchesWallet(transaction, wallet)
  const to = requireAddress(transaction.to, 'fulfillment target')
  const calldata = encodeFulfillmentCalldata(transaction)
  const valueWei = parseNonNegativeUintString(transaction.value, 'value')
  const payment = getBuyPaymentDetails(transaction)
  const steps: TxStep[] = []
  if (!isNative(payment.token)) {
    steps.push(
      buildApprovalStep(
        payment.token,
        getErc20ApprovalSpender(transaction),
        payment.totalAmount.toString(),
        chainId,
        'Approve ERC20 payment token for OpenSea',
      ),
    )
  }

  steps.push({
    to,
    data: calldata,
    value: `0x${valueWei.toString(16)}`,
    chainId,
    label: 'OpenSea buy NFT',
  })

  return { steps }
}

export async function buildOpenSeaSwapSteps(args: OpenSeaSwapArgs): Promise<StepOutput> {
  const quote = await getSwapQuote({
    fromChain: args.fromChain,
    fromAddress: args.fromAddress,
    toChain: args.toChain,
    toAddress: args.toAddress,
    quantity: args.quantity,
    address: requireAddress(args.wallet, 'wallet'),
    slippage: parseSlippage(args.slippage),
    recipient: args.recipient,
  })
  const transactions = extractSwapTransactions(quote)
  const fallbackChain =
    typeof transactions[0]?.chain === 'string'
      ? normalizeOpenSeaChain(transactions[0].chain).chainId
      : typeof transactions[0]?.chain === 'object' && transactions[0]?.chain?.networkId
        ? transactions[0].chain.networkId
        : undefined
  if (!fallbackChain) {
    throw new Error('OpenSea swap quote did not include a valid chain on the first transaction')
  }

  return {
    steps: transactions.map((transaction, index) => {
      if (!transaction.to) {
        throw new Error(`OpenSea swap transaction ${index + 1} did not include a target contract`)
      }
      if (!transaction.data || !transaction.data.startsWith('0x')) {
        throw new Error(`OpenSea swap transaction ${index + 1} did not include valid calldata`)
      }

      const chainId = resolveSwapTransactionChainId(transaction.chain, fallbackChain)
      return {
        to: requireAddress(transaction.to, `swap transaction ${index + 1} target`),
        data: transaction.data as `0x${string}`,
        value: `0x${BigInt(transaction.value ?? '0').toString(16)}`,
        chainId,
        label: getSwapStepLabel(transaction, index, transactions.length),
      }
    }),
  }
}

export async function buildOpenSeaSellSteps(args: OpenSeaSellArgs): Promise<StepOutput> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const transaction = requireFulfillmentTransaction(args.fulfillment, 'sell')
  const chainId = requireFulfillmentChainId(transaction, 'sell')
  const to = requireAddress(transaction.to, 'fulfillment target')
  const calldata = encodeFulfillmentCalldata(transaction)
  const valueWei = parseNonNegativeUintString(transaction.value, 'value')
  const nft = getSellNftItem(transaction)
  await ensureWalletOwnsTokenStandardNft(
    getTokenStandardFromItemType(nft.itemType),
    wallet,
    chainId,
    nft.tokenId,
    nft.token,
  )
  const approvalStep = buildDirectNftApprovalStep({
    tokenStandard: getTokenStandardFromItemType(nft.itemType),
    contract: nft.token,
    tokenId: nft.tokenId,
    operator: getOperatorFromConduitKey(
      transaction.input_data?.fulfillerConduitKey ??
        getOfferSellerOrder(transaction, wallet).parameters.conduitKey,
      transaction.to,
    ),
    chainId,
  })

  return {
    steps: [
      approvalStep,
      {
        to,
        data: calldata,
        value: `0x${valueWei.toString(16)}`,
        chainId,
        label: 'OpenSea sell NFT',
      },
    ],
  }
}
