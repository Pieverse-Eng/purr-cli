import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import {
  apiGet,
  apiPost,
  resolveCredentials,
  ApiClientError,
} from '@pieverseio/purr-core/api-client'

type JsonRecord = Record<string, unknown>
type BillingKind = 'renewal' | 'credit_topup' | 'membership_purchase'
type PaymentSource = 'agent_wallet' | 'passport'

interface PaymentMethod {
  tokenId: string
  symbol: string
  aliases: string[]
  chainId: number
  chainName: string
  native: boolean
  tokenAddress?: string
  decimals: number
  paymentRail: string
}

interface QuoteAffordability {
  affordable: boolean
  reason?: 'INSUFFICIENT_TOKEN_BALANCE' | 'INSUFFICIENT_GAS' | 'UNAVAILABLE'
  recoveringPayment?: boolean
  walletAddress: string
  tokenRequiredBaseUnits: string
  tokenBalanceBaseUnits?: string
  gasRequiredWei?: string
  nativeBalanceWei?: string
}

interface BillingQuote extends PaymentMethod {
  quoteId: string
  payTo: string
  amount: string
  baseUsdAmount: string
  finalUsdAmount: string
  discountUsdAmount: string
  expiresAt: string
  affordability?: QuoteAffordability
}

interface BillingQuoteBase {
  invoiceId: string
  kind: BillingKind
  state?: string
  requiresPayment?: boolean
  benefits?: JsonRecord
}

interface PassportPaymentRequest {
  url: string
  method: 'POST'
  body: JsonRecord
}

interface WalletBillingQuoteResponse extends BillingQuoteBase {
  paymentSource?: 'agent_wallet'
  quotes: BillingQuote[]
}

interface PassportBillingQuoteResponse extends BillingQuoteBase {
  paymentSource: 'passport'
  quotes: []
  paymentRequest?: PassportPaymentRequest
}

type BillingQuoteResponse = WalletBillingQuoteResponse | PassportBillingQuoteResponse

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

export const INSTANCE_GROUP_USAGE = `Usage: purr instance <status|credits|payment-methods|billing-status|renew|topup|pawpilot-pro> [options]

Commands:
  status   Show instance billing status, renewal quote, and trusted wallet balances
  credits  Show this instance's Purrfect Claw credit balance
  payment-methods  List canonical tokens accepted for instance billing
  billing-status   Check one existing billing invoice without paying again
  renew    Renew this instance using a canonical token or automatic selection
  topup    Purchase Purrfect Claw credits
  pawpilot-pro  Purchase PawPilot Pro for this hosted instance

Examples:
  purr instance status
  purr instance credits
  purr instance payment-methods
  purr instance billing-status --invoice <invoice-id>
  purr instance renew --token usdt-bsc
  purr instance renew --token usdc-xlayer --yes
  purr instance topup --credits 100 --token usdc-monad --yes
  purr instance pawpilot-pro --payment-source agent-wallet --idempotency-key <purchase-id> --yes
  purr instance pawpilot-pro --payment-source passport --idempotency-key <purchase-id> --dry-run`

const INSTANCE_STATUS_USAGE = `Usage: purr instance status [--json]

Calls GET /v1/instances/:id/billing-status using WALLET_API_URL, WALLET_API_TOKEN,
and INSTANCE_ID. Prints billing status, quote, and trusted wallet balances.
Use --json for the raw platform response.`

const INSTANCE_CREDITS_USAGE = `Usage: purr instance credits

Shows this instance's Purrfect Claw credit balance.`

const INSTANCE_PAYMENT_METHODS_USAGE = `Usage: purr instance payment-methods

Lists canonical tokens and aliases accepted for instance renewal and credit top-up.`

const INSTANCE_BILLING_STATUS_USAGE = `Usage: purr instance billing-status --invoice <invoice-id>

Checks one existing instance-billing invoice. This command is read-only and never retries payment.`

const INSTANCE_RENEW_USAGE = `Usage: purr instance renew [--token <token-id-or-alias>] [--dry-run] [--yes]

Options:
  --token <id-or-alias>  Canonical token id or case-insensitive alias
  --dry-run              Create a quote and print the authoritative preview without paying
  --yes                  Skip interactive payment confirmation`

const INSTANCE_TOPUP_USAGE = `Usage: purr instance topup --credits <integer> [--token <token-id-or-alias>] [--dry-run] [--yes]

Options:
  --credits <integer>    Credits to purchase; minimum 100
  --token <id-or-alias>  Canonical token id or case-insensitive alias
  --dry-run              Create a quote and print the authoritative preview without paying
  --yes                  Skip interactive payment confirmation`

