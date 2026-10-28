import {
  ApiClientError,
  apiGet,
  apiPost,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'
import { readFileSync, statSync } from 'node:fs'

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
Read commands do not broadcast. Trading is backend-gated and the Agent wallet pays INJ gas.

Native perpetual trading (local drafts until --execute true):
  readiness --market-id <hash>
  management --market-id <hash>
  order --market-id <hash> --kind limit|market --side buy|sell --quantity <decimal> --price <worst-or-limit> --margin <USDC> --max-fee-inj <decimal> [--review-file <json>]
  cancel --market-id <hash> --order-hash <hash> --max-fee-inj <decimal>
  close --market-id <hash> --side buy|sell --quantity <decimal> --price <worst> --max-fee-inj <decimal> [--review-file <json>]
  protection --market-id <hash> --quantity <decimal> --review-file <json> --max-fee-inj <decimal> [--stop-loss-kind market|limit --stop-loss-trigger <price> --stop-loss-price <price>] [--take-profit-kind market|limit --take-profit-trigger <price> --take-profit-price <price>]
  replace --market-id <hash> --order-hash <hash> --quantity <decimal> --price <price> --margin <decimal> --reduce-only true|false --review-file <json> --max-fee-inj <decimal>
  cancel-batch --market-id <hash> --review-file <json> --max-fee-inj <decimal>
  margin --market-id <hash> --direction add|remove --amount <USDC> --review-file <json> --max-fee-inj <decimal>
  request --request-id <original-id-or-key> [--by id|idempotency-key]
  funding [--market-id <hash>] [--start-at <rfc3339> --end-at <rfc3339>] [--limit <n>] [--cursor <opaque>]

RFQ (same native position and execution journal):
  rfq authorization --market-id <hash>
  rfq preview --market-id <hash> --direction long|short --quantity <decimal> --margin <decimal> --worst-price <price> --wallet-generation <hash>
  rfq setup --market-id <hash> --permissions <comma-separated-type-URLs> --expires-at <unix-seconds> --acknowledge-broad-authority true --authorization-state-hash <hash> --max-fee-inj <decimal>
  rfq revoke --market-id <hash> --permissions <comma-separated-type-URLs> --authorization-state-hash <hash> --max-fee-inj <decimal>
  rfq accept --market-id <hash> --bundle-file <json> --intent open|reduce --maximum-settlement-fee <USDC> --review-file <json> --authorization-state-hash <hash> --max-fee-inj <decimal>

Every execution additionally requires --wallet-generation <hash> --idempotency-key <original-key> --execute true.
Review JSON contains stateHash and an explicit cancelOrderHashes array; no implicit cancel-all.
Bundle JSON is the preview's settlement object, preserving original signed decimal strings.
Generic RFQ authorization has broad bank/exchange authority; finite expiry is not a spending cap.
Unknown outcomes: query request with the original key; never retry with a new key or quote.
Positions/orders/order-history/fills accept --view accounting-v1 for qualified accounting facts.`

export function injectiveHelp(): string {
  return USAGE
}

const MARKET_OPTIONS = ['market-id', 'market-type']
const PAGE_OPTIONS = [...MARKET_OPTIONS, 'limit', 'cursor', 'view']
const WRITE_COMMON = ['market-id', 'max-fee-inj', 'wallet-generation', 'idempotency-key', 'execute']
const RFQ_COMMON = [...WRITE_COMMON, 'authorization-state-hash']
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
  funding: [...PAGE_OPTIONS.filter((name) => name !== 'view'), 'start-at', 'end-at'],
  readiness: ['market-id'],
  management: ['market-id'],
  request: ['request-id', 'by'],
  order: [...WRITE_COMMON, 'kind', 'side', 'quantity', 'price', 'margin', 'review-file'],
  cancel: [...WRITE_COMMON, 'order-hash'],
  close: [...WRITE_COMMON, 'side', 'quantity', 'price', 'review-file'],
  protection: [
    ...WRITE_COMMON,
    'quantity',
    'review-file',
    'stop-loss-kind',
    'stop-loss-trigger',
    'stop-loss-price',
    'take-profit-kind',
    'take-profit-trigger',
    'take-profit-price',
  ],
  replace: [
    ...WRITE_COMMON,
    'order-hash',
    'quantity',
    'price',
    'margin',
    'reduce-only',
    'review-file',
  ],
  'cancel-batch': [...WRITE_COMMON, 'review-file'],
  margin: [...WRITE_COMMON, 'direction', 'amount', 'review-file'],
  'rfq/authorization': ['market-id'],
  'rfq/preview': [
    'market-id',
    'direction',
    'quantity',
    'margin',
    'worst-price',
    'wallet-generation',
  ],
  'rfq/setup': [...RFQ_COMMON, 'permissions', 'expires-at', 'acknowledge-broad-authority'],
  'rfq/revoke': [...RFQ_COMMON, 'permissions'],
  'rfq/accept': [...RFQ_COMMON, 'bundle-file', 'intent', 'maximum-settlement-fee', 'review-file'],
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
  if (!value || !/^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value))
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
  const fields = {
    ...(typeof error.reason === 'string' ? { reason: error.reason } : {}),
    ...((typeof error.retryAfterMs === 'number' &&
      Number.isFinite(error.retryAfterMs) &&
      error.retryAfterMs >= 0) ||
    error.retryAfterMs === null
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  }
  const structured = Object.keys(fields).length
    ? { ...(record(detail) ? detail : detail === undefined ? {} : { details: detail }), ...fields }
    : detail
  const data =
    retryAfter === undefined
      ? structured
      : { ...(record(structured) ? structured : { details: structured }), retryAfter }
  if (status === 404 && (!code || code === 'NOT_FOUND' || code === 'ROUTE_NOT_FOUND')) {
    return new InjectiveCliError(
      'Injective capability unavailable on this backend. Upgrade the platform backend to enable this Injective API.',
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
      keepalive: false,
    })
    if (
      record(response) &&
      response.code === 'POLICY_DEFERRED' &&
      typeof response.reason === 'string'
    )
      return response
    if (!record(response) || response.ok !== true || response.data === undefined)
      throw backendError(response)
    return response.data
  } catch (error) {
    if (error instanceof ApiClientError) {
      const failure = backendError(error.body, error.status, error.retryAfter)
      if (path === CATALOG_PATH && error.status === 400 && failure.code === 'INVALID_QUERY')
        throw new InjectiveCliError(
          'This backend does not accept the Injective catalog query. Upgrade the platform backend to enable Injective read APIs.',
          { code: 'INJECTIVE_CAPABILITY_UNAVAILABLE', status: error.status, data: failure.data },
        )
      throw failure
    }
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new InjectiveCliError('Injective backend request timed out after 20s.', {
        code: 'INJECTIVE_REQUEST_TIMEOUT',
      })
    }
    throw error
  }
}

const CATALOG_PATH = '/v1/market-data/reference/terminal/instruments'

function required(args: Record<string, string>, name: string): string {
  return args[name] || invalid(`Missing --${name}`)
}
function choice(args: Record<string, string>, name: string, values: readonly string[]): string {
  const value = required(args, name)
  if (!values.includes(value)) invalid(`--${name} must be ${values.join(' or ')}`)
  return value
}
function amount(args: Record<string, string>, name: string, zero = false): string {
  const value = required(args, name)
  if (!/^(?:0|[1-9]\d{0,31})(?:\.\d{0,17}[1-9])?(?![\s\S])/.test(value) || (!zero && value === '0'))
    invalid(
      `--${name} must be an exact ${zero ? 'nonnegative' : 'positive'} decimal without trailing zeros`,
    )
  return value
}
function hexBinding(args: Record<string, string>, name: string): string {
  const value = required(args, name)
  if (!/^[a-f0-9]{64}(?![\s\S])/.test(value)) invalid(`--${name} must be the reviewed 64-hex value`)
  return value
}
function jsonFile(args: Record<string, string>, name: string): JsonRecord {
  try {
    const path = required(args, name),
      stat = statSync(path)
    if (!stat.isFile() || stat.size > 60000)
      invalid(`--${name} requires a JSON file of at most 60000 bytes`)
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!record(value)) invalid(`--${name} requires a JSON object`)
    return value
  } catch (cause) {
    if (cause instanceof InjectiveCliError) throw cause
    return invalid(`Cannot read valid JSON from --${name}`)
  }
}
function reviewed(args: Record<string, string>): JsonRecord {
  const value = jsonFile(args, 'review-file')
  if (
    Object.keys(value).some((key) => !['stateHash', 'cancelOrderHashes'].includes(key)) ||
    typeof value.stateHash !== 'string' ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(value.stateHash) ||
    !Array.isArray(value.cancelOrderHashes) ||
    value.cancelOrderHashes.length > 32 ||
    value.cancelOrderHashes.some(
      (hash) => typeof hash !== 'string' || !/^0x[0-9a-f]{64}(?![\s\S])/.test(hash),
    ) ||
    new Set(value.cancelOrderHashes).size !== value.cancelOrderHashes.length
  )
    invalid('Review must contain the current stateHash and explicit unique cancelOrderHashes only')
  return value
}
function businessBody(command: string, args: Record<string, string>): JsonRecord {
  const body: JsonRecord = {
    marketId: marketHash(args['market-id'], true)?.toLowerCase(),
    maxFeeInj: amount(args, 'max-fee-inj'),
  }
  if (args['review-file'] !== undefined) body.review = reviewed(args)
  if (
    ['protection', 'replace', 'cancel-batch', 'margin', 'rfq/accept'].includes(command) &&
    body.review === undefined
  )
    invalid(
      'This operation requires --review-file with the current native state and explicit cancellation scope',
    )
  if (['order', 'close', 'replace', 'protection'].includes(command))
    body.quantity = amount(args, 'quantity')
  if (['order', 'close', 'replace'].includes(command)) body.price = amount(args, 'price')
  if (['order', 'close'].includes(command)) body.side = choice(args, 'side', ['buy', 'sell'])
  if (command === 'order') {
    body.kind = choice(args, 'kind', ['limit', 'market'])
    body.margin = amount(args, 'margin')
  }
  if (['cancel', 'replace'].includes(command))
    body.orderHash = marketHash(required(args, 'order-hash'), true)?.toLowerCase()
  if (command === 'replace') {
    body.margin = amount(args, 'margin', true)
    body.reduceOnly = choice(args, 'reduce-only', ['true', 'false']) === 'true'
  }
  if (command === 'protection') {
    for (const [flag, key] of [
      ['stop-loss', 'stopLoss'],
      ['take-profit', 'takeProfit'],
    ] as const) {
      if (['kind', 'trigger', 'price'].some((part) => args[`${flag}-${part}`] !== undefined))
        body[key] = {
          kind: choice(args, `${flag}-kind`, ['market', 'limit']),
          triggerPrice: amount(args, `${flag}-trigger`),
          price: amount(args, `${flag}-price`),
        }
    }
    if (!body.stopLoss && !body.takeProfit) invalid('Provide a stop loss or take profit')
  }
  if (command === 'margin') {
    body.direction = choice(args, 'direction', ['add', 'remove'])
    body.amount = amount(args, 'amount')
  }
  if (command.startsWith('rfq/'))
    body.authorizationStateHash = hexBinding(args, 'authorization-state-hash')
  if (['rfq/setup', 'rfq/revoke'].includes(command)) {
    const allowed = [
      '/cosmos.bank.v1beta1.MsgSend',
      '/injective.exchange.v2.MsgPrivilegedExecuteContract',
      '/injective.exchange.v2.MsgBatchUpdateOrders',
      '/injective.exchange.v2.MsgCreateDerivativeMarketOrder',
    ]
    const permissions = required(args, 'permissions').split(',')
    if (
      !permissions.length ||
      permissions.some((value) => !allowed.includes(value)) ||
      new Set(permissions).size !== permissions.length
    )
      invalid('Provide unique official RFQ permission type URLs')
    body.permissions = permissions
    if (command === 'rfq/setup') {
      const expires = required(args, 'expires-at')
      if (
        !/^[1-9]\d{0,15}(?![\s\S])/.test(expires) ||
        BigInt(expires) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        invalid('--expires-at must be finite Unix seconds')
      body.expiresAt = expires
      if (args['acknowledge-broad-authority'] !== 'true')
        invalid('RFQ setup requires --acknowledge-broad-authority true')
      body.acknowledgeBroadAuthority = true
    }
  }
  if (command === 'rfq/accept') {
    const bundle = jsonFile(args, 'bundle-file')
    if (
      Object.keys(bundle).some((key) => !['request', 'quotes'].includes(key)) ||
      !record(bundle.request) ||
      !Array.isArray(bundle.quotes) ||
      !bundle.quotes.length ||
      bundle.quotes.length > 25
    )
      invalid('--bundle-file must contain the original preview settlement request and quotes')
    body.bundle = bundle
    body.intent = choice(args, 'intent', ['open', 'reduce'])
    body.maximumSettlementFee = amount(args, 'maximum-settlement-fee', true)
  }
  return body
}
async function postBusiness(
  operation: string,
  body: JsonRecord,
  args: Record<string, string>,
  execution: boolean,
): Promise<unknown> {
  const generation = hexBinding(args, 'wallet-generation')
  const key = execution ? required(args, 'idempotency-key') : undefined
  if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(key))
    invalid('Invalid --idempotency-key')
  const { instanceId } = resolveCredentials()
  const recovery =
    key === undefined
      ? undefined
      : {
          originalKey: key,
          command: `purr injective request --request-id ${key} --by idempotency-key`,
        }
  try {
    const response = await apiPost<unknown>(
      `/v1/instances/${encodeURIComponent(instanceId)}/injective/${operation}`,
      body,
      {
        headers: {
          'X-Terminal-Connection-Version': generation,
          ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        },
        timeoutMs: 20000,
        keepalive: false,
        redirect: 'error',
      },
    )
    if (
      record(response) &&
      response.code === 'POLICY_DEFERRED' &&
      typeof response.reason === 'string'
    )
      return response
    if (!record(response) || response.ok !== true || response.data === undefined)
      throw backendError(response)
    return response.data
  } catch (cause) {
    if (cause instanceof ApiClientError) {
      const failure = backendError(cause.body, cause.status, cause.retryAfter)
      throw new InjectiveCliError(failure.message, {
        code: failure.code,
        status: failure.status,
        data: {
          ...(record(failure.data) ? failure.data : { details: failure.data }),
          ...(recovery ? { recovery } : {}),
        },
      })
    }
    if (cause instanceof InjectiveCliError) throw cause
    throw new InjectiveCliError(
      execution
        ? 'Execution response unavailable. Query the original request; do not submit a replacement.'
        : 'RFQ preview unavailable.',
      {
        code: execution ? 'INJECTIVE_OUTCOME_UNKNOWN' : 'INJECTIVE_REQUEST_TIMEOUT',
        data: recovery ? { recovery } : undefined,
      },
    )
  }
}

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
  if (catalog.data === null) {
    // An exact miss has no observation clock. Prove absence from a fresh complete
    // product catalog; missing[] alone is not authority when coverage is unknown.
    if (Array.isArray(catalog.missing) && catalog.missing.includes(id)) {
      const full = await get(CATALOG_PATH, {
        venue: 'injective',
        environment: 'mainnet',
        product: marketType,
      })
      if (
        record(full) &&
        record(full.identity) &&
        full.identity.venue === 'injective' &&
        full.identity.environment === 'mainnet' &&
        Array.isArray(full.data) &&
        record(full.meta) &&
        full.meta.status === 'fresh' &&
        full.meta.completeness === 'complete' &&
        !full.data.some(
          (item) => record(item) && (item.id === id || item.nativeMarketId === marketId),
        )
      )
        throw new InjectiveCliError(
          'Exact native Injective market not found. Query markets and use its native hash and product.',
          { code: 'MARKET_NOT_FOUND', data: catalog },
        )
    }
    throw new InjectiveCliError('Injective market catalog is unavailable.', {
      code: 'INJECTIVE_SOURCE_UNAVAILABLE',
      data: catalog,
    })
  }
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
  let [command = 'help', ...rest] = argv
  if (command === 'rfq') {
    const [action, ...options] = rest
    if (!action || ['help', '--help', '-h'].includes(action)) return injectiveHelp()
    command = `rfq/${action}`
    rest = options
  }
  if (['help', '--help', '-h'].includes(command)) {
    parseOptions(rest, [])
    return injectiveHelp()
  }
  if (!Object.hasOwn(OPTIONS, command)) {
    throw new InjectiveCliError(
      `Unsupported Injective command: ${command}. Use purr injective --help.`,
      { code: 'INJECTIVE_INVALID_ARGUMENT' },
    )
  }
  const args = parseOptions(rest, OPTIONS[command])
  if (args.help) return injectiveHelp()

  if (['readiness', 'management', 'rfq/authorization', 'request'].includes(command)) {
    const { instanceId } = resolveCredentials()
    const prefix = `/v1/instances/${encodeURIComponent(instanceId)}/injective/`
    if (command === 'request') {
      const id = required(args, 'request-id')
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) invalid('Invalid original request reference')
      if (args.by !== undefined && !['id', 'idempotency-key'].includes(args.by))
        invalid('--by must be id or idempotency-key')
      return get(prefix + `requests/${encodeURIComponent(id)}`, {
        by: args.by === 'idempotency-key' ? args.by : undefined,
      })
    }
    return get(prefix + (command === 'rfq/authorization' ? 'rfq-authorization' : command), {
      marketId: marketHash(args['market-id'], true)?.toLowerCase(),
    })
  }
  if (command === 'rfq/preview') {
    const body = {
      marketId: marketHash(args['market-id'], true)?.toLowerCase(),
      direction: choice(args, 'direction', ['long', 'short']),
      quantity: amount(args, 'quantity'),
      margin: amount(args, 'margin', true),
      worstPrice: amount(args, 'worst-price'),
    }
    return postBusiness('rfq/preview', body, args, false)
  }
  if (WRITE_COMMON.every((option) => OPTIONS[command].includes(option))) {
    const body = businessBody(command, args)
    if (args.execute !== undefined && !['true', 'false'].includes(args.execute))
      invalid('--execute must be true or false')
    const operation = command.replace('rfq/', 'rfq-')
    if (args.execute !== 'true') return { executionEnabled: false, operation, body }
    return postBusiness(operation, body, args, true)
  }

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
  if (['positions', 'orders', 'order-history', 'fills', 'funding'].includes(command)) {
    const marketType = product(args['market-type'], !['positions', 'funding'].includes(command))
    if (['positions', 'funding'].includes(command) && marketType === 'spot')
      invalid('Injective positions support only --market-type perp')
    query.product = ['positions', 'funding'].includes(command) ? 'perp' : marketType
    if (args.view !== undefined) {
      if (args.view !== 'accounting-v1') invalid('--view must be accounting-v1')
      query.view = args.view
    }
    query.marketId = marketHash(args['market-id'])
    query.limit = limit(args.limit, 50)
    if (args.cursor !== undefined) {
      if (!args.cursor.length || args.cursor.length > 20000)
        invalid('--cursor must be an opaque value of at most 20000 characters')
      query.cursor = args.cursor
    }
    if (['order-history', 'fills', 'funding'].includes(command)) {
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
    (!record(result) ||
      typeof result.executionEnabled !== 'boolean' ||
      typeof result.mode !== 'string')
  ) {
    throw new InjectiveCliError('Invalid Injective account capability response.', {
      code: 'INJECTIVE_INVALID_RESPONSE',
      data: result,
    })
  }
  return result
}
