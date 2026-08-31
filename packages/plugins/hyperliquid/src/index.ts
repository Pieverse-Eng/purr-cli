import {
  ApiClientError,
  apiGet,
  apiPost,
  apiPut,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'

type JsonRecord = Record<string, unknown>

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info'
const HYPERLIQUID_PUBLIC_REQUEST_TIMEOUT_MS = 10_000

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

interface PublicPerpAsset {
  name: string
  szDecimals: number
  maxLeverage?: number
  isDelisted?: boolean
}

interface PublicPerpMeta {
  universe: PublicPerpAsset[]
}

interface PublicPerpDex {
  name: string
  assetToStreamingOiCap: Array<[string, string]>
}

interface PublicSpotToken {
  index: number
  name: string
  fullName?: string
  szDecimals: number
}

interface PublicSpotMarket {
  index: number
  name: string
  tokens: [number, number]
}

interface PublicSpotMeta {
  tokens: PublicSpotToken[]
  universe: PublicSpotMarket[]
}

interface PublicSymbolResolution {
  network: 'mainnet'
  inputCoin: string
  coin: string
  assetId: number
  szDecimals: number
  dex?: string
  spotPairId?: string
}

interface PublicPerpAnnotation {
  category?: string
  description?: string
  displayName?: string
  keywords?: string[]
}

type PublicAllPerpMetas = PublicPerpMeta[]

interface PublicPerpSearchCandidate {
  kind: 'perp'
  symbol: string
  dex: string
  assetId: number
  szDecimals: number
  maxLeverage?: number
  active: boolean
  score: number
  matchedFields: string[]
}

interface PublicSpotSearchCandidate {
  kind: 'spot'
  symbol: string
  pairId: string
  assetId: number
  base: string
  baseFullName?: string
  quote: string
  szDecimals: number
  active: true
  score: number
  matchedFields: string[]
}

type PublicMarketSearchCandidate = PublicPerpSearchCandidate | PublicSpotSearchCandidate

const HYPERLIQUID_SEARCH_RESULT_LIMIT = 10

export class HyperliquidCliError extends Error {
  readonly code?: string
  readonly status?: number
  readonly data?: unknown
  readonly exitCode: number

  constructor(
    message: string,
    options: { code?: string; status?: number; data?: unknown; exitCode?: number } = {},
  ) {
    super(message)
    this.name = 'HyperliquidCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
    this.exitCode = options.exitCode ?? 1
  }
}

export const HYPERLIQUID_USAGE = `Usage: purr hyperliquid <command> [options]

Read commands:
  status
  snapshot
  account
  abstraction
  builder-fee-status
  search --query <company-or-asset>
  symbol --coin <coin> [--dex <dex|default>]
  markets [--kind perp|spot|both] [--dex <dex>]
  prices [--dex <dex>]
  l2 --coin <coin> [--n-sig-figs <2-5>] [--mantissa 2|5]  # --mantissa requires --n-sig-figs 5
  candles --coin <coin> --interval <interval> --start-time <ms> [--end-time <ms>]
  funding --coin <coin> --start-time <ms> [--end-time <ms>]
  state [--kind perp|spot|both] [--dex <dex>]
  orders [--kind open|frontend|historical] [--dex <dex>]
  fills [--start-time <ms>] [--end-time <ms>] [--aggregate-by-time true] [--reversed true]
  order-status --oid <oid-or-cloid>
  withdraw-status --nonce <nonce>

Write commands:
  enable
  disable
  approve-builder-fee
  limit-order --asset <id> --side buy|sell --size <amount> --price <price> --tif Gtc|Ioc|Alo|FrontendMarket --reduce-only true|false [--cloid <cloid>]
  bracket-order --asset <id> --side buy|sell --size <amount> --entry-price <price> --entry-tif Gtc|Ioc|Alo|FrontendMarket --take-profit-price <price> --stop-loss-price <price> --execution market|limit [--take-profit-worst-price <price>] [--stop-loss-worst-price <price>] [--take-profit-limit-price <price>] [--stop-loss-limit-price <price>] [--cloid <cloid>]
  stop-loss --asset <id> --position-side long|short --size <amount> --trigger-price <price> --execution market|limit [--worst-price <price>] [--limit-price <price>] [--cloid <cloid>]
  take-profit --asset <id> --position-side long|short --size <amount> --trigger-price <price> --execution market|limit [--worst-price <price>] [--limit-price <price>] [--cloid <cloid>]
  protect-position --asset <id> --position-side long|short --size <amount> --take-profit-price <price> --stop-loss-price <price> --execution market --take-profit-worst-price <price> --stop-loss-worst-price <price>
  modify-limit-order --oid <oid-or-cloid> --asset <id> --side buy|sell --size <amount> --price <price> --tif Gtc|Ioc|Alo|FrontendMarket --reduce-only true|false [--always-place true] [--cloid <cloid>]
  modify-stop-loss --oid <oid-or-cloid> --asset <id> --position-side long|short --size <amount> --trigger-price <price> --execution market|limit --always-place true [--worst-price <price>] [--limit-price <price>] [--cloid <cloid>]
  modify-take-profit --oid <oid-or-cloid> --asset <id> --position-side long|short --size <amount> --trigger-price <price> --execution market|limit --always-place true [--worst-price <price>] [--limit-price <price>] [--cloid <cloid>]
  cancel --asset <id> --oid <oid>
  cancel-by-cloid --asset <id> --cloid <cloid>
  update-leverage --asset <asset-id> --is-cross true|false --leverage <1-50>
  schedule-cancel [--time <ms>]
  set-abstraction --mode disabled|unifiedAccount|portfolioMargin
  usd-class-transfer --amount <amount> --to-perp true|false
  send-asset [--source-dex <dex>] --destination-dex <dex> --amount <amount>
  deposit --amount <amount>
  withdraw --amount <amount>

Search, symbol resolution, markets, and candles call Hyperliquid's public mainnet Info API without wallet credentials.
Trading integration and all other exchange commands use the platform mainnet TEE wallet.

Market TP/SL requires an explicit worst price: below the trigger when closing long, above the
trigger when closing short. Limit TP/SL requires the corresponding limit-price option instead.`

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

const PARAMETER_WRITE_ENDPOINTS: Record<string, string> = {
  'limit-order': '/order',
  'bracket-order': '/order',
  'stop-loss': '/order',
  'take-profit': '/order',
  'protect-position': '/order',
  'modify-limit-order': '/modify',
  'modify-stop-loss': '/modify',
  'modify-take-profit': '/modify',
  cancel: '/cancel',
  'cancel-by-cloid': '/cancel-by-cloid',
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

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  status: [],
  'trading-status': [],
  'integration-status': [],
  snapshot: [],
  account: [],
  abstraction: [],
  'builder-fee-status': [],
  search: ['query'],
  symbol: ['coin', 'dex'],
  markets: ['kind', 'dex'],
  prices: ['dex'],
  l2: ['coin', 'n-sig-figs', 'nSigFigs', 'mantissa'],
  candles: ['coin', 'interval', 'start-time', 'startTime', 'end-time', 'endTime'],
  funding: ['coin', 'start-time', 'startTime', 'end-time', 'endTime'],
  state: ['kind', 'dex'],
  orders: ['kind', 'dex'],
  fills: [
    'start-time',
    'startTime',
    'end-time',
    'endTime',
    'aggregate-by-time',
    'aggregateByTime',
    'reversed',
  ],
  'order-status': ['oid'],
  'withdraw-status': ['nonce'],
  enable: [],
  'enable-trading': [],
  disable: [],
  'disable-trading': [],
  'approve-builder-fee': [],
  'limit-order': ['asset', 'side', 'size', 'price', 'tif', 'reduce-only', 'cloid'],
  'bracket-order': [
    'asset',
    'side',
    'size',
    'entry-price',
    'entry-tif',
    'take-profit-price',
    'stop-loss-price',
    'execution',
    'take-profit-worst-price',
    'stop-loss-worst-price',
    'take-profit-limit-price',
    'stop-loss-limit-price',
    'cloid',
  ],
  'stop-loss': [
    'asset',
    'position-side',
    'size',
    'trigger-price',
    'execution',
    'worst-price',
    'limit-price',
    'cloid',
  ],
  'take-profit': [
    'asset',
    'position-side',
    'size',
    'trigger-price',
    'execution',
    'worst-price',
    'limit-price',
    'cloid',
  ],
  'protect-position': [
    'asset',
    'position-side',
    'size',
    'take-profit-price',
    'stop-loss-price',
    'execution',
    'take-profit-worst-price',
    'stop-loss-worst-price',
  ],
  'modify-limit-order': [
    'oid',
    'asset',
    'side',
    'size',
    'price',
    'tif',
    'reduce-only',
    'always-place',
    'cloid',
  ],
  'modify-stop-loss': [
    'oid',
    'asset',
    'position-side',
    'size',
    'trigger-price',
    'execution',
    'worst-price',
    'limit-price',
    'always-place',
    'cloid',
  ],
  'modify-take-profit': [
    'oid',
    'asset',
    'position-side',
    'size',
    'trigger-price',
    'execution',
    'worst-price',
    'limit-price',
    'always-place',
    'cloid',
  ],
  cancel: ['asset', 'oid'],
  'cancel-by-cloid': ['asset', 'cloid'],
  'update-leverage': ['asset', 'is-cross', 'isCross', 'leverage'],
  'schedule-cancel': ['time'],
  'set-abstraction': ['mode', 'abstraction'],
  'usd-class-transfer': ['amount', 'to-perp', 'toPerp'],
  'send-asset': ['source-dex', 'sourceDex', 'destination-dex', 'destinationDex', 'amount'],
  deposit: ['amount'],
  withdraw: ['amount'],
}

const LIMIT_TIFS = ['Gtc', 'Ioc', 'Alo', 'FrontendMarket'] as const
const ORDER_SIDES = ['buy', 'sell'] as const
const POSITION_SIDES = ['long', 'short'] as const
const TRIGGER_EXECUTIONS = ['market', 'limit'] as const

const REMOVED_WRITE_COMMANDS: Record<string, string> = {
  order:
    'purr hyperliquid order was removed. Use limit-order, bracket-order, stop-loss, take-profit, or protect-position',
  modify:
    'purr hyperliquid modify was removed. Use modify-limit-order, modify-stop-loss, or modify-take-profit',
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
      data: body?.data,
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

function instancePath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}`
}

function hyperliquidBasePath(): string {
  return `${instancePath()}/hyperliquid`
}

function hyperliquidTradingIntegrationPath(): string {
  return `${instancePath()}/integrations/hyperliquid-trading`
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
  try {
    const response = await apiGet<ApiEnvelope<T>>(appendQuery(path, params))
    return unwrap(response)
  } catch (error) {
    throw toHyperliquidError(error)
  }
}

async function postEnvelope<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPost<ApiEnvelope<T>>(path, body)
    return unwrap(response)
  } catch (error) {
    throw toHyperliquidError(error)
  }
}

async function putEnvelope<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  try {
    const response = await apiPut<ApiEnvelope<T>>(path, body)
    return unwrap(response)
  } catch (error) {
    throw toHyperliquidError(error)
  }
}

async function getHyperliquid<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  return getEnvelope(`${hyperliquidBasePath()}${path}`, params)
}

async function postHyperliquidInfo<T = unknown>(body: JsonRecord): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HYPERLIQUID_PUBLIC_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = (await response.json()) as unknown
    if (!response.ok) {
      throw new HyperliquidCliError(`Hyperliquid public API returned HTTP ${response.status}`, {
        status: response.status,
        data,
      })
    }
    return data as T
  } catch (error) {
    if (error instanceof HyperliquidCliError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HyperliquidCliError('Hyperliquid public API request timed out', {
        code: 'HYPERLIQUID_REQUEST_TIMEOUT',
      })
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timeout)
  }
}

async function getPublicHyperliquidMarkets(
  params: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  const kind = params.kind ?? 'both'
  if (!['perp', 'spot', 'both'].includes(String(kind))) {
    throw new Error(`Invalid --kind: "${String(kind)}"`)
  }
  const perpRequest = {
    type: 'metaAndAssetCtxs',
    ...(params.dex === undefined ? {} : { dex: params.dex }),
  }
  if (kind === 'perp') return postHyperliquidInfo(perpRequest)
  if (kind === 'spot') return postHyperliquidInfo({ type: 'spotMetaAndAssetCtxs' })
  return {
    perp: await postHyperliquidInfo(perpRequest),
    spot: await postHyperliquidInfo({ type: 'spotMetaAndAssetCtxs' }),
  }
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

function searchFieldScore(query: string, value: string): number {
  const candidate = normalizeSearchText(value)
  if (!candidate) return 0
  if (candidate === query) return 100
  if (candidate.startsWith(query)) return 85
  if (candidate.includes(query)) return 75
  return 0
}

function searchFieldsScore(
  query: string,
  fields: Array<[string, string | undefined]>,
): { score: number; matchedFields: string[] } {
  let score = 0
  const matchedFields = new Set<string>()
  for (const [field, value] of fields) {
    if (!value) continue
    const fieldScore = searchFieldScore(query, value)
    if (fieldScore > 0) matchedFields.add(field)
    score = Math.max(score, fieldScore)
  }
  return { score, matchedFields: [...matchedFields] }
}

function buildPerpSearchCandidates(
  query: string,
  perpDexs: Array<PublicPerpDex | null>,
  allPerpMetas: PublicAllPerpMetas,
): PublicPerpSearchCandidate[] {
  const candidates: PublicPerpSearchCandidate[] = []
  for (const [dexIndex, meta] of allPerpMetas.entries()) {
    const dex = dexIndex === 0 ? 'default' : perpDexs[dexIndex]?.name
    if (!dex) continue
    for (const [universeIndex, asset] of meta.universe.entries()) {
      const match = searchFieldsScore(query, [
        ['symbol', asset.name],
        ['symbol', symbolBareName(asset.name)],
      ])
      if (match.score === 0) continue
      candidates.push({
        kind: 'perp',
        symbol: asset.name,
        dex,
        assetId: dexIndex === 0 ? universeIndex : 100_000 + dexIndex * 10_000 + universeIndex,
        szDecimals: asset.szDecimals,
        ...(asset.maxLeverage === undefined ? {} : { maxLeverage: asset.maxLeverage }),
        active: asset.isDelisted !== true,
        ...match,
      })
    }
  }
  return candidates
}

function buildSpotSearchCandidates(
  query: string,
  spotMeta: PublicSpotMeta,
): PublicSpotSearchCandidate[] {
  const tokens = new Map(spotMeta.tokens.map((token) => [token.index, token]))
  const candidates: PublicSpotSearchCandidate[] = []
  for (const market of spotMeta.universe) {
    const base = tokens.get(market.tokens[0])
    const quote = tokens.get(market.tokens[1])
    if (!base || !quote) continue
    const symbol = `${base.name}/${quote.name}`
    const match = searchFieldsScore(query, [
      ['symbol', market.name],
      ['symbol', symbol],
      ['base', base.name],
      ['quote', quote.name],
    ])
    if (match.score === 0) continue
    candidates.push({
      kind: 'spot',
      symbol,
      pairId: market.name,
      assetId: 10_000 + market.index,
      base: base.name,
      ...(base.fullName ? { baseFullName: base.fullName } : {}),
      quote: quote.name,
      szDecimals: base.szDecimals,
      active: true,
      ...match,
    })
  }
  return candidates
}

async function searchPublicHyperliquidMarkets(queryValue: string): Promise<unknown> {
  if (queryValue.length > 200) throw new Error('--query must contain at most 200 characters')
  const query = normalizeSearchText(queryValue)
  if (!query) throw new Error('--query must not be empty')

  const [perpDexs, allPerpMetas, spotMeta] = await Promise.all([
    postHyperliquidInfo<Array<PublicPerpDex | null>>({ type: 'perpDexs' }),
    postHyperliquidInfo<PublicAllPerpMetas>({ type: 'allPerpMetas' }),
    postHyperliquidInfo<PublicSpotMeta>({ type: 'spotMeta' }),
  ])
  const candidates: PublicMarketSearchCandidate[] = [
    ...buildPerpSearchCandidates(query, perpDexs, allPerpMetas),
    ...buildSpotSearchCandidates(query, spotMeta),
  ]
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      Number(right.active) - Number(left.active) ||
      left.symbol.localeCompare(right.symbol),
  )
  const selected = candidates.slice(0, HYPERLIQUID_SEARCH_RESULT_LIMIT)

  if (selected.length === 0) return { network: 'mainnet', query: queryValue, matches: [] }

  const detailedAnnotations = new Map<string, PublicPerpAnnotation | null>()
  await Promise.all(
    selected.map(async (candidate) => {
      if (candidate.kind !== 'perp') return
      detailedAnnotations.set(
        candidate.symbol,
        await postHyperliquidInfo<PublicPerpAnnotation | null>({
          type: 'perpAnnotation',
          coin: candidate.symbol,
        }),
      )
    }),
  )

  return {
    network: 'mainnet',
    query: queryValue,
    matches: selected.map((candidate) => {
      if (candidate.kind === 'spot') return candidate
      const annotation = detailedAnnotations.get(candidate.symbol)
      return {
        ...candidate,
        ...(annotation?.category ? { category: annotation.category } : {}),
        ...(annotation?.displayName ? { displayName: annotation.displayName } : {}),
        ...(annotation?.keywords ? { keywords: annotation.keywords } : {}),
        ...(annotation?.description ? { description: annotation.description } : {}),
      }
    }),
  }
}

function symbolDexName(coin: string): string | undefined {
  const separator = coin.indexOf(':')
  if (separator <= 0) return undefined
  return coin.slice(0, separator)
}

function symbolBareName(coin: string): string {
  const separator = coin.indexOf(':')
  if (separator <= 0) return coin
  return coin.slice(separator + 1)
}

function publicPerpCandidate(
  inputCoin: string,
  coin: string,
  meta: PublicPerpMeta,
  offset: number,
  dex?: string,
): PublicSymbolResolution | null {
  const index = meta.universe.findIndex((asset) => asset.name === coin)
  if (index < 0) return null
  const asset = meta.universe[index]
  return {
    network: 'mainnet',
    inputCoin,
    coin,
    assetId: offset + index,
    szDecimals: asset.szDecimals,
    ...(dex ? { dex } : {}),
  }
}

function publicSpotCandidate(
  inputCoin: string,
  spotMeta: PublicSpotMeta,
): PublicSymbolResolution | null {
  const tokens = new Map(spotMeta.tokens.map((token) => [token.index, token]))
  for (const market of spotMeta.universe) {
    const base = tokens.get(market.tokens[0])
    const quote = tokens.get(market.tokens[1])
    if (!base || !quote || `${base.name}/${quote.name}` !== inputCoin) continue
    return {
      network: 'mainnet',
      inputCoin,
      coin: inputCoin,
      assetId: 10_000 + market.index,
      szDecimals: base.szDecimals,
      spotPairId: market.name,
    }
  }
  return null
}

function publicSymbolError(
  code: string,
  message: string,
  status: number,
  data: JsonRecord,
): HyperliquidCliError {
  return new HyperliquidCliError(message, { code, status, data })
}

async function getPublicHyperliquidSymbol(
  params: Record<string, string | number | boolean | undefined>,
): Promise<PublicSymbolResolution> {
  const inputCoin = String(params.coin)
  const requestedDex = params.dex === undefined ? undefined : String(params.dex)
  const embeddedDex = symbolDexName(inputCoin)
  if (embeddedDex === 'default') {
    throw publicSymbolError(
      'HYPERLIQUID_SYMBOL_INVALID',
      'default is a selector; use dex=default',
      400,
      { coin: inputCoin },
    )
  }
  if (requestedDex && embeddedDex && requestedDex !== embeddedDex) {
    throw publicSymbolError(
      'HYPERLIQUID_SYMBOL_DEX_MISMATCH',
      'coin dex prefix does not match dex query parameter',
      400,
      { coin: inputCoin, dex: requestedDex },
    )
  }

  const selectedDex = requestedDex ?? embeddedDex
  const resolvedCoin =
    selectedDex && selectedDex !== 'default' && !embeddedDex
      ? `${selectedDex}:${inputCoin}`
      : selectedDex === 'default'
        ? symbolBareName(inputCoin)
        : inputCoin

  if (selectedDex === 'default') {
    const meta = await postHyperliquidInfo<PublicPerpMeta>({ type: 'meta' })
    const candidate = publicPerpCandidate(inputCoin, resolvedCoin, meta, 0, selectedDex)
    if (candidate) return candidate
    throw publicSymbolError(
      'HYPERLIQUID_SYMBOL_NOT_FOUND',
      `Hyperliquid symbol was not found: ${inputCoin}`,
      404,
      { coin: inputCoin, dex: selectedDex, resolvedCoin },
    )
  }

  const perpDexs = await postHyperliquidInfo<Array<PublicPerpDex | null>>({ type: 'perpDexs' })
  if (selectedDex) {
    const dexIndex = perpDexs.findIndex((dex) => dex?.name === selectedDex)
    if (dexIndex > 0) {
      const meta = await postHyperliquidInfo<PublicPerpMeta>({ type: 'meta', dex: selectedDex })
      const candidate = publicPerpCandidate(
        inputCoin,
        resolvedCoin,
        meta,
        100_000 + dexIndex * 10_000,
        selectedDex,
      )
      if (candidate) return candidate
    }
    throw publicSymbolError(
      'HYPERLIQUID_SYMBOL_NOT_FOUND',
      `Hyperliquid symbol was not found: ${inputCoin}`,
      404,
      { coin: inputCoin, dex: selectedDex, resolvedCoin },
    )
  }

  const [defaultMeta, spotMeta] = await Promise.all([
    postHyperliquidInfo<PublicPerpMeta>({ type: 'meta' }),
    postHyperliquidInfo<PublicSpotMeta>({ type: 'spotMeta' }),
  ])
  const candidates: PublicSymbolResolution[] = []
  const defaultCandidate = publicPerpCandidate(
    inputCoin,
    inputCoin,
    defaultMeta,
    0,
    defaultMeta.universe.some((asset) => asset.name === inputCoin) ? 'default' : undefined,
  )
  if (defaultCandidate) candidates.push(defaultCandidate)
  const spotCandidate = publicSpotCandidate(inputCoin, spotMeta)
  if (spotCandidate) candidates.push(spotCandidate)

  const matchingDexs = perpDexs
    .map((dex, index) => ({ dex, index }))
    .filter(
      (entry): entry is { dex: PublicPerpDex; index: number } =>
        entry.index > 0 &&
        entry.dex !== null &&
        entry.dex.assetToStreamingOiCap.some(([asset]) => symbolBareName(asset) === inputCoin),
    )
  const builderMetas = await Promise.all(
    matchingDexs.map(async ({ dex, index }) => ({
      dex,
      index,
      meta: await postHyperliquidInfo<PublicPerpMeta>({ type: 'meta', dex: dex.name }),
    })),
  )
  for (const { dex, index, meta } of builderMetas) {
    const coin = `${dex.name}:${inputCoin}`
    const candidate = publicPerpCandidate(inputCoin, coin, meta, 100_000 + index * 10_000, dex.name)
    if (candidate) candidates.push(candidate)
  }

  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw publicSymbolError(
      'HYPERLIQUID_SYMBOL_AMBIGUOUS',
      `Hyperliquid symbol is ambiguous: ${inputCoin}`,
      409,
      { coin: inputCoin, candidates },
    )
  }
  throw publicSymbolError(
    'HYPERLIQUID_SYMBOL_NOT_FOUND',
    `Hyperliquid symbol was not found: ${inputCoin}`,
    404,
    { coin: inputCoin },
  )
}

async function getPublicHyperliquidCandles(
  params: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  return postHyperliquidInfo<unknown>({
    type: 'candleSnapshot',
    req: {
      coin: params.coin,
      interval: params.interval,
      startTime: params.startTime,
      ...(params.endTime === undefined ? {} : { endTime: params.endTime }),
    },
  })
}

async function postHyperliquid<T = unknown>(path: string, body: JsonRecord): Promise<T> {
  return postEnvelope(`${hyperliquidBasePath()}${path}`, body)
}

async function getHyperliquidTradingIntegration<T = unknown>(path = ''): Promise<T> {
  return getEnvelope(`${hyperliquidTradingIntegrationPath()}${path}`)
}

async function setHyperliquidTradingIntegration<T = unknown>(enabled: boolean): Promise<T> {
  return putEnvelope(hyperliquidTradingIntegrationPath(), { enabled })
}

function arg(args: Record<string, string>, ...names: string[]): string | undefined {
  const provided = names.filter((name) => args[name] !== undefined)
  if (provided.length > 1) {
    throw new Error(`Pass only one of: ${provided.map((name) => `--${name}`).join(', ')}`)
  }
  return provided[0] === undefined ? undefined : args[provided[0]]
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

function optionalAlwaysPlace(args: Record<string, string>): true | undefined {
  const value = args['always-place']
  if (value === undefined) return undefined
  if (parseBoolean(value, 'always-place') !== true) {
    throw new Error('Invalid --always-place: expected true; false is not supported')
  }
  return true
}

function assertKnownOptions(command: string, args: Record<string, string>): void {
  const allowed = COMMAND_OPTIONS[command]
  if (!allowed) return
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(args)
    .filter((name) => !allowedSet.has(name))
    .sort()
  if (unknown.length === 0) return

  const rendered = unknown.map((name) => `--${name}`).join(', ')
  if (allowed.length === 0) {
    throw new Error(
      `Unknown option${unknown.length === 1 ? '' : 's'} for purr hyperliquid ${command}: ${rendered}. This command does not accept options.`,
    )
  }
  throw new Error(
    `Unknown option${unknown.length === 1 ? '' : 's'} for purr hyperliquid ${command}: ${rendered}. Allowed options: ${allowed.map((name) => `--${name}`).join(', ')}`,
  )
}

function requireChoice<const T extends readonly string[]>(
  args: Record<string, string>,
  name: string,
  choices: T,
): T[number] {
  const value = requireArg(args, name)
  if ((choices as readonly string[]).includes(value)) return value as T[number]
  throw new Error(`Invalid --${name}: "${value}". Expected one of: ${choices.join(', ')}`)
}

function requirePositiveDecimal(args: Record<string, string>, name: string): string {
  const value = requireArg(args, name)
  if (!/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new Error(`Invalid --${name}: "${value}". Expected a positive decimal`)
  }
  return value
}

function optionalCloid(args: Record<string, string>): string | undefined {
  const value = args.cloid
  if (value === undefined) return undefined
  if (!/^0x[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error(`Invalid --cloid: "${value}". Expected 0x followed by 32 hex characters`)
  }
  return value.toLowerCase()
}

function requireCloid(args: Record<string, string>): string {
  requireArg(args, 'cloid')
  return optionalCloid(args) as string
}

function requireOrderRef(args: Record<string, string>): number | string {
  const value = requireArg(args, 'oid')
  if (/^0x[0-9a-fA-F]{32}$/.test(value)) return value.toLowerCase()
  const parsed = parseInteger(value, 'oid')
  if (parsed !== undefined) return parsed
  throw new Error(`Invalid --oid: "${value}"`)
}

function comparePositiveDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ''] = left.split('.')
  const [rightWhole, rightFraction = ''] = right.split('.')
  const scale = Math.max(leftFraction.length, rightFraction.length)
  const leftScaled = BigInt(`${leftWhole}${leftFraction.padEnd(scale, '0')}`)
  const rightScaled = BigInt(`${rightWhole}${rightFraction.padEnd(scale, '0')}`)
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0
}

function withCloid(order: JsonRecord, cloid: string | undefined): JsonRecord {
  return cloid === undefined ? order : { ...order, c: cloid }
}

function assertProtectionPriceOrder(
  positionSide: (typeof POSITION_SIDES)[number],
  takeProfitPrice: string,
  stopLossPrice: string,
): void {
  const comparison = comparePositiveDecimals(takeProfitPrice, stopLossPrice)
  if (positionSide === 'long' && comparison <= 0) {
    throw new Error(
      '--take-profit-price must be greater than --stop-loss-price for a long position',
    )
  }
  if (positionSide === 'short' && comparison >= 0) {
    throw new Error('--take-profit-price must be less than --stop-loss-price for a short position')
  }
}

function resolveTriggerOrderPrice(
  args: Record<string, string>,
  execution: (typeof TRIGGER_EXECUTIONS)[number],
  positionSide: (typeof POSITION_SIDES)[number],
  triggerPrice: string,
  triggerPriceName: string,
  worstPriceName: string,
  limitPriceName: string,
): string {
  const suppliedWorstPrice = args[worstPriceName]
  const suppliedLimitPrice = args[limitPriceName]

  if (execution === 'market') {
    if (suppliedLimitPrice !== undefined) {
      throw new Error(`--${limitPriceName} is not allowed when --execution is market`)
    }
    if (suppliedWorstPrice === undefined) {
      throw new Error(`--${worstPriceName} is required when --execution is market`)
    }

    const worstPrice = requirePositiveDecimal(args, worstPriceName)
    const comparison = comparePositiveDecimals(worstPrice, triggerPrice)
    if (positionSide === 'long' && comparison >= 0) {
      throw new Error(
        `--${worstPriceName} must be less than --${triggerPriceName} when closing a long position`,
      )
    }
    if (positionSide === 'short' && comparison <= 0) {
      throw new Error(
        `--${worstPriceName} must be greater than --${triggerPriceName} when closing a short position`,
      )
    }
    return worstPrice
  }

  if (suppliedWorstPrice !== undefined) {
    throw new Error(`--${worstPriceName} is not allowed when --execution is limit`)
  }
  if (suppliedLimitPrice === undefined) {
    throw new Error(`--${limitPriceName} is required when --execution is limit`)
  }
  return requirePositiveDecimal(args, limitPriceName)
}

function buildLimitOrder(args: Record<string, string>): JsonRecord {
  const side = requireChoice(args, 'side', ORDER_SIDES)
  const tif = requireChoice(args, 'tif', LIMIT_TIFS)
  return withCloid(
    {
      a: requireInteger(args, 'asset'),
      b: side === 'buy',
      p: requirePositiveDecimal(args, 'price'),
      s: requirePositiveDecimal(args, 'size'),
      r: requireBoolean(args, 'reduce-only'),
      t: { limit: { tif } },
    },
    optionalCloid(args),
  )
}

function buildTriggerOrder(args: Record<string, string>, tpsl: 'tp' | 'sl'): JsonRecord {
  const positionSide = requireChoice(args, 'position-side', POSITION_SIDES)
  const execution = requireChoice(args, 'execution', TRIGGER_EXECUTIONS)
  const asset = requireInteger(args, 'asset')
  const size = requirePositiveDecimal(args, 'size')
  const triggerPrice = requirePositiveDecimal(args, 'trigger-price')
  const orderPrice = resolveTriggerOrderPrice(
    args,
    execution,
    positionSide,
    triggerPrice,
    'trigger-price',
    'worst-price',
    'limit-price',
  )

  return withCloid(
    {
      a: asset,
      b: positionSide === 'short',
      p: orderPrice,
      s: size,
      r: true,
      t: {
        trigger: {
          isMarket: execution === 'market',
          triggerPx: triggerPrice,
          tpsl,
        },
      },
    },
    optionalCloid(args),
  )
}

function buildModifyLimitBody(args: Record<string, string>): JsonRecord {
  const tif = requireChoice(args, 'tif', LIMIT_TIFS)
  const order = buildLimitOrder(args)
  const alwaysPlace = optionalAlwaysPlace(args)
  if ((tif === 'Ioc' || tif === 'FrontendMarket') && alwaysPlace !== true) {
    throw new Error(`--always-place true is required when modifying an order with --tif ${tif}`)
  }
  return {
    oid: requireOrderRef(args),
    order,
    ...(alwaysPlace === true ? { a: true } : {}),
  }
}

function buildModifyTriggerBody(args: Record<string, string>, tpsl: 'tp' | 'sl'): JsonRecord {
  const order = buildTriggerOrder(args, tpsl)
  const alwaysPlace = optionalAlwaysPlace(args)
  if (alwaysPlace !== true) {
    throw new Error('--always-place true is required when modifying a trigger order')
  }
  return {
    oid: requireOrderRef(args),
    order,
    a: true,
  }
}

function buildBracketBody(args: Record<string, string>): JsonRecord {
  const side = requireChoice(args, 'side', ORDER_SIDES)
  const execution = requireChoice(args, 'execution', TRIGGER_EXECUTIONS)
  const asset = requireInteger(args, 'asset')
  const size = requirePositiveDecimal(args, 'size')
  const entryPrice = requirePositiveDecimal(args, 'entry-price')
  const entryTif = requireChoice(args, 'entry-tif', LIMIT_TIFS)
  const takeProfitPrice = requirePositiveDecimal(args, 'take-profit-price')
  const stopLossPrice = requirePositiveDecimal(args, 'stop-loss-price')
  const positionSide = side === 'buy' ? 'long' : 'short'
  assertProtectionPriceOrder(positionSide, takeProfitPrice, stopLossPrice)
  const takeProfitOrderPrice = resolveTriggerOrderPrice(
    args,
    execution,
    positionSide,
    takeProfitPrice,
    'take-profit-price',
    'take-profit-worst-price',
    'take-profit-limit-price',
  )
  const stopLossOrderPrice = resolveTriggerOrderPrice(
    args,
    execution,
    positionSide,
    stopLossPrice,
    'stop-loss-price',
    'stop-loss-worst-price',
    'stop-loss-limit-price',
  )

  const entryOrder = withCloid(
    {
      a: asset,
      b: side === 'buy',
      p: entryPrice,
      s: size,
      r: false,
      t: { limit: { tif: entryTif } },
    },
    optionalCloid(args),
  )
  const closeIsBuy = side === 'sell'
  const triggerOrder = (
    triggerPrice: string,
    orderPrice: string,
    tpsl: 'tp' | 'sl',
  ): JsonRecord => ({
    a: asset,
    b: closeIsBuy,
    p: orderPrice,
    s: size,
    r: true,
    t: {
      trigger: {
        isMarket: execution === 'market',
        triggerPx: triggerPrice,
        tpsl,
      },
    },
  })

  return {
    orders: [
      entryOrder,
      triggerOrder(takeProfitPrice, takeProfitOrderPrice, 'tp'),
      triggerOrder(stopLossPrice, stopLossOrderPrice, 'sl'),
    ],
    grouping: 'normalTpsl',
  }
}

function buildProtectionBody(args: Record<string, string>): JsonRecord {
  const positionSide = requireChoice(args, 'position-side', POSITION_SIDES)
  const execution = requireChoice(args, 'execution', ['market'] as const)
  const asset = requireInteger(args, 'asset')
  const size = requirePositiveDecimal(args, 'size')
  const takeProfitPrice = requirePositiveDecimal(args, 'take-profit-price')
  const stopLossPrice = requirePositiveDecimal(args, 'stop-loss-price')
  assertProtectionPriceOrder(positionSide, takeProfitPrice, stopLossPrice)
  const takeProfitOrderPrice = resolveTriggerOrderPrice(
    args,
    execution,
    positionSide,
    takeProfitPrice,
    'take-profit-price',
    'take-profit-worst-price',
    'take-profit-limit-price',
  )
  const stopLossOrderPrice = resolveTriggerOrderPrice(
    args,
    execution,
    positionSide,
    stopLossPrice,
    'stop-loss-price',
    'stop-loss-worst-price',
    'stop-loss-limit-price',
  )

  const isBuy = positionSide === 'short'
  const triggerOrder = (
    triggerPrice: string,
    orderPrice: string,
    tpsl: 'tp' | 'sl',
  ): JsonRecord => ({
    a: asset,
    b: isBuy,
    p: orderPrice,
    s: size,
    r: true,
    t: {
      trigger: {
        isMarket: execution === 'market',
        triggerPx: triggerPrice,
        tpsl,
      },
    },
  })
  return {
    orders: [
      triggerOrder(takeProfitPrice, takeProfitOrderPrice, 'tp'),
      triggerOrder(stopLossPrice, stopLossOrderPrice, 'sl'),
    ],
    grouping: 'positionTpsl',
  }
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
    case 'builder-fee-status':
      return {}
    case 'search':
      return {
        query: requireArg(args, 'query'),
      }
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
    case 'l2': {
      const nSigFigs = parseInteger(arg(args, 'n-sig-figs', 'nSigFigs'), 'n-sig-figs')
      const mantissa = parseInteger(args.mantissa, 'mantissa')
      if (mantissa !== undefined && nSigFigs !== 5) {
        throw new Error('--n-sig-figs 5 is required when --mantissa is provided')
      }
      return {
        coin: requireArg(args, 'coin'),
        nSigFigs,
        mantissa,
      }
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
    case 'withdraw-status':
      return {
        nonce: requireInteger(args, 'nonce'),
      }
    default:
      throw new Error(`Unknown hyperliquid read command: ${command}`)
  }
}

function writeBody(command: string, args: Record<string, string>): JsonRecord {
  switch (command) {
    case 'limit-order':
      return { orders: [buildLimitOrder(args)], grouping: 'na' }
    case 'bracket-order':
      return buildBracketBody(args)
    case 'stop-loss':
      return { orders: [buildTriggerOrder(args, 'sl')], grouping: 'positionTpsl' }
    case 'take-profit':
      return { orders: [buildTriggerOrder(args, 'tp')], grouping: 'positionTpsl' }
    case 'protect-position':
      return buildProtectionBody(args)
    case 'modify-limit-order':
      return buildModifyLimitBody(args)
    case 'modify-stop-loss':
      return buildModifyTriggerBody(args, 'sl')
    case 'modify-take-profit':
      return buildModifyTriggerBody(args, 'tp')
    case 'cancel':
      return {
        cancels: [{ a: requireInteger(args, 'asset'), o: requireInteger(args, 'oid') }],
      }
    case 'cancel-by-cloid':
      return {
        cancels: [{ asset: requireInteger(args, 'asset'), cloid: requireCloid(args) }],
      }
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
  return PARAMETER_WRITE_ENDPOINTS[command] ?? CONVENIENCE_WRITE_ENDPOINTS[command]
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

  const removedCommandMessage = REMOVED_WRITE_COMMANDS[command]
  if (removedCommandMessage !== undefined) throw new Error(removedCommandMessage)

  ensureMainnetOnly(args)
  assertKnownOptions(command, args)

  const readEndpoints: Record<string, string> = {
    account: '/account',
    abstraction: '/abstraction',
    'builder-fee-status': '/builder-fee/status',
    markets: '/markets',
    prices: '/prices',
    l2: '/l2',
    candles: '/candles',
    funding: '/funding',
    state: '/state',
    orders: '/orders',
    fills: '/fills',
    'order-status': '/order-status',
    'withdraw-status': '/withdraw-status',
  }
  const integrationReadEndpoints: Record<string, string> = {
    status: '',
    'trading-status': '',
    'integration-status': '',
    snapshot: '/snapshot',
  }
  const integrationWriteCommands: Record<string, boolean> = {
    enable: true,
    'enable-trading': true,
    disable: false,
    'disable-trading': false,
  }

  if (integrationReadEndpoints[command] !== undefined) {
    printJson(await getHyperliquidTradingIntegration(integrationReadEndpoints[command]))
    return
  }

  if (integrationWriteCommands[command] !== undefined) {
    printJson(await setHyperliquidTradingIntegration(integrationWriteCommands[command]))
    return
  }

  if (command === 'markets') {
    printJson(await getPublicHyperliquidMarkets(readQueryArgs(command, args)))
    return
  }

  if (command === 'search') {
    const params = readQueryArgs(command, args)
    printJson(await searchPublicHyperliquidMarkets(String(params.query)))
    return
  }

  if (command === 'symbol') {
    printJson(await getPublicHyperliquidSymbol(readQueryArgs(command, args)))
    return
  }

  if (command === 'candles') {
    printJson(await getPublicHyperliquidCandles(readQueryArgs(command, args)))
    return
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
