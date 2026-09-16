import {
  ApiClientError,
  apiGet,
  apiPost,
  apiPut,
  resolveCredentials,
} from '@pieverseio/purr-core/api-client'
import bs58 from 'bs58'
import { isAddress, parseUnits } from 'viem'

type JsonRecord = Record<string, unknown>
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface Envelope<T = unknown> {
  success?: boolean
  ok?: boolean
  data?: T
  message?: string
  error?: string
  code?: string | number
}

interface WalletResponse {
  ok: boolean
  data?: { address?: string; signature?: string; chainType?: string; hash?: string }
  error?: string
}

interface WalletStepResult {
  stepIndex: number
  label: string
  hash: string
  status: 'success' | 'skipped'
}

interface WalletStepsResponse {
  ok: boolean
  data: { results: WalletStepResult[] } | undefined
  error: string | undefined
}

interface Identity {
  evmAddress: string
  solanaAddress: string
  accountId: string
  orderlyKey: string
}

interface TradingIntegrationResponse {
  ok: boolean
  data?: { enabled?: boolean }
  error?: string
}

const API_URL = (process.env.ORDERLY_API_URL ?? 'https://api.orderly.org').replace(/\/$/, '')
const ORDER_TYPES = ['LIMIT', 'MARKET', 'IOC', 'FOK', 'POST_ONLY', 'ASK', 'BID'] as const
const MARGIN_MODES = ['CROSS', 'ISOLATED'] as const
type MarginMode = (typeof MARGIN_MODES)[number]

const ORDERLY_KEY_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000
const ORDERLY_KEY_EXPIRY_BUFFER_MS = 5 * 60 * 1_000

function orderlyKeyExpiration(timestamp: number): number {
  return timestamp + ORDERLY_KEY_MAX_LIFETIME_MS - ORDERLY_KEY_EXPIRY_BUFFER_MS
}

export class OrderlyCliError extends Error {
  readonly code?: string | number
  readonly status?: number
  readonly data?: unknown
  readonly exitCode: number

  constructor(
    message: string,
    options: { code?: string | number; status?: number; data?: unknown; exitCode?: number } = {},
  ) {
    super(message)
    this.name = 'OrderlyCliError'
    this.code = options.code
    this.status = options.status
    this.data = options.data
    this.exitCode = options.exitCode ?? 1
  }
}

export const ORDERLY_USAGE = `Usage: purr orderly <command> [options]

Public read commands (no wallet credentials):
  status
  markets [--query <text>]
  market --symbol <PERP_TOKEN_USDC>
  orderbook --symbol <PERP_TOKEN_USDC> [--depth <n>]
  candles --symbol <PERP_TOKEN_USDC> --interval <1m|5m|15m|1h|4h|1d> [--start-t <ms>] [--end-t <ms>]
  funding --symbol <PERP_TOKEN_USDC> [--start-t <ms>] [--end-t <ms>]
  networks
  tokens [--chain-id <id>]

Trading integration switch (Platform owns the durable state):
  enable
  disable

Account and asset commands:
  onboard --chain-id <id> [--execute true]
  account
  balance
  positions [--symbol <PERP_TOKEN_USDC>]
  orders [--status <INCOMPLETE|COMPLETED>] [--symbol <symbol>] [--page <n>] [--size <n>]
  fills [--symbol <symbol>] [--page <n>] [--size <n>]
  asset-history [--token <symbol>] [--side <DEPOSIT|WITHDRAW>] [--page <n>] [--size <n>]
  deposit --chain-id <id> --token <symbol> --amount <decimal> [--execute true]
  withdraw --chain-id <id> --token <symbol> --amount <decimal> --address <0x...> [--allow-cross-chain true] [--execute true]

Trading commands:
  order create --symbol <symbol> --side <BUY|SELL> --type <${ORDER_TYPES.join('|')}> --quantity <decimal> [--price <decimal>] [--reduce-only true] [--client-order-id <id>] [--margin-mode <${MARGIN_MODES.join('|')}>] [--execute true]
  order update --order-id <id> --symbol <symbol> --quantity <decimal> [--price <decimal>] [--execute true]
  order cancel --order-id <id> --symbol <symbol> [--execute true]
  orders cancel-all [--symbol <symbol>] [--execute true]
  position close --symbol <symbol> [--percentage <1-100>] [--margin-mode <${MARGIN_MODES.join('|')}>] [--execute true]
  leverage get --symbol <symbol> [--margin-mode <${MARGIN_MODES.join('|')}>]
  leverage set --symbol <symbol> --leverage <n> [--margin-mode <${MARGIN_MODES.join('|')}>] [--execute true]
  bracket-order --symbol <symbol> --side <BUY|SELL> --type <LIMIT|MARKET> --quantity <decimal> [--price <decimal>] --take-profit <trigger> --stop-loss <trigger> [--client-order-id <id>] [--margin-mode <${MARGIN_MODES.join('|')}>] [--execute true]
  algo create --symbol <symbol> --side <BUY|SELL> --quantity <decimal> [--take-profit <price>] [--stop-loss <price>] [--margin-mode <${MARGIN_MODES.join('|')}>] [--execute true]
  algo list [--symbol <symbol>]
  algo cancel --order-id <id> --symbol <symbol> [--execute true]

ORDERLY_BROKER_ID is required for account, network, deposit, and withdrawal commands.
All commands that change assets or orders are previews until --execute true is supplied.
Leverage is tracked per symbol and per margin mode, and markets listed by a
broker support ISOLATED only. Unsupported options are refused rather than
ignored, so a preview always matches what execution submits.
bracket-order submits an entry with protection linked to it and sized from its
fill. algo create builds standalone TP/SL for a position that already exists.`

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrderlyCliError('Expected an object response from Orderly')
  }
  return value as JsonRecord
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asRows(value: unknown): JsonRecord[] {
  if (Array.isArray(value))
    return value.filter(
      (row): row is JsonRecord => typeof row === 'object' && row !== null && !Array.isArray(row),
    )
  if (typeof value === 'object' && value !== null && 'rows' in value && Array.isArray(value.rows)) {
    return value.rows.filter(
      (row): row is JsonRecord => typeof row === 'object' && row !== null && !Array.isArray(row),
    )
  }
  return []
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name]
  if (!value) throw new OrderlyCliError(`Missing required argument: --${name}`)
  return value
}

