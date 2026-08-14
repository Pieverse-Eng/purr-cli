import { Connection, VersionedTransaction } from '@solana/web3.js'
import {
  ApiClientError,
  apiGet,
  apiPost,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'

const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'
const DFLOW_REQUEST_TIMEOUT_MS = 20_000
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
  paramsJson?: string
  raw?: boolean
}

export interface DflowExecuteOrderArgs {
  orderJson?: string
  rpcUrl?: string
  poll?: boolean
  pollTimeoutMs?: number
  pollIntervalMs?: number
  raw?: boolean
}

export interface DflowStatusArgs {
  signature?: string
  lastValidBlockHeight?: string
  poll?: boolean
  timeoutMs?: number
  intervalMs?: number
  raw?: boolean
}

export interface DflowMetadataArgs {
  path?: string
  queryJson?: string
  bodyJson?: string
}

export interface DflowStreamArgs {
  channel?: string
  tickers?: string
  all?: boolean
  maxEvents?: number
  timeoutMs?: number
  onMessage?: (message: unknown) => void | Promise<void>
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

interface PlatformDflowResponse {
  ok: boolean
  data?: unknown
  code?: string
  providerCode?: string
  error?: string
  retryable?: boolean
  retryAfterSeconds?: number | null
}

type JsonObject = Record<string, unknown>

class DflowCliError extends Error {
  readonly code?: string
  readonly providerCode?: string
  readonly status?: number
  readonly retryable?: boolean
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    options: {
      code?: string
      providerCode?: string
      status?: number
      retryable?: boolean
      retryAfterSeconds?: number
    } = {},
  ) {
    super(message)
    this.name = 'DflowCliError'
    this.code = options.code
    this.providerCode = options.providerCode
    this.status = options.status
    this.retryable = options.retryable
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function retryAfterSeconds(
  error: ApiClientError,
  body: JsonObject | undefined,
): number | undefined {
  const bodySeconds = optionalNonnegativeNumber(body?.retryAfterSeconds)
  if (bodySeconds !== undefined) return bodySeconds
  if (!error.retryAfter) return undefined
  const seconds = Number(error.retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const retryAt = Date.parse(error.retryAfter)
  return Number.isFinite(retryAt)
    ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
    : undefined
}

function toDflowCliError(error: unknown): Error {
  if (error instanceof DflowCliError) return error
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const body = isJsonObject(error.body) ? error.body : undefined
  return new DflowCliError(
    optionalString(body?.error) ?? optionalString(body?.message) ?? 'DFlow platform request failed',
    {
      code: optionalString(body?.code),
      providerCode: optionalString(body?.providerCode),
      status: error.status,
      retryable: optionalBoolean(body?.retryable),
      retryAfterSeconds: retryAfterSeconds(error, body),
    },
  )
}

function unwrapPlatformDflowResponse(response: PlatformDflowResponse): unknown {
  if (!response.ok || response.data === undefined) {
    throw new DflowCliError(response.error ?? 'DFlow platform request failed', {
      code: response.code,
      providerCode: response.providerCode,
      retryable: response.retryable,
      retryAfterSeconds: response.retryAfterSeconds ?? undefined,
    })
  }
  return response.data
}

function requireJsonObjectResponse(response: PlatformDflowResponse): JsonObject {
  const data = unwrapPlatformDflowResponse(response)
  if (!isJsonObject(data)) throw new Error('DFlow platform returned an unexpected response')
  return data
}

function instanceDflowPath(suffix: string): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}/dflow${suffix}`
}

async function platformDflowOrder(body: JsonObject): Promise<JsonObject> {
  try {
    const response = await apiPost<PlatformDflowResponse>(instanceDflowPath('/order'), body, {
      timeoutMs: DFLOW_REQUEST_TIMEOUT_MS,
    })
    return requireJsonObjectResponse(response)
  } catch (error) {
    throw toDflowCliError(error)
  }
}

async function platformDflowStatus(
  signature: string,
  lastValidBlockHeight?: string,
): Promise<JsonObject> {
  const params = new URLSearchParams({ signature })
  if (lastValidBlockHeight) params.set('lastValidBlockHeight', lastValidBlockHeight)
  try {
    const response = await apiGet<PlatformDflowResponse>(
      `${instanceDflowPath('/order-status')}?${params.toString()}`,
      { timeoutMs: DFLOW_REQUEST_TIMEOUT_MS },
    )
    return requireJsonObjectResponse(response)
  } catch (error) {
    throw toDflowCliError(error)
  }
}

async function platformDflowGet(suffix: string, timeoutMs = DFLOW_REQUEST_TIMEOUT_MS) {
  try {
    const response = await apiGet<PlatformDflowResponse>(instanceDflowPath(suffix), { timeoutMs })
    return unwrapPlatformDflowResponse(response)
  } catch (error) {
    throw toDflowCliError(error)
  }
}

async function platformDflowPost(suffix: string, body: JsonObject) {
  try {
    const response = await apiPost<PlatformDflowResponse>(instanceDflowPath(suffix), body, {
      timeoutMs: DFLOW_REQUEST_TIMEOUT_MS,
    })
    return unwrapPlatformDflowResponse(response)
  } catch (error) {
    throw toDflowCliError(error)
  }
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

function dflowRequestBody(args: DflowOrderArgs): JsonObject {
  const extraParams = args.paramsJson ? parseJsonObject(args.paramsJson, '--params-json') : {}
  assertNoUnsupportedOrderParams(extraParams)
  return {
    inputMint: requireString(args.inputMint, 'input-mint'),
    outputMint: requireString(args.outputMint, 'output-mint'),
    amount: requireString(args.amount, 'amount'),
    ...(Object.keys(extraParams).length > 0 ? { options: extraParams } : {}),
  }
}

function platformTransport(): JsonObject {
  const { apiUrl } = resolveCredentials()
  return { transport: 'platform', platformApiBaseUrl: apiUrl.replace(/\/$/, '') }
}

export async function dflowQuote(args: DflowOrderArgs): Promise<JsonObject> {
  const quote = await platformDflowPost('/quote', dflowRequestBody(args))
  return {
    type: 'dflow-quote',
    ...platformTransport(),
    ...(args.raw ? { quote } : { summary: isJsonObject(quote) ? orderSummary(quote) : quote }),
  }
}

export async function dflowPositions(): Promise<JsonObject> {
  const positions = await platformDflowGet('/positions')
  return { type: 'dflow-positions', ...platformTransport(), positions }
}

export async function dflowPriorityFees(): Promise<JsonObject> {
  const priorityFees = await platformDflowGet('/priority-fees')
  return { type: 'dflow-priority-fees', ...platformTransport(), priorityFees }
}

function normalizedMetadataPath(raw: string | undefined): string {
  let path = requireString(raw, 'path').replace(/^\/+/, '')
  if (path.startsWith('api/v1/')) path = path.slice('api/v1/'.length)
  if (
    !path ||
    path
      .split('/')
      .some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._:-]+$/.test(segment))
  ) {
    throw new Error('--path must be a DFlow Metadata API path without query parameters')
  }
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function metadataQuery(raw: string | undefined): string {
  if (!raw) return ''
  const query = parseJsonObject(raw, '--query-json')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid Metadata query key: ${key}`)
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Metadata query value for ${key} must be a string, number, or boolean`)
    }
    params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

export async function dflowMetadata(args: DflowMetadataArgs): Promise<JsonObject> {
  if (args.bodyJson && args.queryJson) {
    throw new Error('--query-json cannot be combined with a Metadata POST body')
  }
  const suffix = `/metadata/${normalizedMetadataPath(args.path)}${metadataQuery(args.queryJson)}`
  const data = args.bodyJson
    ? await platformDflowPost(suffix, parseJsonObject(args.bodyJson, '--body-json'))
    : await platformDflowGet(suffix)
  return { type: 'dflow-metadata', ...platformTransport(), data }
}

function parseSseFrame(frame: string): { event: string; data: string } | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }
  return data.length ? { event, data: data.join('\n') } : undefined
}

export async function dflowStream(args: DflowStreamArgs): Promise<JsonObject> {
  const channel = requireString(args.channel, 'channel')
  if (!['prices', 'trades', 'orderbook', 'priority-fees'].includes(channel)) {
    throw new Error('--channel must be prices, trades, orderbook, or priority-fees')
  }
  if (channel === 'priority-fees' && (args.tickers || args.all)) {
    throw new Error('--channel priority-fees does not accept --tickers or --all')
  }
  if (channel !== 'priority-fees' && Boolean(args.tickers) === Boolean(args.all)) {
    throw new Error('Specify exactly one of --tickers or --all true')
  }
  const maxEvents = args.maxEvents ?? 100
  const timeoutMs = args.timeoutMs ?? 60_000
  validatePositiveInteger(maxEvents, 'max-events')
  validatePositiveInteger(timeoutMs, 'timeout-ms')
  if (maxEvents > 10_000) throw new Error('--max-events must not exceed 10000')
  if (timeoutMs > 15 * 60_000) throw new Error('--timeout-ms must not exceed 900000')

  const params = new URLSearchParams({ channel })
  if (args.tickers) params.set('tickers', args.tickers)
  else if (args.all) params.set('all', 'true')
  const { apiUrl, apiToken, instanceId } = resolveCredentials()
  const path = `/v1/instances/${encodeURIComponent(instanceId)}/dflow/stream?${params.toString()}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const events: unknown[] = []
  let eventCount = 0
  let timedOut = false

  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const bodyText = await response.text()
      let body: unknown
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = undefined
      }
      throw toDflowCliError(
        new ApiClientError({
          status: response.status,
          method: 'GET',
          path,
          bodyText,
          body,
          retryAfter: response.headers.get('retry-after') ?? undefined,
        }),
      )
    }
    if (!response.body) throw new Error('DFlow platform stream returned no response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (eventCount < maxEvents) {
      const { value, done } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1 && eventCount < maxEvents) {
        const frame = parseSseFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        if (!frame || frame.event === 'connected') continue
        let data: unknown
        try {
          data = JSON.parse(frame.data)
        } catch {
          throw new Error('DFlow platform streamed invalid JSON')
        }
        if (frame.event === 'error') {
          const error = isJsonObject(data) ? data : {}
          throw new DflowCliError(optionalString(error.code) ?? 'DFlow stream failed', {
            code: optionalString(error.code),
            retryable: optionalBoolean(error.retryable),
          })
        }
        eventCount++
        if (args.onMessage) await args.onMessage(data)
        else events.push(data)
      }
      if (done) break
    }
    if (eventCount >= maxEvents) await reader.cancel()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') timedOut = true
    else throw error
  } finally {
    clearTimeout(timeout)
  }

  return {
    type: 'dflow-stream',
    ...platformTransport(),
    channel,
    eventCount,
    timedOut,
    ...(args.onMessage ? {} : { events }),
  }
}

