import { ApiClientError, apiGet, resolveCredentials } from '@pieverseio/purr-core/api-client'

type JsonRecord = Record<string, unknown>
type Query = Record<string, string | number | undefined>

export class InjectiveCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly data?: unknown
  readonly exitCode = 1

  constructor(message: string, options: { code?: string; status?: number; data?: unknown } = {}) {
    super(message)
    this.name = 'InjectiveCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
  }
}

const USAGE = `Usage: purr injective <command> [options]

Read-only Injective mainnet queries:
  status
  account
  balances
  positions [--market-type perp] [--market-id <hash>] [--limit <1..100>] [--cursor <opaque>]
  markets [--market-type perp|spot|all]
  market --market-id <hash> --market-type perp|spot
  order-book-depth --market-id <hash> --market-type perp|spot [--limit <1..100>]
  recent-trades --market-id <hash> --market-type perp|spot [--limit <1..100>]
  candles --market-id <hash> --market-type perp|spot --resolution <1m|5m|15m|30m|1h|4h|1d> --start-at <rfc3339> --end-at <rfc3339>
  orders --market-type perp|spot [--market-id <hash>] [--limit <1..100>] [--cursor <opaque>]
  order-history --market-type perp|spot [--market-id <hash>] [--start-at <rfc3339> --end-at <rfc3339>] [--limit <1..100>] [--cursor <opaque>]
  fills --market-type perp|spot [--market-id <hash>] [--start-at <rfc3339> --end-at <rfc3339>] [--limit <1..100>] [--cursor <opaque>]

All requests use the authenticated platform backend. Account reads also require INSTANCE_ID.
Markets require exact native 0x + 64-hex hash and product; symbols are never selectors.
Default limits: book 20; trades, positions and records 50. Candles: at most 1500 buckets.
History defaults to the backend's fixed last 7 days; explicit windows are at most 31 days.
Reuse cursors only with the same instance, wallet generation, product, market and time filters.
Execution is unavailable. No signing, orders, transfers or gas are needed for these reads.`

export function injectiveHelp(): string {
  return USAGE
}

const MARKET_OPTIONS = ['market-id', 'market-type']
const PAGE_OPTIONS = [...MARKET_OPTIONS, 'limit', 'cursor']
const OPTIONS: Record<string, readonly string[]> = {
  status: [],
  account: [],
  balances: [],
  positions: PAGE_OPTIONS,
  markets: ['market-type'],
  market: MARKET_OPTIONS,
  'order-book-depth': [...MARKET_OPTIONS, 'limit'],
  'recent-trades': [...MARKET_OPTIONS, 'limit'],
  candles: [...MARKET_OPTIONS, 'resolution', 'start-at', 'end-at'],
  orders: PAGE_OPTIONS,
  'order-history': [...PAGE_OPTIONS, 'start-at', 'end-at'],
  fills: [...PAGE_OPTIONS, 'start-at', 'end-at'],
}
const TIMEFRAMES: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

function invalid(message: string): never {
  throw new InjectiveCliError(message, { code: 'INJECTIVE_INVALID_ARGUMENT' })
}

// Parse raw argv before the CLI's permissive legacy parser can drop positionals or duplicates.
function parseOptions(argv: string[], allowed: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] === '-h' ? '--help' : argv[i]
    if (!token.startsWith('--') || token === '--') invalid(`Unexpected argument: ${token}`)
    const [name, ...equals] = token.slice(2).split('=')
    if (name !== 'help' && !allowed.includes(name)) invalid(`Unknown option: --${name}`)
    if (Object.hasOwn(args, name)) invalid(`Duplicate option: --${name}`)
    if (name === 'help') {
      if (equals.length) invalid('--help does not accept a value')
      args.help = 'true'
      continue
    }
    const value = equals.length ? equals.join('=') : argv[++i]
    if (!value || value.startsWith('--') || value === '-h') invalid(`Missing value for --${name}`)
    args[name] = value
  }
  return args
}

function product(value: string | undefined, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (value !== 'perp' && value !== 'spot') invalid('--market-type must be perp or spot')
  return value
}

function marketHash(value: string | undefined, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
    invalid('--market-id must be a native 0x + 64-hex market hash')
  return value
}

function limit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)
    invalid('--limit must be an integer from 1 to 100')
  return Number(value)
}