function optionalInt(args: Record<string, string>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new OrderlyCliError(`Invalid --${name}: "${value}"`)
  }
  return Number(value)
}

function requiredChainId(args: Record<string, string>): number {
  const value = optionalInt(args, 'chain-id')
  if (value === undefined || value <= 0) throw new OrderlyCliError('Missing or invalid --chain-id')
  return value
}

function positiveDecimal(value: string, name: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new OrderlyCliError(`Invalid --${name}: "${value}". Expected a positive decimal.`)
  }
  return value
}

function decimalParts(value: string): { units: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.')
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString()
  const digits = units.toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, -scale)
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function percentageOfDecimal(value: string, percentage: string): string {
  const amount = decimalParts(value)
  const percent = decimalParts(percentage)
  return formatDecimal(amount.units * percent.units, amount.scale + percent.scale + 2)
}

function compareDecimals(left: string, right: string): number {
  const leftAmount = decimalParts(left)
  const rightAmount = decimalParts(right)
  const scale = Math.max(leftAmount.scale, rightAmount.scale)
  const leftUnits = leftAmount.units * 10n ** BigInt(scale - leftAmount.scale)
  const rightUnits = rightAmount.units * 10n ** BigInt(scale - rightAmount.scale)
  return leftUnits === rightUnits ? 0 : leftUnits < rightUnits ? -1 : 1
}

function multiplyDecimals(left: string, right: string): string {
  const leftAmount = decimalParts(left)
  const rightAmount = decimalParts(right)
  return formatDecimal(leftAmount.units * rightAmount.units, leftAmount.scale + rightAmount.scale)
}

function execute(args: Record<string, string>): boolean {
  if (args.execute === undefined) return false
  if (args.execute !== 'true') throw new OrderlyCliError('--execute must be true')
  return true
}

function brokerId(): string {
  const value = process.env.ORDERLY_BROKER_ID
  if (!value) throw new OrderlyCliError('ORDERLY_BROKER_ID is required for this Orderly operation')
  return value
}

function tradingIntegrationPath(): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${encodeURIComponent(instanceId)}/integrations/orderly-trading`
}

async function orderlyTradingEnabled(): Promise<boolean> {
  const response = await apiGet<TradingIntegrationResponse>(tradingIntegrationPath())
  if (!response.ok || response.data?.enabled !== true) return false
  return true
}

async function requireOrderlyTradingEnabled(): Promise<void> {
  if (await orderlyTradingEnabled()) return
  throw new OrderlyCliError(
    'Orderly trading is disabled for this instance. Run purr orderly enable, or enable Orderly Trading in the app, before using private commands.',
    { code: 'ORDERLY_TRADING_DISABLED', status: 403 },
  )
}

/**
 * Platform owns the durable switch. A blocked disable answers 409 with the
 * positions, orders, balances, and asset operations that still have to be
 * resolved, so that body is surfaced instead of the bare HTTP failure.
 */
function tradingIntegrationError(error: unknown, enabled: boolean): Error {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const body =
    typeof error.body === 'object' && error.body !== null && !Array.isArray(error.body)
      ? (error.body as JsonRecord)
      : {}
  const code = body.code
  return new OrderlyCliError(
    asString(body.error) ??
      asString(body.message) ??
      `Orderly trading could not be ${enabled ? 'enabled' : 'disabled'}`,
    {
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
      status: error.status,
      data: body.data,
    },
  )
}

async function setOrderlyTradingIntegration(enabled: boolean): Promise<void> {
  let response: Envelope<JsonRecord>
  try {
    response = await apiPut<Envelope<JsonRecord>>(tradingIntegrationPath(), { enabled })
  } catch (error) {
    throw tradingIntegrationError(error, enabled)
  }
  if (response.ok !== true || response.data === undefined) {
    throw new OrderlyCliError(
      response.error ?? `Orderly trading could not be ${enabled ? 'enabled' : 'disabled'}`,
      { code: response.code, data: response.data },
    )
  }
  print(response.data)
}

function query(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(path, API_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}`
}

export function orderlyCanonicalMessage(
  timestamp: string,
  method: HttpMethod,
  path: string,
  bodyText = '',
): string {
  return `${timestamp}${method}${path}${bodyText}`
}

/**
 * `POST /wallet/sign` with `chainType: 'solana'` and `scheme: 'raw'` returns a
 * base58-encoded, 64-byte Ed25519 signature. Orderly requires those bytes as
 * unpadded base64url in the `orderly-signature` header.
 */
export function solanaBase58SignatureToBase64Url(value: string): string {
  let signature: Uint8Array
  try {
    signature = bs58.decode(value)
  } catch {
    throw new OrderlyCliError('Solana raw signing returned an invalid base58 signature')
  }
  if (signature.length !== 64) {
    throw new OrderlyCliError(
      `Solana raw signing returned ${signature.length} bytes; expected a 64-byte Ed25519 signature`,
    )
  }
  return Buffer.from(signature).toString('base64url')
}

