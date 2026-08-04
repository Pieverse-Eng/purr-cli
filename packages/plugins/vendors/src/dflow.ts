import { Connection, VersionedTransaction } from '@solana/web3.js'
import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'

const PROD_TRADE_API_BASE_URL = 'https://quote-api.dflow.net'
const DEV_TRADE_API_BASE_URL = 'https://dev-quote-api.dflow.net'
const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'
const DYNAMIC_COMPUTE_UNIT_LIMIT_PARAM = 'dynamicComputeUnitLimit'

const UNSUPPORTED_ORDER_PARAMS = new Set(['sponsor', 'sponsorExec', 'predictionMarketInitPayer'])
const RESERVED_ORDER_PARAMS = new Set(['userPublicKey', 'inputMint', 'outputMint', 'amount'])
const RESPONSE_ONLY_ORDER_PARAM_MESSAGES = new Map([
  [
    DYNAMIC_COMPUTE_UNIT_LIMIT_PARAM,
    'DFlow order parameter dynamicComputeUnitLimit is not supported in --params-json; purr sends dynamicComputeUnitLimit=true automatically',
  ],
  [
    'computeUnitLimit',
    'DFlow order parameter computeUnitLimit is a response field, not a request parameter; purr already sends dynamicComputeUnitLimit=true',
  ],
])
const TERMINAL_ORDER_STATES = new Set([
  'closed',
  'complete',
  'completed',
  'filled',
  'expired',
  'failed',
  'canceled',
  'cancelled',
  'rejected',
  'settled',
])

export interface DflowOrderArgs {
  inputMint?: string
  outputMint?: string
  amount?: string
  apiKey?: string
  baseUrl?: string
  paramsJson?: string
  raw?: boolean
}

export interface DflowExecuteOrderArgs {
  orderJson?: string
  rpcUrl?: string
  apiKey?: string
  baseUrl?: string
  poll?: boolean
  pollTimeoutMs?: number
  pollIntervalMs?: number
  raw?: boolean
}

export interface DflowStatusArgs {
  orderAddress?: string
  apiKey?: string
  baseUrl?: string
  poll?: boolean
  timeoutMs?: number
  intervalMs?: number
  raw?: boolean
}

interface PlatformWalletEnsureResponse {
  ok: boolean
  data?: {
    address: string
    chainId: number
    chainType: string
    createdNow?: boolean
  }
  error?: string
}

interface PlatformSignSolanaTransactionResponse {
  ok: boolean
  data?: {
    signedTransaction: string
    address: string
  }
  error?: string
}

type JsonObject = Record<string, unknown>

