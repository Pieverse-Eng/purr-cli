import { randomUUID } from 'node:crypto'
import {
  ApiClientError,
  apiGet,
  apiPost,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'

const DFLOW_REQUEST_TIMEOUT_MS = 20_000
// The platform builds, signs and broadcasts within this request, so allow for
// a fresh DFlow order, the wallet policy check and the managed signer.
const DFLOW_EXECUTE_TIMEOUT_MS = 90_000
const DFLOW_CONFIRM_TIMEOUT_MS = 90_000
const DFLOW_CONFIRM_INTERVAL_MS = 2_000
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
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
  idempotencyKey?: string
  minimumToAmount?: string
  poll?: boolean
  pollTimeoutMs?: number
  pollIntervalMs?: number
  raw?: boolean
}

export interface DflowExecutionStatusArgs {
  requestId?: string
}

export interface DflowPredictionOrderStatusArgs {
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

interface PlatformDflowResponse {
  ok: boolean
  data?: unknown
  code?: string
  providerCode?: string
  error?: string
  retryable?: boolean
  retryAfterSeconds?: number | null
  /** Wallet-policy answers (for example `202 POLICY_DEFERRED`) carry these instead. */
  reason?: string
  request_id?: string
  expires_at?: string
}

type JsonObject = Record<string, unknown>

export class DflowCliError extends Error {
  readonly code?: string
  readonly providerCode?: string
  readonly status?: number
  readonly retryable?: boolean
  readonly retryAfterSeconds?: number
  readonly data?: JsonObject

