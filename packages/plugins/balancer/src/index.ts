import {
  ApiClientError,
  apiGet,
  apiPost,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'
import { parseChainId } from '@pieverseio/purr-core/shared'
import { chainNameToId, resolveToken } from '@pieverseio/purr-core/token-registry'

const SUPPORTED_PROTOCOLS = {
  1: [2, 3],
  10: [2, 3],
  137: [2],
  143: [3],
  8453: [2, 3],
  42161: [2, 3],
} as const

type SupportedChainId = keyof typeof SUPPORTED_PROTOCOLS
type ProtocolVersion = 2 | 3
type PoolType = 'standard' | 'boosted' | 'nested'
type AddKind = 'unbalanced' | 'proportional' | 'single_token_exact_bpt'
type RemoveKind = 'proportional' | 'single_token_exact_in' | 'unbalanced' | 'recovery'

interface ApiSuccess<T> {
  ok: true
  data: T
}

interface ApiErrorResponse {
  ok?: false
  error?: string
  code?: string
  reason?: string
  request_id?: string
  expires_at?: string
  [key: string]: unknown
}

type ApiResponse<T = unknown> = ApiSuccess<T> | ApiErrorResponse

interface TokenAmount {
  token: string
  amount: string
}

interface RawTokenAmount {
  token: string
  amountRaw: string
}

function requiredArg(args: Record<string, string>, name: string): string {
  const value = args[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required argument: --${name}`)
  }
  return value
}

function parseOptionalInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`Invalid --${name}: "${value}"`)
  return parsed
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Invalid --${name}: expected true or false`)
}

function parseEnum<T extends string>(
  value: string | undefined,
  name: string,
  values: readonly T[],
  fallback?: T,
): T | undefined {
  if (value === undefined) return fallback
  if ((values as readonly string[]).includes(value)) return value as T
  throw new Error(`Invalid --${name}: expected ${values.join(', ')}`)
}

function resolveChainId(args: Record<string, string>): SupportedChainId {
  let chainId: number | undefined
  if (args['chain-id']) {
    chainId = parseChainId(args['chain-id'])
  } else if (args.chain) {
    chainId = chainNameToId(args.chain)
    if (chainId === undefined) throw new Error(`Unknown --chain: ${args.chain}`)
  } else {
    throw new Error('Missing required argument: --chain or --chain-id')
  }

  if (!(chainId in SUPPORTED_PROTOCOLS)) {
    throw new Error(
      `Balancer supports chain IDs ${Object.keys(SUPPORTED_PROTOCOLS).join(', ')} in purr`,
    )
  }
  return chainId as SupportedChainId
}

function parseProtocolVersion(
  value: string | undefined,
  chainId: SupportedChainId,
  required = false,
): ProtocolVersion | undefined {
  if (value === undefined) {
    if (required) throw new Error('Missing required argument: --protocol-version')
    return undefined
  }
  const protocol = parseOptionalInteger(value, 'protocol-version')
  if (protocol !== 2 && protocol !== 3) {
    throw new Error('Invalid --protocol-version: expected 2 or 3')
  }
  const supported = SUPPORTED_PROTOCOLS[chainId] as readonly number[]
  if (!supported.includes(protocol)) {
    throw new Error(`Balancer chain ${chainId} supports protocol version ${supported.join(', ')}`)
  }
  return protocol
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

function resolvedTokens(value: string | undefined, chainId: SupportedChainId): string[] | undefined {
  return parseCsv(value)?.map((token) => resolveToken(token, chainId))
}

function parseTokenAmounts(
  value: string | undefined,
  name: string,
  chainId: SupportedChainId,
): TokenAmount[] | undefined {
  return parseCsv(value)?.map((item) => {
    const separator = item.lastIndexOf(':')
    if (separator <= 0 || separator === item.length - 1) {
      throw new Error(`Invalid --${name} item "${item}": expected TOKEN:AMOUNT`)
    }
    return {
      token: resolveToken(item.slice(0, separator), chainId),
      amount: item.slice(separator + 1),
    }
  })
}

function parseRawTokenAmounts(
  value: string | undefined,
  name: string,
  chainId: SupportedChainId,
): RawTokenAmount[] | undefined {
  return parseTokenAmounts(value, name, chainId)?.map(({ token, amount }) => ({
    token,
    amountRaw: amount,
  }))
}

function requireExecute(args: Record<string, string>): void {
  if (args.execute !== 'true') {
    throw new Error('Refusing to broadcast without explicit --execute')
  }
}

function addDefined(target: Record<string, unknown>, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) target[key] = value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function printApiError(error: ApiClientError): void {
  const body = isRecord(error.body)
    ? { ...error.body }
    : { ok: false, error: error.bodyText || error.message }
  const output: Record<string, unknown> = { ...body, http_status: error.status }
  if (error.retryAfter !== undefined) output.retry_after = error.retryAfter
  console.log(JSON.stringify(output))
  process.exitCode = 1
}

function printResult<T>(response: ApiResponse<T>, operation: string): void {
  if ('code' in response && response.code === 'POLICY_DEFERRED') {
    console.log(JSON.stringify(response))
    return
  }
  if (response.ok !== true) {
    console.log(
      JSON.stringify({
        ...response,
        error: response.error ?? response.reason ?? `Balancer ${operation} failed`,
      }),
    )
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(response.data))
}

async function requestAndPrint<T>(
  operation: string,
  request: () => Promise<ApiResponse<T>>,
): Promise<void> {
  try {
    printResult(await request(), operation)
  } catch (error) {
    if (error instanceof ApiClientError) {
      printApiError(error)
      return
    }
    throw error
  }
}

function instancePath(suffix: string): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${instanceId}/wallet/balancer${suffix}`
}

export function buildBalancerPoolsQuery(args: Record<string, string>): string {
  const chainId = resolveChainId(args)
  const protocolVersion = parseProtocolVersion(args['protocol-version'], chainId)
  const params = new URLSearchParams({ chainId: String(chainId) })
  const first = parseOptionalInteger(args.first, 'first')
  const minTvl = parseOptionalNumber(args['min-tvl'], 'min-tvl')
  const reviewedOnly = parseBoolean(args['reviewed-only'], 'reviewed-only')
  if (first !== undefined) params.set('first', String(first))
  if (minTvl !== undefined) params.set('minTvl', String(minTvl))
  if (args['order-by']) params.set('orderBy', args['order-by'])
  if (args['order-direction']) params.set('orderDirection', args['order-direction'])
  if (protocolVersion !== undefined) params.set('protocolVersion', String(protocolVersion))
  if (reviewedOnly !== undefined) params.set('reviewedOnly', String(reviewedOnly))
  const tokens = resolvedTokens(args.tokens, chainId)
  if (tokens) params.set('tokens', tokens.join(','))
  return params.toString()
}

export function buildBalancerSwapBody(
  args: Record<string, string>,
  execute: boolean,
): Record<string, unknown> {
  const chainId = resolveChainId(args)
  const kind = parseEnum(args.kind, 'kind', ['exact-in', 'exact-out'] as const, 'exact-in')
  const amount = requiredArg(args, 'amount')
  const body: Record<string, unknown> = {
    chainId,
    tokenIn: resolveToken(requiredArg(args, 'from'), chainId),
    tokenOut: resolveToken(requiredArg(args, 'to'), chainId),
    swapKind: kind === 'exact-out' ? 'exact_out' : 'exact_in',
    ...(kind === 'exact-out' ? { amountOut: amount } : { amountIn: amount }),
  }
  addDefined(body, {
    slippageBps: parseOptionalInteger(args['slippage-bps'], 'slippage-bps'),
    protocolVersion: parseProtocolVersion(args['protocol-version'], chainId),
    poolIds: parseCsv(args['pool-ids']),
  })
  if (execute) {
    if (args['min-amount-out'] !== undefined) body.minAmountOut = args['min-amount-out']
    if (args['max-amount-in'] !== undefined) body.maxAmountIn = args['max-amount-in']
    if (kind === 'exact-out' && args['max-amount-in'] === undefined) {
      throw new Error('Missing required argument: --max-amount-in')
    }
  }
  return body
}

export function buildBalancerAddBody(
  args: Record<string, string>,
  execute: boolean,
): Record<string, unknown> {
  const chainId = resolveChainId(args)
  const protocolVersion = parseProtocolVersion(
    args['protocol-version'],
    chainId,
    true,
  ) as ProtocolVersion
  const poolType = parseEnum(
    args['pool-type'],
    'pool-type',
    ['standard', 'boosted', 'nested'] as const,
    'standard',
  ) as PoolType
  const kind = parseEnum(
    args.kind,
    'kind',
    ['unbalanced', 'proportional', 'single-token-exact-bpt'] as const,
    'unbalanced',
  ) ?? 'unbalanced'
  const apiKind: AddKind =
    kind === 'single-token-exact-bpt' ? 'single_token_exact_bpt' : kind
  if ((poolType === 'boosted' || poolType === 'nested') && protocolVersion !== 3) {
    throw new Error(`Balancer ${poolType} liquidity requires protocol version 3`)
  }
  if (poolType === 'nested' && !([1, 8453, 42161] as number[]).includes(chainId)) {
    throw new Error('Balancer nested liquidity supports Ethereum, Base, and Arbitrum only')
  }
  if (poolType === 'nested' && apiKind !== 'unbalanced') {
    throw new Error('Balancer nested pools support unbalanced add only')
  }
  if (poolType === 'boosted' && apiKind === 'single_token_exact_bpt') {
    throw new Error('Balancer boosted pools do not support single-token exact-BPT add')
  }
  const amountsIn = parseTokenAmounts(args['amounts-in'], 'amounts-in', chainId)
  const referenceToken = args['reference-token']
    ? resolveToken(args['reference-token'], chainId)
    : undefined
  const tokenIn = args['token-in'] ? resolveToken(args['token-in'], chainId) : undefined
  const tokensIn = resolvedTokens(args['tokens-in'], chainId)
  if ((apiKind === 'unbalanced' || poolType === 'nested') && !amountsIn) {
    throw new Error('Missing required argument: --amounts-in')
  }
  if (apiKind === 'proportional' && (!referenceToken || !args['reference-amount'])) {
    throw new Error(
      'Proportional add requires --reference-token and --reference-amount',
    )
  }
  if (apiKind === 'single_token_exact_bpt' && (!tokenIn || !args['bpt-amount-out'])) {
    throw new Error('Single-token exact-BPT add requires --token-in and --bpt-amount-out')
  }
  if (poolType === 'boosted' && apiKind === 'proportional' && !tokensIn) {
    throw new Error('Boosted proportional add requires --tokens-in')
  }
  const body: Record<string, unknown> = {
    chainId,
    poolId: requiredArg(args, 'pool-id'),
    protocolVersion,
    poolType,
    kind: apiKind,
  }
  addDefined(body, {
    amountsIn,
    referenceToken,
    referenceAmount: args['reference-amount'],
    tokenIn,
    bptAmountOut: args['bpt-amount-out'],
    tokensIn,
    slippageBps: parseOptionalInteger(args['slippage-bps'], 'slippage-bps'),
  })
  if (execute) {
    if (
      (apiKind === 'unbalanced' || apiKind === 'proportional' || poolType === 'nested') &&
      args['min-bpt-out'] === undefined
    ) {
      throw new Error('Missing required argument: --min-bpt-out')
    }
    if (apiKind === 'proportional' && args['max-amounts-in'] === undefined) {
      throw new Error('Missing required argument: --max-amounts-in')
    }
    if (apiKind === 'single_token_exact_bpt' && args['max-amount-in'] === undefined) {
      throw new Error('Missing required argument: --max-amount-in')
    }
    addDefined(body, {
      minBptOut: args['min-bpt-out'],
      maxAmountsIn: parseRawTokenAmounts(args['max-amounts-in'], 'max-amounts-in', chainId),
      maxAmountIn: args['max-amount-in'],
    })
  }
  return body
}

export function buildBalancerRemoveBody(
  args: Record<string, string>,
  execute: boolean,
): Record<string, unknown> {
  const chainId = resolveChainId(args)
  const protocolVersion = parseProtocolVersion(
    args['protocol-version'],
    chainId,
    true,
  ) as ProtocolVersion
  const poolType = parseEnum(
    args['pool-type'],
    'pool-type',
    ['standard', 'boosted', 'nested'] as const,
    'standard',
  ) as PoolType
  const kind = parseEnum(
    args.kind,
    'kind',
    ['proportional', 'single-token', 'unbalanced', 'recovery'] as const,
    'proportional',
  ) ?? 'proportional'
  const apiKind: RemoveKind = kind === 'single-token' ? 'single_token_exact_in' : kind
  if ((poolType === 'boosted' || poolType === 'nested') && protocolVersion !== 3) {
    throw new Error(`Balancer ${poolType} liquidity requires protocol version 3`)
  }
  if (poolType === 'nested' && !([1, 8453, 42161] as number[]).includes(chainId)) {
    throw new Error('Balancer nested liquidity supports Ethereum, Base, and Arbitrum only')
  }
  if ((poolType === 'boosted' || poolType === 'nested') && apiKind !== 'proportional') {
    throw new Error(`Balancer ${poolType} pools support proportional remove only`)
  }
  if (apiKind === 'unbalanced' && protocolVersion !== 2) {
    throw new Error('Balancer unbalanced remove is supported only for protocol version 2')
  }
  const tokenOut = args['token-out'] ? resolveToken(args['token-out'], chainId) : undefined
  const amountsOut = parseTokenAmounts(args['amounts-out'], 'amounts-out', chainId)
  if (apiKind !== 'unbalanced' && !args['bpt-amount-in']) {
    throw new Error('Missing required argument: --bpt-amount-in')
  }
  if (apiKind === 'single_token_exact_in' && !tokenOut) {
    throw new Error('Missing required argument: --token-out')
  }
  if (apiKind === 'unbalanced' && !amountsOut) {
    throw new Error('Missing required argument: --amounts-out')
  }
  const body: Record<string, unknown> = {
    chainId,
    poolId: requiredArg(args, 'pool-id'),
    protocolVersion,
    poolType,
    kind: apiKind,
  }
  addDefined(body, {
    bptAmountIn: args['bpt-amount-in'],
    tokenOut,
    amountsOut,
    tokensOut: resolvedTokens(args['tokens-out'], chainId),
    slippageBps: parseOptionalInteger(args['slippage-bps'], 'slippage-bps'),
  })
  if (execute) {
    if (
      (apiKind === 'proportional' || apiKind === 'recovery') &&
      args['min-amounts-out'] === undefined
    ) {
      throw new Error('Missing required argument: --min-amounts-out')
    }
    if (apiKind === 'single_token_exact_in' && args['min-amount-out'] === undefined) {
      throw new Error('Missing required argument: --min-amount-out')
    }
    if (apiKind === 'unbalanced' && args['max-bpt-in'] === undefined) {
      throw new Error('Missing required argument: --max-bpt-in')
    }
    addDefined(body, {
      minAmountsOut: parseRawTokenAmounts(args['min-amounts-out'], 'min-amounts-out', chainId),
      minAmountOut: args['min-amount-out'],
      maxBptIn: args['max-bpt-in'],
    })
  }
  return body
}

export async function balancerPools(args: Record<string, string>): Promise<void> {
  const query = buildBalancerPoolsQuery(args)
  await requestAndPrint('pools query', () =>
    apiGet<ApiResponse<{ pools: unknown[] }>>(`${instancePath('/pools')}?${query}`),
  )
}

export async function balancerQuote(args: Record<string, string>): Promise<void> {
  await requestAndPrint('quote', () =>
    apiPost<ApiResponse>(instancePath('/quote'), buildBalancerSwapBody(args, false)),
  )
}

export async function balancerSwap(args: Record<string, string>): Promise<void> {
  requireExecute(args)
  await requestAndPrint('swap', () =>
    apiPost<ApiResponse>(instancePath('/swap'), buildBalancerSwapBody(args, true)),
  )
}

export async function balancerAddQuote(args: Record<string, string>): Promise<void> {
  await requestAndPrint('add liquidity quote', () =>
    apiPost<ApiResponse>(
      instancePath('/liquidity/add/quote'),
      buildBalancerAddBody(args, false),
    ),
  )
}

export async function balancerAdd(args: Record<string, string>): Promise<void> {
  requireExecute(args)
  await requestAndPrint('add liquidity', () =>
    apiPost<ApiResponse>(instancePath('/liquidity/add'), buildBalancerAddBody(args, true)),
  )
}

export async function balancerRemoveQuote(args: Record<string, string>): Promise<void> {
  await requestAndPrint('remove liquidity quote', () =>
    apiPost<ApiResponse>(
      instancePath('/liquidity/remove/quote'),
      buildBalancerRemoveBody(args, false),
    ),
  )
}

export async function balancerRemove(args: Record<string, string>): Promise<void> {
  requireExecute(args)
  await requestAndPrint('remove liquidity', () =>
    apiPost<ApiResponse>(instancePath('/liquidity/remove'), buildBalancerRemoveBody(args, true)),
  )
}

export function balancerHelp(): string {
  return `Usage: purr balancer <command> [options]

Commands:
  pools          Discover reviewed Balancer pools
  quote          Quote an exact-input or exact-output swap
  swap           Execute a swap (requires --execute)
  add-quote      Quote adding liquidity
  add            Add liquidity (requires --execute)
  remove-quote   Quote removing liquidity
  remove         Remove liquidity (requires --execute)

Common options:
  --chain <name> | --chain-id <id>
  --protocol-version <2|3>

Pool options:
  --tokens <TOKEN,TOKEN> [--first <1-50>] [--min-tvl <usd>]
  [--reviewed-only <true|false>] [--order-by <field>] [--order-direction <asc|desc>]

Swap options:
  --from <TOKEN> --to <TOKEN> --amount <decimal> [--kind <exact-in|exact-out>]
  [--slippage-bps <1-500>] [--pool-ids <id,id>]
  Execution: --execute
  Exact-input limit: [--min-amount-out <raw>]
  Exact-output limit: --max-amount-in <raw>

Add liquidity options:
  --pool-id <id> --pool-type <standard|boosted|nested>
  --kind <unbalanced|proportional|single-token-exact-bpt>
  Unbalanced: --amounts-in <TOKEN:DECIMAL,...>
  Proportional: --reference-token <TOKEN> --reference-amount <decimal>
  Boosted proportional: also --tokens-in <TOKEN,...>
  Single-token exact-BPT: --token-in <TOKEN> --bpt-amount-out <decimal>
  Execution limits: --min-bpt-out <raw>, --max-amounts-in <TOKEN:RAW,...>,
                    or --max-amount-in <raw>, plus --execute

Remove liquidity options:
  --pool-id <id> --pool-type <standard|boosted|nested>
  --kind <proportional|single-token|unbalanced|recovery>
  Proportional/recovery: --bpt-amount-in <decimal>
  Single-token: --bpt-amount-in <decimal> --token-out <TOKEN>
  Unbalanced V2: --amounts-out <TOKEN:DECIMAL,...>
  Boosted selection: --tokens-out <TOKEN,...>
  Execution limits: --min-amounts-out <TOKEN:RAW,...>, --min-amount-out <raw>,
                    or --max-bpt-in <raw>, plus --execute

Supported chains:
  ethereum, optimism, polygon, monad, base, arbitrum

Examples:
  purr balancer pools --chain base --tokens WETH,USDC --protocol-version 3
  purr balancer quote --chain base --from ETH --to USDC --amount 0.001 --kind exact-in
  purr balancer swap --chain base --from ETH --to USDC --amount 0.001 --kind exact-in --min-amount-out <raw> --execute
  purr balancer add-quote --chain base --pool-id 0x... --protocol-version 3 --kind unbalanced --amounts-in ETH:0.001
  purr balancer remove-quote --chain base --pool-id 0x... --protocol-version 3 --kind proportional --bpt-amount-in 0.001`
}