async function orderlyRequest<T = unknown>(
  method: HttpMethod,
  path: string,
  body?: JsonRecord,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    parsed = { message: text }
  }
  if (!response.ok) {
    const data = typeof parsed === 'object' && parsed !== null ? (parsed as JsonRecord) : undefined
    throw new OrderlyCliError(
      asString(data?.message) ?? asString(data?.error) ?? `Orderly ${method} ${path} failed`,
      { status: response.status, code: data?.code as string | number | undefined, data: parsed },
    )
  }
  const envelope = parsed as Envelope<T>
  if (envelope.success === false || envelope.ok === false) {
    throw new OrderlyCliError(envelope.message ?? envelope.error ?? 'Orderly request failed', {
      code: envelope.code,
      data: parsed,
    })
  }
  return (envelope.data ?? parsed) as T
}

async function platformWallet(chainType: 'ethereum' | 'solana'): Promise<string> {
  const { instanceId } = resolveCredentials()
  const response = await apiGet<WalletResponse>(
    query(`/v1/instances/${encodeURIComponent(instanceId)}/wallet`, { chain_type: chainType }),
  )
  const address = response.data?.address
  if (!response.ok || !address) {
    throw new OrderlyCliError(response.error ?? `No ${chainType} managed wallet is available`)
  }
  return address
}

async function lookupAccount(
  evmAddress: string,
  requiredAccount = true,
): Promise<string | undefined> {
  try {
    const data = await orderlyRequest<JsonRecord>(
      'GET',
      query('/v1/get_account', { broker_id: brokerId(), address: evmAddress, chain_type: 'EVM' }),
    )
    return asString(data.account_id) ?? asString(record(data.data ?? {}).account_id)
  } catch (error) {
    if (
      !requiredAccount &&
      error instanceof OrderlyCliError &&
      (error.status === 404 || String(error.code) === '-1607')
    )
      return undefined
    throw error
  }
}

async function identity(): Promise<Identity> {
  const evmAddress = await platformWallet('ethereum')
  const solanaAddress = await platformWallet('solana')
  const accountId = await lookupAccount(evmAddress)
  if (!accountId)
    throw new OrderlyCliError(
      'Orderly account is not registered. Run purr orderly onboard --chain-id <id> --execute true.',
    )
  return { evmAddress, solanaAddress, accountId, orderlyKey: `ed25519:${solanaAddress}` }
}

async function privateRequest<T = unknown>(
  method: HttpMethod,
  path: string,
  body?: JsonRecord,
): Promise<T> {
  const { instanceId } = resolveCredentials()
  const response = await apiPost<Envelope<T>>(
    `/v1/instances/${encodeURIComponent(instanceId)}/orderly/private-request`,
    { method, path, ...(body === undefined ? {} : { body }) },
  )
  if (response.ok !== true || response.data === undefined) {
    throw new OrderlyCliError(response.error ?? `Orderly ${method} ${path} failed`)
  }
  return response.data
}

async function publicInfo(symbol: string): Promise<JsonRecord> {
  return record(await orderlyRequest('GET', `/v1/public/info/${encodeURIComponent(symbol)}`))
}

function marginModeArg(args: Record<string, string>): MarginMode | undefined {
  const value = args['margin-mode']
  if (value === undefined) return undefined
  const normalized = value.toUpperCase()
  if (!(MARGIN_MODES as readonly string[]).includes(normalized)) {
    throw new OrderlyCliError(
      `Invalid --margin-mode: "${value}". Expected ${MARGIN_MODES.join(' or ')}.`,
    )
  }
  return normalized as MarginMode
}

/**
 * Orderly selects the margin mode per order and no endpoint reports which modes
 * a market accepts: `/v1/public/info` carries no margin field, and a leverage
 * update succeeds even for a mode the market rejects at order submission.
 * Builder markets (Perp Anything, listed with a non-null `broker_id`) are
 * documented as isolated only, so that is the one signal available before an
 * order exists. Resolving the mode here keeps a preview and its execution
 * identical and fails before collateral is moved rather than after.
 */
async function resolveMarginMode(
  symbol: string,
  requested: MarginMode | undefined,
): Promise<MarginMode | undefined> {
  if (requested === 'ISOLATED') return requested
  const isolatedOnly = asString((await publicInfo(symbol)).broker_id) !== undefined
  if (!isolatedOnly) return requested
  if (requested === 'CROSS') {
    throw new OrderlyCliError(
      `${symbol} supports ISOLATED margin only. Re-run with --margin-mode isolated; the account needs no mode conversion and no second account.`,
    )
  }
  return 'ISOLATED'
}

async function tokenMetadata(token: string, chainId: number): Promise<{ ledgerDecimals: number }> {
  const response = await orderlyRequest<unknown>('GET', '/v1/public/token')
  const row = asRows(response).find(
    (item) => asString(item.token)?.toUpperCase() === token.toUpperCase(),
  )
  if (!row) throw new OrderlyCliError(`Orderly does not support token ${token}`)
  const chain = asRows(row.chain_details).find(
    (item) => Number(item.chain_id ?? item.chainId) === chainId,
  )
  const ledgerDecimals = Number(row.decimals)
  if (!chain || !Number.isInteger(ledgerDecimals)) {
    throw new OrderlyCliError(`${token} is not executable on chain ${chainId}`)
  }
  return { ledgerDecimals }
}

