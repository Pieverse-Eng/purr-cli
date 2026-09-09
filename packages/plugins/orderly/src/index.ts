import { apiGet, apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  stringToHex,
} from 'viem'

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
  label?: string
  hash?: string
  status?: string
}

interface WalletStepsResponse {
  ok: boolean
  data?: { results?: WalletStepResult[] }
  error?: string
}

interface Identity {
  evmAddress: string
  solanaAddress: string
  accountId: string
  orderlyKey: string
}

const API_URL = (process.env.ORDERLY_API_URL ?? 'https://api.orderly.org').replace(/\/$/, '')
const OFFCHAIN_VERIFYING_CONTRACT = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC'
const MAINNET_LEDGER = '0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203'
const TESTNET_LEDGER = '0x1826B75e2ef249173FC735149AE4B8e9ea10abff'
const ORDER_TYPES = ['LIMIT', 'MARKET', 'IOC', 'FOK', 'POST_ONLY', 'ASK', 'BID'] as const

const VAULT_ABI = parseAbi([
  'function getDepositFee(address account, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) input) view returns (uint256)',
])
const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
])
const DEPOSIT_ABI = parseAbi([
  'function deposit((bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) input) payable',
])
const MAX_UINT128 = (1n << 128n) - 1n
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

Account and asset commands:
  onboard --chain-id <id> [--execute true]
  account
  balance
  positions [--symbol <PERP_TOKEN_USDC>]
  orders [--status <INCOMPLETE|COMPLETED>] [--symbol <symbol>] [--page <n>] [--size <n>]
  fills [--symbol <symbol>] [--page <n>] [--size <n>]
  asset-history [--token <symbol>] [--side <DEPOSIT|WITHDRAW>] [--page <n>] [--size <n>]
  deposit --chain-id <id> --token <symbol> --amount <decimal> [--fee-wei <wei>] [--execute true]
  withdraw --chain-id <id> --token <symbol> --amount <decimal> --address <0x...> [--allow-cross-chain true] [--execute true]

Trading commands:
  order create --symbol <symbol> --side <BUY|SELL> --type <${ORDER_TYPES.join('|')}> --quantity <decimal> [--price <decimal>] [--reduce-only true] [--client-order-id <id>] [--execute true]
  order update --order-id <id> --quantity <decimal> [--price <decimal>] [--execute true]
  order cancel --order-id <id> --symbol <symbol> [--execute true]
  orders cancel-all [--symbol <symbol>] [--execute true]
  position close --symbol <symbol> [--percentage <1-100>] [--execute true]
  leverage get --symbol <symbol>
  leverage set --symbol <symbol> --leverage <n> [--execute true]
  algo create --symbol <symbol> --side <BUY|SELL> --quantity <decimal> [--take-profit <price>] [--stop-loss <price>] [--execute true]
  algo list [--symbol <symbol>]
  algo cancel --order-id <id> --symbol <symbol> [--execute true]

