import {
  ApiClientError,
  apiGet,
  apiPost,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'

type JsonRecord = Record<string, unknown>
type CliArgs = Record<string, string>

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  cursor?: unknown
  error?: unknown
  code?: string
  retryable?: boolean
}

const ORDER_SIDES = ['BUY', 'SELL'] as const
const ORDER_STRATEGIES = ['LIMIT', 'MARKET'] as const
const OUTCOMES = ['YES', 'NO'] as const
const APPROVAL_OPERATIONS = ['TRADE', 'SPLIT', 'MERGE', 'REDEEM', 'CONVERT', 'ALL'] as const
const POSITION_ACTIONS = ['SPLIT', 'MERGE', 'REDEEM', 'CONVERT'] as const
const SELF_TRADE_PREVENTIONS = ['CANCEL_MAKER', 'CANCEL_TAKER', 'CANCEL_BOTH'] as const
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POSITIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/

const COMMAND_ARGS: Readonly<Record<string, readonly string[]>> = {
  account: [],
  balances: ['market-id'],
  readiness: ['market-id'],
  categories: ['first', 'after', 'status', 'sort', 'tag-ids', 'market-variant'],
  category: ['slug'],
  tags: [],
  search: ['query', 'include-resolved', 'limit'],
  markets: [
    'first',
    'after',
    'status',
    'sort',
    'tag-ids',
    'market-variant',
    'is-boosted',
    'has-active-rewards',
  ],
  market: ['market-id'],
  'market-stats': ['market-id'],
  'market-last-sale': ['market-id'],
  'market-quote': ['market-id'],
  'market-quotes': ['market-ids'],
  orderbook: ['market-id', 'outcome'],
  'timeseries-latest': ['market-id'],
  timeseries: ['market-id', 'from', 'to', 'resolution', 'limit', 'after'],
  orders: ['first', 'after', 'status'],
  order: ['order-hash'],
  positions: ['first', 'after', 'market-id', 'sort'],
  'address-positions': ['address', 'first', 'after', 'market-id', 'sort'],
  activity: ['first', 'after'],
  matches: ['first', 'after', 'market-id', 'minimum-value'],
  referral: [],
  approvals: ['market-id', 'operation', 'side'],
  'set-referral': ['code'],
  'order-preview': [
    'market-id',
    'outcome',
    'side',
    'strategy',
    'quantity',
    'spend',
    'price',
    'slippage-bps',
    'is-min-amount-out',
    'expires-at',
    'fill-or-kill',
    'post-only',
    'self-trade-prevention',
    'reserved-balance-policy',
  ],
  'order-execute': ['preview-id'],
  'cancel-preview': ['order-hashes'],
  'cancel-all-preview': [],
  'cancel-execute': ['preview-id'],
  'cancel-all-execute': ['preview-id'],
  'remove-from-book-preview': ['order-hashes'],
  'remove-from-book-execute': ['preview-id', 'acknowledge-risk'],
  'approval-preview': ['operation', 'market-id', 'side', 'amount', 'unlimited', 'step-ids'],
  'approval-revoke-preview': ['operation', 'market-id', 'side', 'amount', 'unlimited', 'step-ids'],
  'approval-execute': ['preview-id'],
  'approval-revoke-execute': ['preview-id'],
  'position-preview': ['action', 'market-id', 'amount', 'outcome', 'category-slug', 'market-ids'],
  'position-execute': ['preview-id'],
  stream: ['topics', 'max-events', 'timeout-ms'],
}

export class PredictCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly data?: unknown
  readonly retryable?: boolean
  readonly retryAfter?: string
  readonly exitCode: number

  constructor(
    message: string,
    options: {
      code?: string
      status?: number
      data?: unknown
      retryable?: boolean
      retryAfter?: string
      exitCode?: number
    } = {},
  ) {
    super(message)
    this.name = 'PredictCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
    this.retryable = options.retryable
    this.retryAfter = options.retryAfter
    this.exitCode = options.exitCode ?? 1
  }
}