function decimalIsMultiple(value: string, tick: unknown): boolean {
  if (typeof tick !== 'number' && typeof tick !== 'string') return true
  const normalizedTick = String(tick)
  if (!/^\d+(?:\.\d+)?$/.test(normalizedTick)) return true
  try {
    const amount = decimalParts(value)
    const tickAmount = decimalParts(normalizedTick)
    const scale = Math.max(amount.scale, tickAmount.scale)
    const units = amount.units * 10n ** BigInt(scale - amount.scale)
    const tickUnits = tickAmount.units * 10n ** BigInt(scale - tickAmount.scale)
    return tickUnits > 0n && units % tickUnits === 0n
  } catch {
    return false
  }
}

async function validateOrder(order: JsonRecord): Promise<void> {
  const info = await publicInfo(required(order as Record<string, string>, 'symbol'))
  const quantity = String(order.order_quantity)
  if (!decimalIsMultiple(quantity, info.base_tick)) {
    throw new OrderlyCliError(
      `--quantity must be a multiple of base_tick ${String(info.base_tick)}`,
    )
  }
  if (
    order.order_price !== undefined &&
    !decimalIsMultiple(String(order.order_price), info.quote_tick)
  ) {
    throw new OrderlyCliError(`--price must be a multiple of quote_tick ${String(info.quote_tick)}`)
  }
  const baseMin = String(info.base_min)
  if (!/^\d+(?:\.\d+)?$/.test(baseMin))
    throw new OrderlyCliError('Orderly market metadata has an invalid base_min')
  if (compareDecimals(quantity, baseMin) < 0) {
    throw new OrderlyCliError(`--quantity is below base_min ${baseMin}`)
  }
  if (order.order_price !== undefined) {
    const minNotional = String(info.min_notional)
    if (!/^\d+(?:\.\d+)?$/.test(minNotional))
      throw new OrderlyCliError('Orderly market metadata has an invalid min_notional')
    if (compareDecimals(multiplyDecimals(quantity, String(order.order_price)), minNotional) < 0) {
      throw new OrderlyCliError(`Order notional is below min_notional ${minNotional}`)
    }
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function status(): Promise<void> {
  const result: JsonRecord = {
    publicReady: false,
    brokerConfigured: Boolean(process.env.ORDERLY_BROKER_ID),
    integrationEnabled: false,
    accountReady: false,
    keyReady: false,
    authReady: false,
    fundedReady: false,
    tradeReady: false,
    reasons: [] as string[],
  }
  try {
    await publicInfo('PERP_BTC_USDC')
    result.publicReady = true
  } catch (error) {
    ;(result.reasons as string[]).push(
      error instanceof Error ? error.message : 'Orderly public API unavailable',
    )
  }
  if (!result.brokerConfigured)
    (result.reasons as string[]).push('ORDERLY_BROKER_ID is not configured')
  try {
    result.integrationEnabled = await orderlyTradingEnabled()
  } catch (error) {
    ;(result.reasons as string[]).push(
      error instanceof Error ? error.message : 'Orderly integration status unavailable',
    )
  }
  if (result.integrationEnabled !== true) {
    ;(result.reasons as string[]).push('Orderly trading integration is disabled')
    print(result)
    return
  }
  try {
    const current = await identity()
    result.accountReady = true
    result.keyReady = Boolean(current.solanaAddress)
    const holdings = record(await privateRequest('GET', '/v1/client/holding'))
    result.authReady = true
    // Collateral is reported on its own: an enabled, authenticated account can
    // still hold nothing, and only a funded one can back an order.
    result.fundedReady = asRows(holdings.holding).some((row) => Number(row.holding) > 0)
    if (result.fundedReady !== true) {
      ;(result.reasons as string[]).push('Orderly account holds no collateral')
    }
  } catch (error) {
    ;(result.reasons as string[]).push(
      error instanceof Error ? error.message : 'Managed wallet authentication unavailable',
    )
  }
  result.tradeReady =
    result.publicReady === true &&
    result.brokerConfigured === true &&
    result.integrationEnabled === true &&
    result.accountReady === true &&
    result.keyReady === true &&
    result.authReady === true
  print(result)
}

async function onboard(args: Record<string, string>): Promise<void> {
  const chainId = requiredChainId(args)
  const broker = brokerId()
  const evmAddress = await platformWallet('ethereum')
  const existing = await lookupAccount(evmAddress, false)
  const now = Date.now()
  const registrationNonce = existing
    ? undefined
    : await orderlyRequest<unknown>('GET', '/v1/registration_nonce')
  const nonceValue =
    typeof registrationNonce === 'object' &&
    registrationNonce !== null &&
    'registration_nonce' in registrationNonce
      ? (registrationNonce as JsonRecord).registration_nonce
      : registrationNonce
  const registrationMessage = {
    brokerId: broker,
    chainId,
    timestamp: now,
    ...(nonceValue !== undefined ? { registrationNonce: String(nonceValue) } : {}),
  }
  if (!execute(args)) {
    let solanaAddress: string | undefined
    try {
      solanaAddress = await platformWallet('solana')
    } catch {
      // A preview must not create a managed wallet. Creation happens only after --execute true.
    }
    const orderlyKey = solanaAddress ? `ed25519:${solanaAddress}` : undefined
    const addKeyMessage = orderlyKey
      ? {
          brokerId: broker,
          chainId,
          orderlyKey,
          scope: 'read,trading,asset',
          timestamp: now,
          expiration: orderlyKeyExpiration(now),
        }
      : undefined
    return print({
      execute: false,
      evmAddress,
      solanaAddress: solanaAddress ?? null,
      solanaWalletCreationRequired: !solanaAddress,
      existingAccountId: existing ?? null,
      orderlyKey: orderlyKey ?? null,
      registration: existing
        ? { required: false }
        : { required: true, message: { ...registrationMessage, chainType: 'EVM' } },
      addOrderlyKey: addKeyMessage
        ? { required: true, message: { ...addKeyMessage, chainType: 'EVM' } }
        : { required: true, requiresSolanaWallet: true },
    })
  }

  const { instanceId } = resolveCredentials()
  const response = await apiPost<Envelope<JsonRecord>>(
    `/v1/instances/${encodeURIComponent(instanceId)}/orderly/onboard`,
    { chainId },
  )
  if (response.ok !== true || response.data === undefined)
    throw new OrderlyCliError(response.error ?? 'Orderly onboarding failed')
  print({ execute: true, ...response.data })
}

async function deposit(args: Record<string, string>): Promise<void> {
  const chainId = requiredChainId(args)
  const token = required(args, 'token').toUpperCase()
  const amount = positiveDecimal(required(args, 'amount'), 'amount')
  if (!execute(args))
    return print({
      execute: false,
      chainId,
      token,
      amount,
      note: 'Platform validates Orderly metadata, quotes the vault fee, and builds the approval and deposit transactions when executed.',
    })
  const { instanceId } = resolveCredentials()
  const result = await apiPost<WalletStepsResponse>(
    `/v1/instances/${encodeURIComponent(instanceId)}/orderly/deposit`,
    { chainId, token, amount },
  )
  let results: WalletStepResult[] = []
  if (result.data !== undefined) results = result.data.results
  const approval = results.find((step) => step.label === 'approve')
  const deposited = results.find((step) => step.label === 'deposit')
  if (!result.ok || deposited === undefined || deposited.hash.length === 0) {
    let message = 'Orderly deposit transaction failed'
    if (result.error !== undefined) message = result.error
    throw new OrderlyCliError(message)
  }
  let approveTxHash: string | null = null
  let approvalSkipped = false
  if (approval !== undefined) {
    approvalSkipped = approval.status === 'skipped'
    if (approval.status === 'success') approveTxHash = approval.hash
  }
  print({
    execute: true,
    approveTxHash,
    approvalSkipped,
    depositTxHash: deposited.hash,
  })
}

async function withdraw(args: Record<string, string>): Promise<void> {
  const chainId = requiredChainId(args)
  const token = required(args, 'token').toUpperCase()
  const amount = positiveDecimal(required(args, 'amount'), 'amount')
  const receiver = required(args, 'address')
  if (!isAddress(receiver)) throw new OrderlyCliError('--address must be a valid EVM address')
  const tokenInfo = await tokenMetadata(token, chainId)
  const amountBaseUnits = parseUnits(amount, tokenInfo.ledgerDecimals).toString()
  if (!execute(args))
    return print({
      execute: false,
      chainId,
      token,
      amount: amountBaseUnits,
      receiver,
      allowCrossChain: args['allow-cross-chain'] === 'true',
      note: 'The withdrawal nonce is short lived; execute promptly and never retry a timed-out withdrawal without checking asset-history.',
    })
  const { instanceId } = resolveCredentials()
  const response = await apiPost<Envelope>(
    `/v1/instances/${encodeURIComponent(instanceId)}/orderly/withdraw`,
    {
      chainId,
      token,
      amount: amountBaseUnits,
      receiver,
      ...(args['allow-cross-chain'] === 'true' ? { allowCrossChain: true } : {}),
    },
  )
  if (response.ok !== true || response.data === undefined)
    throw new OrderlyCliError(response.error ?? 'Orderly withdrawal failed')
  print(response.data)
}

function orderFromArgs(args: Record<string, string>): JsonRecord {
  const type = required(args, 'type').toUpperCase()
  if (!(ORDER_TYPES as readonly string[]).includes(type))
    throw new OrderlyCliError(`Unsupported --type ${type}`)
  const order: JsonRecord = {
    symbol: required(args, 'symbol'),
    side: required(args, 'side').toUpperCase(),
    order_type: type,
    order_quantity: positiveDecimal(required(args, 'quantity'), 'quantity'),
  }
  if (order.side !== 'BUY' && order.side !== 'SELL')
    throw new OrderlyCliError('--side must be BUY or SELL')
  if (type !== 'MARKET' && type !== 'ASK' && type !== 'BID')
    order.order_price = positiveDecimal(required(args, 'price'), 'price')
  if (args['reduce-only'] !== undefined) order.reduce_only = args['reduce-only'] === 'true'
  if (args['client-order-id']) order.client_order_id = args['client-order-id']
  return order
}

async function createOrder(args: Record<string, string>): Promise<void> {
  const order = orderFromArgs(args)
  const requested = marginModeArg(args)
  await validateOrder(order)
  const marginMode = await resolveMarginMode(String(order.symbol), requested)
  if (marginMode) order.margin_mode = marginMode
  if (!execute(args))
    return print({
      execute: false,
      order,
      note: 'Reuse the same --client-order-id when executing this preview.',
    })
  print(await privateRequest('POST', '/v1/order', order))
}

async function updateOrder(args: Record<string, string>): Promise<void> {
  const order: JsonRecord = {
    symbol: required(args, 'symbol'),
    order_quantity: positiveDecimal(required(args, 'quantity'), 'quantity'),
  }
  if (args.price) order.order_price = positiveDecimal(args.price, 'price')
  await validateOrder(order)
  const body: JsonRecord = {
    order_id: required(args, 'order-id'),
    order_quantity: order.order_quantity,
  }
  if (order.order_price !== undefined) body.order_price = order.order_price
  if (!execute(args)) return print({ execute: false, order: body })
  print(await privateRequest('PUT', '/v1/order', body))
}

async function cancelOrder(args: Record<string, string>): Promise<void> {
  const path = query('/v1/order', {
    order_id: required(args, 'order-id'),
    symbol: required(args, 'symbol'),
  })
  if (!execute(args)) return print({ execute: false, method: 'DELETE', path })
  print(await privateRequest('DELETE', path))
}

async function cancelAll(args: Record<string, string>): Promise<void> {
  const path = query('/v1/orders', { symbol: args.symbol })
  if (!execute(args)) return print({ execute: false, method: 'DELETE', path })
  print(await privateRequest('DELETE', path))
}

async function closePosition(args: Record<string, string>): Promise<void> {
  const symbol = required(args, 'symbol')
  const requested = marginModeArg(args)
  const position = await privateRequest<unknown>(
    'GET',
    `/v1/position/${encodeURIComponent(symbol)}`,
    undefined,
  )
  const row = record(position)
  const positionQty = asString(row.position_qty)
  if (!positionQty || !/^-?\d+(?:\.\d+)?$/.test(positionQty))
    throw new OrderlyCliError(`Invalid position quantity for ${symbol}`)
  const isLong = !positionQty.startsWith('-')
  const quantity = isLong ? positionQty : positionQty.slice(1)
  if (decimalParts(quantity).units === 0n)
    throw new OrderlyCliError(`No open position for ${symbol}`)
  const percentage =
    args.percentage === undefined ? '100' : positiveDecimal(args.percentage, 'percentage')
  if (Number(percentage) > 100) throw new OrderlyCliError('--percentage must be between 1 and 100')
  const order: JsonRecord = {
    symbol,
    side: isLong ? 'SELL' : 'BUY',
    order_type: 'MARKET',
    order_quantity: percentageOfDecimal(quantity, percentage),
    reduce_only: true,
  }
  await validateOrder(order)
  const marginMode = await resolveMarginMode(symbol, requested)
  if (marginMode) order.margin_mode = marginMode
  if (!execute(args)) return print({ execute: false, position: row, order })
  print(await privateRequest('POST', '/v1/order', order))
}

async function createAlgo(args: Record<string, string>): Promise<void> {
  const symbol = required(args, 'symbol')
  const requested = marginModeArg(args)
  const side = required(args, 'side').toUpperCase()
  const quantity = positiveDecimal(required(args, 'quantity'), 'quantity')
  const children: JsonRecord[] = []
  if (args['take-profit'])
    children.push({
      symbol,
      algo_type: 'TAKE_PROFIT',
      side,
      type: 'MARKET',
      trigger_price: positiveDecimal(args['take-profit'], 'take-profit'),
      reduce_only: true,
    })
  if (args['stop-loss'])
    children.push({
      symbol,
      algo_type: 'STOP_LOSS',
      side,
      type: 'MARKET',
      trigger_price: positiveDecimal(args['stop-loss'], 'stop-loss'),
      reduce_only: true,
    })
  if (children.length === 0) throw new OrderlyCliError('Specify --take-profit and/or --stop-loss')
  const body: JsonRecord =
    children.length === 2
      ? {
          symbol,
          algo_type: 'TP_SL',
          quantity,
          trigger_price_type: 'MARK_PRICE',
          child_orders: children,
        }
      : {
          symbol,
          algo_type: 'STOP',
          side,
          type: 'MARKET',
          quantity,
          trigger_price_type: 'MARK_PRICE',
          trigger_price: children[0].trigger_price,
          reduce_only: true,
        }
  const marginMode = await resolveMarginMode(symbol, requested)
  if (marginMode) body.margin_mode = marginMode
  if (!execute(args)) return print({ execute: false, algoOrder: body })
  print(await privateRequest('POST', '/v1/algo/order', body))
}

/**
 * A native bracket: Orderly links the protection to this entry, sizes it from
 * the entry's executed quantity, and cancels it with the entry. Calling `order
 * create` and then `algo create` produces two unlinked orders instead, and
 * leaves the entry unprotected in between. `TP_SL` is used rather than
 * `POSITIONAL_TP_SL`, which would instead target whatever position exists when
 * the trigger fires.
 *
 * The protection legs are MARKET because Orderly's own SDK resolves a `TP_SL`
 * child without an exit limit price to exactly that (`resolveTPSLOrderType`:
 * limit price wins, else `CLOSE_POSITION` for a full-position group, else
 * `MARKET`). `CLOSE_POSITION` belongs to `POSITIONAL_TP_SL` and would silently
 * resize the protection to the whole position, and a LIMIT leg can trigger
 * without filling.
 */
async function createBracketOrder(args: Record<string, string>): Promise<void> {
  const symbol = required(args, 'symbol')
  const requested = marginModeArg(args)
  const side = required(args, 'side').toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') throw new OrderlyCliError('--side must be BUY or SELL')
  const type = required(args, 'type').toUpperCase()
  if (type !== 'LIMIT' && type !== 'MARKET')
    throw new OrderlyCliError('--type must be LIMIT or MARKET for a bracket entry')
  if (type === 'MARKET' && args.price !== undefined)
    throw new OrderlyCliError('--price is not supported for a MARKET bracket entry')
  const quantity = positiveDecimal(required(args, 'quantity'), 'quantity')
  const takeProfit = positiveDecimal(required(args, 'take-profit'), 'take-profit')
  const stopLoss = positiveDecimal(required(args, 'stop-loss'), 'stop-loss')
  // Protection is submitted with the entry or not at all, so a swapped pair has
  // to fail here rather than arm a stop above the target.
  const profitAbove = side === 'BUY'
  if (compareDecimals(takeProfit, stopLoss) !== (profitAbove ? 1 : -1)) {
    throw new OrderlyCliError(
      `--take-profit must be ${profitAbove ? 'above' : 'below'} --stop-loss for a ${side} entry`,
    )
  }
  const entry: JsonRecord = { symbol, order_quantity: quantity }
  if (type === 'LIMIT') entry.order_price = positiveDecimal(required(args, 'price'), 'price')
  await validateOrder(entry)
  const marginMode = await resolveMarginMode(symbol, requested)
  const exit = profitAbove ? 'SELL' : 'BUY'
  const protection = (algoType: 'TAKE_PROFIT' | 'STOP_LOSS', triggerPrice: string): JsonRecord => ({
    symbol,
    algo_type: algoType,
    side: exit,
    type: 'MARKET',
    trigger_price: triggerPrice,
    reduce_only: true,
  })
  const body: JsonRecord = {
    symbol,
    algo_type: 'BRACKET',
    side,
    type,
    quantity,
    ...(entry.order_price === undefined ? {} : { price: entry.order_price }),
    ...(args['client-order-id'] ? { client_order_id: args['client-order-id'] } : {}),
    ...(marginMode === undefined ? {} : { margin_mode: marginMode }),
    child_orders: [
      {
        symbol,
        algo_type: 'TP_SL',
        child_orders: [protection('TAKE_PROFIT', takeProfit), protection('STOP_LOSS', stopLoss)],
      },
    ],
  }
  if (!execute(args))
    return print({
      execute: false,
      bracketOrder: body,
      note: 'Protection is sized from the entry fill and is submitted with it. Reuse the same --client-order-id when executing this preview.',
    })
  const result = record(await privateRequest('POST', '/v1/algo/order', body))
  const entryRow = asRows(result)[0]
  if (!entryRow || entryRow.order_id === undefined) {
    throw new OrderlyCliError(
      'Orderly did not return a bracket entry order ID. Check algo list before resubmitting; the entry may already be live.',
      { data: result },
    )
  }
  print(result)
}

async function publicQuery(type: string, args: Record<string, string>): Promise<void> {
  const body: JsonRecord = {
    type,
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.interval ? { interval: args.interval } : {}),
    ...(args['start-t'] ? { start_time: Number(args['start-t']) } : {}),
    ...(args['end-t'] ? { end_time: Number(args['end-t']) } : {}),
    ...(args.depth ? { max_level: Number(args.depth) } : {}),
  }
  print(await orderlyRequest('POST', '/v1/public/query', body))
}

export function orderlyHelp(): string {
  return ORDERLY_USAGE
}

const INTEGRATION_WRITE_COMMANDS: Record<string, boolean> = { enable: true, disable: false }

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  status: [],
  markets: ['query'],
  market: ['symbol'],
  orderbook: ['symbol', 'depth'],
  candles: ['symbol', 'interval', 'start-t', 'end-t'],
  funding: ['symbol', 'start-t', 'end-t'],
  networks: [],
  tokens: ['chain-id'],
  enable: [],
  disable: [],
  onboard: ['chain-id', 'execute'],
  account: [],
  balance: [],
  positions: ['symbol'],
  orders: ['status', 'symbol', 'page', 'size'],
  fills: ['symbol', 'page', 'size'],
  'asset-history': ['token', 'side', 'page', 'size'],
  deposit: ['chain-id', 'token', 'amount', 'execute'],
  withdraw: ['chain-id', 'token', 'amount', 'address', 'allow-cross-chain', 'execute'],
  'order-create': [
    'symbol',
    'side',
    'type',
    'quantity',
    'price',
    'reduce-only',
    'client-order-id',
    'margin-mode',
    'execute',
  ],
  'order-update': ['order-id', 'symbol', 'quantity', 'price', 'execute'],
  'order-cancel': ['order-id', 'symbol', 'execute'],
  'orders-cancel-all': ['symbol', 'execute'],
  'position-close': ['symbol', 'percentage', 'margin-mode', 'execute'],
  'leverage-get': ['symbol', 'margin-mode'],
  'leverage-set': ['symbol', 'leverage', 'margin-mode', 'execute'],
  'bracket-order': [
    'symbol',
    'side',
    'type',
    'quantity',
    'price',
    'take-profit',
    'stop-loss',
    'client-order-id',
    'margin-mode',
    'execute',
  ],
  'algo-create': [
    'symbol',
    'side',
    'quantity',
    'take-profit',
    'stop-loss',
    'margin-mode',
    'execute',
  ],
  'algo-list': ['symbol'],
  'algo-cancel': ['order-id', 'symbol', 'execute'],
}