export async function dflowOrder(args: DflowOrderArgs): Promise<JsonObject> {
  const body = dflowRequestBody(args)
  const userPublicKey = await resolvePlatformSolanaAddress()
  const order = await platformDflowOrder(body)
  if (args.raw) {
    return {
      type: 'dflow-order',
      userPublicKey,
      ...platformTransport(),
      order,
    }
  }
  return {
    type: 'dflow-order',
    userPublicKey,
    ...platformTransport(),
    summary: orderSummary(order),
    order,
  }
}

export async function dflowStatus(args: DflowStatusArgs): Promise<JsonObject> {
  const signature = requireString(args.signature, 'signature')
  const timeoutMs = args.timeoutMs ?? 120_000
  const intervalMs = args.intervalMs ?? 2_000
  validatePositiveInteger(timeoutMs, 'timeout-ms')
  validatePositiveInteger(intervalMs, 'interval-ms')
  const started = Date.now()
  const snapshots: JsonObject[] = []
  let lastStatus: JsonObject | undefined

  while (true) {
    let status: JsonObject
    try {
      status = await platformDflowStatus(signature, args.lastValidBlockHeight)
    } catch (error) {
      const retryableRateLimit =
        args.poll &&
        error instanceof DflowCliError &&
        (error.status === 429 || error.code === 'dflow_rate_limited')
      if (!retryableRateLimit) throw error
      const delayMs = Math.max(intervalMs, (error.retryAfterSeconds ?? 0) * 1_000)
      if (Date.now() - started + delayMs >= timeoutMs) {
        return {
          type: 'dflow-status',
          signature,
          terminal: false,
          timedOut: true,
          ...(lastStatus ? { status: lastStatus } : {}),
          ...(args.raw ? { snapshots } : {}),
        }
      }
      await sleep(delayMs)
      continue
    }
    snapshots.push(status)
    lastStatus = status

    if (!args.poll || isTerminalStatus(status)) {
      return args.raw
        ? {
            type: 'dflow-status',
            signature,
            terminal: isTerminalStatus(status),
            status,
            snapshots,
          }
        : {
            type: 'dflow-status',
            signature,
            terminal: isTerminalStatus(status),
            status,
          }
    }

    if (Date.now() - started >= timeoutMs) {
      return {
        type: 'dflow-status',
        signature,
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
  const orderAddress = getOrderAddress(order)
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

  const status =
    args.poll && orderAddress
      ? await dflowStatus({
          signature,
          lastValidBlockHeight: String(lastValidBlockHeight),
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
