import {
  ApiClientError,
  apiGet,
  apiPost,
  apiPut,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'
import { requireArgOrFile } from '@pieverseio/purr-core/file-input'
import { parseJsonCliArg } from '@pieverseio/purr-core/json-input'

type JsonRecord = Record<string, unknown>

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

interface ApiErrorBody {
  error?: string | JsonRecord
  code?: string
  message?: string
  reason?: string
  data?: unknown
  request_id?: string
  matched_rule_id?: string
  matched_policy_id?: string
  expires_at?: string
}

interface RequestContext {
  timeoutMs: number
}

export class LighterCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly data?: unknown
  readonly exitCode: number

  constructor(
    message: string,
    options: { code?: string; status?: number; data?: unknown; exitCode?: number } = {},
  ) {
    super(message)
    this.name = 'LighterCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
    this.exitCode = options.exitCode ?? 1
  }
}

export const LIGHTER_REQUEST_TIMEOUT_MS = 20_000
const MAX_LIGHTER_ORDER_INDEX = 9_223_372_036_854_775_807n

export const LIGHTER_USAGE = `Usage: purr lighter <command> [options]

Integration commands:
  status
  enable
  disable
  partner-fee-status
  approve-partner-fee

Read commands:
  sdk-status
  deposit-networks
  deposits [--limit <n>]
  deposit-status --request-id <id>
  requests [--limit <n>]
  request-status --request-id <id>
  system-status
  system-info
  system-config
  layer1-basic-info
  withdrawal-delay
  markets [--market-type perp|spot|all] [--market-id <id> | --market <symbol>]
  market (--market-id <id> | --market <symbol> [--market-type perp|spot|all])
  order-books [--market-type perp|spot|all] [--market-id <id> | --market <symbol>]
  order-book-depth (--market-id <id> | --market <symbol> [--market-type perp|spot|all]) [--limit <n>]
  recent-trades (--market-id <id> | --market <symbol> [--market-type perp|spot|all]) [--limit <n>]
  trades [--market-id <id> | --market <symbol> [--market-type perp|spot|all]] [--limit <n>]
  candles (--market-id <id> | --market <symbol> [--market-type perp|spot|all]) --resolution <value> --start-at <rfc3339> --end-at <rfc3339> --count-back <n>
  funding-rates [--market-id <id> | --market <symbol> [--market-type perp|spot|all]]
  account
  balances
  positions
  limits
  pnl --resolution <value> --start-at <rfc3339> --end-at <rfc3339> --count-back <n>
  orders
  active-orders
  inactive-orders
  transactions [--offset <n>] [--limit <n>]
  transaction --tx-hash <hash>
  l1-transaction --l1-tx-hash <ethereum-l1-tx-hash>

Write commands:
  order-preview --body-json <json> | --body-file <path>
  reconcile-deposit --request-id <id>
  open-account --amount <amount> --source-chain-id <1|42161|8453|43114|999> [--route-type perps]
  deposit --amount <amount> --source-chain-id <1|42161|8453|43114|999> [--route-type perps]
  order (--market-id <id> | --market <symbol> [--market-type perp|spot]) --side buy|sell --size <amount> --price <price> [--type <type>] [--time-in-force ioc|gtt|postOnly] [--reduce-only true|false] [non-IOC: --expires-in <duration> | --expires-at <iso> | --order-expiry <unix-ms>]
  place-orders (--market-id <id> | --market <symbol> [--market-type perp|spot]) --side buy|sell --size <amount> --price <price> [--type <type>] [--time-in-force ioc|gtt|postOnly] [--reduce-only true|false] [non-IOC: --expires-in <duration> | --expires-at <iso> | --order-expiry <unix-ms>]
  cancel (--market-id <id> | --market <symbol> [--market-type perp|spot]) --order-index <id>
  cancel-all [--time-in-force immediate|scheduled|abortScheduled] [--time <unix-ms>]
  modify (--market-id <id> | --market <symbol> [--market-type perp|spot]) --order-index <id> --size <amount> --price <price>
  update-leverage (--market-id <id> | --market <symbol> [--market-type perp]) (--leverage <n> | --initial-margin-fraction <n>) [--margin-mode cross|isolated]
  update-margin (--market-id <id> | --market <symbol> [--market-type perp]) --amount <amount> --direction add|remove
  withdraw --amount <USDC> [--yes]
  fast-withdraw --amount <USDC> [--yes]
Withdrawal commands preview without --yes. Adding --yes fetches and executes the latest quote, which may differ from an earlier preview.
Lighter read and preview requests use a 20s client timeout. Confirmed write commands wait for the Platform response.
IOC market/limit orders do not accept expiry flags.`