export const PREDICT_USAGE = `Usage: purr predict-fun <command> [options]

Account and discovery:
  account
  balances [--market-id <id>]
  readiness [--market-id <id>]
  categories [--first <1-100>] [--after <cursor>] [--status <status>] [--sort <sort>] [--tag-ids <ids>] [--market-variant <variant>]
  category --slug <slug>
  tags
  search --query <text> [--include-resolved <true|false>] [--limit <1-25>]
  markets [--first <1-100>] [--after <cursor>] [--status <status>] [--sort <sort>] [--tag-ids <ids>] [--market-variant <variant>] [--is-boosted <true|false>] [--has-active-rewards <true|false>]
  market --market-id <id>
  market-stats --market-id <id>
  market-last-sale --market-id <id>
  market-quote --market-id <id>
  market-quotes --market-ids <id,id,...>
  orderbook --market-id <id> [--outcome <YES|NO>]
  timeseries-latest --market-id <id>
  timeseries --market-id <id> --from <unix-seconds> [--to <unix-seconds>] [--resolution <value>] [--limit <1-1000>] [--after <cursor>]

Wallet data:
  orders [--first <1-100>] [--after <cursor>] [--status <status>]
  order --order-hash <0x-hash>
  positions [--first <1-100>] [--after <cursor>] [--market-id <id>] [--sort <sort>]
  address-positions --address <0x-address> [--first <1-100>] [--after <cursor>] [--market-id <id>] [--sort <sort>]
  activity [--first <1-100>] [--after <cursor>]
  matches [--first <1-100>] [--after <cursor>] [--market-id <id>] [--minimum-value <decimal>]
  referral
  approvals [--market-id <id>] [--operation <operation>] [--side <BUY|SELL>]

Orders and cancellations:
  order-preview --market-id <id> --outcome <YES|NO> --side <BUY|SELL> --strategy <LIMIT|MARKET> [--quantity <decimal>] [--spend <decimal>] [--price <decimal>] [--slippage-bps <0-5000>] [--is-min-amount-out <true|false>] [--expires-at <ISO-8601>] [--fill-or-kill <true|false>] [--post-only <true|false>] [--self-trade-prevention <mode>] [--reserved-balance-policy <policy>]
  order-execute --preview-id <uuid>
  cancel-preview --order-hashes <hash,hash,...>
  cancel-all-preview
  cancel-execute --preview-id <uuid>
  cancel-all-execute --preview-id <uuid>
  remove-from-book-preview --order-hashes <hash,hash,...>
  remove-from-book-execute --preview-id <uuid> --acknowledge-risk true

Order amounts: LIMIT requires quantity and price; MARKET BUY accepts spend or quantity; MARKET SELL requires quantity.

Approvals and positions:
  approval-preview --operation <TRADE|SPLIT|MERGE|REDEEM|CONVERT|ALL> [--market-id <id>] [--side <BUY|SELL>] [--amount <decimal>] [--unlimited <true|false>] [--step-ids <id,id,...>]
  approval-revoke-preview --operation <operation> [same options as approval-preview]
  approval-execute --preview-id <uuid>
  approval-revoke-execute --preview-id <uuid>
  position-preview --action <SPLIT|MERGE> --market-id <id> --amount <decimal>
  position-preview --action REDEEM --market-id <id> --outcome <YES|NO> [--amount <decimal>]
  position-preview --action CONVERT --category-slug <slug> --market-ids <id,id,...> --amount <decimal>
  position-execute --preview-id <uuid>

Referral and streaming:
  set-referral --code <5-char-code>
  stream --topics <topic,topic,...> [--max-events <count>] [--timeout-ms <milliseconds>]

Stream topics: orderbook:<marketId>, trading-status:<marketId>, market-status:<marketId>, market-changed:<marketId>, category-changed:<categoryId>, wallet.

Predict.fun is BNB Chain mainnet-only. Credentials, the Predict API key, and idempotency are managed by the platform.`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function errorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  if (isRecord(body.error)) return optionalString(body.error.code) ?? optionalString(body.code)
  return optionalString(body.code)
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  if (typeof body.error === 'string') return body.error
  if (isRecord(body.error)) {
    const direct = optionalString(body.error.message) ?? optionalString(body.error.error)
    if (direct) return direct
    if (Array.isArray(body.error.issues)) {
      const issue = body.error.issues.find(isRecord)
      const issueMessage = issue ? optionalString(issue.message) : undefined
      if (issueMessage) return issueMessage
    }
  }
  if (Array.isArray(body.issues)) {
    const issue = body.issues.find(isRecord)
    const issueMessage = issue ? optionalString(issue.message) : undefined
    if (issueMessage) return issueMessage
  }
  return optionalString(body.message)
}