function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required argument: --${name}`)
  }
  return value
}

function parseJsonObject(raw: string, label: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as JsonObject
}

function getDflowApiKey(explicit?: string): string | undefined {
  const key = explicit ?? process.env.DFLOW_API_KEY
  return key && key.trim() !== '' ? key : undefined
}

function getDflowBaseUrl(args: { baseUrl?: string; apiKey?: string }): string {
  if (args.baseUrl && args.baseUrl.trim() !== '') return args.baseUrl.replace(/\/$/, '')
  if (process.env.DFLOW_TRADE_API_BASE_URL) {
    return process.env.DFLOW_TRADE_API_BASE_URL.replace(/\/$/, '')
  }
  return getDflowApiKey(args.apiKey) ? PROD_TRADE_API_BASE_URL : DEV_TRADE_API_BASE_URL
}

function dflowHeaders(apiKey?: string): HeadersInit {
  return {
    Accept: 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  }
}

async function dflowGet(
  path: string,
  params: URLSearchParams,
  args: { apiKey?: string; baseUrl?: string },
): Promise<JsonObject> {
  const apiKey = getDflowApiKey(args.apiKey)
  const baseUrl = getDflowBaseUrl({ ...args, apiKey })
  const query = params.toString()
  const res = await fetch(`${baseUrl}${path}${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: dflowHeaders(apiKey),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`DFlow API error ${res.status} GET ${path}: ${text.slice(0, 500)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`DFlow API returned non-object response for ${path}`)
  }
  return parsed as JsonObject
}

async function resolvePlatformSolanaAddress(): Promise<string> {
  const { instanceId } = resolveCredentials()
  const ensure = await apiPost<PlatformWalletEnsureResponse>(
    `/v1/instances/${instanceId}/wallet/ensure`,
    {
      chainType: 'solana',
    },
  )
  if (!ensure.ok || !ensure.data) {
    throw new Error(ensure.error ?? 'Failed to resolve purr Solana address')
  }
  return ensure.data.address
}

async function signSolanaTransactionViaPlatform(
  transaction: string,
): Promise<{ signedTransaction: string; address: string }> {
  const { instanceId } = resolveCredentials()
  const signed = await apiPost<PlatformSignSolanaTransactionResponse>(
    `/v1/instances/${instanceId}/wallet/sign-solana-transaction`,
    {
      transaction,
      intent: { kind: 'raw_hash', chainId: 'solana:mainnet' },
    },
  )
  if (!signed.ok || !signed.data) {
    throw new Error(signed.error ?? 'Failed to sign DFlow Solana transaction')
  }
  return signed.data
}

function assertNoUnsupportedOrderParams(params: JsonObject): void {
  for (const key of Object.keys(params)) {
    if (RESERVED_ORDER_PARAMS.has(key)) {
      throw new Error(`DFlow order parameter ${key} is managed by purr and cannot be overridden`)
    }
    const responseOnlyMessage = RESPONSE_ONLY_ORDER_PARAM_MESSAGES.get(key)
    if (responseOnlyMessage) {
      throw new Error(responseOnlyMessage)
    }
    if (UNSUPPORTED_ORDER_PARAMS.has(key)) {
      throw new Error(
        `DFlow ${key} is out of scope because purr signing currently supports one signer only`,
      )
    }
  }
}

function addParam(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (typeof value === 'object') {
    throw new Error(`DFlow order parameter ${key} must be a scalar value`)
  }
  params.set(key, String(value))
}

function orderSummary(order: JsonObject): JsonObject {
  return {
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    otherAmountThreshold: order.otherAmountThreshold,
    priceImpactPct: order.priceImpactPct,
    slippageBps: order.slippageBps,
    prioritizationFeeLamports: order.prioritizationFeeLamports,
    prioritizationType: order.prioritizationType,
    executionMode: order.executionMode,
    orderAddress: order.orderAddress,
    hasTransaction: typeof order.transaction === 'string',
  }
}

function requireOrderTransaction(order: JsonObject): {
  transaction: string
  lastValidBlockHeight: number
} {
  if (typeof order.transaction !== 'string' || order.transaction.trim() === '') {
    throw new Error('DFlow order response must contain transaction')
  }
  const lastValidBlockHeight = Number(order.lastValidBlockHeight)
  if (!Number.isFinite(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    throw new Error('DFlow order response must contain numeric lastValidBlockHeight')
  }
  return { transaction: order.transaction, lastValidBlockHeight }
}

function parseDflowTransaction(transaction: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
  } catch {
    throw new Error('DFlow transaction must be a valid base64-encoded Solana transaction')
  }
}

function unwrapOrderJson(parsed: JsonObject): JsonObject {
  const order = parsed.order
  if (typeof order === 'object' && order !== null && !Array.isArray(order)) {
    return order as JsonObject
  }
  return parsed
}

function requireSinglePlatformSigner(tx: VersionedTransaction, platformAddress: string): void {
  const requiredSignerCount = tx.message.header.numRequiredSignatures
  const signers = tx.message.staticAccountKeys
    .slice(0, requiredSignerCount)
    .map((key) => key.toBase58())
  if (signers.length !== 1) {
    throw new Error(
      `DFlow transaction requires ${signers.length} signers; purr execution supports exactly one signer`,
    )
  }
  if (signers[0] !== platformAddress) {
    throw new Error(
      `DFlow transaction signer ${signers[0]} does not match purr Solana address ${platformAddress}`,
    )
  }
}

function resolveSolanaRpcUrl(explicit?: string): string {
  const rpcUrl = explicit ?? process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL
  return rpcUrl.trim()
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`--${name} must be a positive integer`)
  }
}

function getOrderAddress(order: JsonObject): string | undefined {
  const value = order.orderAddress ?? order.order_address
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function responseDataObject(resp: JsonObject): JsonObject {
  const data = resp.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return data as JsonObject
  }
  return resp
}

function statusValue(resp: JsonObject): string | undefined {
  const data = responseDataObject(resp)
  const value = data.status ?? data.orderStatus ?? data.state
  return typeof value === 'string' ? value.toLowerCase() : undefined
}

function isTerminalStatus(resp: JsonObject): boolean {
  const status = statusValue(resp)
  return status ? TERMINAL_ORDER_STATES.has(status) : false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function dflowOrder(args: DflowOrderArgs): Promise<JsonObject> {
  const extraParams = args.paramsJson ? parseJsonObject(args.paramsJson, '--params-json') : {}
  assertNoUnsupportedOrderParams(extraParams)
  const userPublicKey = await resolvePlatformSolanaAddress()

  const params = new URLSearchParams()
  params.set('userPublicKey', userPublicKey)
  params.set('inputMint', requireString(args.inputMint, 'input-mint'))
  params.set('outputMint', requireString(args.outputMint, 'output-mint'))
  params.set('amount', requireString(args.amount, 'amount'))
  params.set(DYNAMIC_COMPUTE_UNIT_LIMIT_PARAM, 'true')
  for (const [key, value] of Object.entries(extraParams)) {
    addParam(params, key, value)
  }

  const order = await dflowGet('/order', params, args)
  if (args.raw) {
    return {
      type: 'dflow-order',
      userPublicKey,
      apiBaseUrl: getDflowBaseUrl(args),
      apiKeyPresent: Boolean(getDflowApiKey(args.apiKey)),
      order,
    }
  }
  return {
    type: 'dflow-order',
    userPublicKey,
    apiBaseUrl: getDflowBaseUrl(args),
    apiKeyPresent: Boolean(getDflowApiKey(args.apiKey)),
    summary: orderSummary(order),
    order,
  }
}

export async function dflowStatus(args: DflowStatusArgs): Promise<JsonObject> {
  const orderAddress = requireString(args.orderAddress, 'order-address')
  const timeoutMs = args.timeoutMs ?? 120_000
  const intervalMs = args.intervalMs ?? 2_000
  validatePositiveInteger(timeoutMs, 'timeout-ms')
  validatePositiveInteger(intervalMs, 'interval-ms')
  const started = Date.now()
  const snapshots: JsonObject[] = []

  while (true) {
    const params = new URLSearchParams()
    params.set('orderAddress', orderAddress)
    const status = await dflowGet('/order-status', params, args)
    snapshots.push(status)

    if (!args.poll || isTerminalStatus(status)) {
      return args.raw
        ? {
            type: 'dflow-status',
            orderAddress,
            terminal: isTerminalStatus(status),
            status,
            snapshots,
          }
        : {
            type: 'dflow-status',
            orderAddress,
            terminal: isTerminalStatus(status),
            status,
          }
    }

    if (Date.now() - started >= timeoutMs) {
      return {
        type: 'dflow-status',
        orderAddress,
        terminal: false,
        timedOut: true,
        status,
        ...(args.raw ? { snapshots } : {}),
      }
    }
    await sleep(intervalMs)
  }
}

export async function dflowExecuteOrder(args: DflowExecuteOrderArgs): Promise<JsonObject> {
  validatePositiveInteger(args.pollTimeoutMs, 'poll-timeout-ms')
  validatePositiveInteger(args.pollIntervalMs, 'poll-interval-ms')
  const order = unwrapOrderJson(
    parseJsonObject(requireString(args.orderJson, 'order-json'), '--order-json'),
  )
  const { transaction, lastValidBlockHeight } = requireOrderTransaction(order)
  const tx = parseDflowTransaction(transaction)
  const recentBlockhash = tx.message.recentBlockhash
  const rpcUrl = resolveSolanaRpcUrl(args.rpcUrl)
  const platformAddress = await resolvePlatformSolanaAddress()
  requireSinglePlatformSigner(tx, platformAddress)
  const signed = await signSolanaTransactionViaPlatform(transaction)
  if (signed.address !== platformAddress) {
    throw new Error(`purr signer returned address ${signed.address}; expected ${platformAddress}`)
  }
  const connection = new Connection(rpcUrl, 'confirmed')
  const signedBytes = Buffer.from(signed.signedTransaction, 'base64')
  const signature = await connection.sendRawTransaction(signedBytes)
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  )
  if (confirmation.value.err) {
    throw new Error(
      `DFlow transaction failed confirmation: ${JSON.stringify(confirmation.value.err)}`,
    )
  }

  const orderAddress = getOrderAddress(order)
  const status =
    args.poll && orderAddress
      ? await dflowStatus({
          orderAddress,
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
          poll: true,
          timeoutMs: args.pollTimeoutMs,
          intervalMs: args.pollIntervalMs,
          raw: args.raw,
        })
      : undefined

  return {
    type: 'dflow-execute-order',
    signerAddress: signed.address,
    signature,
    recentBlockhash,
    lastValidBlockHeight,
    orderAddress,
    confirmation: args.raw ? confirmation : { slot: confirmation.context.slot, err: null },
    ...(status ? { status } : {}),
    ...(args.raw ? { order, signedTransaction: signed.signedTransaction, rpcUrl } : {}),
  }
}