function timestamp(value: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    )
  if (!match) invalid('Time bounds must be RFC3339 timestamps with a timezone')
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  const ms = Date.parse(value)
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59) ||
    !Number.isSafeInteger(ms) ||
    ms < 0
  ) {
    invalid('Time bounds must be valid RFC3339 timestamps after the Unix epoch')
  }
  return ms
}

function timeRange(args: Record<string, string>, required = false): { from?: number; to?: number } {
  if (!args['start-at'] && !args['end-at'] && !required) return {}
  if (!args['start-at'] || !args['end-at'])
    invalid('--start-at and --end-at must be supplied together')
  const from = timestamp(args['start-at'])
  const to = timestamp(args['end-at'])
  if (from >= to) invalid('--start-at must be before --end-at')
  return { from, to }
}

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function backendError(body: unknown, status?: number, retryAfter?: string): InjectiveCliError {
  const envelope = record(body) ? body : {}
  const error = record(envelope.error) ? envelope.error : envelope
  const code = typeof error.code === 'string' ? error.code : undefined
  const detail = envelope.data ?? error.data
  const data =
    retryAfter === undefined
      ? detail
      : { ...(record(detail) ? detail : { details: detail }), retryAfter }
  if (status === 404 && (!code || code === 'NOT_FOUND' || code === 'ROUTE_NOT_FOUND')) {
    return new InjectiveCliError(
      'Injective capability unavailable on this backend. Upgrade the platform backend to enable Injective read APIs.',
      { code: 'INJECTIVE_CAPABILITY_UNAVAILABLE', status, data },
    )
  }
  const message =
    typeof error.message === 'string'
      ? error.message
      : typeof envelope.error === 'string'
        ? envelope.error
        : 'Injective backend request failed'
  return new InjectiveCliError(message, { code, status, data })
}

async function get(path: string, params: Query = {}): Promise<unknown> {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) query.set(name, String(value))
  try {
    const response = await apiGet<unknown>(`${path}${query.size ? `?${query}` : ''}`, {
      timeoutMs: 20_000,
    })
    if (!record(response) || response.ok !== true || response.data === undefined)
      throw backendError(response)
    return response.data
  } catch (error) {
    if (error instanceof ApiClientError)
      throw backendError(error.body, error.status, error.retryAfter)
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new InjectiveCliError('Injective backend request timed out after 20s.', {
        code: 'INJECTIVE_REQUEST_TIMEOUT',
      })
    }
    throw error
  }
}

const CATALOG_PATH = '/v1/market-data/reference/terminal/instruments'

async function exactMarket(
  marketId: string,
  marketType: string,
): Promise<{ catalog: JsonRecord; instrument: JsonRecord }> {
  const id = `injective:${marketType}:${marketId}`
  const catalog = await get(CATALOG_PATH, {
    venue: 'injective',
    environment: 'mainnet',
    product: marketType,
    ids: id,
  })
  if (
    !record(catalog) ||
    !record(catalog.identity) ||
    catalog.identity.venue !== 'injective' ||
    catalog.identity.environment !== 'mainnet'
  ) {
    throw new InjectiveCliError('Invalid Injective catalog identity.', {
      code: 'INJECTIVE_INVALID_RESPONSE',
      data: catalog,
    })
  }
  if (catalog.data === null)
    throw new InjectiveCliError('Injective market catalog is unavailable.', {
      code: 'INJECTIVE_SOURCE_UNAVAILABLE',
      data: catalog,
    })
  if (!Array.isArray(catalog.data))
    throw new InjectiveCliError('Invalid Injective catalog.', {
      code: 'INJECTIVE_INVALID_RESPONSE',
      data: catalog,
    })
  const matches = catalog.data.filter(
    (item): item is JsonRecord =>
      record(item) &&
      item.id === id &&
      item.nativeMarketId === marketId &&
      item.product === marketType &&
      item.venue === 'injective' &&
      item.environment === 'mainnet',
  )
  if (matches.length !== 1)
    throw new InjectiveCliError(
      'Exact native Injective market not found or ambiguous. Query markets and use its native hash and product.',
      { code: 'MARKET_NOT_FOUND', data: catalog },
    )
  const instrument = matches[0]
  if (typeof instrument.base !== 'string' || !instrument.base)
    throw new InjectiveCliError('Injective catalog is missing the market base.', {
      code: 'INJECTIVE_INVALID_RESPONSE',
      data: catalog,
    })
  return { catalog, instrument }
}

