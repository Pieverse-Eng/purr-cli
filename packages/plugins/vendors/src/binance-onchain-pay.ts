/**
 * Binance Onchain Pay fiat on/off-ramp client for purr CLI.
 *
 * All provider authentication and RSA signing lives in the platform Binance
 * Connect broker. The CLI authenticates with its existing per-instance
 * platform credentials and never reads reusable Binance credentials.
 *
 * Env vars:
 *   WALLET_API_URL                  — platform API base URL
 *   WALLET_API_TOKEN                — per-instance platform bearer token
 *   INSTANCE_ID                     — hosted instance ID
 *   BINANCE_CONNECT_MERCHANT_CODE   — optional default pre-order merchantCode
 *   BINANCE_CONNECT_MERCHANT_NAME   — optional default pre-order merchantName
 */

import { randomUUID } from 'node:crypto'
import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'

interface BrokerResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

interface OrderBrokerResponse<T = unknown> extends BrokerResponse<T> {
  externalOrderId?: string
  idempotent?: boolean
}

type AmountType = 1 | 2

function brokerPath(suffix: string): string {
  const { instanceId } = resolveCredentials()
  return `/v1/instances/${instanceId}/binance-connect${suffix}`
}

function unwrapBrokerResponse<T>(response: BrokerResponse<T>, operation: string): T {
  if (!response.ok) {
    throw new Error(response.error ?? `Binance Connect ${operation} failed`)
  }
  return response.data as T
}

async function request<T = unknown>(
  suffix: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await apiPost<BrokerResponse<T>>(brokerPath(suffix), body, {
    timeoutMs: 15_000,
  })
  return unwrapBrokerResponse(response, suffix)
}

function appendOrderMetadata(
  result: unknown,
  externalOrderId: string,
  metadata: { idempotencyKey?: string; idempotent?: boolean } = {},
): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, externalOrderId, ...metadata }
  }
  return { externalOrderId, data: result, ...metadata }
}

export async function getTradingPairs(): Promise<unknown> {
  return request('/trading-pairs')
}

export async function getNetworks(): Promise<unknown> {
  return request('/crypto-networks')
}

export async function getP2PTradingPairs(args: { fiatCurrency?: string } = {}): Promise<unknown> {
  return request('/p2p-trading-pairs', {
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
    return request('/payment-methods', {
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

  return request('/payment-methods/eligible', {
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

  return request('/quote', {
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
  idempotencyKey?: string
  merchantCode?: string
  merchantName?: string
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
  const idempotencyKey =
    args.idempotencyKey === undefined ? randomUUID() : args.idempotencyKey.trim()
  if (!idempotencyKey) {
    throw new Error('Pre-order --idempotency-key must not be blank')
  }
  if (idempotencyKey.length > 128) {
    throw new Error('Pre-order --idempotency-key must be at most 128 characters')
  }

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

  try {
    const response = await apiPost<OrderBrokerResponse>(
      brokerPath('/pre-orders'),
      {
        merchantCode,
        merchantName,
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
        ...(args.failRedirectDeepLink != null && {
          failRedirectDeepLink: args.failRedirectDeepLink,
        }),
        ...(args.contractAddress != null && { contractAddress: args.contractAddress }),
        ...(args.customization != null && { customization: args.customization }),
        ...(args.destContractAddress != null && { destContractAddress: args.destContractAddress }),
        ...(args.destContractABI != null && { destContractABI: args.destContractABI }),
        ...(args.destContractParams != null && { destContractParams: args.destContractParams }),
        ...(args.affiliateCode != null && { affiliateCode: args.affiliateCode }),
        ...(args.gtrTemplateCode != null && { gtrTemplateCode: args.gtrTemplateCode }),
      },
      {
        headers: { 'Idempotency-Key': idempotencyKey },
        timeoutMs: 15_000,
      },
    )
    if (!response.ok || !response.externalOrderId) {
      throw new Error(response.error ?? 'Binance Connect pre-order failed')
    }
    return appendOrderMetadata(response.data, response.externalOrderId, {
      idempotencyKey,
      idempotent: response.idempotent ?? false,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}. Retry with --idempotency-key ${idempotencyKey}`, {
      cause: error,
    })
  }
}

export async function queryOrder(externalOrderId: string): Promise<unknown> {
  const response = await apiPost<OrderBrokerResponse>(
    brokerPath('/orders/lookup'),
    { externalOrderId },
    { timeoutMs: 15_000 },
  )
  if (!response.ok || !response.externalOrderId) {
    throw new Error(response.error ?? 'Binance Connect order lookup failed')
  }
  return appendOrderMetadata(response.data, response.externalOrderId)
}