function errorDetails(body: unknown): unknown {
  if (!isRecord(body)) return undefined
  if (body.data !== undefined) return body.data
  if (isRecord(body.error) || Array.isArray(body.issues)) return body
  return undefined
}

function toPredictError(error: unknown): Error {
  if (error instanceof PredictCliError) return error
  if (error instanceof ApiClientError) {
    const body = error.body
    return new PredictCliError(errorMessage(body) ?? error.message, {
      code: errorCode(body),
      status: error.status,
      data: errorDetails(body),
      retryable: isRecord(body) ? optionalBoolean(body.retryable) : undefined,
      retryAfter: error.retryAfter,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new PredictCliError(errorMessage(response) ?? response.code ?? 'Predict request failed', {
      code: response.code,
      data: errorDetails(response),
      retryable: response.retryable,
    })
  }
  return response.data
}

function unwrapPage<T>(response: ApiEnvelope<T>): { data: T; cursor: unknown } {
  return { data: unwrap(response), cursor: response.cursor ?? null }
}

function predictBasePath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}/predict`
}

function appendQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

async function getPredict<T = unknown>(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  try {
    const response = await apiGet<ApiEnvelope<T>>(appendQuery(`${predictBasePath()}${path}`, query))
    return unwrap(response)
  } catch (error) {
    throw toPredictError(error)
  }
}

async function getPredictPage<T = unknown>(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: T; cursor: unknown }> {
  try {
    const response = await apiGet<ApiEnvelope<T>>(appendQuery(`${predictBasePath()}${path}`, query))
    return unwrapPage(response)
  } catch (error) {
    throw toPredictError(error)
  }
}

async function postPredict<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPost<ApiEnvelope<T>>(`${predictBasePath()}${path}`, body)
    return unwrap(response)
  } catch (error) {
    throw toPredictError(error)
  }
}

function requireArg(args: CliArgs, name: string): string {
  const value = args[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required argument: --${name}`)
  }
  return value.trim()
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid --${name}: "${value}". Expected ${min}-${max}`)
  }
  return parsed
}

function optionalInteger(
  args: CliArgs,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[name]
  return value === undefined ? undefined : parseInteger(value, name, min, max)
}

function requireMarketId(args: CliArgs, name = 'market-id'): number {
  return parseInteger(requireArg(args, name), name, 1, Number.MAX_SAFE_INTEGER)
}

function optionalMarketId(args: CliArgs, name = 'market-id'): number | undefined {
  return optionalInteger(args, name, 1, Number.MAX_SAFE_INTEGER)
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${value}". Expected true or false`)
}

function optionalBooleanArg(args: CliArgs, name: string): boolean | undefined {
  const value = args[name]
  return value === undefined ? undefined : parseBoolean(value, name)
}

function requireEnum<const T extends readonly string[]>(
  args: CliArgs,
  name: string,
  values: T,
): T[number] {
  const value = requireArg(args, name).toUpperCase().replaceAll('-', '_')
  if ((values as readonly string[]).includes(value)) return value as T[number]
  throw new Error(`Invalid --${name}: "${args[name]}". Use: ${values.join(', ')}`)
}

function optionalEnum<const T extends readonly string[]>(
  args: CliArgs,
  name: string,
  values: T,
): T[number] | undefined {
  return args[name] === undefined ? undefined : requireEnum(args, name, values)
}

function positiveDecimal(value: string, name: string): string {
  if (!POSITIVE_DECIMAL_PATTERN.test(value) || /^0(?:\.0+)?$/.test(value)) {
    throw new Error(
      `Invalid --${name}: "${value}". Expected a positive decimal with up to 18 places`,
    )
  }
  return value
}

function optionalPositiveDecimal(args: CliArgs, name: string): string | undefined {
  const value = args[name]
  return value === undefined ? undefined : positiveDecimal(value, name)
}

