import {
  ApiClientError,
  apiGet,
  apiPost,
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
  error?: string
  code?: string
  message?: string
}

export class HyperliquidCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly exitCode: number

  constructor(
    message: string,
    options: { code?: string; status?: number; exitCode?: number } = {},
  ) {
    super(message)
    this.name = 'HyperliquidCliError'
    this.code = options.code
    this.status = options.status
    this.exitCode = options.exitCode ?? 1
  }
}

export const HYPERLIQUID_USAGE = `Usage: purr hyperliquid <command> [options]

Read commands:
  account
  abstraction
  symbol --coin <coin> [--dex <dex|default>]
  markets [--kind perp|spot|both] [--dex <dex>]
  prices [--dex <dex>]
  l2 --coin <coin> [--n-sig-figs <2-5>] [--mantissa 2|5]
  candles --coin <coin> --interval <interval> --start-time <ms> [--end-time <ms>]
  funding --coin <coin> --start-time <ms> [--end-time <ms>]
  state [--kind perp|spot|both] [--dex <dex>]
  orders [--kind open|frontend|historical] [--dex <dex>]
  fills [--start-time <ms>] [--end-time <ms>] [--aggregate-by-time true] [--reversed true]
  order-status --oid <oid-or-cloid>

Write commands:
  approve-builder-fee
  order --body-json <json> | --body-file <path>
  cancel --body-json <json> | --body-file <path>
  cancel-by-cloid --body-json <json> | --body-file <path>
  modify --body-json <json> | --body-file <path>
  update-leverage --asset <asset-id> --is-cross true|false --leverage <1-50>
  schedule-cancel [--time <ms>]
  set-abstraction --mode disabled|unifiedAccount|portfolioMargin
  usd-class-transfer --amount <amount> --to-perp true|false
  send-asset [--source-dex <dex>] --destination-dex <dex> --amount <amount>
  deposit --amount <amount>
  withdraw --amount <amount>

All commands call /v1/instances/:id/hyperliquid/* and use the platform mainnet TEE wallet.`

const ABSTRACTION_WRITE_MODES = ['disabled', 'unifiedAccount', 'portfolioMargin'] as const
type AbstractionWriteMode = (typeof ABSTRACTION_WRITE_MODES)[number]

function isAbstractionWriteMode(value: string): value is AbstractionWriteMode {
  return (ABSTRACTION_WRITE_MODES as readonly string[]).includes(value)
}

function requireAbstractionMode(args: Record<string, string>): AbstractionWriteMode {
  const value = requireArg(args, 'mode', 'abstraction')
  if (isAbstractionWriteMode(value)) return value
  throw new Error(
    `Invalid abstraction mode: "${value}". Expected one of: ${ABSTRACTION_WRITE_MODES.join(', ')}`,
  )
}

const BODY_WRITE_ENDPOINTS: Record<string, string> = {
  order: '/order',
  cancel: '/cancel',
  'cancel-by-cloid': '/cancel-by-cloid',
  modify: '/modify',
}

const CONVENIENCE_WRITE_ENDPOINTS: Record<string, string> = {
  'approve-builder-fee': '/builder-fee/approve',
  'update-leverage': '/update-leverage',
  'schedule-cancel': '/schedule-cancel',
  'set-abstraction': '/abstraction',
  'usd-class-transfer': '/usd-class-transfer',
  'send-asset': '/send-asset',
  deposit: '/deposit',
  withdraw: '/withdraw',
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

function toHyperliquidError(error: unknown): Error {
  if (error instanceof HyperliquidCliError) return error
  if (error instanceof ApiClientError) {
    const body = error.body as ApiErrorBody | undefined
    const message = extractErrorMessage(body) ?? error.message
    return new HyperliquidCliError(message, {
      code: extractErrorCode(body),
      status: error.status,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new HyperliquidCliError(response.error ?? response.code ?? 'Hyperliquid request failed', {
      code: response.code,
    })
  }
  return response.data
}

function basePath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}/hyperliquid`
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

async function getHyperliquid<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  try {
    const response = await apiGet<ApiEnvelope<T>>(appendQuery(`${basePath()}${path}`, params))
    return unwrap(response)
  } catch (error) {
    throw toHyperliquidError(error)
  }
}

async function postHyperliquid<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPost<ApiEnvelope<T>>(`${basePath()}${path}`, body)
    return unwrap(response)
  } catch (error) {
    throw toHyperliquidError(error)
  }
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

function requirePresentArg(
  args: Record<string, string>,
  name: string,
  ...aliases: string[]
): string {
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

function requireInteger(args: Record<string, string>, name: string, ...aliases: string[]): number {
  return parseInteger(requireArg(args, name, ...aliases), name) as number
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${value}"`)
}

function requireBoolean(args: Record<string, string>, name: string, ...aliases: string[]): boolean {
  return parseBoolean(requireArg(args, name, ...aliases), name) as boolean
}

