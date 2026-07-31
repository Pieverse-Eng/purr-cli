import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOrder,
  getNetworks,
  getP2PTradingPairs,
  getPaymentMethods,
  getQuote,
  getTradingPairs,
  queryOrder,
} from '@pieverseio/purr-plugin-vendors/binance-onchain-pay'
import { mockFetch } from '../../helpers.js'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const PLATFORM_URL = 'https://platform.test'

function parsedRequest(mock: ReturnType<typeof mockFetch>, index = 0) {
  const [url, options] = mock.mock.calls[index]
  return {
    url,
    options,
    body: JSON.parse(String(options.body)) as Record<string, unknown>,
  }
}

describe('binance-onchain-pay platform broker client', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = PLATFORM_URL
    process.env.WALLET_API_TOKEN = 'instance-token'
    process.env.INSTANCE_ID = INSTANCE_ID
  })

  afterEach(() => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.BINANCE_CONNECT_CLIENT_ID
    delete process.env.BINANCE_CONNECT_ACCESS_TOKEN
    delete process.env.BINANCE_CONNECT_PRIVATE_KEY
    delete process.env.BINANCE_CONNECT_BASE_URL
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('requires the existing platform credentials instead of Binance credentials', async () => {
    // Empty env values deliberately override any developer-local purr config.
    process.env.WALLET_API_TOKEN = ''

    await expect(getTradingPairs()).rejects.toThrow('WALLET_API_TOKEN')
  })

  it('calls the instance-scoped broker with the per-instance bearer token', async () => {
    const mock = mockFetch({ ok: true, data: { fiatCurrencies: ['USD'] } })
    vi.stubGlobal('fetch', mock)

    await expect(getTradingPairs()).resolves.toEqual({ fiatCurrencies: ['USD'] })

    const { url, options, body } = parsedRequest(mock)
    expect(url).toBe(`${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/trading-pairs`)
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer instance-token')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(options.headers).not.toHaveProperty('X-Tesla-ClientId')
    expect(options.headers).not.toHaveProperty('X-Tesla-SignAccessToken')
    expect(options.headers).not.toHaveProperty('X-Tesla-Signature')
    expect(body).toEqual({})
  })

  it('never uses legacy Binance credentials or a caller-controlled Binance base URL', async () => {
    process.env.BINANCE_CONNECT_CLIENT_ID = 'legacy-client'
    process.env.BINANCE_CONNECT_ACCESS_TOKEN = 'legacy-token'
    process.env.BINANCE_CONNECT_PRIVATE_KEY = 'legacy-private-key'
    process.env.BINANCE_CONNECT_BASE_URL = 'https://attacker.example'
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await getTradingPairs()

    const { url, options } = parsedRequest(mock)
    expect(url).toMatch(/^https:\/\/platform\.test\/v1\/instances\//)
    expect(url).not.toContain('attacker.example')
    expect(JSON.stringify(options)).not.toContain('legacy-client')
    expect(JSON.stringify(options)).not.toContain('legacy-token')
    expect(JSON.stringify(options)).not.toContain('legacy-private-key')
  })

  it('maps network and P2P reads to fixed broker operations', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await getNetworks()
    await getP2PTradingPairs({ fiatCurrency: 'USD' })

    expect(parsedRequest(mock, 0).url).toBe(
      `${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/crypto-networks`,
    )
    expect(parsedRequest(mock, 0).body).toEqual({})
    expect(parsedRequest(mock, 1).url).toBe(
      `${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/p2p-trading-pairs`,
    )
    expect(parsedRequest(mock, 1).body).toEqual({ fiatCurrency: 'USD' })
  })

  it('uses the catalog payment-method operation when only lang is supplied', async () => {
    const mock = mockFetch({ ok: true, data: { methods: ['BUY_CARD'] } })
    vi.stubGlobal('fetch', mock)

    await expect(getPaymentMethods({ lang: 'en' })).resolves.toEqual({ methods: ['BUY_CARD'] })

    const { url, body } = parsedRequest(mock)
    expect(url).toBe(`${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/payment-methods`)
    expect(body).toEqual({ lang: 'en' })
  })

  it('uses the eligible payment-method operation for pair-scoped requests', async () => {
    const mock = mockFetch({ ok: true, data: { methods: ['BUY_CARD'] } })
    vi.stubGlobal('fetch', mock)

    await getPaymentMethods({
      fiatCurrency: 'USD',
      cryptoCurrency: 'USDT',
      totalAmount: 50,
      amountType: 2,
      network: 'BSC',
    })

    const { url, body } = parsedRequest(mock)
    expect(url).toBe(
      `${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/payment-methods/eligible`,
    )
    expect(body).toEqual({
      fiatCurrency: 'USD',
      cryptoCurrency: 'USDT',
      totalAmount: 50,
      amountType: 2,
      network: 'BSC',
    })
  })

  it('rejects incomplete pair-scoped payment-method requests before fetch', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(getPaymentMethods({ fiatCurrency: 'USD' })).rejects.toThrow(
      'requires --fiat, --crypto, --total-amount, and --amount-type',
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('maps estimated quotes to the fixed quote operation', async () => {
    const mock = mockFetch({ ok: true, data: { cryptoAmount: '49.85' } })
    vi.stubGlobal('fetch', mock)

    await expect(
      getQuote({
        fiatCurrency: 'USD',
        requestedAmount: 50,
        payMethodCode: 'BUY_CARD',
        amountType: 1,
        cryptoCurrency: 'USDT',
      }),
    ).resolves.toEqual({ cryptoAmount: '49.85' })

    const { url, body } = parsedRequest(mock)
    expect(url).toBe(`${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/quote`)
    expect(body).toEqual({
      fiatCurrency: 'USD',
      requestedAmount: 50,
      payMethodCode: 'BUY_CARD',
      amountType: 1,
      cryptoCurrency: 'USDT',
    })
  })

  it('creates pre-orders without caller-controlled externalOrderId or timestamp', async () => {
    const mock = mockFetch({
      ok: true,
      externalOrderId: 'pc0123456789abcdef0123456789abcdef',
      idempotent: false,
      data: { orderId: 'provider-order', redirectUrl: 'https://pay.example/checkout' },
    })
    vi.stubGlobal('fetch', mock)

    await expect(
      createOrder({
        idempotencyKey: 'checkout-123',
        fiatCurrency: 'USD',
        requestedAmount: 50,
        amountType: 1,
        cryptoCurrency: 'USDT',
        network: 'BSC',
        address: '0x1234567890123456789012345678901234567890',
      }),
    ).resolves.toEqual({
      orderId: 'provider-order',
      redirectUrl: 'https://pay.example/checkout',
      externalOrderId: 'pc0123456789abcdef0123456789abcdef',
      idempotencyKey: 'checkout-123',
      idempotent: false,
    })

    const { url, options, body } = parsedRequest(mock)
    expect(url).toBe(`${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/pre-orders`)
    expect(options.headers['Idempotency-Key']).toBe('checkout-123')
    expect(body).not.toHaveProperty('externalOrderId')
    expect(body).not.toHaveProperty('ts')
    expect(body).not.toHaveProperty('merchantCode')
    expect(body).not.toHaveProperty('merchantName')
  })

  it('generates and returns a retryable idempotency key when one is omitted', async () => {
    const mock = mockFetch({
      ok: true,
      externalOrderId: 'pc0123456789abcdef0123456789abcdef',
      data: {},
    })
    vi.stubGlobal('fetch', mock)

    const result = (await createOrder({
      fiatAmount: 50,
      fiatCurrency: 'USD',
    })) as Record<string, unknown>

    const { options } = parsedRequest(mock)
    expect(options.headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(result.idempotencyKey).toBe(options.headers['Idempotency-Key'])
  })

  it('includes the idempotency key in request failures so callers can retry safely', async () => {
    const mock = mockFetch(
      { ok: false, code: 'BINANCE_CONNECT_TIMEOUT', error: 'Binance Connect request timed out' },
      504,
    )
    vi.stubGlobal('fetch', mock)

    await expect(
      createOrder({ idempotencyKey: 'retry-this-order', fiatAmount: 50 }),
    ).rejects.toThrow('Retry with --idempotency-key retry-this-order')
  })

  it('validates idempotency keys before fetch', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(createOrder({ idempotencyKey: 'x'.repeat(129), fiatAmount: 50 })).rejects.toThrow(
      'must be at most 128 characters',
    )
    await expect(createOrder({ idempotencyKey: '   ', fiatAmount: 50 })).rejects.toThrow(
      'must not be blank',
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('looks up only platform-issued order IDs through the broker', async () => {
    const externalOrderId = 'pc0123456789abcdef0123456789abcdef'
    const mock = mockFetch({
      ok: true,
      externalOrderId,
      data: { status: 'completed', cryptoAmount: '49.85' },
    })
    vi.stubGlobal('fetch', mock)

    await expect(queryOrder(externalOrderId)).resolves.toEqual({
      status: 'completed',
      cryptoAmount: '49.85',
      externalOrderId,
    })

    const { url, body } = parsedRequest(mock)
    expect(url).toBe(`${PLATFORM_URL}/v1/instances/${INSTANCE_ID}/binance-connect/orders/lookup`)
    expect(body).toEqual({ externalOrderId })
  })

  it('surfaces sanitized broker failures without making a fallback provider request', async () => {
    const mock = mockFetch(
      {
        ok: false,
        code: 'BINANCE_CONNECT_UPSTREAM_ERROR',
        error: 'Binance Connect is unavailable',
      },
      502,
    )
    vi.stubGlobal('fetch', mock)

    await expect(getTradingPairs()).rejects.toThrow('Binance Connect is unavailable')
    expect(mock).toHaveBeenCalledOnce()
  })
})
