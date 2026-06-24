/**
 * Binance Onchain Pay fiat on/off-ramp client for purr CLI.
 *
 * RSA-signed HTTP client for Binance Onchain Pay API endpoints.
 *
 * Auth headers (from Binance docs):
 *   X-Tesla-ClientId       — partner client ID
 *   X-Tesla-SignAccessToken — access token
 *   X-Tesla-Timestamp      — ms timestamp
 *   X-Tesla-Signature      — SHA256withRSA(body + timestamp, privateKey)
 *
 * Env vars:
 *   BINANCE_CONNECT_CLIENT_ID       — X-Tesla-ClientId
 *   BINANCE_CONNECT_ACCESS_TOKEN    — X-Tesla-SignAccessToken
 *   BINANCE_CONNECT_PRIVATE_KEY     — RSA private key (PEM)
 *   BINANCE_CONNECT_BASE_URL        — API base URL (provided by Binance team)
 *   BINANCE_CONNECT_MERCHANT_CODE   — optional default pre-order merchantCode
 *   BINANCE_CONNECT_MERCHANT_NAME   — optional default pre-order merchantName
 *   INSTANCE_ID                     — optional externalOrderId namespace for webhook routing
 */

import { createSign, randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig() {
  const clientId = process.env.BINANCE_CONNECT_CLIENT_ID
  const accessToken = process.env.BINANCE_CONNECT_ACCESS_TOKEN
  const privateKey = process.env.BINANCE_CONNECT_PRIVATE_KEY
  const baseUrl = process.env.BINANCE_CONNECT_BASE_URL

  if (!clientId || !accessToken || !privateKey || !baseUrl) {
    const missing = [
      !clientId && 'BINANCE_CONNECT_CLIENT_ID',
      !accessToken && 'BINANCE_CONNECT_ACCESS_TOKEN',
      !privateKey && 'BINANCE_CONNECT_PRIVATE_KEY',
      !baseUrl && 'BINANCE_CONNECT_BASE_URL',
    ].filter(Boolean)
    throw new Error(
      `Missing env vars: ${missing.join(', ')}. ` +
        'These are provided during Binance Onchain Pay partner onboarding.',
    )
  }

  return { clientId, accessToken, privateKey, baseUrl: baseUrl.replace(/\/+$/, '') }
}

// ---------------------------------------------------------------------------
// RSA signing
// ---------------------------------------------------------------------------

/**
 * Sign with SHA256withRSA.
 *
 * Per Binance docs, the signed payload is: jsonBody + timestamp (concatenated).
 * The private key signs this string, result is base64-encoded.
 */
function signPayload(body: string, timestamp: string, privateKeyPem: string): string {
  const signer = createSign('SHA256')
  signer.update(body + timestamp)
  return signer.sign(privateKeyPem, 'base64')
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

interface ApiResponse {
  success?: boolean
  code?: string
  data?: unknown
  message?: string
}

type AmountType = 1 | 2

function hasRequestBody(
  body: Record<string, unknown> | undefined,
): body is Record<string, unknown> {
  return body != null && Object.keys(body).length > 0
}

async function request(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const { clientId, accessToken, privateKey, baseUrl } = getConfig()
  const timestamp = String(Date.now())
  const withBody = hasRequestBody(body)
  const bodyStr = withBody ? JSON.stringify(body) : ''
  const signature = signPayload(bodyStr, timestamp, privateKey)

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tesla-ClientId': clientId,
      'X-Tesla-SignAccessToken': accessToken,
      'X-Tesla-Timestamp': timestamp,
      'X-Tesla-Signature': signature,
      'User-Agent': 'onchain-pay-open-api/0.1.2 (Skill)',
    },
    ...(withBody ? { body: bodyStr } : {}),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Binance Onchain Pay HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  const json = (await res.json()) as ApiResponse
  if (json.code && json.code !== '000000') {
    throw new Error(
      `Binance Onchain Pay error ${json.code}: ${json.message ?? JSON.stringify(json)}`,
    )
  }

  return json.data ?? json
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const BASE = '/papi/v1/ramp/connect'
const BUY = `${BASE}/buy`
const BUY_V2 = '/papi/v2/ramp/connect/buy'

function appendExternalOrderId(result: unknown, externalOrderId: string): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, externalOrderId }
  }
  return { externalOrderId, data: result }
}

export async function getTradingPairs(): Promise<unknown> {
  return request(`${BUY}/trading-pairs`)
}

export async function getNetworks(): Promise<unknown> {
  return request(`${BASE}/crypto-network`)
}

export async function getP2PTradingPairs(args: { fiatCurrency?: string } = {}): Promise<unknown> {
  return request(`${BUY}/p2p/trading-pairs`, {
    ...(args.fiatCurrency != null && { fiatCurrency: args.fiatCurrency }),
  })
}