function requirePositiveDecimal(args: CliArgs, name: string): string {
  return positiveDecimal(requireArg(args, name), name)
}

function splitList(value: string, name: string, max: number): string[] {
  const items = value.split(',').map((item) => item.trim())
  if (items.length === 0 || items.length > max || items.some((item) => item.length === 0)) {
    throw new Error(`Invalid --${name}: expected 1-${max} comma-separated values`)
  }
  return items
}

function marketIds(args: CliArgs, name = 'market-ids', max = 500): number[] {
  return splitList(requireArg(args, name), name, max).map((value) =>
    parseInteger(value, name, 1, Number.MAX_SAFE_INTEGER),
  )
}

function orderHashes(args: CliArgs): string[] {
  const hashes = splitList(requireArg(args, 'order-hashes'), 'order-hashes', 25)
  if (hashes.some((hash) => !HASH_PATTERN.test(hash))) {
    throw new Error('Invalid --order-hashes: each value must be a 0x-prefixed 32-byte hash')
  }
  return hashes
}

function requireOrderHash(args: CliArgs): string {
  const hash = requireArg(args, 'order-hash')
  if (!HASH_PATTERN.test(hash))
    throw new Error('Invalid --order-hash: expected a 0x-prefixed 32-byte hash')
  return hash
}

function requirePreviewId(args: CliArgs): string {
  const previewId = requireArg(args, 'preview-id')
  if (!UUID_PATTERN.test(previewId)) throw new Error('Invalid --preview-id: expected a UUID')
  return previewId
}

function pageQuery(args: CliArgs): Record<string, string | number | undefined> {
  return {
    first: optionalInteger(args, 'first', 1, 100),
    after: args.after,
  }
}

function positionsQuery(args: CliArgs): Record<string, string | number | undefined> {
  return {
    ...pageQuery(args),
    marketId: optionalMarketId(args),
    sort: args.sort,
  }
}

function orderPreviewBody(args: CliArgs): JsonRecord {
  const quantity = optionalPositiveDecimal(args, 'quantity')
  const spend = optionalPositiveDecimal(args, 'spend')
  const price = optionalPositiveDecimal(args, 'price')
  const slippageBps = optionalInteger(args, 'slippage-bps', 0, 5_000)
  const isMinAmountOut = optionalBooleanArg(args, 'is-min-amount-out')
  const fillOrKill = optionalBooleanArg(args, 'fill-or-kill')
  const postOnly = optionalBooleanArg(args, 'post-only')
  const selfTradePrevention = optionalEnum(args, 'self-trade-prevention', SELF_TRADE_PREVENTIONS)
  const reservedBalancePolicy = args['reserved-balance-policy']
  const hasOptions =
    fillOrKill !== undefined ||
    postOnly !== undefined ||
    selfTradePrevention !== undefined ||
    reservedBalancePolicy !== undefined
  const expiresAt = args['expires-at']
  if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
    throw new Error(`Invalid --expires-at: "${expiresAt}". Expected ISO-8601`)
  }

  return {
    marketId: requireMarketId(args),
    outcome: requireEnum(args, 'outcome', OUTCOMES),
    side: requireEnum(args, 'side', ORDER_SIDES),
    strategy: requireEnum(args, 'strategy', ORDER_STRATEGIES),
    ...(quantity === undefined ? {} : { quantity }),
    ...(spend === undefined ? {} : { spend }),
    ...(price === undefined ? {} : { price }),
    ...(slippageBps === undefined ? {} : { slippageBps }),
    ...(isMinAmountOut === undefined ? {} : { isMinAmountOut }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(hasOptions
      ? {
          options: {
            ...(fillOrKill === undefined ? {} : { fillOrKill }),
            ...(postOnly === undefined ? {} : { postOnly }),
            ...(selfTradePrevention === undefined ? {} : { selfTradePrevention }),
            ...(reservedBalancePolicy === undefined ? {} : { reservedBalancePolicy }),
          },
        }
      : {}),
  }
}