const SIDE_EFFECT_WRITE_ENDPOINTS: Record<string, string> = {
  'approve-partner-fee': '/partner-fee/approve',
  'open-account': '/account/open',
  deposit: '/deposits',
  order: '/order',
  'place-orders': '/orders',
  cancel: '/cancel',
  'cancel-all': '/cancel-all',
  modify: '/modify',
  'update-leverage': '/update-leverage',
  'update-margin': '/update-margin',
  withdraw: '/withdraw',
  'fast-withdraw': '/fast-withdraw',
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function nestedError(body: unknown): unknown {
  return isRecord(body) ? body.error : undefined
}

function extractErrorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const err = nestedError(body)
  if (isRecord(err)) return asString(err.code)
  return asString(body.code)
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const err = nestedError(body)
  if (typeof err === 'string') return err
  if (isRecord(err)) return asString(err.message) ?? asString(err.error)
  return asString(body.reason) ?? asString(body.message) ?? asString(body.error)
}

function extractErrorData(body: unknown): unknown {
  if (!isRecord(body)) return undefined
  if (body.data !== undefined) return body.data

  const details: JsonRecord = {}
  for (const key of ['request_id', 'matched_rule_id', 'matched_policy_id', 'expires_at'] as const) {
    if (typeof body[key] === 'string') details[key] = body[key]
  }
  return Object.keys(details).length > 0 ? details : undefined
}

function isTimeoutError(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError'
}

function toLighterError(error: unknown, context?: RequestContext): Error {
  if (error instanceof LighterCliError) return error
  if (context && isTimeoutError(error)) {
    const seconds = Math.round(context.timeoutMs / 1000)
    return new LighterCliError(`Lighter request timed out after ${seconds}s.`, {
      code: 'LIGHTER_REQUEST_TIMEOUT',
      data: {
        timeoutMs: context.timeoutMs,
      },
    })
  }
  if (error instanceof ApiClientError) {
    const body = error.body as ApiErrorBody | undefined
    const message = extractErrorMessage(body) ?? error.message
    return new LighterCliError(message, {
      code: extractErrorCode(body),
      status: error.status,
      data: extractErrorData(body),
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new LighterCliError(
      extractErrorMessage(response) ?? response.code ?? 'Lighter request failed',
      {
        code: response.code,
        data: extractErrorData(response),
      },
    )
  }
  return response.data
}

function instancePath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}`
}

function lighterBasePath(): string {
  return `${instancePath()}/lighter`
}

function lighterTradingIntegrationPath(): string {
  return `${instancePath()}/integrations/lighter-trading`
}

function appendQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

async function getEnvelope<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const context: RequestContext = { timeoutMs: LIGHTER_REQUEST_TIMEOUT_MS }
  try {
    const response = await apiGet<ApiEnvelope<T>>(appendQuery(path, params), {
      timeoutMs: LIGHTER_REQUEST_TIMEOUT_MS,
    })
    return unwrap(response)
  } catch (error) {
    throw toLighterError(error, context)
  }
}

async function postEnvelope<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  const timeoutMs = path.endsWith('/preview') ? LIGHTER_REQUEST_TIMEOUT_MS : undefined
  try {
    const response =
      timeoutMs === undefined
        ? await apiPost<ApiEnvelope<T>>(path, body)
        : await apiPost<ApiEnvelope<T>>(path, body, { timeoutMs })
    return unwrap(response)
  } catch (error) {
    throw timeoutMs === undefined ? toLighterError(error) : toLighterError(error, { timeoutMs })
  }
}

async function putEnvelope<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPut<ApiEnvelope<T>>(path, body)
    return unwrap(response)
  } catch (error) {
    throw toLighterError(error)
  }
}

async function getLighter<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  return getEnvelope(`${lighterBasePath()}${path}`, params)
}

async function postLighter<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  return postEnvelope(`${lighterBasePath()}${path}`, body)
}

async function getLighterTradingIntegration<T = unknown>(path = ''): Promise<T> {
  return getEnvelope(`${lighterTradingIntegrationPath()}${path}`)
}

async function setLighterTradingIntegration<T = unknown>(enabled: boolean): Promise<T> {
  return putEnvelope(lighterTradingIntegrationPath(), { enabled })
}

function arg(args: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (args[name] !== undefined) return args[name]
  }
  return undefined
}

function requireArg(args: Record<string, string>, name: string, ...aliases: string[]): string {
  const value = arg(args, name, ...aliases)
  if (value === undefined) throw new Error(`Missing required argument: --${name}`)
  return value
}

function parseInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid --${name}: "${value}"`)
  return parsed
}