function readBody(args: Record<string, string>): JsonRecord {
  if (args['body-json'] !== undefined && args['body-file'] !== undefined) {
    throw new Error('Pass either --body-json or --body-file, not both')
  }
  const raw = requireArgOrFile(args, 'body-json', 'body-file')
  return parseJsonCliArg<JsonRecord>(raw, args['body-file'] ? 'body-file' : 'body-json')
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function ensureMainnetOnly(args: Record<string, string>): void {
  if (args.network !== undefined) {
    throw new Error(
      'purr hyperliquid uses the platform mainnet endpoint; --network is not supported',
    )
  }
}

function readQueryArgs(command: string, args: Record<string, string>) {
  switch (command) {
    case 'account':
    case 'abstraction':
      return {}
    case 'symbol':
      return {
        coin: requireArg(args, 'coin'),
        dex: args.dex,
      }
    case 'markets':
    case 'state':
      return {
        kind: args.kind,
        dex: args.dex,
      }
    case 'prices':
      return {
        dex: args.dex,
      }
    case 'l2':
      return {
        coin: requireArg(args, 'coin'),
        nSigFigs: parseInteger(arg(args, 'n-sig-figs', 'nSigFigs'), 'n-sig-figs'),
        mantissa: parseInteger(args.mantissa, 'mantissa'),
      }
    case 'candles':
      return {
        coin: requireArg(args, 'coin'),
        interval: requireArg(args, 'interval'),
        startTime: requireInteger(args, 'start-time', 'startTime'),
        endTime: parseInteger(arg(args, 'end-time', 'endTime'), 'end-time'),
      }
    case 'funding':
      return {
        coin: requireArg(args, 'coin'),
        startTime: requireInteger(args, 'start-time', 'startTime'),
        endTime: parseInteger(arg(args, 'end-time', 'endTime'), 'end-time'),
      }
    case 'orders':
      return {
        kind: args.kind,
        dex: args.dex,
      }
    case 'fills': {
      const startTime = parseInteger(arg(args, 'start-time', 'startTime'), 'start-time')
      const endTime = parseInteger(arg(args, 'end-time', 'endTime'), 'end-time')
      const reversed = parseBoolean(args.reversed, 'reversed')
      if (startTime === undefined && endTime !== undefined) {
        throw new Error('--start-time is required when --end-time is provided')
      }
      if (startTime === undefined && reversed !== undefined) {
        throw new Error('--start-time is required when --reversed is provided')
      }
      return {
        startTime,
        endTime,
        aggregateByTime: parseBoolean(
          arg(args, 'aggregate-by-time', 'aggregateByTime'),
          'aggregate-by-time',
        ),
        reversed,
      }
    }
    case 'order-status':
      return {
        oid: requireArg(args, 'oid'),
      }
    default:
      throw new Error(`Unknown hyperliquid read command: ${command}`)
  }
}

function writeBody(command: string, args: Record<string, string>): JsonRecord {
  if (BODY_WRITE_ENDPOINTS[command]) return readBody(args)

  switch (command) {
    case 'approve-builder-fee':
      return {}
    case 'update-leverage':
      return {
        asset: requireInteger(args, 'asset'),
        isCross: requireBoolean(args, 'is-cross', 'isCross'),
        leverage: requireInteger(args, 'leverage'),
      }
    case 'schedule-cancel': {
      const time = parseInteger(args.time, 'time')
      return time === undefined ? {} : { time }
    }
    case 'set-abstraction':
      return {
        abstraction: requireAbstractionMode(args),
      }
    case 'usd-class-transfer':
      return {
        amount: requireArg(args, 'amount'),
        toPerp: requireBoolean(args, 'to-perp', 'toPerp'),
      }
    case 'send-asset':
      return {
        sourceDex: arg(args, 'source-dex', 'sourceDex') ?? '',
        destinationDex: requirePresentArg(args, 'destination-dex', 'destinationDex'),
        amount: requireArg(args, 'amount'),
      }
    case 'deposit':
    case 'withdraw':
      return {
        amount: requireArg(args, 'amount'),
      }
    default:
      throw new Error(`Unknown hyperliquid write command: ${command}`)
  }
}

function writeEndpoint(command: string): string | undefined {
  return BODY_WRITE_ENDPOINTS[command] ?? CONVENIENCE_WRITE_ENDPOINTS[command]
}

export function hyperliquidHelp(): string {
  return HYPERLIQUID_USAGE
}

export async function hyperliquidCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(hyperliquidHelp())
    return
  }

  ensureMainnetOnly(args)

  const readEndpoints: Record<string, string> = {
    account: '/account',
    abstraction: '/abstraction',
    symbol: '/symbol',
    markets: '/markets',
    prices: '/prices',
    l2: '/l2',
    candles: '/candles',
    funding: '/funding',
    state: '/state',
    orders: '/orders',
    fills: '/fills',
    'order-status': '/order-status',
  }

  if (readEndpoints[command]) {
    printJson(await getHyperliquid(readEndpoints[command], readQueryArgs(command, args)))
    return
  }

  const endpoint = writeEndpoint(command)
  if (endpoint) {
    printJson(await postHyperliquid(endpoint, writeBody(command, args)))
    return
  }

  throw new Error(`Unknown hyperliquid command: ${command}. Run: purr hyperliquid help`)
}
