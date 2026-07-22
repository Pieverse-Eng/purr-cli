import {
  ApiClientError,
  apiGet,
  apiPost,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'

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
  retryAfterSeconds?: unknown
}

export class SkyInsightsCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly data?: unknown
  readonly exitCode: number
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    options: {
      code?: string
      status?: number
      data?: unknown
      exitCode?: number
      retryAfterSeconds?: number
    } = {},
  ) {
    super(message)
    this.name = 'SkyInsightsCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
    this.exitCode = options.exitCode ?? 1
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export const SKYINSIGHTS_USAGE = `Usage: purr skyinsights <command> [options]

Commands:
  kya-labels --chain <chain> --address <wallet>
  kya-risk --chain <chain> --address <wallet>
  kyt-risk --chain <chain> --tx-hash <hash>
  screening-submit --chain <chain> --address <wallet> [--rule-set-id <id>]
  screening-list [--limit <count>]
  screening-get --request-id <id>

Aliases:
  screenings        Alias for screening-list
  screening-result  Alias for screening-get

Calls /v1/instances/:id/security/skyinsights and prints the platform response data as JSON.`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
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

function extractRetryAfterSeconds(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined
  const err = nestedError(body)
  if (isRecord(err)) {
    return asNumber(err.retryAfterSeconds) ?? asNumber(err.retryAfter)
  }
  return asNumber(body.retryAfterSeconds) ?? asNumber(body.retryAfter)
}

function toSkyInsightsError(error: unknown): Error {
  if (error instanceof SkyInsightsCliError) return error
  if (error instanceof ApiClientError) {
    const body = error.body as ApiErrorBody | undefined
    const retryAfterSeconds = extractRetryAfterSeconds(body)
    const retryHint = retryAfterSeconds === undefined ? '' : ` (retry after ${retryAfterSeconds}s)`
    return new SkyInsightsCliError(`${extractErrorMessage(body) ?? error.message}${retryHint}`, {
      code: extractErrorCode(body),
      status: error.status,
      data: body?.data,
      retryAfterSeconds,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new SkyInsightsCliError(response.error ?? response.code ?? 'SkyInsights request failed', {
      code: response.code,
    })
  }
  return response.data
}

function instancePath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}`
}

function skyInsightsBasePath(): string {
  return `${instancePath()}/security/skyinsights`
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

async function getSkyInsights<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  try {
    const response = await apiGet<ApiEnvelope<T>>(
      appendQuery(`${skyInsightsBasePath()}${path}`, params),
    )
    return unwrap(response)
  } catch (error) {
    throw toSkyInsightsError(error)
  }
}

async function postSkyInsights<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPost<ApiEnvelope<T>>(`${skyInsightsBasePath()}${path}`, body)
    return unwrap(response)
  } catch (error) {
    throw toSkyInsightsError(error)
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

function parseInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid --${name}: "${value}"`)
  return parsed
}

function screeningBody(args: Record<string, string>): JsonRecord {
  const ruleSetId = arg(args, 'rule-set-id', 'ruleSetId')
  return {
    chain: requireArg(args, 'chain'),
    address: requireArg(args, 'address'),
    ...(ruleSetId === undefined ? {} : { ruleSetId }),
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export function skyInsightsHelp(): string {
  return SKYINSIGHTS_USAGE
}

export async function skyInsightsCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(skyInsightsHelp())
    return
  }

  switch (command) {
    case 'kya-labels':
      printJson(
        await getSkyInsights('/kya/labels', {
          chain: requireArg(args, 'chain'),
          address: requireArg(args, 'address'),
        }),
      )
      return

    case 'kya-risk':
      printJson(
        await getSkyInsights('/kya/risk', {
          chain: requireArg(args, 'chain'),
          address: requireArg(args, 'address'),
        }),
      )
      return

    case 'kyt-risk':
      printJson(
        await getSkyInsights('/kyt/risk', {
          chain: requireArg(args, 'chain'),
          txHash: requireArg(args, 'tx-hash', 'txHash'),
        }),
      )
      return

    case 'screening-submit':
      printJson(await postSkyInsights('/kya/screenings', screeningBody(args)))
      return

    case 'screening-list':
    case 'screenings':
      printJson(
        await getSkyInsights('/kya/screenings', {
          limit: parseInteger(args.limit, 'limit'),
        }),
      )
      return

    case 'screening-get':
    case 'screening-result':
      printJson(
        await getSkyInsights(
          `/kya/screenings/${encodeURIComponent(requireArg(args, 'request-id', 'requestId'))}`,
        ),
      )
      return

    default:
      throw new Error(`Unknown skyinsights command: ${command}. Run: purr skyinsights help`)
  }
}