function parseIntegerString(
  value: string | undefined,
  name: string,
  min = 0n,
  max = MAX_LIGHTER_ORDER_INDEX,
): string | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = BigInt(value)
  if (parsed < min || parsed > max) throw new Error(`Invalid --${name}: "${value}"`)
  return value
}

function parseSignedInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid --${name}: "${value}"`)
  return parsed
}

function requireInteger(args: Record<string, string>, name: string, ...aliases: string[]): number {
  return parseInteger(requireArg(args, name, ...aliases), name) as number
}

function requireIntegerString(
  args: Record<string, string>,
  name: string,
  ...aliases: string[]
): string {
  return parseIntegerString(requireArg(args, name, ...aliases), name, 1n) as string
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${value}"`)
}

function readBody(args: Record<string, string>): JsonRecord {
  if (args['body-json'] !== undefined && args['body-file'] !== undefined) {
    throw new Error('Pass either --body-json or --body-file, not both')
  }
  const raw = requireArgOrFile(args, 'body-json', 'body-file')
  return parseJsonCliArg<JsonRecord>(raw, args['body-file'] ? 'body-file' : 'body-json')
}

function hasBodyInput(args: Record<string, string>): boolean {
  return args['body-json'] !== undefined || args['body-file'] !== undefined
}

function compact(record: JsonRecord): JsonRecord {
  const result: JsonRecord = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

const MARKET_ARGUMENT_COMMANDS = new Set([
  'markets',
  'market',
  'order-books',
  'order-book-depth',
  'recent-trades',
  'trades',
  'candles',
  'funding-rates',
  'order',
  'place-orders',
  'cancel',
  'modify',
  'update-leverage',
  'update-margin',
])

const CANDLE_RESOLUTIONS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w'])
const PNL_RESOLUTIONS = new Set(['1m', '5m', '15m', '1h', '4h', '1d'])
const RFC3339_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/

function rfc3339ToUnixSeconds(value: string, option: string): number {
  const match = RFC3339_WITH_TIMEZONE.exec(value)
  if (!match) {
    throw new Error(`${option} must be an RFC 3339 timestamp with a timezone`)
  }
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match
  const year = Number(yearValue)
  const month = Number(monthValue)
  const day = Number(dayValue)
  const hour = Number(hourValue)
  const minute = Number(minuteValue)
  const second = Number(secondValue)
  const offsetHour = Number(match[7] ?? 0)
  const offsetMinute = Number(match[8] ?? 0)
  const calendarDate = new Date(0)
  calendarDate.setUTCFullYear(year, month - 1, day)
  calendarDate.setUTCHours(hour, minute, second, 0)
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    calendarDate.getUTCHours() !== hour ||
    calendarDate.getUTCMinutes() !== minute ||
    calendarDate.getUTCSeconds() !== second ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error(`${option} must be a valid RFC 3339 timestamp`)
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`${option} must be a valid RFC 3339 timestamp`)
  }
  return Math.floor(milliseconds / 1000)
}

function marketRecords(response: unknown): JsonRecord[] {
  if (Array.isArray(response)) return response.filter(isRecord)
  if (!isRecord(response)) return []
  const records = response.order_books ?? response.orderBooks ?? response.markets
  return Array.isArray(records) ? records.filter(isRecord) : []
}