const INSTANCE_PAWPILOT_PRO_USAGE = `Usage: purr instance pawpilot-pro --payment-source <agent-wallet|passport> --idempotency-key <purchase-id> [--token <token-id-or-alias>] [--dry-run] [--yes]

Purchase 30 days of PawPilot Pro membership for this hosted Claw without extending hosting.
Starter/Basic receive 150 bonus credits; other plans receive membership only.

Options:
  --payment-source       Required for each purchase: agent-wallet or passport
  --idempotency-key       Reuse the same purchase ID for its preview and payment
  --token <id-or-alias>   Agent Wallet only; omit for automatic token selection
  --dry-run              Preview; required for Passport to return its public paymentRequest
  --yes                  Agent Wallet only; skip interactive payment confirmation

Passport payment is performed by official kpass skills using paymentRequest, never this CLI.
For an uncertain payment, check billing-status --invoice <invoice-id>; do not buy again.`

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  56: 'BSC',
  143: 'Monad',
  196: 'X Layer',
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

function parseBooleanFlag(args: Record<string, string>, name: string): boolean {
  const raw = args[name]
  if (raw === undefined) return false
  const normalized = raw.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${raw}" - expected true or false`)
}

function parseTopupCredits(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    throw new Error('Invalid --credits: must be an integer of at least 100')
  }
  const credits = Number(raw)
  if (!Number.isSafeInteger(credits) || credits < 100) {
    throw new Error('Invalid --credits: must be an integer of at least 100')
  }
  return credits
}