  constructor(
    message: string,
    options: {
      code?: string
      providerCode?: string
      status?: number
      retryable?: boolean
      retryAfterSeconds?: number
      data?: JsonObject
    } = {},
  ) {
    super(message)
    this.name = 'DflowCliError'
    this.code = options.code
    this.providerCode = options.providerCode
    this.status = options.status
    this.retryable = options.retryable
    this.retryAfterSeconds = options.retryAfterSeconds
    this.data = options.data
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

/** The wallet-policy request a caller approves before replaying the same key. */
function policyDetails(body: JsonObject | undefined): JsonObject {
  const policyRequestId = optionalString(body?.request_id)
  const policyExpiresAt = optionalString(body?.expires_at)
  return {
    ...(policyRequestId ? { policyRequestId } : {}),
    ...(policyExpiresAt ? { policyExpiresAt } : {}),
  }
}

function errorData(body: JsonObject | undefined): JsonObject | undefined {
  const data = { ...(isJsonObject(body?.data) ? body.data : {}), ...policyDetails(body) }
  return Object.keys(data).length > 0 ? data : undefined
}

function toDflowCliError(error: unknown): Error {
  if (error instanceof DflowCliError) return error
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const body = isJsonObject(error.body) ? error.body : undefined
  return new DflowCliError(
    optionalString(body?.error) ??
      optionalString(body?.message) ??
      optionalString(body?.reason) ??
      'DFlow platform request failed',
    {
      code: optionalString(body?.code),
      providerCode: optionalString(body?.providerCode),
      status: error.status,
      retryable: optionalBoolean(body?.retryable),
      retryAfterSeconds: retryAfterSeconds(error, body),
      data: errorData(body),
    },
  )
}

function unwrapPlatformDflowResponse(response: PlatformDflowResponse): unknown {
  if (!response.ok || response.data === undefined) {
    const body = response as unknown as JsonObject
    throw new DflowCliError(
      response.error ?? optionalString(response.reason) ?? 'DFlow platform request failed',
      {
        code: response.code,
        providerCode: response.providerCode,
        retryable: response.retryable,
        retryAfterSeconds: response.retryAfterSeconds ?? undefined,
        data: errorData(body),
      },
    )
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

async function platformDflowPredictionOrderStatus(
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
        `DFlow ${key} is out of scope because platform execution supports one signer only`,
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

function unwrapOrderJson(parsed: JsonObject): JsonObject {
  const order = parsed.order
  if (typeof order === 'object' && order !== null && !Array.isArray(order)) {
    return order as JsonObject
  }
  return parsed
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

function getExecutionMode(order: JsonObject): 'sync' | 'async' | undefined {
  const value = order.executionMode
  if (value === undefined) return undefined
  if (value === 'sync' || value === 'async') return value
  throw new Error(`DFlow order response contains unsupported executionMode: ${String(value)}`)
}

function statusErrorDetails(error: unknown): JsonObject {
  const normalized = toDflowCliError(error)
  if (!(normalized instanceof DflowCliError)) {
    return { message: normalized.message }
  }
  return {
    message: normalized.message,
    ...(normalized.code ? { code: normalized.code } : {}),
    ...(normalized.providerCode ? { providerCode: normalized.providerCode } : {}),
    ...(normalized.status !== undefined ? { status: normalized.status } : {}),
    ...(normalized.retryable !== undefined ? { retryable: normalized.retryable } : {}),
    ...(normalized.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: normalized.retryAfterSeconds }
      : {}),
  }
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
  // `request` lets `purr dflow execute-order` ask the platform for the same swap.
  if (args.raw) {
    return {
      type: 'dflow-order',
      userPublicKey,
      ...platformTransport(),
      request: body,
      order,
    }
  }
  return {
    type: 'dflow-order',
    userPublicKey,
    ...platformTransport(),
    request: body,
    summary: orderSummary(order),
    order,
  }
}

export async function dflowPredictionOrderStatus(
  args: DflowPredictionOrderStatusArgs,
): Promise<JsonObject> {
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
      status = await platformDflowPredictionOrderStatus(signature, args.lastValidBlockHeight)
    } catch (error) {
      const retryableRateLimit =
        args.poll &&
        error instanceof DflowCliError &&
        (error.status === 429 || error.code === 'dflow_rate_limited')
      if (!retryableRateLimit) throw error
      const delayMs = Math.max(intervalMs, (error.retryAfterSeconds ?? 0) * 1_000)
      if (Date.now() - started + delayMs >= timeoutMs) {
        return {
          type: 'dflow-prediction-order-status',
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
            type: 'dflow-prediction-order-status',
            signature,
            terminal: isTerminalStatus(status),
            status,
            snapshots,
          }
        : {
            type: 'dflow-prediction-order-status',
            signature,
            terminal: isTerminalStatus(status),
            status,
          }
    }

    if (Date.now() - started >= timeoutMs) {
      return {
        type: 'dflow-prediction-order-status',
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

function requireExecuteRequest(parsed: JsonObject, order: JsonObject): JsonObject {
  if (!isJsonObject(parsed.request)) {
    throw new Error(
      'execute-order needs the JSON printed by `purr dflow order` (with its request); the platform rebuilds and signs the order, so a bare DFlow order cannot be executed',
    )
  }
  const request = parsed.request
  const options = request.options
  if (options !== undefined && !isJsonObject(options)) {
    throw new Error('DFlow order request options must be a JSON object')
  }
  const body = dflowRequestBody({
    inputMint: optionalString(request.inputMint),
    outputMint: optionalString(request.outputMint),
    amount: optionalString(request.amount),
    paramsJson: options ? JSON.stringify(options) : undefined,
  })
  for (const [field, orderField] of [
    ['inputMint', 'inputMint'],
    ['outputMint', 'outputMint'],
    ['amount', 'inAmount'],
  ] as const) {
    if (order[orderField] !== undefined && order[orderField] !== body[field]) {
      throw new Error(`DFlow order ${orderField} does not match its request ${field}`)
    }
  }
  return body
}

function requireMinimumToAmount(explicit: string | undefined, order: JsonObject): string {
  const value = explicit ?? optionalString(order.minOutAmount)
  if (value === undefined) {
    throw new Error('DFlow order has no minOutAmount; pass --minimum-to-amount <atomic>')
  }
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error('--minimum-to-amount must be a positive integer in atomic units')
  }
  return value
}

function resolveIdempotencyKey(explicit: string | undefined): string {
  if (explicit === undefined) return randomUUID()
  if (!IDEMPOTENCY_KEY_PATTERN.test(explicit)) {
    throw new Error('--idempotency-key must be 1-128 letters, digits, ".", "_", ":" or "-"')
  }
  return explicit
}

/** The platform's answer: `{ requestId, replayed?, result }`, result being the submission. */
function executionSubmission(data: JsonObject): {
  requestId: string
  replayed: boolean
  result: JsonObject
} {
  const requestId = optionalString(data.requestId)
  if (!requestId || !isJsonObject(data.result)) {
    throw new Error('DFlow platform execution returned an unexpected response')
  }
  return { requestId, replayed: data.replayed === true, result: data.result }
}

async function platformDflowExecute(body: JsonObject, idempotencyKey: string) {
  try {
    const response = await apiPost<PlatformDflowResponse>(instanceDflowPath('/execute'), body, {
      headers: { 'Idempotency-Key': idempotencyKey },
      timeoutMs: DFLOW_EXECUTE_TIMEOUT_MS,
    })
    return executionSubmission(requireJsonObjectResponse(response))
  } catch (error) {
    // The platform may already have signed and broadcast: keep the key so the
    // caller replays it (never a new one) or reads the execution status.
    const normalized = toDflowCliError(error)
    const details = normalized instanceof DflowCliError ? normalized : undefined
    throw new DflowCliError(normalized.message, {
      code: details?.code,
      providerCode: details?.providerCode,
      status: details?.status,
      retryable: details?.retryable,
      retryAfterSeconds: details?.retryAfterSeconds,
      // A replay must send the same payload, minimum included, under this key.
      data: { idempotencyKey, minimumToAmount: body.minimumToAmount, ...details?.data },
    })
  }
}

async function platformDflowExecution(requestId: string): Promise<JsonObject> {
  try {
    const response = await apiGet<PlatformDflowResponse>(
      instanceDflowPath(`/executions/${encodeURIComponent(requestId)}`),
      { timeoutMs: DFLOW_REQUEST_TIMEOUT_MS },
    )
    return requireJsonObjectResponse(response)
  } catch (error) {
    throw toDflowCliError(error)
  }
}

function chainState(execution: JsonObject): string | undefined {
  return isJsonObject(execution.chain) ? optionalString(execution.chain.state) : undefined
}

/** Waits until the platform reports the submitted signature confirmed or reverted. */
async function waitForConfirmation(
  requestId: string,
  intervalMs: number,
): Promise<{ execution?: JsonObject; state: string }> {
  const started = Date.now()
  let execution: JsonObject | undefined
  while (true) {
    execution = await platformDflowExecution(requestId)
    const state = chainState(execution) ?? 'unknown'
    if (state === 'confirmed' || state === 'finalized' || state === 'reverted') {
      return { execution, state }
    }
    if (Date.now() - started + intervalMs >= DFLOW_CONFIRM_TIMEOUT_MS) {
      return { execution, state }
    }
    await sleep(intervalMs)
  }
}

export async function dflowExecuteOrder(args: DflowExecuteOrderArgs): Promise<JsonObject> {
  validatePositiveInteger(args.pollTimeoutMs, 'poll-timeout-ms')
  validatePositiveInteger(args.pollIntervalMs, 'poll-interval-ms')
  const parsed = parseJsonObject(requireString(args.orderJson, 'order-json'), '--order-json')
  const order = unwrapOrderJson(parsed)
  const request = requireExecuteRequest(parsed, order)
  const minimumToAmount = requireMinimumToAmount(args.minimumToAmount, order)
  const idempotencyKey = resolveIdempotencyKey(args.idempotencyKey)

  const { requestId, replayed, result } = await platformDflowExecute(
    { ...request, minimumToAmount },
    idempotencyKey,
  )
  const signature = optionalString(result.signature)
  const executionMode = getExecutionMode(result)
  const lastValidBlockHeight = optionalNonnegativeNumber(result.lastValidBlockHeight)
  const base = {
    type: 'dflow-execute-order',
    requestId,
    idempotencyKey,
    ...(replayed ? { replayed } : {}),
    minimumToAmount,
    state: result.state,
    executionMode,
    signature,
    lastValidBlockHeight,
    orderAddress: getOrderAddress(order),
  }
  if (!signature) {
    // Not submitted (for example awaiting a policy approval): nothing to confirm.
    return { ...base, ...(args.raw ? { execution: result } : {}) }
  }

  const confirmation = await waitForConfirmation(
    requestId,
    args.pollIntervalMs ?? DFLOW_CONFIRM_INTERVAL_MS,
  )
  const chain = isJsonObject(confirmation.execution?.chain) ? confirmation.execution.chain : {}
  if (confirmation.state === 'reverted') {
    throw new DflowCliError(`DFlow transaction failed on chain: ${JSON.stringify(chain.error)}`, {
      code: 'DFLOW_TRANSACTION_REVERTED',
      data: { requestId, idempotencyKey, signature, error: chain.error ?? null },
    })
  }

  let status: JsonObject | undefined
  let statusError: JsonObject | undefined
  const confirmed = confirmation.state === 'confirmed' || confirmation.state === 'finalized'
  if (confirmed && args.poll && executionMode === 'async') {
    try {
      status = await dflowPredictionOrderStatus({
        signature,
        lastValidBlockHeight:
          lastValidBlockHeight === undefined ? undefined : String(lastValidBlockHeight),
        poll: true,
        timeoutMs: args.pollTimeoutMs,
        intervalMs: args.pollIntervalMs,
        raw: args.raw,
      })
    } catch (error) {
      // The transaction has already been broadcast and confirmed. Preserve its
      // signature so callers retry only the status lookup, never the order.
      statusError = statusErrorDetails(error)
    }
  }

  return {
    ...base,
    confirmation: { state: confirmation.state, confirmed },
    ...(status ? { status } : {}),
    ...(statusError ? { statusError } : {}),
    ...(args.raw ? { execution: confirmation.execution ?? result } : {}),
  }
}

export async function dflowExecutionStatus(args: DflowExecutionStatusArgs): Promise<JsonObject> {
  const requestId = requireString(args.requestId, 'request-id')
  const execution = await platformDflowExecution(requestId)
  return { type: 'dflow-execution-status', requestId, execution }
}