function marketRecordId(record: JsonRecord): number | undefined {
  const value = record.market_id ?? record.marketId ?? record.id
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return typeof value === 'string' ? parseInteger(value, 'market-id') : undefined
}

function marketRecordSymbol(record: JsonRecord): string | undefined {
  return asString(record.symbol ?? record.name)
}

function marketRecordType(record: JsonRecord): string | undefined {
  return asString(record.market_type ?? record.marketType ?? record.type)?.toLowerCase()
}

function marketSymbolMatches(candidate: string, requested: string): boolean {
  const normalizedCandidate = candidate.trim().toUpperCase()
  const normalizedRequested = requested.trim().toUpperCase()
  if (normalizedCandidate === normalizedRequested) return true
  return normalizedCandidate.split(/[-/]/, 1)[0] === normalizedRequested
}

function readMarketType(args: Record<string, string>, command: string): string {
  if (args.type !== undefined && !['order', 'place-orders', 'trades'].includes(command)) {
    throw new Error(
      'Use --market-type for Lighter market filtering; --type is reserved for order/trade type.',
    )
  }
  const value = arg(args, 'market-type', 'marketType') ?? 'all'
  if (!['perp', 'spot', 'all'].includes(value)) {
    throw new Error(`Invalid --market-type: "${value}"`)
  }
  return value
}

