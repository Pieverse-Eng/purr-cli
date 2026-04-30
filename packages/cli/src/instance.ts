import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { apiGet, apiPost, resolveCredentials, ApiClientError } from '@pieverseio/purr-core/api-client'

type JsonRecord = Record<string, unknown>

interface RenewOptions {
  chainId: number
  tokenAddress?: string
  dryRun: boolean
  yes: boolean
}

class PlatformResponseError extends Error {
  readonly body: unknown

  constructor(message: string, body: unknown) {
    super(message)
    this.name = 'PlatformResponseError'
    this.body = body
  }
}

export class InstanceCliError extends Error {
  readonly exitCode: number
  readonly code?: string
  readonly status?: number

  constructor(message: string, exitCode: number, options: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'InstanceCliError'
    this.exitCode = exitCode
    this.code = options.code
    this.status = options.status
  }
}

export const INSTANCE_GROUP_USAGE = `Usage: purr instance <status|renew> [options]

Commands:
  status   Show instance billing status, renewal quote, and trusted wallet balances
  renew    Renew this instance using the platform-managed trusted wallet

Examples:
  purr instance status
  purr instance renew --chain-id 56 --token-address 0x55d398326f99059fF775485246999027B3197955
  purr instance renew --chain-id 56 --token-address 0x55d398326f99059fF775485246999027B3197955 --yes
  purr instance renew --chain-id 8453 --dry-run`

const INSTANCE_STATUS_USAGE = `Usage: purr instance status [--json]

Calls GET /v1/instances/:id/billing-status using WALLET_API_URL, WALLET_API_TOKEN,
and INSTANCE_ID. Prints billing status, quote, trusted wallet balances, and
ready-to-renew state. Use --json for the raw platform response.`

const INSTANCE_RENEW_USAGE = `Usage: purr instance renew --chain-id <id> [--token-address 0x...] [--dry-run] [--yes]

Options:
  --chain-id <id>        Required EIP-155 numeric chain id, e.g. 56 for BSC
  --token-address <hex>  Optional ERC20 contract address. Omit for native token
  --dry-run             Fetch billing status and print the renewal preview only
  --yes                 Skip interactive payment confirmation`

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  56: 'BSC',
  8453: 'Base',
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function parsePositiveChainId(raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error('Missing required argument: --chain-id')
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid --chain-id: "${raw}" - must be a positive integer`)
  }
  const chainId = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid --chain-id: "${raw}" - must be a positive integer`)
  }
  return chainId
}

function parseTokenAddress(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    throw new Error(`Invalid --token-address: "${raw}" - must be a 0x-prefixed hex address`)
  }
  return raw
}

function parseBooleanFlag(args: Record<string, string>, name: string): boolean {
  const raw = args[name]
  if (raw === undefined) return false
  const normalized = raw.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${raw}" - expected true or false`)
}

function parseRenewOptions(args: Record<string, string>): RenewOptions {
  return {
    chainId: parsePositiveChainId(args['chain-id']),
    tokenAddress: parseTokenAddress(args['token-address']),
    dryRun: parseBooleanFlag(args, 'dry-run'),
    yes: parseBooleanFlag(args, 'yes'),
  }
}

function unwrapPlatformResponse<T>(response: unknown): T {
  if (isRecord(response) && typeof response.ok === 'boolean') {
    if (!response.ok) {
      const message = extractErrorMessageFromBody(response) ?? 'Platform request failed'
      throw new PlatformResponseError(message, response)
    }
    return (Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response) as T
  }
  return response as T
}

function platformErrorBody(error: unknown): unknown {
  if (error instanceof ApiClientError) return error.body
  if (error instanceof PlatformResponseError) return error.body
  return undefined
}

function nestedError(body: unknown): unknown {
  if (!isRecord(body)) return undefined
  return body.error
}

function extractErrorCodeFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const err = nestedError(body)
  if (isRecord(err)) return asString(err.code)
  return asString(body.code)
}

function extractErrorMessageFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const err = nestedError(body)
  if (typeof err === 'string') return err
  if (isRecord(err)) return asString(err.message) ?? asString(err.error)
  return asString(body.message) ?? asString(body.error)
}

function mapPlatformExitCode(code: string | undefined, message: string, status?: number): number {
  const haystack = `${code ?? ''} ${message}`.toUpperCase()
  if (
    haystack.includes('INSUFFICIENT_BALANCE') ||
    haystack.includes('INSUFFICIENT_FUNDS') ||
    status === 402
  ) {
    return 2
  }
  if (haystack.includes('INELIGIBLE') || haystack.includes('NOT_RENEWABLE')) {
    return 3
  }
  return 4
}

