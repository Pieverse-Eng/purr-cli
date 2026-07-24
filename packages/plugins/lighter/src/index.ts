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
  data?: unknown
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

export const LIGHTER_USAGE = `Usage: purr lighter <command> [options]

Integration commands:
  status
  enable
  disable

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
  markets [--market-id <id>] [--type perp|spot|all]
  market --market-id <id>
  order-books [--market-id <id>] [--type perp|spot|all]
  order-book-depth --market-id <id> [--limit <n>]
  recent-trades --market-id <id> [--limit <n>]
  trades [--market-id <id>] [--market-type perp|spot|all] [--limit <n>]
  candles --market-id <id> --resolution <value> --start-timestamp <unix> [--end-timestamp <unix>] [--count-back <n>]
  funding-rates [--market-id <id>] [--resolution <value>] [--start-timestamp <unix>] [--end-timestamp <unix>]
  account
  balances
  positions
  limits
  pnl [--resolution <value>] [--start-timestamp <unix>] [--end-timestamp <unix>] [--count-back <n>]
  api-keys
  orders
  active-orders
  inactive-orders
  transactions [--offset <n>] [--limit <n>]
  transaction --tx-hash <hash>
  l1-transaction --l1-tx-hash <hash>

Write commands:
  order-preview --body-json <json> | --body-file <path>
  reconcile-deposit --request-id <id>
  deposit --amount <amount> --source-chain-id <1|42161|8453|43114|999> [--route-type perps]
  order --market-id <id> --side buy|sell --size <amount> --price <price> [--type <type>] [--time-in-force ioc|gtt|postOnly]
  place-orders --market-id <id> --side buy|sell --size <amount> --price <price> [--type <type>] [--time-in-force ioc|gtt|postOnly]
  cancel --market-id <id> --order-index <id>
  cancel-all [--time-in-force immediate|scheduled|abortScheduled] [--time <unix-ms>]
  modify --market-id <id> --order-index <id> --size <amount> --price <price>
  update-leverage --market-id <id> (--leverage <n> | --initial-margin-fraction <n>) [--margin-mode cross|isolated]
  update-margin --market-id <id> --amount <amount> --direction add|remove
  withdraw --amount-base-units <integer> [--asset-index 3] [--route-type perps|spot]
  transfer --to-account-index <id> --amount-base-units <integer> [--asset-index 3] [--from-route-type perps|spot] [--to-route-type perps|spot]

Lighter read requests use a 20s client timeout. Write commands wait for the Platform response.`

const SIDE_EFFECT_WRITE_ENDPOINTS: Record<string, string> = {
  deposit: '/deposits',
  order: '/order',
  'place-orders': '/orders',
  cancel: '/cancel',
  'cancel-all': '/cancel-all',
  modify: '/modify',
  'update-leverage': '/update-leverage',
  'update-margin': '/update-margin',
  withdraw: '/withdraw',
  transfer: '/transfer',
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
  return asString(body.message) ?? asString(body.error)
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
      data: body?.data,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new LighterCliError(response.error ?? response.code ?? 'Lighter request failed', {
      code: response.code,
    })
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
  try {
    const response = await apiPost<ApiEnvelope<T>>(path, body)
    return unwrap(response)
  } catch (error) {
    throw toLighterError(error)
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

function requireSignedInteger(
  args: Record<string, string>,
  name: string,
  ...aliases: string[]
): number {
  return parseSignedInteger(requireArg(args, name, ...aliases), name) as number
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
        type: args.type,
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
        orderIndex: parseInteger(arg(args, 'order-index', 'orderIndex'), 'order-index'),
        sortBy: arg(args, 'sort-by', 'sortBy'),
        sortDir: arg(args, 'sort-dir', 'sortDir'),
        from: parseSignedInteger(args.from, 'from'),
        role: args.role,
        type: args.type,
        limit: parseInteger(args.limit, 'limit'),
        aggregate: parseBoolean(args.aggregate, 'aggregate'),
      }
    case 'candles':
      return {
        marketId: requireInteger(args, 'market-id', 'marketId'),
        resolution: requireArg(args, 'resolution'),
        startTimestamp: requireInteger(args, 'start-timestamp', 'startTimestamp'),
        endTimestamp: parseInteger(arg(args, 'end-timestamp', 'endTimestamp'), 'end-timestamp'),
        countBack: parseInteger(arg(args, 'count-back', 'countBack'), 'count-back'),
      }
    case 'funding-rates':
      return {
        marketId: parseInteger(arg(args, 'market-id', 'marketId'), 'market-id'),
        resolution: args.resolution,
        startTimestamp: parseInteger(
          arg(args, 'start-timestamp', 'startTimestamp'),
          'start-timestamp',
        ),
        endTimestamp: parseInteger(arg(args, 'end-timestamp', 'endTimestamp'), 'end-timestamp'),
      }
    case 'pnl':
      return {
        resolution: args.resolution,
        startTimestamp: parseInteger(
          arg(args, 'start-timestamp', 'startTimestamp'),
          'start-timestamp',
        ),
        endTimestamp: parseInteger(arg(args, 'end-timestamp', 'endTimestamp'), 'end-timestamp'),
        countBack: parseInteger(arg(args, 'count-back', 'countBack'), 'count-back'),
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
    'api-keys': '/api-keys',
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
        orderExpiry: parseSignedInteger(arg(args, 'order-expiry', 'orderExpiry'), 'order-expiry'),
        priceProtection,
      })
    case 'cancel':
      return compact({
        marketId: requireInteger(args, 'market-id', 'marketId'),
        orderIndex: requireInteger(args, 'order-index', 'orderIndex'),
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
        orderIndex: requireInteger(args, 'order-index', 'orderIndex'),
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
      return compact({
        assetIndex: parseInteger(arg(args, 'asset-index', 'assetIndex'), 'asset-index'),
        routeType: arg(args, 'route-type', 'routeType'),
        amountBaseUnits: requireInteger(args, 'amount-base-units', 'amountBaseUnits'),
        priceProtection,
      })
    case 'transfer':
      return compact({
        toAccountIndex: requireSignedInteger(args, 'to-account-index', 'toAccountIndex'),
        assetIndex: parseInteger(arg(args, 'asset-index', 'assetIndex'), 'asset-index'),
        fromRouteType: arg(args, 'from-route-type', 'fromRouteType'),
        toRouteType: arg(args, 'to-route-type', 'toRouteType'),
        amountBaseUnits: requireInteger(args, 'amount-base-units', 'amountBaseUnits'),
        usdcFeeBaseUnits: parseInteger(
          arg(args, 'usdc-fee-base-units', 'usdcFeeBaseUnits'),
          'usdc-fee-base-units',
        ),
        memo: args.memo,
        priceProtection,
      })
    default:
      throw new Error(`Unknown lighter write command: ${command}`)
  }
}

export function lighterHelp(): string {
  return LIGHTER_USAGE
}

export async function lighterCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
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

  const endpoint = readEndpoint(command, args)
  if (endpoint) {
    printJson(await getLighter(endpoint, readQueryArgs(command, args)))
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
    printJson(await postLighter(writeEndpoint, writeBody(command, args)))
    return
  }

  throw new Error(`Unknown lighter command: ${command}. Run: purr lighter help`)
}