async function resolveMarketArgs(
  command: string,
  args: Record<string, string>,
): Promise<Record<string, string>> {
  if (!MARKET_ARGUMENT_COMMANDS.has(command)) return args
  const marketId = arg(args, 'market-id', 'marketId')
  const symbol = arg(args, 'market', 'symbol')
  if (marketId !== undefined && symbol !== undefined) {
    throw new Error('Pass either --market-id or --market, not both')
  }
  if (symbol === undefined) return args

  const marketType = readMarketType(args, command)
  const response = await getLighter('/markets', { type: marketType })
  const matches = marketRecords(response).filter((record) => {
    const candidate = marketRecordSymbol(record)
    if (!candidate || !marketSymbolMatches(candidate, symbol)) return false
    const candidateType = marketRecordType(record)
    return marketType === 'all' || candidateType === undefined || candidateType === marketType
  })
  if (matches.length === 0) {
    throw new LighterCliError(
      `No Lighter ${marketType === 'all' ? '' : `${marketType} `}market found for "${symbol}".`,
      { code: 'LIGHTER_MARKET_NOT_FOUND' },
    )
  }
  if (matches.length > 1) {
    const candidates = matches
      .map((record) => {
        const id = marketRecordId(record)
        const type = marketRecordType(record)
        return `${marketRecordSymbol(record) ?? 'unknown'}${type ? ` ${type}` : ''}${id === undefined ? '' : ` (${id})`}`
      })
      .join(', ')
    throw new LighterCliError(
      `Lighter market "${symbol}" is ambiguous. Pass --market-type perp or spot. Matches: ${candidates}`,
      { code: 'LIGHTER_MARKET_AMBIGUOUS' },
    )
  }
  const resolvedMarketId = marketRecordId(matches[0])
  if (resolvedMarketId === undefined) {
    throw new LighterCliError(`Lighter market "${symbol}" has no valid market id.`, {
      code: 'LIGHTER_MARKET_INVALID_RESPONSE',
    })
  }
  return { ...args, 'market-id': String(resolvedMarketId) }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function readQueryArgs(command: string, args: Record<string, string>) {
  switch (command) {
    case 'deposits':
    case 'requests':
      return { limit: parseInteger(args.limit, 'limit') }
    case 'markets':
    case 'order-books':
      return {
        marketId: parseInteger(arg(args, 'market-id', 'marketId'), 'market-id'),
        type: readMarketType(args, command),
      }
    case 'order-book-depth':
    case 'recent-trades':
      return {
        marketId: requireInteger(args, 'market-id', 'marketId'),
        limit: parseInteger(args.limit, 'limit'),
      }
    case 'trades':
      return {
        marketId: parseInteger(arg(args, 'market-id', 'marketId'), 'market-id'),
        marketType: arg(args, 'market-type', 'marketType'),
        orderIndex: parseIntegerString(arg(args, 'order-index', 'orderIndex'), 'order-index'),
        sortBy: arg(args, 'sort-by', 'sortBy'),
        sortDir: arg(args, 'sort-dir', 'sortDir'),
        from: parseSignedInteger(args.from, 'from'),
        role: args.role,
        type: args.type,
        limit: parseInteger(args.limit, 'limit'),
        aggregate: parseBoolean(args.aggregate, 'aggregate'),
      }
    case 'candles': {
      const resolution = requireArg(args, 'resolution')
      if (!CANDLE_RESOLUTIONS.has(resolution)) {
        throw new Error(
          `--resolution must be one of: ${[...CANDLE_RESOLUTIONS].join(', ')}`,
        )
      }
      const startTimestamp = rfc3339ToUnixSeconds(
        requireArg(args, 'start-at', 'startAt'),
        '--start-at',
      )
      const endTimestamp = rfc3339ToUnixSeconds(
        requireArg(args, 'end-at', 'endAt'),
        '--end-at',
      )
      if (startTimestamp > endTimestamp) {
        throw new Error('--start-at must be earlier than or equal to --end-at')
      }
      return {
        marketId: requireInteger(args, 'market-id', 'marketId'),
        resolution,
        startTimestamp,
        endTimestamp,
        countBack: requireInteger(args, 'count-back', 'countBack'),
      }
    }
    case 'funding-rates':
      return {
        marketId: parseInteger(arg(args, 'market-id', 'marketId'), 'market-id'),
      }
    case 'pnl': {
      const resolution = requireArg(args, 'resolution')
      if (!PNL_RESOLUTIONS.has(resolution)) {
        throw new Error(`--resolution must be one of: ${[...PNL_RESOLUTIONS].join(', ')}`)
      }
      const startTimestamp = rfc3339ToUnixSeconds(
        requireArg(args, 'start-at', 'startAt'),
        '--start-at',
      )
      const endTimestamp = rfc3339ToUnixSeconds(
        requireArg(args, 'end-at', 'endAt'),
        '--end-at',
      )
      if (startTimestamp > endTimestamp) {
        throw new Error('--start-at must be earlier than or equal to --end-at')
      }
      return {
        resolution,
        startTimestamp,
        endTimestamp,
        countBack: requireInteger(args, 'count-back', 'countBack'),
      }
    }
    case 'transactions':
      return {
        offset: parseInteger(args.offset, 'offset'),
        limit: parseInteger(args.limit, 'limit'),
      }
    default:
      return {}
  }
}

function readEndpoint(command: string, args: Record<string, string>): string | undefined {
  const staticEndpoints: Record<string, string> = {
    'sdk-status': '/sdk/status',
    'deposit-networks': '/deposit-networks',
    deposits: '/deposits',
    requests: '/requests',
    'partner-fee-status': '/partner-fee/status',
    'system-status': '/system/status',
    'system-info': '/system/info',
    'system-config': '/system/config',
    'layer1-basic-info': '/system/layer1-basic-info',
    'withdrawal-delay': '/system/withdrawal-delay',
    markets: '/markets',
    'order-books': '/order-books',
    'order-book-depth': '/order-book-depth',
    'recent-trades': '/recent-trades',
    trades: '/trades',
    candles: '/candles',
    'funding-rates': '/funding-rates',
    account: '/account',
    balances: '/balances',
    positions: '/positions',
    limits: '/limits',
    pnl: '/pnl',
    orders: '/orders',
    'active-orders': '/orders/active',
    'inactive-orders': '/orders/inactive',
    transactions: '/transactions',
  }
  if (staticEndpoints[command]) return staticEndpoints[command]

  switch (command) {
    case 'deposit-status':
      return `/deposits/${encodeURIComponent(requireArg(args, 'request-id', 'requestId'))}`
    case 'request-status':
      return `/requests/${encodeURIComponent(requireArg(args, 'request-id', 'requestId'))}`
    case 'market':
      return `/markets/${requireInteger(args, 'market-id', 'marketId')}`
    case 'transaction':
      return `/transactions/${encodeURIComponent(requireArg(args, 'tx-hash', 'txHash'))}`
    case 'l1-transaction':
      return `/transactions/l1/${encodeURIComponent(requireArg(args, 'l1-tx-hash', 'l1TxHash'))}`
    default:
      return undefined
  }
}

function writeBody(command: string, args: Record<string, string>): JsonRecord {
  if (hasBodyInput(args)) return readBody(args)

  const priceProtection = parseBoolean(
    arg(args, 'price-protection', 'priceProtection'),
    'price-protection',
  )

  switch (command) {
    case 'approve-partner-fee':
      return {}
    case 'open-account':
    case 'deposit':
      return compact({
        amount: requireArg(args, 'amount'),
        sourceChainId: requireInteger(args, 'source-chain-id', 'sourceChainId'),
        routeType: arg(args, 'route-type', 'routeType'),
      })
    case 'order':
    case 'place-orders':
      return compact({
        marketId: requireInteger(args, 'market-id', 'marketId'),
        side: requireArg(args, 'side'),
        type: args.type,
        size: requireArg(args, 'size'),
        price: requireArg(args, 'price'),
        reduceOnly: parseBoolean(arg(args, 'reduce-only', 'reduceOnly'), 'reduce-only'),
        timeInForce: arg(args, 'time-in-force', 'timeInForce'),
        clientOrderIndex: parseInteger(
          arg(args, 'client-order-index', 'clientOrderIndex'),
          'client-order-index',
        ),
        triggerPrice: arg(args, 'trigger-price', 'triggerPrice'),
        ...(() => {
          const expiresIn = arg(args, 'expires-in', 'expiresIn')
          const expiresAt = arg(args, 'expires-at', 'expiresAt')
          const rawOrderExpiry = arg(args, 'order-expiry', 'orderExpiry')
          const provided = [expiresIn, expiresAt, rawOrderExpiry].filter(
            (value) => value !== undefined,
          )
          if (provided.length > 1) {
            throw new Error('--expires-in, --expires-at, and --order-expiry are mutually exclusive')
          }
          const orderType = args.type ?? 'limit'
          const timeInForce =
            arg(args, 'time-in-force', 'timeInForce') ??
            (['market', 'stopLoss', 'takeProfit'].includes(orderType) ? 'ioc' : 'gtt')
          if (
            provided.length > 0 &&
            (orderType === 'market' || orderType === 'limit') &&
            timeInForce === 'ioc'
          ) {
            throw new Error(
              'IOC market and limit orders do not accept --expires-in, --expires-at, or --order-expiry',
            )
          }
          if (rawOrderExpiry !== undefined) {
            return {
              orderExpiry: parseSignedInteger(rawOrderExpiry, 'order-expiry'),
            }
          }
          if (expiresAt !== undefined) {
            if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(expiresAt)) {
              throw new Error('--expires-at must include Z or an explicit UTC offset')
            }
            const timestamp = Date.parse(expiresAt)
            if (!Number.isFinite(timestamp)) {
              throw new Error('--expires-at must be a valid ISO-8601 timestamp')
            }
            return { expiresAt: new Date(timestamp).toISOString() }
          }
          if (expiresIn !== undefined) {
            if (!/^(\d+)(ms|s|m|h|d|w)$/.test(expiresIn)) {
              throw new Error('--expires-in must be an integer duration such as 30m, 24h, or 7d')
            }
            return { expiresIn }
          }
          return {}
        })(),
        priceProtection,
      })
    case 'cancel':
      return compact({
        marketId: requireInteger(args, 'market-id', 'marketId'),
        orderIndex: requireIntegerString(args, 'order-index', 'orderIndex'),
        priceProtection,
      })
    case 'cancel-all':
      return compact({
        timeInForce: arg(args, 'time-in-force', 'timeInForce'),
        time: parseInteger(args.time, 'time'),
        priceProtection,
      })
    case 'modify':
      return compact({
        marketId: requireInteger(args, 'market-id', 'marketId'),
        orderIndex: requireIntegerString(args, 'order-index', 'orderIndex'),
        size: requireArg(args, 'size'),
        price: requireArg(args, 'price'),
        triggerPrice: arg(args, 'trigger-price', 'triggerPrice'),
        priceProtection,
      })
    case 'update-leverage': {
      const initialMarginFraction = parseInteger(
        arg(args, 'initial-margin-fraction', 'initialMarginFraction'),
        'initial-margin-fraction',
      )
      const leverage = parseInteger(args.leverage, 'leverage')
      if (initialMarginFraction === undefined && leverage === undefined) {
        throw new Error('Missing required argument: --leverage or --initial-margin-fraction')
      }
      return compact({
        marketId: requireInteger(args, 'market-id', 'marketId'),
        initialMarginFraction,
        leverage,
        marginMode: arg(args, 'margin-mode', 'marginMode'),
        priceProtection,
      })
    }
    case 'update-margin':
      return compact({
        marketId: requireInteger(args, 'market-id', 'marketId'),
        amount: requireArg(args, 'amount'),
        direction: requireArg(args, 'direction'),
        priceProtection,
      })
    case 'withdraw':
    case 'fast-withdraw':
      return {
        amount: requireArg(args, 'amount'),
      }
    default:
      throw new Error(`Unknown lighter write command: ${command}`)
  }
}