function approvalBody(args: CliArgs): JsonRecord {
  const marketId = optionalMarketId(args)
  const side = optionalEnum(args, 'side', ORDER_SIDES)
  const amount = optionalPositiveDecimal(args, 'amount')
  const unlimited = optionalBooleanArg(args, 'unlimited')
  const stepIds =
    args['step-ids'] === undefined ? undefined : splitList(args['step-ids'], 'step-ids', 20)
  return {
    operation: requireEnum(args, 'operation', APPROVAL_OPERATIONS),
    ...(marketId === undefined ? {} : { marketId }),
    ...(side === undefined ? {} : { side }),
    ...(amount === undefined ? {} : { amount }),
    ...(unlimited === undefined ? {} : { unlimited }),
    ...(stepIds === undefined ? {} : { stepIds }),
  }
}

function positionBody(args: CliArgs): JsonRecord {
  const action = requireEnum(args, 'action', POSITION_ACTIONS)
  if (action === 'CONVERT') {
    return {
      action,
      categorySlug: requireArg(args, 'category-slug'),
      marketIds: marketIds(args, 'market-ids', 25),
      amount: requirePositiveDecimal(args, 'amount'),
    }
  }
  if (action === 'REDEEM') {
    const amount = optionalPositiveDecimal(args, 'amount')
    return {
      action,
      marketId: requireMarketId(args),
      outcome: requireEnum(args, 'outcome', OUTCOMES),
      ...(amount === undefined ? {} : { amount }),
    }
  }
  return {
    action,
    marketId: requireMarketId(args),
    amount: requirePositiveDecimal(args, 'amount'),
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function printStreamJson(value: unknown): void {
  console.log(JSON.stringify(value))
}

function parseSseFrame(frame: string): { event: string; data: string } | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }
  return data.length > 0 ? { event, data: data.join('\n') } : undefined
}