function unwrapPlatformResponse<T>(response: unknown): T {
  if (isRecord(response) && typeof response.ok === 'boolean') {
    if (!response.ok) {
      const message = extractErrorMessageFromBody(response) ?? 'Platform request failed'
      throw new PlatformResponseError(message, response)
    }
    return (Object.hasOwn(response, 'data') ? response.data : response) as T
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

async function fetchInstanceCredits(): Promise<JsonRecord> {
  const { instanceId } = resolveCredentials()
  try {
    const response = await apiGet(`/v1/instances/${instanceId}/credits`)
    return unwrapPlatformResponse<JsonRecord>(response)
  } catch (error) {
    throw toPlatformError(error)
  }
}

async function fetchPaymentMethods(): Promise<PaymentMethod[]> {
  const { instanceId } = resolveCredentials()
  try {
    const response = unwrapPlatformResponse<JsonRecord>(
      await apiGet(`/v1/instances/${instanceId}/billing/payment-methods`),
    )
    if (!Array.isArray(response.methods)) {
      throw new Error('Platform payment-method response is missing methods')
    }
    return response.methods.filter((method): method is PaymentMethod => isRecord(method))
  } catch (error) {
    throw toPlatformError(error)
  }
}

function resolvePaymentMethod(selection: string, methods: PaymentMethod[]): PaymentMethod {
  const exact = methods.find((method) => method.tokenId === selection)
  if (exact) return exact

  const normalized = selection.toLowerCase()
  const aliasMatches = methods.filter((method) =>
    method.aliases.some((alias) => alias.toLowerCase() === normalized),
  )
  if (aliasMatches.length === 1) return aliasMatches[0]

  const canonicalIds = (aliasMatches.length > 0 ? aliasMatches : methods)
    .map((method) => method.tokenId)
    .sort()
  if (aliasMatches.length > 1) {
    throw new Error(`Ambiguous token "${selection}". Use one of: ${canonicalIds.join(', ')}`)
  }
  throw new Error(`Unknown token "${selection}". Supported token IDs: ${canonicalIds.join(', ')}`)
}

function parseBillingQuote(value: unknown): BillingQuote {
  if (!isRecord(value)) throw new Error('Platform returned an invalid billing quote')
  const required = [
    'quoteId',
    'tokenId',
    'symbol',
    'chainName',
    'payTo',
    'amount',
    'baseUsdAmount',
    'finalUsdAmount',
    'discountUsdAmount',
    'expiresAt',
  ]
  if (
    required.some((key) => asString(value[key]) === undefined) ||
    !Number.isInteger(value.chainId)
  ) {
    throw new Error('Platform returned an invalid billing quote')
  }
  return value as unknown as BillingQuote
}

async function fetchUnifiedBillingQuote(input: {
  kind: BillingKind
  paymentSource?: PaymentSource
  credits?: number
  tokenId?: string
  idempotencyKey: string
}): Promise<BillingQuoteResponse> {
  const { instanceId } = resolveCredentials()
  const body: JsonRecord = { kind: input.kind }
  if (input.credits !== undefined) body.credits = input.credits
  if (input.tokenId !== undefined) body.tokenId = input.tokenId
  if (input.paymentSource !== undefined) body.paymentSource = input.paymentSource

  try {
    const response = unwrapPlatformResponse<JsonRecord>(
      await apiPost(`/v1/instances/${instanceId}/billing/quote`, body, {
        headers: { 'Idempotency-Key': input.idempotencyKey },
      }),
    )
    const invoiceId = asString(response.invoiceId)
    if (!invoiceId || !Array.isArray(response.quotes)) {
      throw new Error('Platform returned an invalid billing quote response')
    }
    const common: BillingQuoteBase = {
      invoiceId,
      kind: input.kind,
      state: asString(response.state),
      requiresPayment:
        typeof response.requiresPayment === 'boolean' ? response.requiresPayment : undefined,
      benefits: isRecord(response.benefits) ? response.benefits : undefined,
    }
    if (input.paymentSource === 'passport') {
      if (response.paymentSource !== 'passport' || response.quotes.length > 0) {
        throw new Error('Platform returned an invalid Passport payment request')
      }
      return {
        ...common,
        paymentSource: 'passport',
        quotes: [],
        paymentRequest:
          common.requiresPayment === false
            ? undefined
            : parsePassportPaymentRequest(response.paymentRequest),
      }
    }
    return {
      ...common,
      paymentSource: input.paymentSource,
      quotes: response.quotes.map(parseBillingQuote),
    }
  } catch (error) {
    throw toPlatformError(error)
  }
}

function parsePassportPaymentRequest(value: unknown): PassportPaymentRequest {
  const error = () => new Error('Platform returned an invalid Passport payment request')
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    value.method !== 'POST' ||
    !isRecord(value.body)
  ) {
    throw error()
  }
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    throw error()
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw error()
  // Copy only the public merchant contract. Instance credentials stay in apiPost.
  return { url: value.url, method: 'POST', body: value.body }
}

async function createCanonicalQuote(input: {
  kind: BillingKind
  paymentSource?: 'agent_wallet'
  credits?: number
  token?: string
  pinnedTokenId?: string
  idempotencyKey: string
}): Promise<{ response: BillingQuoteResponse; quote?: BillingQuote }> {
  const selectedTokenId =
    input.pinnedTokenId ??
    (input.token
      ? resolvePaymentMethod(input.token, await fetchPaymentMethods()).tokenId
      : undefined)
  const response = await fetchUnifiedBillingQuote({
    kind: input.kind,
    credits: input.credits,
    tokenId: selectedTokenId,
    paymentSource: input.paymentSource,
    idempotencyKey: input.idempotencyKey,
  })
  if (response.requiresPayment === false) {
    return { response }
  }
  const quote = selectedTokenId
    ? response.quotes.find((candidate) => candidate.tokenId === selectedTokenId)
    : selectAutomaticQuote(response.quotes)
  if (!quote) throw new Error('Platform returned no matching billing quote')
  return { response, quote }
}

function isStablecoinQuote(quote: BillingQuote): boolean {
  return ['USDT', 'USDC', 'U', '$U'].includes(quote.symbol.toUpperCase())
}

function selectAutomaticQuote(quotes: BillingQuote[]): BillingQuote {
  const affordable = quotes.filter((quote) => quote.affordability?.affordable === true)
  if (affordable.length === 0) {
    if (quotes.some((quote) => quote.affordability?.reason === 'UNAVAILABLE')) {
      throw new InstanceCliError(
        'Some payment methods are temporarily unavailable; no affordable quote could be confirmed.',
        4,
        { code: 'PAYMENT_METHOD_UNAVAILABLE' },
      )
    }
    throw new InstanceCliError(
      'No affordable payment quote: insufficient token balance or gas across supported methods.',
      2,
      { code: 'INSUFFICIENT_BALANCE' },
    )
  }
  for (const quote of affordable) {
    if (!Number.isFinite(Number(quote.finalUsdAmount))) {
      throw new Error('Platform returned a billing quote with an invalid final USD amount')
    }
  }
  const lowestPrice = Math.min(...affordable.map((quote) => Number(quote.finalUsdAmount)))
  let candidates = affordable.filter((quote) => Number(quote.finalUsdAmount) === lowestPrice)
  const bscCandidates = candidates.filter((quote) => quote.chainId === 56)
  if (bscCandidates.length > 0) candidates = bscCandidates
  const stablecoinCandidates = candidates.filter(isStablecoinQuote)
  if (stablecoinCandidates.length > 0) candidates = stablecoinCandidates
  return candidates.sort((left, right) => left.tokenId.localeCompare(right.tokenId))[0]
}

function assertQuoteAffordable(quote: BillingQuote): void {
  if (quote.affordability?.affordable === true) return
  const reason = quote.affordability?.reason
  if (reason === 'UNAVAILABLE') {
    throw new InstanceCliError(
      `Payment method ${quote.tokenId} is temporarily unavailable; try again later or choose another token`,
      4,
      { code: reason },
    )
  }
  const message =
    reason === 'INSUFFICIENT_GAS'
      ? `Insufficient gas for ${quote.tokenId} payment`
      : `Insufficient token balance for ${quote.tokenId} payment`
  throw new InstanceCliError(message, 2, { code: reason ?? 'INSUFFICIENT_BALANCE' })
}

async function payBillingQuote(invoiceId: string, quoteId: string): Promise<JsonRecord> {
  const { instanceId } = resolveCredentials()
  try {
    return unwrapPlatformResponse<JsonRecord>(
      await apiPost(`/v1/instances/${instanceId}/billing/pay`, { invoiceId, quoteId }),
    )
  } catch (error) {
    throw toPlatformError(error)
  }
}

async function fetchUnifiedBillingStatus(invoiceId: string): Promise<JsonRecord> {
  const { instanceId } = resolveCredentials()
  try {
    return unwrapPlatformResponse<JsonRecord>(
      await apiGet(`/v1/instances/${instanceId}/billing/${invoiceId}`),
    )
  } catch (error) {
    throw toPlatformError(error)
  }
}

function printCredits(credits: JsonRecord): void {
  console.log('Purrfect Claw credits')
  console.log(`Balance: ${asString(credits.balance) ?? 'unknown'}`)
  console.log(`Used: ${asString(credits.used) ?? 'unknown'}`)
  console.log(`Limit: ${asString(credits.limit) ?? 'unknown'}`)
}

function printPaymentMethods(methods: PaymentMethod[]): void {
  console.log('Instance billing payment methods')
  for (const method of methods) {
    console.log(
      `${method.tokenId}: ${method.symbol} on ${method.chainName} (${method.chainId})` +
        (method.aliases.length > 0 ? `; aliases: ${method.aliases.join(', ')}` : ''),
    )
  }
}

function printCanonicalQuotePreview(
  kind: BillingKind,
  quoteResponse: BillingQuoteResponse,
  quote: BillingQuote,
): void {
  const label =
    kind === 'membership_purchase'
      ? 'PawPilot Pro'
      : kind === 'renewal'
        ? 'renewal'
        : 'credit top-up'
  console.error(`Instance ${label} quote`)
  console.error(`  Invoice: ${quoteResponse.invoiceId}`)
  console.error(`  Token: ${quote.symbol} (${quote.tokenId})`)
  console.error(`  Chain: ${quote.chainId} (${quote.chainName})`)
  console.error(`  Amount: ${quote.amount} ${quote.symbol}`)
  console.error(`  Base price: $${quote.baseUsdAmount} USD`)
  console.error(`  Final price: $${quote.finalUsdAmount} USD`)
  console.error(`  Discount: $${quote.discountUsdAmount} USD`)
  console.error(`  Wallet: ${quote.affordability?.walletAddress ?? 'unknown'}`)
  console.error(`  Affordable: ${quote.affordability?.affordable === true ? 'yes' : 'no'}`)
  if (quote.affordability?.recoveringPayment) {
    console.error('  Recovery: resuming an already-started payment with the same transaction IDs')
  }
  if (quote.affordability?.reason) console.error(`  Availability: ${quote.affordability.reason}`)
  console.error(`  Quote expires: ${quote.expiresAt}`)
  if (quoteResponse.benefits) console.error(`  Benefits: ${JSON.stringify(quoteResponse.benefits)}`)
}

function printBillingOutcome(status: JsonRecord): void {
  const state = asString(status.state) ?? 'unknown'
  console.error(`Billing state: ${state}`)
  if (state === 'fulfilled') {
    console.error('Billing fulfilled.')
  } else if (state === 'confirming') {
    console.error('Payment is confirming; billing fulfillment is not complete yet.')
  } else if (state === 'quoted') {
    console.error('Payment has not been confirmed yet.')
  } else if (state === 'failed') {
    console.error('Billing failed. Check the invoice status before retrying.')
  }
}

function confirmingPaymentOutcome(payment: JsonRecord, status?: JsonRecord): JsonRecord {
  return {
    ...(status ?? {}),
    ...payment,
    state: 'confirming',
  }
}

async function enrichPaymentOutcome(invoiceId: string, payment: JsonRecord): Promise<JsonRecord> {
  try {
    const status = await fetchUnifiedBillingStatus(invoiceId)
    const state = asString(status.state)
    if (state === 'fulfilled' || state === 'failed') return status
    return confirmingPaymentOutcome(payment, status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `Billing status check failed after payment broadcast: ${message}. ` +
        'Payment remains confirming; do not submit another payment. Check the invoice status later.',
    )
    return confirmingPaymentOutcome(payment)
  }
}

async function handleCanonicalBillingCommand(input: {
  kind: BillingKind
  paymentSource?: 'agent_wallet'
  idempotencyKey?: string
  credits?: number
  token?: string
  dryRun: boolean
  yes: boolean
}): Promise<void> {
  const billingIdempotencyKey = input.idempotencyKey ?? randomUUID()
  const { response, quote } = await createCanonicalQuote({
    kind: input.kind,
    paymentSource: input.paymentSource,
    credits: input.credits,
    token: input.token,
    idempotencyKey: billingIdempotencyKey,
  })
  if (response.requiresPayment === false) {
    printBillingOutcome(response as unknown as JsonRecord)
    console.log(JSON.stringify(response, null, 2))
    return
  }
  if (!quote) throw new Error('Platform returned no matching billing quote')
  printCanonicalQuotePreview(input.kind, response, quote)

  if (input.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          invoiceId: response.invoiceId,
          kind: input.kind,
          paymentSource: input.paymentSource,
          benefits: response.benefits,
          quote,
        },
        null,
        2,
      ),
    )
    return
  }

  assertQuoteAffordable(quote)
  const confirmation = input.yes ? undefined : createConfirmationSession()
  try {
    if (confirmation && !(await confirmation.ask())) {
      throw new InstanceCliError('Aborted.', 1)
    }

    let paidInvoiceId = response.invoiceId
    let payment: JsonRecord
    try {
      payment = await payBillingQuote(response.invoiceId, quote.quoteId)
    } catch (error) {
      if (input.kind === 'membership_purchase') {
        console.error(
          `Check the original Invoice with: purr instance billing-status --invoice ${response.invoiceId}`,
        )
        throw error
      }
      if (!isStaleQuoteError(error)) throw error
      console.error('Billing quote was stale or expired; retrying once with a fresh quote.')
      const retry = await createCanonicalQuote({
        kind: input.kind,
        credits: input.credits,
        pinnedTokenId: quote.tokenId,
        idempotencyKey: billingIdempotencyKey,
      })
      if (!retry.quote) {
        printBillingOutcome(retry.response as unknown as JsonRecord)
        console.log(JSON.stringify(retry.response, null, 2))
        return
      }
      printCanonicalQuotePreview(input.kind, retry.response, retry.quote)
      assertQuoteAffordable(retry.quote)
      if (confirmation && !(await confirmation.ask())) {
        throw new InstanceCliError('Aborted.', 1)
      }
      payment = await payBillingQuote(retry.response.invoiceId, retry.quote.quoteId)
      paidInvoiceId = retry.response.invoiceId
    }

    const outcome = await enrichPaymentOutcome(paidInvoiceId, payment)
    printBillingOutcome(outcome)
    console.log(JSON.stringify(outcome, null, 2))
  } finally {
    confirmation?.close()
  }
}