const NESTED_COMMAND_PREFIXES = ['order', 'orders', 'position', 'leverage', 'algo']

function commandLabel(command: string): string {
  const separator = command.indexOf('-')
  const prefix = separator > 0 ? command.slice(0, separator) : ''
  return NESTED_COMMAND_PREFIXES.includes(prefix)
    ? `${prefix} ${command.slice(separator + 1)}`
    : command
}

/**
 * An option the command never reads used to be dropped in silence, so a
 * misspelled or unsupported flag produced a preview that looked like it had
 * been applied. Refuse the command instead, while the preview is still the
 * only thing at stake.
 */
function assertKnownOptions(command: string, args: Record<string, string>): void {
  const allowed = COMMAND_OPTIONS[command]
  if (!allowed) return
  const allowedSet = new Set([...allowed, 'h'])
  const unknown = Object.keys(args)
    .filter((name) => !allowedSet.has(name))
    .sort()
  if (unknown.length === 0) return
  const rendered = unknown.map((name) => `--${name}`).join(', ')
  throw new OrderlyCliError(
    `Unknown option${unknown.length === 1 ? '' : 's'} for purr orderly ${commandLabel(command)}: ${rendered}.${
      allowed.length === 0
        ? ' This command does not accept options.'
        : ` Allowed options: ${allowed.map((name) => `--${name}`).join(', ')}`
    }`,
  )
}

