import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import { apiPost, resolveCredentials } from '../api-client.js'
import { buildApprovalStep, isNative, requireAddress } from '../shared.js'
import type { StepOutput, TxStep } from '../types.js'
import {
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  OPENSEA_SEAPORT_V1_6,
  type OpenSeaAdvancedOrder,
  type OpenSeaCriteriaResolver,
  type OpenSeaFulfillmentMatch,
  type OpenSeaFulfillmentResponse,
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
const MATCH_ADVANCED_ORDERS_SELECTOR = toFunctionSelector(MATCH_ADVANCED_ORDERS_FUNCTION)
const FULFILL_ADVANCED_ORDER_SELECTOR = toFunctionSelector(FULFILL_ADVANCED_ORDER_FUNCTION)
const BASIC_ORDER_SELECTOR = toFunctionSelector(BASIC_ORDER_FUNCTION)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'
const execFileAsync = promisify(execFile)
const ALLOWED_OPENSEA_FULFILLMENT_SELECTORS = new Set([
  BASIC_ORDER_SELECTOR,
  MATCH_ADVANCED_ORDERS_SELECTOR,
  FULFILL_ADVANCED_ORDER_SELECTOR,
])

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

interface PaymentDetails {
  itemType: number
  token: string
  totalAmount: bigint
}

interface SelectedAdvancedOrder {
  order: OpenSeaAdvancedOrder
  orderIndex: number
}

interface SelectedNftItem {
  itemType: number
  token: `0x${string}`
  tokenId: string
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

function getFulfillmentSelector(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
): `0x${string}` | undefined {
  if (transaction.data) {
    return requireHexData(transaction.data, 'fulfillment transaction.data').slice(0, 10) as `0x${string}`
  }

  const rawData = transaction.input_data?.data
  if (typeof rawData === 'string' && rawData.startsWith('0x')) {
    return requireHexData(rawData, 'fulfillment transaction.input_data.data').slice(
      0,
      10,
    ) as `0x${string}`
  }

  if (transaction.input_data?.parameters) {
    return BASIC_ORDER_SELECTOR
  }

  if (transaction.function === BASIC_ORDER_FUNCTION) {
    return BASIC_ORDER_SELECTOR
  }

  const functionName = transaction.function?.split('(')[0]
  if (functionName === 'matchAdvancedOrders') {
    return MATCH_ADVANCED_ORDERS_SELECTOR
  }
  if (functionName === 'fulfillAdvancedOrder') {
    return FULFILL_ADVANCED_ORDER_SELECTOR
  }

  return undefined
}

function ensureOfficialOpenSeaFulfillment(
  fulfillment: OpenSeaFulfillmentResponse,
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  action: 'buy' | 'sell',
): void {
  const target = requireAddress(transaction.to, 'fulfillment target')
  if (target.toLowerCase() !== OPENSEA_SEAPORT_V1_6.toLowerCase()) {
    throw new Error(
      `OpenSea ${action} fulfillment must target the official Seaport contract`,
    )
  }

  const protocol = fulfillment.protocol?.trim().toLowerCase()
  if (protocol && protocol !== 'seaport') {
    throw new Error(`OpenSea ${action} fulfillment must use the Seaport protocol`)
  }

  const selector = getFulfillmentSelector(transaction)
  if (!selector || !ALLOWED_OPENSEA_FULFILLMENT_SELECTORS.has(selector)) {
    throw new Error(`OpenSea ${action} fulfillment used an unsupported Seaport function`)
  }
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

function ensureSellFulfillmentRecipientMatchesWallet(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  wallet: `0x${string}`,
): void {
  const recipient = transaction.input_data?.recipient
  if (!recipient) return
  const normalizedRecipient = requireAddress(recipient, 'sell fulfillment recipient')
  if (normalizedRecipient.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(
      `OpenSea sell fulfillment recipient does not match wallet ${wallet}: ${normalizedRecipient}`,
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

function getMatchingOfferSellerOrder(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  wallet: `0x${string}`,
): SelectedAdvancedOrder {
  const orders = transaction.input_data?.orders
  if (!orders || orders.length === 0) {
    throw new Error('OpenSea offer fulfillment response did not include seller orders')
  }

  const walletLower = wallet.toLowerCase()
  const orderIndex = orders.findIndex((order) => order.parameters.offerer.toLowerCase() === walletLower)
  if (orderIndex === -1) {
    throw new Error(`OpenSea offer fulfillment did not include a seller order for wallet ${wallet}`)
  }

  return {
    order: orders[orderIndex],
    orderIndex,
  }
}

function getCriteriaResolvedTokenId(args: {
  transaction: NonNullable<ReturnType<typeof extractTransaction>>
  itemType: number
  identifierOrCriteria: string
  orderIndex: number
  side: 0 | 1
  itemIndex: number
}): string {
  if ((args.itemType !== 4 && args.itemType !== 5) || BigInt(args.identifierOrCriteria) !== 0n) {
    return args.identifierOrCriteria.toString()
  }

  const resolver = args.transaction.input_data?.criteriaResolvers?.find(
    (candidate) =>
      BigInt(candidate.orderIndex) === BigInt(args.orderIndex) &&
      Number(candidate.side) === args.side &&
      BigInt(candidate.index) === BigInt(args.itemIndex),
  )
  if (!resolver?.identifier) {
    throw new Error(
      `OpenSea fulfillment did not include a matching criteria resolver for order ${args.orderIndex} item ${args.itemIndex}`,
    )
  }

  return resolver.identifier
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

  if (transaction.function !== BASIC_ORDER_FUNCTION && !transaction.input_data?.parameters) {
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
  if (transaction.input_data?.orders?.length) {
    return getMatchingOfferSellerOrder(transaction, wallet).order
  }

  const advancedOrder = transaction.input_data?.advancedOrder
  if (advancedOrder) return advancedOrder

  throw new Error('OpenSea offer fulfillment response did not include advanced orders')
}

function getSellNftItem(
  transaction: NonNullable<ReturnType<typeof extractTransaction>>,
  wallet: `0x${string}`,
): SelectedNftItem {
  const advancedOrder = transaction.input_data?.advancedOrder
  if (advancedOrder) {
    const nftIndex = advancedOrder.parameters.consideration.findIndex((item) =>
      [2, 3, 4, 5].includes(item.itemType),
    )
    const nftItem = nftIndex >= 0 ? advancedOrder.parameters.consideration[nftIndex] : undefined
    if (!nftItem) {
      throw new Error('OpenSea offer fulfillment response did not include an NFT to transfer')
    }

    return {
      itemType: nftItem.itemType,
      token: requireAddress(nftItem.token, 'NFT contract'),
      tokenId: getCriteriaResolvedTokenId({
        transaction,
        itemType: nftItem.itemType,
        identifierOrCriteria: nftItem.identifierOrCriteria.toString(),
        orderIndex: 0,
        side: 1,
        itemIndex: nftIndex,
      }),
    }
  }

  const sellerOrder = getMatchingOfferSellerOrder(transaction, wallet)
  const nftIndex = sellerOrder.order.parameters.offer.findIndex((item) => [2, 3, 4, 5].includes(item.itemType))
  const nftItem = nftIndex >= 0 ? sellerOrder.order.parameters.offer[nftIndex] : undefined
  if (!nftItem) {
    throw new Error('OpenSea offer fulfillment response did not include an NFT to transfer')
  }

  return {
    itemType: nftItem.itemType,
    token: requireAddress(nftItem.token, 'NFT contract'),
    tokenId: getCriteriaResolvedTokenId({
      transaction,
      itemType: nftItem.itemType,
      identifierOrCriteria: nftItem.identifierOrCriteria.toString(),
      orderIndex: sellerOrder.orderIndex,
      side: 0,
      itemIndex: nftIndex,
    }),
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
  const nft = getSellNftItem(transaction, wallet)
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

function getTokenStandardFromItemType(itemType: number): 'erc721' | 'erc1155' {
  if (itemType === 2 || itemType === 4) return 'erc721'
  if (itemType === 3 || itemType === 5) return 'erc1155'
  throw new Error(`Unsupported OpenSea NFT itemType: ${itemType}`)
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


export async function buildOpenSeaBuySteps(args: OpenSeaBuyArgs): Promise<StepOutput> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const transaction = requireFulfillmentTransaction(args.fulfillment, 'buy')
  ensureOfficialOpenSeaFulfillment(args.fulfillment, transaction, 'buy')
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

export async function buildOpenSeaSellSteps(args: OpenSeaSellArgs): Promise<StepOutput> {
  const wallet = requireAddress(args.wallet, 'wallet')
  const transaction = requireFulfillmentTransaction(args.fulfillment, 'sell')
  ensureOfficialOpenSeaFulfillment(args.fulfillment, transaction, 'sell')
  const chainId = requireFulfillmentChainId(transaction, 'sell')
  ensureSellFulfillmentRecipientMatchesWallet(transaction, wallet)
  const to = requireAddress(transaction.to, 'fulfillment target')
  const calldata = encodeFulfillmentCalldata(transaction)
  const valueWei = parseNonNegativeUintString(transaction.value, 'value')
  const nft = getSellNftItem(transaction, wallet)
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
