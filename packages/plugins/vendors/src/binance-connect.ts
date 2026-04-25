/**
 * Binance Connect fiat on/off-ramp client for purr CLI.
 *
 * RSA-signed HTTP client for Binance Connect API endpoints.
 *
 * Auth headers (from Binance docs):
 *   X-Tesla-ClientId       — partner client ID
 *   X-Tesla-SignAccessToken — access token
 *   X-Tesla-Timestamp      — ms timestamp
 *   X-Tesla-Signature      — SHA256withRSA(body + timestamp, privateKey)
 *
 * Env vars:
 *   BINANCE_CONNECT_CLIENT_ID    — X-Tesla-ClientId
 *   BINANCE_CONNECT_ACCESS_TOKEN — X-Tesla-SignAccessToken
 *   BINANCE_CONNECT_PRIVATE_KEY  — RSA private key (PEM)
 *   BINANCE_CONNECT_BASE_URL     — API base URL (provided by Binance team)
 *   INSTANCE_ID                  — (optional) embedded in auto-generated order IDs for webhook routing
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
        'These are provided by the Binance Connect team during partner onboarding.',
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

async function request(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const { clientId, accessToken, privateKey, baseUrl } = getConfig()
  const timestamp = String(Date.now())
  const bodyStr = body ? JSON.stringify(body) : '{}'
  const signature = signPayload(bodyStr, timestamp, privateKey)

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tesla-ClientId': clientId,
      'X-Tesla-SignAccessToken': accessToken,
      'X-Tesla-Timestamp': timestamp,
      'X-Tesla-Signature': signature,
    },
    body: bodyStr,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Binance Connect HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  const json = (await res.json()) as ApiResponse
  if (json.code && json.code !== '000000') {
    throw new Error(`Binance Connect error ${json.code}: ${json.message ?? JSON.stringify(json)}`)
  }

  return json.data ?? json
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const BASE = '/papi/v1/ramp/connect'
const BUY = `${BASE}/buy`

export async function getTradingPairs(): Promise<unknown> {
  return request(`${BUY}/trading-pairs`)
}

export async function getNetworks(): Promise<unknown> {
  return request(`${BASE}/crypto-network`)
}

export async function getQuote(args: {
  fiatCurrency: string
  cryptoCurrency: string
  fiatAmount: string
  network?: string
  paymentMethod?: string
}): Promise<unknown> {
  return request(`${BUY}/estimated-quote`, {
    fiatCurrency: args.fiatCurrency,
    cryptoCurrency: args.cryptoCurrency,
    requestedAmount: args.fiatAmount,
    amountType: 1,
    ...(args.network != null && { network: args.network }),
    ...(args.paymentMethod != null && { payMethodCode: args.paymentMethod }),
  })
}

export async function createOrder(args: {
  fiatCurrency: string
  cryptoCurrency: string
  fiatAmount: string
  cryptoNetwork: string
  walletAddress: string
  externalOrderId?: string
  paymentMethod?: string
}): Promise<unknown> {
  const instanceId = process.env.INSTANCE_ID ?? 'unknown'
  // externalOrderId must be alphanumeric only per Binance docs
  const externalOrderId =
    args.externalOrderId ??
    `oc${instanceId.replace(/-/g, '')}${Date.now()}${randomUUID().slice(0, 8).replace(/-/g, '')}`

  return request(`${BUY}/pre-order`, {
    fiatCurrency: args.fiatCurrency,
    cryptoCurrency: args.cryptoCurrency,
    requestedAmount: args.fiatAmount,
    amountType: 1,
    network: args.cryptoNetwork,
    address: args.walletAddress,
    externalOrderId,
    ...(args.paymentMethod != null && { payMethodCode: args.paymentMethod }),
  })
}

export async function queryOrder(orderId: string): Promise<unknown> {
  return request(`${BASE}/order`, { externalOrderId: orderId })
}