ORDERLY_BROKER_ID is required for account, network, deposit, and withdrawal commands.
All commands that change assets or orders are previews until --execute true is supplied.`

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

export function toBase64Url(value: string): string {
  return Buffer.from(value, 'base64').toString('base64url')
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
    `/v1/instances/${encodeURIComponent(instanceId)}/wallet?chain_type=${chainType}`,
  )
  const address = response.data?.address
  if (!response.ok || !address) {
    throw new OrderlyCliError(response.error ?? `No ${chainType} managed wallet is available`)
  }
  return address
}

async function ensureSolanaWallet(): Promise<string> {
  try {
    return await platformWallet('solana')
  } catch {
    const { instanceId } = resolveCredentials()
    const response = await apiPost<WalletResponse>(
      `/v1/instances/${encodeURIComponent(instanceId)}/wallet/ensure`,
      {
        chainType: 'solana',
      },
    )
    const address = response.data?.address
    if (!response.ok || !address)
      throw new OrderlyCliError(response.error ?? 'Failed to create Solana managed wallet')
    return address
  }
}

async function signRawSolana(message: string): Promise<string> {
  const { instanceId } = resolveCredentials()
  const response = await apiPost<WalletResponse>(
    `/v1/instances/${encodeURIComponent(instanceId)}/wallet/sign`,
    {
      message,
      chainType: 'solana',
      scheme: 'raw',
    },
  )
  if (!response.ok || !response.data?.signature)
    throw new OrderlyCliError(response.error ?? 'Solana raw signing failed')
  const raw = response.data.signature
  return toBase64Url(raw)
}

async function signTypedData(
  domain: JsonRecord,
  types: JsonRecord,
  primaryType: string,
  message: JsonRecord,
): Promise<string> {
  const { instanceId } = resolveCredentials()
  const response = await apiPost<WalletResponse>(
    `/v1/instances/${encodeURIComponent(instanceId)}/wallet/sign-typed-data`,
    { domain, types, primaryType, message },
  )
  if (!response.ok || !response.data?.signature)
    throw new OrderlyCliError(response.error ?? 'EIP-712 signing failed')
  return response.data.signature
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
  context?: Identity,
): Promise<T> {
  const auth = context ?? (await identity())
  const timestamp = String(Date.now())
  const bodyText = body ? JSON.stringify(body) : ''
  const canonical = orderlyCanonicalMessage(timestamp, method, path, bodyText)
  const signature = await signRawSolana(canonical)
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': body ? 'application/json' : 'application/x-www-form-urlencoded',
      'orderly-timestamp': timestamp,
      'orderly-account-id': auth.accountId,
      'orderly-key': auth.orderlyKey,
      'orderly-signature': signature,
    },
    ...(body ? { body: bodyText } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    parsed = { message: text }
  }
  const envelope = parsed as Envelope<T>
  if (!response.ok || envelope.success === false || envelope.ok === false) {
    const data = typeof parsed === 'object' && parsed !== null ? (parsed as JsonRecord) : undefined
    throw new OrderlyCliError(
      envelope.message ??
        envelope.error ??
        asString(data?.message) ??
        `Orderly ${method} ${path} failed`,
      { status: response.status, code: envelope.code, data: parsed },
    )
  }
  return (envelope.data ?? parsed) as T
}

async function publicInfo(symbol: string): Promise<JsonRecord> {
  return record(await orderlyRequest('GET', `/v1/public/info/${encodeURIComponent(symbol)}`))
}

async function tokenMetadata(
  token: string,
  chainId: number,
): Promise<{ address: string; chainDecimals: number; ledgerDecimals: number }> {
  const response = await orderlyRequest<unknown>('GET', '/v1/public/token')
  const row = asRows(response).find(
    (item) => asString(item.token)?.toUpperCase() === token.toUpperCase(),
  )
  if (!row) throw new OrderlyCliError(`Orderly does not support token ${token}`)
  const chain = asRows(row.chain_details).find(
    (item) => Number(item.chain_id ?? item.chainId) === chainId,
  )
  const address = asString(chain?.contract_address ?? chain?.contractAddress)
  const chainDecimals = Number(chain?.decimals)
  const ledgerDecimals = Number(row.decimals)
  if (
    !address ||
    !isAddress(address) ||
    !Number.isInteger(chainDecimals) ||
    !Number.isInteger(ledgerDecimals)
  ) {
    throw new OrderlyCliError(`${token} is not executable on chain ${chainId}`)
  }
  return { address, chainDecimals, ledgerDecimals }
}

async function chainMetadata(chainId: number): Promise<JsonRecord> {
  const response = await orderlyRequest<unknown>(
    'GET',
    query('/v1/public/chain_info', { broker_id: brokerId() }),
  )
  const chain = asRows(response).find((row) => Number(row.chain_id ?? row.chainId) === chainId)
  if (!chain) throw new OrderlyCliError(`Orderly broker does not support chain ${chainId}`)
  return chain
}

function chainRpcUrl(chain: JsonRecord, chainId: number): string | undefined {
  const configured = process.env[`ORDERLY_RPC_URL_${chainId}`]
  if (configured) return configured
  for (const key of ['public_rpc_url', 'rpc_url', 'rpcUrl', 'rpc'] as const) {
    const value = asString(chain[key])
    if (value) return value
  }
  return undefined
}

async function queryDepositFee(
  rpcUrl: string | undefined,
  vault: string,
  evmAddress: string,
  input: {
    accountId: `0x${string}`
    brokerHash: `0x${string}`
    tokenHash: `0x${string}`
    tokenAmount: bigint
  },
): Promise<string | undefined> {
  if (!rpcUrl) return undefined
  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: 'getDepositFee',
    args: [evmAddress as `0x${string}`, input],
  })
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: vault, data }, 'latest'],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok)
    throw new OrderlyCliError(`Deposit-fee RPC request failed for chain ${String(vault)}`)
  const json = record(await response.json())
  if (json.error)
    throw new OrderlyCliError('Orderly vault rejected the deposit-fee quote', { data: json.error })
  const result = asString(json.result)
  if (!result) throw new OrderlyCliError('Deposit-fee RPC response has no result')
  return decodeFunctionResult({
    abi: VAULT_ABI,
    functionName: 'getDepositFee',
    data: result as `0x${string}`,
  }).toString()
}

function decimalIsMultiple(value: string, tick: unknown): boolean {
  if (typeof tick !== 'number' && typeof tick !== 'string') return true
  const normalizedTick = String(tick)
  if (!/^\d+(?:\.\d+)?$/.test(normalizedTick)) return true
  const [, fraction = ''] = normalizedTick.split('.')
  const scale = fraction.length
  try {
    const units = parseUnits(value, scale)
    const tickUnits = parseUnits(normalizedTick, scale)
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
  if (Number(quantity) < Number(info.base_min)) {
    throw new OrderlyCliError(`--quantity is below base_min ${String(info.base_min)}`)
  }
  if (
    order.order_price !== undefined &&
    Number(quantity) * Number(order.order_price) < Number(info.min_notional)
  ) {
    throw new OrderlyCliError(`Order notional is below min_notional ${String(info.min_notional)}`)
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function status(): Promise<void> {
  const result: JsonRecord = {
    publicReady: false,
    brokerConfigured: Boolean(process.env.ORDERLY_BROKER_ID),
    accountReady: false,
    keyReady: false,
    authReady: false,
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
    const current = await identity()
    result.accountReady = true
    result.keyReady = Boolean(current.solanaAddress)
    await privateRequest('GET', '/v1/client/holding', undefined, current)
    result.authReady = true
  } catch (error) {
    ;(result.reasons as string[]).push(
      error instanceof Error ? error.message : 'Managed wallet authentication unavailable',
    )
  }
  result.tradeReady =
    result.publicReady === true &&
    result.brokerConfigured === true &&
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

  const solanaAddress = await ensureSolanaWallet()
  const orderlyKey = `ed25519:${solanaAddress}`
  const registrationWireMessage = { ...registrationMessage, chainType: 'EVM' }

  const domain = {
    name: 'Orderly',
    version: '1',
    chainId,
    verifyingContract: OFFCHAIN_VERIFYING_CONTRACT,
  }
  let accountId = existing
  if (!accountId) {
    const signature = await signTypedData(
      domain,
      {
        Registration: [
          { name: 'brokerId', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'registrationNonce', type: 'uint256' },
        ],
      },
      'Registration',
      registrationMessage,
    )
    const response = await orderlyRequest<JsonRecord>('POST', '/v1/register_account', {
      message: registrationWireMessage,
      signature,
      userAddress: evmAddress,
    })
    accountId = asString(response.account_id) ?? asString(record(response.data ?? {}).account_id)
  }
  if (!accountId)
    throw new OrderlyCliError('Orderly did not return an account ID after registration')
  const keyTimestamp = Date.now()
  const addKeyMessage = {
    brokerId: broker,
    chainId,
    orderlyKey,
    scope: 'read,trading,asset',
    timestamp: keyTimestamp,
    expiration: orderlyKeyExpiration(keyTimestamp),
  }
  const addKeyWireMessage = { ...addKeyMessage, chainType: 'EVM' }
  const keySignature = await signTypedData(
    domain,
    {
      AddOrderlyKey: [
        { name: 'brokerId', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'orderlyKey', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'timestamp', type: 'uint64' },
        { name: 'expiration', type: 'uint64' },
      ],
    },
    'AddOrderlyKey',
    addKeyMessage,
  )
  await orderlyRequest('POST', '/v1/orderly_key', {
    message: addKeyWireMessage,
    signature: keySignature,
    userAddress: evmAddress,
  })
  const current: Identity = { evmAddress, solanaAddress, accountId, orderlyKey }
  const holding = await privateRequest('GET', '/v1/client/holding', undefined, current)
  print({ execute: true, accountId, orderlyKey, holding })
}

async function deposit(args: Record<string, string>): Promise<void> {
  const chainId = requiredChainId(args)
  const token = required(args, 'token').toUpperCase()
  const amount = positiveDecimal(required(args, 'amount'), 'amount')
  const identityContext = await identity()
  const chain = await chainMetadata(chainId)
  const vault = asString(chain.vault_address) ?? asString(chain.vaultAddress)
  if (!vault || !isAddress(vault))
    throw new OrderlyCliError(`Orderly chain ${chainId} has no executable EVM vault`)
  const tokenInfo = await tokenMetadata(token, chainId)
  const amountWei = parseUnits(amount, tokenInfo.chainDecimals)
  if (amountWei > MAX_UINT128)
    throw new OrderlyCliError('--amount exceeds the Orderly Vault uint128 tokenAmount limit')
  const input = {
    accountId: identityContext.accountId as `0x${string}`,
    brokerHash: keccak256(stringToHex(brokerId())),
    tokenHash: keccak256(stringToHex(token)),
    tokenAmount: amountWei,
  }
  const quotedFeeWei = await queryDepositFee(
    chainRpcUrl(chain, chainId),
    vault,
    identityContext.evmAddress,
    input,
  )
  const feeWei = args['fee-wei'] ?? quotedFeeWei
  if (!feeWei) {
    if (execute(args))
      throw new OrderlyCliError(
        `No RPC URL is available to quote the deposit fee for chain ${chainId}. Set ORDERLY_RPC_URL_${chainId} or supply the verified --fee-wei quote.`,
      )
    return print({
      execute: false,
      chainId,
      token,
      amount,
      amountWei: amountWei.toString(),
      steps: [],
      requires: `Set ORDERLY_RPC_URL_${chainId} or supply --fee-wei from a verified Vault getDepositFee quote.`,
    })
  }
  if (!/^\d+$/.test(feeWei)) throw new OrderlyCliError('--fee-wei must be an integer wei amount')
  const steps = [
    {
      kind: 'approve',
      to: tokenInfo.address,
      signature: 'approve(address,uint256)',
      args: [vault, amountWei.toString()],
      value: '0',
      chainId,
      conditional: {
        type: 'allowance_lt',
        token: tokenInfo.address,
        spender: vault,
        amount: amountWei.toString(),
      },
    },
    {
      kind: 'deposit',
      to: vault,
      signature: 'deposit((bytes32,bytes32,bytes32,uint128))',
      args: [input.accountId, input.brokerHash, input.tokenHash, amountWei.toString()],
      value: feeWei,
      chainId,
    },
  ]
  if (!execute(args))
    return print({
      execute: false,
      chainId,
      token,
      amount,
      amountWei: amountWei.toString(),
      feeWei,
      feeSource: args['fee-wei'] ? 'explicit' : 'vault_rpc',
      steps,
    })
  const { instanceId } = resolveCredentials()
  const approvalData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [vault, amountWei],
  })
  const depositData = encodeFunctionData({
    abi: DEPOSIT_ABI,
    functionName: 'deposit',
    args: [input],
  })
  const result = await apiPost<WalletStepsResponse>(
    `/v1/instances/${encodeURIComponent(instanceId)}/wallet/execute`,
    {
      steps: [
        {
          label: 'approve',
          to: tokenInfo.address,
          data: approvalData,
          value: '0',
          chainId,
          conditional: {
            type: 'allowance_lt',
            token: tokenInfo.address,
            spender: vault,
            amount: amountWei.toString(),
          },
        },
        {
          label: 'deposit',
          to: vault,
          data: depositData,
          value: feeWei,
          chainId,
        },
      ],
      dedupKey: `${instanceId}:orderly-deposit:${chainId}:${tokenInfo.address.toLowerCase()}:${amountWei.toString()}`,
    },
  )
  const results = result.data?.results
  const approval = results?.find((step) => step.label === 'approve')
  const deposited = results?.find((step) => step.label === 'deposit')
  if (!result.ok || !deposited?.hash)
    throw new OrderlyCliError(result.error ?? 'Orderly deposit transaction failed')
  print({
    execute: true,
    approveTxHash: approval?.status === 'success' ? approval.hash : null,
    approvalSkipped: approval?.status === 'skipped',
    depositTxHash: deposited.hash,
    accountId: identityContext.accountId,
  })
}

async function withdraw(args: Record<string, string>): Promise<void> {
  const chainId = requiredChainId(args)
  const token = required(args, 'token').toUpperCase()
  const amount = positiveDecimal(required(args, 'amount'), 'amount')
  const receiver = required(args, 'address')
  if (!isAddress(receiver)) throw new OrderlyCliError('--address must be a valid EVM address')
  const tokenInfo = await tokenMetadata(token, chainId)
  const context = await identity()
  const nonce = await privateRequest<JsonRecord>('GET', '/v1/withdraw_nonce', undefined, context)
  const withdrawNonce = asString(nonce.withdraw_nonce) ?? String(nonce.withdraw_nonce ?? '')
  if (!withdrawNonce) throw new OrderlyCliError('Orderly did not return a withdrawal nonce')
  const signedMessage = {
    brokerId: brokerId(),
    chainId,
    receiver,
    token,
    amount: parseUnits(amount, tokenInfo.ledgerDecimals).toString(),
    withdrawNonce,
    timestamp: Date.now(),
  }
  const message = {
    ...signedMessage,
    chainType: 'EVM',
    ...(args['allow-cross-chain'] === 'true' ? { allowCrossChainWithdraw: true } : {}),
  }
  const domain = {
    name: 'Orderly',
    version: '1',
    chainId,
    verifyingContract: API_URL.includes('testnet') ? TESTNET_LEDGER : MAINNET_LEDGER,
  }
  if (!execute(args))
    return print({
      execute: false,
      message,
      domain,
      note: 'The withdrawal nonce is short lived; execute promptly and never retry a timed-out withdrawal without checking asset-history.',
    })
  const signature = await signTypedData(
    domain,
    {
      Withdraw: [
        { name: 'brokerId', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'receiver', type: 'address' },
        { name: 'token', type: 'string' },
        { name: 'amount', type: 'uint256' },
        { name: 'withdrawNonce', type: 'uint64' },
        { name: 'timestamp', type: 'uint64' },
      ],
    },
    'Withdraw',
    signedMessage,
  )
  print(
    await privateRequest(
      'POST',
      '/v1/withdraw_request',
      {
        message,
        signature,
        userAddress: context.evmAddress,
        verifyingContract: domain.verifyingContract,
      },
      context,
    ),
  )
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
  await validateOrder(order)
  if (!execute(args))
    return print({
      execute: false,
      order,
      note: 'Reuse the same --client-order-id when executing this preview.',
    })
  print(await privateRequest('POST', '/v1/order', order))
}

async function updateOrder(args: Record<string, string>): Promise<void> {
  const body: JsonRecord = {
    order_id: required(args, 'order-id'),
    order_quantity: positiveDecimal(required(args, 'quantity'), 'quantity'),
  }
  if (args.price) body.order_price = positiveDecimal(args.price, 'price')
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
  const context = await identity()
  const position = await privateRequest<unknown>(
    'GET',
    `/v1/position/${encodeURIComponent(symbol)}`,
    undefined,
    context,
  )
  const row = record(position)
  const qty = Number(row.position_qty)
  if (!Number.isFinite(qty) || qty === 0)
    throw new OrderlyCliError(`No open position for ${symbol}`)
  const percentage = args.percentage === undefined ? 100 : Number(args.percentage)
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100)
    throw new OrderlyCliError('--percentage must be between 1 and 100')
  const order = {
    symbol,
    side: qty > 0 ? 'SELL' : 'BUY',
    order_type: 'MARKET',
    order_quantity: ((Math.abs(qty) * percentage) / 100).toString(),
    reduce_only: true,
  }
  if (!execute(args)) return print({ execute: false, position: row, order })
  print(await privateRequest('POST', '/v1/order', order, context))
}

async function createAlgo(args: Record<string, string>): Promise<void> {
  const symbol = required(args, 'symbol')
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
  const body = {
    symbol,
    algo_type: children.length === 2 ? 'TP_SL' : children[0].algo_type,
    quantity,
    trigger_price_type: 'MARK_PRICE',
    child_orders: children,
  }
  if (!execute(args)) return print({ execute: false, algoOrder: body })
  print(await privateRequest('POST', '/v1/algo/order', body))
}

async function publicQuery(type: string, args: Record<string, string>): Promise<void> {
  const body: JsonRecord = {
    type,
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.interval ? { interval: args.interval } : {}),
    ...(args['start-t'] ? { start_t: Number(args['start-t']) } : {}),
    ...(args['end-t'] ? { end_t: Number(args['end-t']) } : {}),
    ...(args.depth ? { max_depth: Number(args.depth) } : {}),
  }
  print(await orderlyRequest('POST', '/v1/public/query', body))
}

export function orderlyHelp(): string {
  return ORDERLY_USAGE
}

export async function orderlyCommand(command: string, args: Record<string, string>): Promise<void> {
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
      return print(await orderlyRequest('GET', '/v1/public/token'))
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
    case 'leverage-get':
      return print(
        await privateRequest(
          'GET',
          query('/v1/client/leverage', { symbol: required(args, 'symbol') }),
        ),
      )
    case 'leverage-set': {
      const body = { symbol: required(args, 'symbol'), leverage: optionalInt(args, 'leverage') }
      if (body.leverage === undefined || body.leverage < 1)
        throw new OrderlyCliError('Missing or invalid --leverage')
      if (!execute(args)) return print({ execute: false, leverage: body })
      return print(await privateRequest('POST', '/v1/client/leverages', body))
    }
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