async function handlePassportMembershipPreview(idempotencyKey: string): Promise<void> {
  const response = await fetchUnifiedBillingQuote({
    kind: 'membership_purchase',
    paymentSource: 'passport',
    idempotencyKey,
  })
  if (response.requiresPayment === false) {
    printBillingOutcome(response as unknown as JsonRecord)
    console.log(JSON.stringify(response, null, 2))
    return
  }
  console.error(
    'PawPilot Pro Passport preview; use official kpass skills to approve and pay this Invoice.',
  )
  console.log(JSON.stringify({ dryRun: true, ...response }, null, 2))
}

function formatChainId(chainId: number): string {
  const name = CHAIN_NAMES[chainId]
  return name ? `${chainId} (${name})` : String(chainId)
}

function formatPlan(status: JsonRecord): string {
  const plan = status.plan
  if (typeof plan === 'string') return plan
  if (isRecord(plan)) {
    return asString(plan.name) ?? asString(plan.slug) ?? asString(plan.id) ?? JSON.stringify(plan)
  }
  return 'unknown'
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

function createConfirmationSession(): { ask: () => Promise<boolean>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answers: string[] = []
  const waiters: Array<(answer: string) => void> = []
  let closed = false

  rl.on('line', (answer) => {
    const waiter = waiters.shift()
    if (waiter) waiter(answer)
    else answers.push(answer)
  })
  rl.on('close', () => {
    closed = true
    for (const waiter of waiters.splice(0)) waiter('')
  })

  return {
    ask: async () => {
      process.stderr.write('Proceed? [y/N] ')
      const answer =
        answers.shift() ??
        (closed
          ? ''
          : await new Promise<string>((resolve) => {
              waiters.push(resolve)
            }))
      const normalized = answer.trim().toLowerCase()
      return normalized === 'y' || normalized === 'yes'
    },
    close: () => rl.close(),
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

  if (command === 'credits') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_CREDITS_USAGE)
      return
    }
    printCredits(await fetchInstanceCredits())
    return
  }

  if (command === 'payment-methods') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_PAYMENT_METHODS_USAGE)
      return
    }
    printPaymentMethods(await fetchPaymentMethods())
    return
  }

  if (command === 'billing-status') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_BILLING_STATUS_USAGE)
      return
    }
    const invoiceId = args.invoice?.trim()
    if (!invoiceId) throw new Error('billing-status requires --invoice <invoice-id>')
    console.log(JSON.stringify(await fetchUnifiedBillingStatus(invoiceId), null, 2))
    return
  }

  if (command === 'renew') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_RENEW_USAGE)
      return
    }
    if (args['chain-id'] !== undefined || args['token-address'] !== undefined) {
      throw new Error(
        'renew uses the standard payment flow; use --token <token-id> or omit it for automatic selection',
      )
    }
    await handleCanonicalBillingCommand({
      kind: 'renewal',
      token: args.token,
      dryRun: parseBooleanFlag(args, 'dry-run'),
      yes: parseBooleanFlag(args, 'yes'),
    })
    return
  }

  if (command === 'pawpilot-pro') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_PAWPILOT_PRO_USAGE)
      return
    }
    const source = args['payment-source']
    if (source !== 'agent-wallet' && source !== 'passport') {
      throw new Error('pawpilot-pro requires --payment-source agent-wallet|passport')
    }
    const idempotencyKey = args['idempotency-key']?.trim()
    if (!idempotencyKey) throw new Error('pawpilot-pro requires --idempotency-key <purchase-id>')
    const dryRun = parseBooleanFlag(args, 'dry-run')
    const yes = parseBooleanFlag(args, 'yes')
    if (args['chain-id'] !== undefined || args['token-address'] !== undefined) {
      throw new Error('pawpilot-pro accepts canonical --token IDs for Agent Wallet only')
    }
    if (source === 'passport') {
      if (args.token !== undefined) {
        throw new Error('Passport does not accept --token; use its public paymentRequest')
      }
      if (yes) {
        throw new Error(
          'Passport does not accept --yes; approve payment through official kpass skills',
        )
      }
      if (!dryRun)
        throw new Error('Passport requires --dry-run to return its public paymentRequest')
      await handlePassportMembershipPreview(idempotencyKey)
    } else {
      await handleCanonicalBillingCommand({
        kind: 'membership_purchase',
        paymentSource: 'agent_wallet',
        idempotencyKey,
        token: args.token,
        dryRun,
        yes,
      })
    }
    return
  }

  if (command === 'topup') {
    if (args.help === 'true' || args.h === 'true') {
      console.log(INSTANCE_TOPUP_USAGE)
      return
    }
    if (args['chain-id'] !== undefined || args['token-address'] !== undefined) {
      throw new Error('topup accepts --token only; token addresses are not accepted')
    }
    await handleCanonicalBillingCommand({
      kind: 'credit_topup',
      credits: parseTopupCredits(args.credits),
      token: args.token,
      dryRun: parseBooleanFlag(args, 'dry-run'),
      yes: parseBooleanFlag(args, 'yes'),
    })
    return
  }

  throw new Error(
    `Unknown instance command: ${command}. Use: status, credits, payment-methods, billing-status, renew, topup, pawpilot-pro`,
  )
}
