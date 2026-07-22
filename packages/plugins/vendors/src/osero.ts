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
  error?: string
  code?: string
  message?: string
  data?: unknown
}

const OSERO_ACTIONS = ['mint-usds', 'mint-susds', 'redeem-usds', 'redeem-susds'] as const
type OseroAction = (typeof OSERO_ACTIONS)[number]

const CHAIN_ALIASES: Record<string, number> = {
  eth: 1,
  ethereum: 1,
  mainnet: 1,
  op: 10,
  optimism: 10,
  unichain: 130,
  uni: 130,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
}

export class OseroCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly data?: unknown
  readonly exitCode: number

  constructor(
    message: string,
    options: { code?: string; status?: number; data?: unknown; exitCode?: number } = {},
  ) {
    super(message)
    this.name = 'OseroCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
    this.exitCode = options.exitCode ?? 1
  }
}

export const OSERO_USAGE = `Usage: purr osero <command> [options]

Read commands:
  chains
  chain --chain-id <id> | --chain <alias>
  tokens --chain-id <id> | --chain <alias>
  contracts --chain-id <id> | --chain <alias>
  balances --chain-id <id> | --chain <alias>
  ssr --chain-id <id> | --chain <alias>
  apy --chain-id <id> | --chain <alias>

Action commands:
  preview --action <action> --amount <raw-units> (--chain-id <id> | --chain <alias>) [--receiver <address>] [--slippage-bps <bps>] [--referral-code <raw-int>]
  plan --action <action> --amount <raw-units> (--chain-id <id> | --chain <alias>) [--receiver <address>] [--slippage-bps <bps>] [--referral-code <raw-int>]
  execute --action <action> --amount <raw-units> (--chain-id <id> | --chain <alias>) [--receiver <address>] [--slippage-bps <bps>] [--referral-code <raw-int>]

Actions: mint-usds, mint-susds, redeem-usds, redeem-susds.
Chain aliases: ethereum, op, unichain, base, arbitrum.
Amounts are raw integer token units. Osero execution returns plan, per-step tx hashes, receipts, and finalHash.`

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

function toOseroError(error: unknown): Error {
  if (error instanceof OseroCliError) return error
  if (error instanceof ApiClientError) {
    const body = error.body as ApiErrorBody | undefined
    const message = extractErrorMessage(body) ?? error.message
    return new OseroCliError(message, {
      code: extractErrorCode(body),
      status: error.status,
      data: body?.data,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new OseroCliError(response.error ?? response.code ?? 'Osero request failed', {
      code: response.code,
    })
  }
  return response.data
}

function instancePath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}`
}

function oseroBasePath(): string {
  return `${instancePath()}/osero`
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

async function getOsero<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  try {
    const response = await apiGet<ApiEnvelope<T>>(appendQuery(`${oseroBasePath()}${path}`, params))
    return unwrap(response)
  } catch (error) {
    throw toOseroError(error)
  }
}

async function postOsero<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPost<ApiEnvelope<T>>(`${oseroBasePath()}${path}`, body)
    return unwrap(response)
  } catch (error) {
    throw toOseroError(error)
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

function parseChainIdValue(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function requireChainId(args: Record<string, string>): number {
  const chainId = arg(args, 'chain-id', 'chainId')
  const chain = args.chain
  if (chainId !== undefined && chain !== undefined) {
    throw new Error('Pass either --chain-id or --chain, not both')
  }
  if (chainId !== undefined) return parseChainIdValue(chainId, 'chain-id')
  if (chain !== undefined) {
    const alias = CHAIN_ALIASES[chain.trim().toLowerCase()]
    if (alias === undefined) {
      throw new Error(`Unknown --chain: ${chain}. Use: ${Object.keys(CHAIN_ALIASES).join(', ')}`)
    }
    return alias
  }
  throw new Error('Missing required argument: --chain-id')
}

function requireRawAmount(args: Record<string, string>): string {
  const amount = requireArg(args, 'amount')
  if (!/^\d+$/.test(amount)) {
    throw new Error(`Invalid --amount: "${amount}" - must be a raw integer string`)
  }
  if (BigInt(amount) <= 0n) {
    throw new Error('--amount must be greater than 0')
  }
  return amount
}

function parseOptionalInteger(
  args: Record<string, string>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function requireAction(args: Record<string, string>): OseroAction {
  const action = requireArg(args, 'action')
  if ((OSERO_ACTIONS as readonly string[]).includes(action)) return action as OseroAction
  throw new Error(`Invalid --action: "${action}". Use: ${OSERO_ACTIONS.join(', ')}`)
}

function actionBody(args: Record<string, string>): JsonRecord {
  const slippageBps = parseOptionalInteger(args, 'slippage-bps', 0, 10_000)
  const referralCode = arg(args, 'referral-code', 'referralCode')
  if (referralCode !== undefined && !/^\d+$/.test(referralCode)) {
    throw new Error(`Invalid --referral-code: "${referralCode}"`)
  }
  return {
    chainId: requireChainId(args),
    amount: requireRawAmount(args),
    ...(args.receiver === undefined ? {} : { receiver: args.receiver }),
    ...(slippageBps === undefined ? {} : { slippageBps }),
    ...(referralCode === undefined ? {} : { referralCode }),
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export function oseroHelp(): string {
  return OSERO_USAGE
}

export async function oseroCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(oseroHelp())
    return
  }

  switch (command) {
    case 'chains':
      printJson(await getOsero('/chains'))
      return
    case 'chain':
      printJson(await getOsero(`/chains/${requireChainId(args)}`))
      return
    case 'tokens':
    case 'contracts':
    case 'balances':
    case 'ssr':
    case 'apy':
      printJson(await getOsero(`/${command}`, { chainId: requireChainId(args) }))
      return
    case 'preview':
    case 'plan':
    case 'execute':
      printJson(await postOsero(`/${command}/${requireAction(args)}`, actionBody(args)))
      return
    default:
      throw new Error(
        `Unknown osero command: ${command}. Use: chains, chain, tokens, contracts, balances, ssr, apy, preview, plan, execute`,
      )
  }
}