export async function injectiveCommand(argv: string[]): Promise<unknown> {
  const [command = 'help', ...rest] = argv
  if (['help', '--help', '-h'].includes(command)) {
    parseOptions(rest, [])
    return injectiveHelp()
  }
  if (!Object.hasOwn(OPTIONS, command)) {
    throw new InjectiveCliError(
      `Unsupported Injective command: ${command}. Injective is read-only; use purr injective --help.`,
      { code: 'INJECTIVE_READ_ONLY' },
    )
  }
  const args = parseOptions(rest, OPTIONS[command])
  if (args.help) return injectiveHelp()

  if (command === 'markets') {
    const marketType = args['market-type'] === 'all' ? undefined : product(args['market-type'])
    return get(CATALOG_PATH, { venue: 'injective', environment: 'mainnet', product: marketType })
  }
  if (['market', 'order-book-depth', 'recent-trades', 'candles'].includes(command)) {
    const marketId = marketHash(args['market-id'], true) as string
    const marketType = product(args['market-type'], true) as string
    let count: number | undefined
    let range: { from?: number; to?: number } = {}
    if (command === 'candles') {
      if (!Object.hasOwn(TIMEFRAMES, args.resolution))
        invalid('--resolution must be one of 1m, 5m, 15m, 30m, 1h, 4h, 1d')
      const step = TIMEFRAMES[args.resolution]
      range = timeRange(args, true)
      count = Math.ceil((range.to as number) / step) - Math.floor((range.from as number) / step)
      if (count > 1500)
        invalid(
          'Candle range exceeds 1500 buckets. Use a smaller time window or a coarser resolution.',
        )
    } else if (command !== 'market')
      count = limit(args.limit, command === 'order-book-depth' ? 20 : 50)
    const { catalog, instrument } = await exactMarket(marketId, marketType)
    if (command === 'market') return { ...catalog, data: [instrument] }
    const query: Query = {
      underlying: instrument.base as string,
      instrumentId: instrument.id as string,
    }
    if (command === 'order-book-depth')
      return get('/v1/market-data/orderbook', { ...query, levels: count })
    if (command === 'recent-trades')
      return get('/v1/market-data/trades', { ...query, limit: count })
    const result = await get('/v1/market-data/candles', {
      ...query,
      tf: args.resolution,
      to: range.to,
      limit: count,
    })
    if (
      !record(result) ||
      !Array.isArray(result.candles) ||
      result.candles.some(
        (bar) => !record(bar) || typeof bar.t !== 'number' || !Number.isSafeInteger(bar.t),
      )
    ) {
      throw new InjectiveCliError('Invalid Injective candle response.', {
        code: 'INJECTIVE_INVALID_RESPONSE',
        data: result,
      })
    }
    return {
      ...result,
      candles: result.candles.filter(
        (bar) => bar.t >= (range.from as number) && bar.t < (range.to as number),
      ),
    }
  }

  const query: Query = {}
  if (['positions', 'orders', 'order-history', 'fills'].includes(command)) {
    const marketType = product(args['market-type'], command !== 'positions')
    if (command === 'positions' && marketType === 'spot')
      invalid('Injective positions support only --market-type perp')
    query.product = command === 'positions' ? 'perp' : marketType
    query.marketId = marketHash(args['market-id'])
    query.limit = limit(args.limit, 50)
    if (args.cursor !== undefined) {
      if (!args.cursor.length || args.cursor.length > 20000)
        invalid('--cursor must be an opaque value of at most 20000 characters')
      query.cursor = args.cursor
    }
    if (command === 'order-history' || command === 'fills') {
      const range = timeRange(args)
      if (
        range.from !== undefined &&
        range.to !== undefined &&
        range.to - range.from > 31 * 86_400_000
      )
        invalid('History time window must not exceed 31 days')
      Object.assign(query, range)
    }
  }
  const { instanceId } = resolveCredentials()
  const result = await get(
    `/v1/instances/${encodeURIComponent(instanceId)}/injective/${command}`,
    query,
  )
  if (
    (command === 'status' || command === 'account') &&
    (!record(result) || result.executionEnabled !== false || result.mode !== 'read_only')
  ) {
    throw new InjectiveCliError('Backend did not confirm Injective read-only mode.', {
      code: 'INJECTIVE_INVALID_RESPONSE',
      data: result,
    })
  }
  return result
}