function toPlatformError(error: unknown): InstanceCliError {
  if (error instanceof InstanceCliError) return error

  const body = platformErrorBody(error)
  const code = extractErrorCodeFromBody(body)
  const message =
    extractErrorMessageFromBody(body) ?? (error instanceof Error ? error.message : String(error))
  const status = error instanceof ApiClientError ? error.status : undefined
  const exitCode = mapPlatformExitCode(code, message, status)
  return new InstanceCliError(message, exitCode, { code, status })
}

function isStaleQuoteError(error: unknown): boolean {
  const code = error instanceof InstanceCliError ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  const haystack = `${code ?? ''} ${message}`.toUpperCase()
  return (
    haystack.includes('STALE_QUOTE') ||
    haystack.includes('QUOTE_EXPIRED') ||
    haystack.includes('EXPIRED_QUOTE')
  )
}

async function fetchBillingStatus(): Promise<JsonRecord> {
  const { instanceId } = resolveCredentials()
  try {
    const response = await apiGet(`/v1/instances/${instanceId}/billing-status`)
    return unwrapPlatformResponse<JsonRecord>(response)
  } catch (error) {
    throw toPlatformError(error)
  }
}

async function postRenewOnce(options: RenewOptions, idempotencyKey: string): Promise<JsonRecord> {
  const { instanceId } = resolveCredentials()
  const body: JsonRecord = { chainId: options.chainId }
  if (options.tokenAddress) body.tokenAddress = options.tokenAddress

  try {
    const response = await apiPost(`/v1/instances/${instanceId}/renew`, body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    })
    return unwrapPlatformResponse<JsonRecord>(response)
  } catch (error) {
    throw toPlatformError(error)
  }
}

async function postRenewWithStaleRetry(options: RenewOptions): Promise<JsonRecord> {
  try {
    return await postRenewOnce(options, randomUUID())
  } catch (error) {
    if (!isStaleQuoteError(error)) throw error
    console.error('Renewal quote was stale; retrying once with a fresh quote.')
    return await postRenewOnce(options, randomUUID())
  }
}

function formatChainId(chainId: number): string {
  const name = CHAIN_NAMES[chainId]
  return name ? `${chainId} (${name})` : String(chainId)
}

function tokenMatches(value: unknown, tokenAddress: string | undefined): boolean {
  const raw = asString(value)
  if (!tokenAddress) return raw === undefined || raw.toLowerCase() === 'native'
  return raw?.toLowerCase() === tokenAddress.toLowerCase()
}

function findWallet(status: JsonRecord, chainId: number): JsonRecord | undefined {
  const wallets = Array.isArray(status.agentWallets) ? status.agentWallets : []
  return wallets.find(
    (wallet): wallet is JsonRecord =>
      isRecord(wallet) && Number(wallet.chainId) === chainId && typeof wallet.address === 'string',
  )
}

function findBalance(wallet: JsonRecord | undefined, tokenAddress: string | undefined): string {
  if (!wallet || !Array.isArray(wallet.balances)) return 'unknown'
  const balance = wallet.balances.find(
    (item): item is JsonRecord => isRecord(item) && tokenMatches(item.tokenAddress, tokenAddress),
  )
  if (!balance) return 'unknown'

  const amount =
    asString(balance.amount) ?? asString(balance.balanceFormatted) ?? asString(balance.balance)
  const symbol = asString(balance.symbol) ?? asString(balance.currency)
  if (amount && symbol) return `${amount} ${symbol}`
  return amount ?? 'unknown'
}