export async function getPaymentMethods(
  args: {
    fiatCurrency?: string
    cryptoCurrency?: string
    totalAmount?: number
    amountType?: AmountType
    network?: string
    contractAddress?: string
    lang?: string
  } = {},
): Promise<unknown> {
  const scopedRequest =
    args.fiatCurrency != null ||
    args.cryptoCurrency != null ||
    args.totalAmount != null ||
    args.amountType != null ||
    args.network != null ||
    args.contractAddress != null

  if (!scopedRequest) {
    return request(`${BUY_V2}/payment-method-list`, {
      ...(args.lang != null && { lang: args.lang }),
    })
  }

  if (
    !args.fiatCurrency ||
    !args.cryptoCurrency ||
    args.totalAmount == null ||
    args.amountType == null
  ) {
    throw new Error(
      'Payment method lookup requires --fiat, --crypto, --total-amount, and --amount-type when using pair-specific filters',
    )
  }

  return request(`${BUY}/payment-method-list`, {
    fiatCurrency: args.fiatCurrency,
    cryptoCurrency: args.cryptoCurrency,
    totalAmount: args.totalAmount,
    amountType: args.amountType,
    ...(args.network != null && { network: args.network }),
    ...(args.contractAddress != null && { contractAddress: args.contractAddress }),
  })
}

export async function getQuote(args: {
  fiatCurrency: string
  requestedAmount: number
  payMethodCode: string
  amountType: AmountType
  cryptoCurrency?: string
  network?: string
  address?: string
  contractAddress?: string
}): Promise<unknown> {
  if (args.amountType == null) {
    throw new Error('Estimated quote requires --amount-type')
  }

  return request(`${BUY}/estimated-quote`, {
    fiatCurrency: args.fiatCurrency,
    requestedAmount: args.requestedAmount,
    payMethodCode: args.payMethodCode,
    amountType: args.amountType,
    ...(args.cryptoCurrency != null && { cryptoCurrency: args.cryptoCurrency }),
    ...(args.network != null && { network: args.network }),
    ...(args.address != null && { address: args.address }),
    ...(args.contractAddress != null && { contractAddress: args.contractAddress }),
  })
}

export async function createOrder(args: {
  externalOrderId?: string
  merchantCode?: string
  merchantName?: string
  ts?: number
  fiatCurrency?: string
  fiatAmount?: number
  cryptoCurrency?: string
  requestedAmount?: number
  amountType?: AmountType
  address?: string
  network?: string
  payMethodCode?: string
  payMethodSubCode?: string
  redirectUrl?: string
  failRedirectUrl?: string
  redirectDeepLink?: string
  failRedirectDeepLink?: string
  contractAddress?: string
  customization?: Record<string, unknown>
  destContractAddress?: string
  destContractABI?: string
  destContractParams?: Record<string, unknown>
  affiliateCode?: string
  gtrTemplateCode?: string
}): Promise<unknown> {
  const instanceId = process.env.INSTANCE_ID ?? 'unknown'
  const externalOrderId =
    args.externalOrderId ??
    `oc_${instanceId}_${Date.now()}_${randomUUID().slice(0, 8).replace(/-/g, '')}`
  const merchantCode = args.merchantCode ?? process.env.BINANCE_CONNECT_MERCHANT_CODE
  const merchantName = args.merchantName ?? process.env.BINANCE_CONNECT_MERCHANT_NAME

  if (!merchantCode) {
    throw new Error('Pre-order requires --merchant-code or BINANCE_CONNECT_MERCHANT_CODE')
  }
  if (!merchantName) {
    throw new Error('Pre-order requires --merchant-name or BINANCE_CONNECT_MERCHANT_NAME')
  }
  if (args.fiatAmount == null && (args.requestedAmount == null || args.amountType == null)) {
    throw new Error('Pre-order requires --fiat-amount or both --requested-amount and --amount-type')
  }

  const result = await request(`${BUY}/pre-order`, {
    externalOrderId,
    ts: args.ts ?? Date.now(),
    ...(merchantCode != null && { merchantCode }),
    ...(merchantName != null && { merchantName }),
    ...(args.fiatCurrency != null && { fiatCurrency: args.fiatCurrency }),
    ...(args.fiatAmount != null && { fiatAmount: args.fiatAmount }),
    ...(args.cryptoCurrency != null && { cryptoCurrency: args.cryptoCurrency }),
    ...(args.requestedAmount != null && { requestedAmount: args.requestedAmount }),
    ...(args.amountType != null && { amountType: args.amountType }),
    ...(args.address != null && { address: args.address }),
    ...(args.network != null && { network: args.network }),
    ...(args.payMethodCode != null && { payMethodCode: args.payMethodCode }),
    ...(args.payMethodSubCode != null && { payMethodSubCode: args.payMethodSubCode }),
    ...(args.redirectUrl != null && { redirectUrl: args.redirectUrl }),
    ...(args.failRedirectUrl != null && { failRedirectUrl: args.failRedirectUrl }),
    ...(args.redirectDeepLink != null && { redirectDeepLink: args.redirectDeepLink }),
    ...(args.failRedirectDeepLink != null && { failRedirectDeepLink: args.failRedirectDeepLink }),
    ...(args.contractAddress != null && { contractAddress: args.contractAddress }),
    ...(args.customization != null && { customization: args.customization }),
    ...(args.destContractAddress != null && { destContractAddress: args.destContractAddress }),
    ...(args.destContractABI != null && { destContractABI: args.destContractABI }),
    ...(args.destContractParams != null && { destContractParams: args.destContractParams }),
    ...(args.affiliateCode != null && { affiliateCode: args.affiliateCode }),
    ...(args.gtrTemplateCode != null && { gtrTemplateCode: args.gtrTemplateCode }),
  })

  return appendExternalOrderId(result, externalOrderId)
}

export async function queryOrder(externalOrderId: string): Promise<unknown> {
  return request(`${BASE}/order`, { externalOrderId })
}