export async function orderlyCommand(command: string, args: Record<string, string>): Promise<void> {
  assertKnownOptions(command, args)

  // The switch commands own the gate below, so they have to run before it.
  const integrationWrite = INTEGRATION_WRITE_COMMANDS[command]
  if (integrationWrite !== undefined) return await setOrderlyTradingIntegration(integrationWrite)

  const publicCommands = new Set([
    'status',
    'markets',
    'market',
    'orderbook',
    'candles',
    'funding',
    'networks',
    'tokens',
  ])
  if (!publicCommands.has(command)) await requireOrderlyTradingEnabled()

  switch (command) {
    case 'status':
      return await status()
    case 'markets': {
      const response = await orderlyRequest<unknown>('GET', '/v1/public/info')
      const rows = asRows(response)
      const queryText = args.query?.toUpperCase()
      return print(
        queryText
          ? rows.filter((row) => JSON.stringify(row).toUpperCase().includes(queryText))
          : rows,
      )
    }
    case 'market':
      return print(await publicInfo(required(args, 'symbol')))
    case 'orderbook':
      return await publicQuery('orderbook', args)
    case 'candles':
      return await publicQuery('candles', args)
    case 'funding':
      return await publicQuery('fundingRateHistory', args)
    case 'networks':
      return print(
        await orderlyRequest('GET', query('/v1/public/chain_info', { broker_id: brokerId() })),
      )
    case 'tokens':
      return print(
        await orderlyRequest(
          'GET',
          query('/v1/public/token', {
            chain_id: args['chain-id'] === undefined ? undefined : requiredChainId(args),
          }),
        ),
      )
    case 'onboard':
      return await onboard(args)
    case 'account':
      return print(await identity())
    case 'balance':
      return print(await privateRequest('GET', '/v1/client/holding'))
    case 'positions':
      return print(
        await privateRequest(
          'GET',
          args.symbol ? `/v1/position/${encodeURIComponent(args.symbol)}` : '/v1/positions',
        ),
      )
    case 'orders':
      return print(
        await privateRequest(
          'GET',
          query('/v1/orders', {
            status: args.status,
            symbol: args.symbol,
            page: args.page,
            size: args.size,
          }),
        ),
      )
    case 'fills':
      return print(
        await privateRequest(
          'GET',
          query('/v1/trades', { symbol: args.symbol, page: args.page, size: args.size }),
        ),
      )
    case 'asset-history':
      return print(
        await privateRequest(
          'GET',
          query('/v1/asset/history', {
            token: args.token,
            side: args.side,
            page: args.page,
            size: args.size,
          }),
        ),
      )
    case 'deposit':
      return await deposit(args)
    case 'withdraw':
      return await withdraw(args)
    case 'order-create':
      return await createOrder(args)
    case 'order-update':
      return await updateOrder(args)
    case 'order-cancel':
      return await cancelOrder(args)
    case 'orders-cancel-all':
      return await cancelAll(args)
    case 'position-close':
      return await closePosition(args)
    case 'leverage-get': {
      // Orderly defaults this read to CROSS, so an unqualified query reports the
      // cross setting even for a market that only accepts isolated orders.
      const symbol = required(args, 'symbol')
      const marginMode = await resolveMarginMode(symbol, marginModeArg(args))
      return print(
        await privateRequest(
          'GET',
          query('/v1/client/leverage', { symbol, margin_mode: marginMode }),
        ),
      )
    }
    case 'leverage-set': {
      const symbol = required(args, 'symbol')
      const leverage = optionalInt(args, 'leverage')
      if (leverage === undefined || leverage < 1)
        throw new OrderlyCliError('Missing or invalid --leverage')
      const marginMode = await resolveMarginMode(symbol, marginModeArg(args))
      const body: JsonRecord = {
        symbol,
        leverage,
        ...(marginMode === undefined ? {} : { margin_mode: marginMode }),
      }
      if (!execute(args)) return print({ execute: false, leverage: body })
      const result = record(await privateRequest('POST', '/v1/client/leverages', body))
      // Leverage updates succeed per mode, so a mismatched echo means the
      // requested mode never took effect. Only an order would reveal that, and
      // only after collateral had already been moved.
      const applied = asString(result.margin_mode)?.toUpperCase()
      if (marginMode !== undefined && applied !== marginMode) {
        throw new OrderlyCliError(
          `Orderly applied ${applied ?? 'an unreported'} margin mode for ${symbol} instead of ${marginMode}`,
          { data: result },
        )
      }
      return print(result)
    }
    case 'bracket-order':
      return await createBracketOrder(args)
    case 'algo-create':
      return await createAlgo(args)
    case 'algo-list':
      return print(await privateRequest('GET', query('/v1/algo/orders', { symbol: args.symbol })))
    case 'algo-cancel': {
      const path = query('/v1/algo/order', {
        order_id: required(args, 'order-id'),
        symbol: required(args, 'symbol'),
      })
      if (!execute(args)) return print({ execute: false, method: 'DELETE', path })
      return print(await privateRequest('DELETE', path))
    }
    default:
      throw new OrderlyCliError(`Unknown Orderly command: ${command}.\n${ORDERLY_USAGE}`)
  }
}