function nestedValue(record: JsonRecord, path: string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function renewalAmount(status: JsonRecord): string {
  const paths = [
    ['amount'],
    ['renewalAmount'],
    ['paymentAmount'],
    ['quote', 'amount'],
    ['renewalQuote', 'amount'],
    ['billingStatus', 'amount'],
  ]
  for (const path of paths) {
    const value = asString(nestedValue(status, path))
    if (value) return value
  }
  const usd = asString(status.effectiveRenewalPriceUsd) ?? asString(status.renewalPriceUsd)
  return usd ? `$${usd} USD` : 'unknown'
}

function formatPlan(status: JsonRecord): string {
  const plan = status.plan
  if (typeof plan === 'string') return plan
  if (isRecord(plan)) {
    return asString(plan.name) ?? asString(plan.slug) ?? asString(plan.id) ?? JSON.stringify(plan)
  }
  return 'unknown'
}

function formatReady(status: JsonRecord): string {
  const ready = status.readyToRenew ?? status.readyForRenewal ?? status.ready
  if (typeof ready === 'boolean') return ready ? 'yes' : 'no'
  return asString(ready) ?? 'unknown'
}

function printRenewalPreview(status: JsonRecord, options: RenewOptions): void {
  const wallet = findWallet(status, options.chainId)
  const payer = asString(wallet?.address) ?? asString(status.payerWallet) ?? 'unknown'
  const token = options.tokenAddress ?? 'native'

  console.error('Instance renewal preview')
  console.error(`  Status: ${asString(status.status) ?? 'unknown'}`)
  console.error(`  Plan: ${formatPlan(status)}`)
  console.error(`  Next billing date: ${asString(status.nextBillingDate) ?? 'unknown'}`)
  console.error(`  Ready to renew: ${formatReady(status)}`)
  console.error(`  Chain: ${formatChainId(options.chainId)}`)
  console.error(`  Token: ${token}`)
  console.error(`  Amount: ${renewalAmount(status)}`)
  console.error(`  Payer wallet: ${payer}`)
  console.error(`  Balance: ${findBalance(wallet, options.tokenAddress)}`)
}

function formatRenewalPrice(status: JsonRecord): string {
  const value = asString(status.effectiveRenewalPriceUsd) ?? asString(status.renewalPriceUsd)
  return value ? `$${value} USD` : 'unknown'
}

function formatBalance(balance: JsonRecord): string {
  const amount =
    asString(balance.amount) ?? asString(balance.balanceFormatted) ?? asString(balance.balance)
  const symbol = asString(balance.symbol) ?? asString(balance.currency)
  const token = asString(balance.tokenAddress) ?? 'native'
  if (amount && symbol) return `${amount} ${symbol} (${token})`
  if (amount) return `${amount} (${token})`
  return `unknown (${token})`
}

function printBillingStatus(status: JsonRecord): void {
  console.log(`Status: ${asString(status.status) ?? 'unknown'}`)
  console.log(`Next billing date: ${asString(status.nextBillingDate) ?? 'unknown'}`)
  console.log(`Plan: ${formatPlan(status)}`)
  console.log(`Renewal price: ${formatRenewalPrice(status)}`)
  console.log(`Ready to renew: ${formatReady(status)}`)
  console.log('Agent wallets:')

  const wallets = Array.isArray(status.agentWallets) ? status.agentWallets : []
  if (wallets.length === 0) {
    console.log('  none')
    return
  }

  for (const wallet of wallets) {
    if (!isRecord(wallet)) continue
    const chainId = Number(wallet.chainId)
    const chain = Number.isFinite(chainId) ? formatChainId(chainId) : 'unknown'
    console.log(`  - Chain ${chain}: ${asString(wallet.address) ?? 'unknown'}`)
    const balances = Array.isArray(wallet.balances) ? wallet.balances : []
    if (balances.length === 0) {
      console.log('    balances: none')
      continue
    }
    for (const balance of balances) {
      if (isRecord(balance)) console.log(`    balance: ${formatBalance(balance)}`)
    }
  }
}

async function confirmProceed(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('Proceed? [y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

export async function handleInstanceCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    console.log(INSTANCE_GROUP_USAGE)
    return
  }

  if (command === 'status') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_STATUS_USAGE)
      return
    }
    const status = await fetchBillingStatus()
    if (parseBooleanFlag(args, 'json')) {
      console.log(JSON.stringify(status, null, 2))
    } else {
      printBillingStatus(status)
    }
    return
  }

  if (command === 'renew') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_RENEW_USAGE)
      return
    }
    const options = parseRenewOptions(args)
    const status = await fetchBillingStatus()
    printRenewalPreview(status, options)

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            chainId: options.chainId,
            ...(options.tokenAddress ? { tokenAddress: options.tokenAddress } : {}),
            billingStatus: status,
          },
          null,
          2,
        ),
      )
      return
    }

    if (!options.yes && !(await confirmProceed())) {
      throw new InstanceCliError('Aborted.', 1)
    }

    const result = await postRenewWithStaleRetry(options)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  throw new Error(`Unknown instance command: ${command}. Use: status, renew`)
}