function openAccountCommand(args: Record<string, string>): string {
  const amount = requireArg(args, 'amount')
  const sourceChainId = requireInteger(args, 'source-chain-id', 'sourceChainId')
  const routeType = arg(args, 'route-type', 'routeType')
  return [
    'purr lighter open-account',
    `--amount ${amount}`,
    `--source-chain-id ${sourceChainId}`,
    ...(routeType ? [`--route-type ${routeType}`] : []),
  ].join(' ')
}

function addAccountOpeningResumeCommand(result: unknown, args: Record<string, string>): unknown {
  if (!isRecord(result) || result.nextAction !== 'resume_account_opening') return result
  return {
    ...result,
    resumeCommand: openAccountCommand(args),
  }
}

export function lighterHelp(): string {
  return LIGHTER_USAGE
}

export async function lighterCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    ['help', 'h', '--help', '-h'].some((flag) => Object.hasOwn(args, flag))
  ) {
    console.log(lighterHelp())
    return
  }

  const integrationWriteCommands: Record<string, boolean> = {
    enable: true,
    'enable-trading': true,
    disable: false,
    'disable-trading': false,
  }
  const integrationReadCommands = new Set(['status', 'trading-status', 'integration-status'])

  if (integrationReadCommands.has(command)) {
    printJson(await getLighterTradingIntegration())
    return
  }

  if (integrationWriteCommands[command] !== undefined) {
    printJson(await setLighterTradingIntegration(integrationWriteCommands[command]))
    return
  }

  const resolvedArgs = await resolveMarketArgs(command, args)
  const endpoint = readEndpoint(command, resolvedArgs)
  if (endpoint) {
    printJson(await getLighter(endpoint, readQueryArgs(command, resolvedArgs)))
    return
  }

  if (command === 'order-preview') {
    printJson(await postLighter('/order/preview', readBody(args)))
    return
  }

  if (command === 'reconcile-deposit') {
    const requestId = encodeURIComponent(requireArg(args, 'request-id', 'requestId'))
    printJson(await postLighter(`/deposits/${requestId}/reconcile`, {}))
    return
  }

  const writeEndpoint = SIDE_EFFECT_WRITE_ENDPOINTS[command]
  if (writeEndpoint) {
    try {
      const body = writeBody(command, resolvedArgs)
      const isWithdrawal = command === 'withdraw' || command === 'fast-withdraw'
      const confirmed = parseBoolean(args.yes, 'yes') === true
      if (isWithdrawal && !confirmed) {
        printJson(await postLighter(`${writeEndpoint}/preview`, body))
        return
      }
      const result = await postLighter(
        writeEndpoint,
        isWithdrawal ? { ...body, confirmed: true } : body,
      )
      printJson(
        command === 'open-account' ? addAccountOpeningResumeCommand(result, resolvedArgs) : result,
      )
    } catch (error) {
      if (
        command === 'deposit' &&
        error instanceof LighterCliError &&
        error.code === 'LIGHTER_ACCOUNT_NOT_READY'
      ) {
        throw new LighterCliError(`${error.message}\nRun: ${openAccountCommand(resolvedArgs)}`, {
          code: error.code,
          status: error.status,
          data: error.data,
          exitCode: error.exitCode,
        })
      }
      throw error
    }
    return
  }

  throw new Error(`Unknown lighter command: ${command}. Run: purr lighter help`)
}