async function predictStream(args: CliArgs): Promise<void> {
  const topics = splitList(requireArg(args, 'topics'), 'topics', 50).join(',')
  const maxEvents = optionalInteger(args, 'max-events', 1, 10_000) ?? 100
  const timeoutMs = optionalInteger(args, 'timeout-ms', 1, 15 * 60_000) ?? 60_000
  const { apiUrl, apiToken, instanceId } = resolveCredentials()
  const path = appendQuery(`/v1/instances/${encodeURIComponent(instanceId)}/predict/stream`, {
    topics,
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
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
      throw toPredictError(
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
    if (!response.body) throw new Error('Predict platform stream returned no response body')

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
          throw new Error('Predict platform streamed invalid JSON')
        }
        if (frame.event === 'error') {
          const details = isRecord(data) ? data : {}
          throw new PredictCliError(errorMessage(details) ?? 'Predict stream failed', {
            code: optionalString(details.code),
            retryable: optionalBoolean(details.retryable),
            data,
          })
        }
        eventCount++
        printStreamJson({ type: 'predict-stream-event', event: frame.event, data })
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

  printStreamJson({ type: 'predict-stream', topics: topics.split(','), eventCount, timedOut })
}

function rejectUnsupportedArgs(args: CliArgs): void {
  if (args.network !== undefined) {
    throw new Error('--network is not supported; Predict.fun is BNB Chain mainnet-only')
  }
  if (args['api-key'] !== undefined || args['base-url'] !== undefined) {
    throw new Error('Predict credentials and upstream routing are managed by the platform')
  }
}

function positionPreviewArgs(args: CliArgs): readonly string[] {
  const action = args.action?.trim().toUpperCase().replaceAll('-', '_')
  if (action === 'CONVERT') return ['action', 'category-slug', 'market-ids', 'amount']
  if (action === 'REDEEM') return ['action', 'market-id', 'outcome', 'amount']
  if (action === 'SPLIT' || action === 'MERGE') return ['action', 'market-id', 'amount']
  return COMMAND_ARGS['position-preview']
}

function rejectMalformedRawArgs(command: string, rawArgs: readonly string[]): void {
  const seen = new Set<string>()
  const positionals: string[] = []

  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index]
    if (token === '-h') {
      if (seen.has('h')) throw new Error(`Duplicate argument for predict-fun ${command}: -h`)
      seen.add('h')
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const raw = token.slice(2)
    const equalsIndex = raw.indexOf('=')
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw
    if (name.length === 0)
      throw new Error(`Invalid argument for predict-fun ${command}: "${token}"`)
    if (seen.has(name)) {
      throw new Error(`Duplicate argument for predict-fun ${command}: --${name}`)
    }
    seen.add(name)

    if (equalsIndex < 0) {
      const next = rawArgs[index + 1]
      if (next !== undefined && !next.startsWith('--')) index++
    }
  }

  if (positionals.length > 0) {
    throw new Error(
      `Unexpected positional argument${positionals.length === 1 ? '' : 's'} for predict-fun ${command}: ${positionals.join(', ')}. Use named --options only`,
    )
  }
}

function rejectUnknownArgs(command: string, args: CliArgs, rawArgs: readonly string[]): void {
  const configuredArgs = COMMAND_ARGS[command]
  if (configuredArgs === undefined) return

  rejectMalformedRawArgs(command, rawArgs)
  const allowed = command === 'position-preview' ? positionPreviewArgs(args) : configuredArgs
  const allowedSet = new Set(allowed)
  const unsupported = Object.keys(args).filter((name) => !allowedSet.has(name))
  if (unsupported.length === 0) return

  const options = unsupported.map((name) => `--${name}`).join(', ')
  const suffix =
    allowed.length === 0
      ? 'This command accepts no options'
      : `Allowed: ${allowed.map((name) => `--${name}`).join(', ')}`
  throw new Error(
    `Unsupported argument${unsupported.length === 1 ? '' : 's'} for predict-fun ${command}: ${options}. ${suffix}`,
  )
}

export function predictHelp(): string {
  return PREDICT_USAGE
}

export async function predictCommand(
  command: string | undefined,
  args: CliArgs,
  rawArgs: readonly string[] = [],
): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(predictHelp())
    return
  }
  rejectUnsupportedArgs(args)
  rejectUnknownArgs(command, args, rawArgs)

  switch (command) {
    case 'account':
    case 'referral':
      printJson(await getPredict(command === 'account' ? '/account' : '/account/referral'))
      return
    case 'balances':
    case 'readiness':
      printJson(await getPredict(`/${command}`, { marketId: optionalMarketId(args) }))
      return
    case 'categories':
      printJson(
        await getPredictPage('/categories', {
          ...pageQuery(args),
          status: args.status,
          sort: args.sort,
          tagIds: args['tag-ids'],
          marketVariant: args['market-variant'],
        }),
      )
      return
    case 'category':
      printJson(await getPredict(`/categories/${encodeURIComponent(requireArg(args, 'slug'))}`))
      return
    case 'tags':
      printJson(await getPredictPage('/tags'))
      return
    case 'search':
      printJson(
        await getPredictPage('/search', {
          query: requireArg(args, 'query'),
          includeResolved: optionalBooleanArg(args, 'include-resolved'),
          limit: optionalInteger(args, 'limit', 1, 25),
        }),
      )
      return
    case 'markets':
      printJson(
        await getPredictPage('/markets', {
          ...pageQuery(args),
          status: args.status,
          sort: args.sort,
          tagIds: args['tag-ids'],
          marketVariant: args['market-variant'],
          isBoosted: optionalBooleanArg(args, 'is-boosted'),
          hasActiveRewards: optionalBooleanArg(args, 'has-active-rewards'),
        }),
      )
      return
    case 'market':
    case 'market-stats':
    case 'market-last-sale':
    case 'market-quote': {
      const suffix = {
        market: '',
        'market-stats': '/stats',
        'market-last-sale': '/last-sale',
        'market-quote': '/quote',
      }[command]
      printJson(await getPredict(`/markets/${requireMarketId(args)}${suffix}`))
      return
    }
    case 'market-quotes':
      printJson(await getPredict('/markets/quotes', { ids: marketIds(args).join(',') }))
      return
    case 'orderbook':
      printJson(
        await getPredict(`/markets/${requireMarketId(args)}/orderbook`, {
          outcome: optionalEnum(args, 'outcome', OUTCOMES),
        }),
      )
      return
    case 'timeseries-latest':
      printJson(
        await getPredict(`/markets/${requireMarketId(args)}/timeseries/latest`, {
          metric: 'chance',
        }),
      )
      return
    case 'timeseries':
      printJson(
        await getPredict(`/markets/${requireMarketId(args)}/timeseries`, {
          metric: 'chance',
          resolution: args.resolution,
          from: parseInteger(requireArg(args, 'from'), 'from', 0, Number.MAX_SAFE_INTEGER),
          to: optionalInteger(args, 'to', 0, Number.MAX_SAFE_INTEGER),
          limit: optionalInteger(args, 'limit', 1, 1_000),
          after: args.after,
        }),
      )
      return
    case 'orders':
      printJson(await getPredictPage('/orders', { ...pageQuery(args), status: args.status }))
      return
    case 'order':
      printJson(await getPredict(`/orders/${requireOrderHash(args)}`))
      return
    case 'positions':
      printJson(await getPredictPage('/positions', positionsQuery(args)))
      return
    case 'address-positions': {
      const address = requireArg(args, 'address')
      if (!ADDRESS_PATTERN.test(address)) {
        throw new Error('Invalid --address: expected a 0x-prefixed 20-byte EVM address')
      }
      printJson(await getPredictPage(`/addresses/${address}/positions`, positionsQuery(args)))
      return
    }
    case 'activity':
      printJson(await getPredictPage('/activity', pageQuery(args)))
      return
    case 'matches':
      printJson(
        await getPredictPage('/matches', {
          ...pageQuery(args),
          marketId: optionalMarketId(args),
          minimumValue: optionalPositiveDecimal(args, 'minimum-value'),
        }),
      )
      return
    case 'approvals':
      printJson(
        await getPredict('/approvals', {
          marketId: optionalMarketId(args),
          operation: optionalEnum(args, 'operation', APPROVAL_OPERATIONS.slice(0, -1)),
          side: optionalEnum(args, 'side', ORDER_SIDES),
        }),
      )
      return
    case 'set-referral': {
      const code = requireArg(args, 'code')
      if (code.length !== 5) throw new Error('--code must contain exactly 5 characters')
      printJson(await postPredict('/account/referral', { code }))
      return
    }
    case 'order-preview':
      printJson(await postPredict('/orders/preview', orderPreviewBody(args)))
      return
    case 'order-execute':
      printJson(await postPredict('/orders', { previewId: requirePreviewId(args) }))
      return
    case 'cancel-preview':
      printJson(await postPredict('/orders/cancel/preview', { orderHashes: orderHashes(args) }))
      return
    case 'cancel-all-preview':
      printJson(await postPredict('/orders/cancel-all/preview', {}))
      return
    case 'remove-from-book-preview':
      printJson(
        await postPredict('/orders/remove-from-book/preview', { orderHashes: orderHashes(args) }),
      )
      return
    case 'cancel-execute':
      printJson(await postPredict('/orders/cancel', { previewId: requirePreviewId(args) }))
      return
    case 'cancel-all-execute':
      printJson(await postPredict('/orders/cancel-all', { previewId: requirePreviewId(args) }))
      return
    case 'remove-from-book-execute': {
      const acknowledged = optionalBooleanArg(args, 'acknowledge-risk')
      if (acknowledged !== true) {
        throw new Error('--acknowledge-risk true is required because removal can strand collateral')
      }
      printJson(
        await postPredict('/orders/remove-from-book', {
          previewId: requirePreviewId(args),
          acknowledgeRisk: true,
        }),
      )
      return
    }
    case 'approval-preview':
      printJson(await postPredict('/approvals/preview', approvalBody(args)))
      return
    case 'approval-revoke-preview':
      printJson(await postPredict('/approvals/revoke/preview', approvalBody(args)))
      return
    case 'approval-execute':
      printJson(await postPredict('/approvals', { previewId: requirePreviewId(args) }))
      return
    case 'approval-revoke-execute':
      printJson(await postPredict('/approvals/revoke', { previewId: requirePreviewId(args) }))
      return
    case 'position-preview':
      printJson(await postPredict('/positions/actions/preview', positionBody(args)))
      return
    case 'position-execute':
      printJson(await postPredict('/positions/actions', { previewId: requirePreviewId(args) }))
      return
    case 'stream':
      await predictStream(args)
      return
    default:
      throw new Error(`Unknown predict-fun command: ${command}. Run: purr predict-fun help`)
  }
}
