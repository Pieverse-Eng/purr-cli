import { generateKeyPairSync } from 'node:crypto'
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

// Generate a test RSA key pair for signing
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

describe('binance-onchain-pay', () => {
  beforeEach(() => {
    process.env.BINANCE_CONNECT_CLIENT_ID = 'test-client-id'
    process.env.BINANCE_CONNECT_ACCESS_TOKEN = 'test-access-token'
    process.env.BINANCE_CONNECT_PRIVATE_KEY = TEST_PRIVATE_KEY
    process.env.BINANCE_CONNECT_BASE_URL = 'https://test.example.com'
    process.env.BINANCE_CONNECT_MERCHANT_CODE = 'test-merchant-code'
    process.env.BINANCE_CONNECT_MERCHANT_NAME = 'Test Merchant'
  })

  afterEach(() => {
    delete process.env.BINANCE_CONNECT_CLIENT_ID
    delete process.env.BINANCE_CONNECT_ACCESS_TOKEN
    delete process.env.BINANCE_CONNECT_PRIVATE_KEY
    delete process.env.BINANCE_CONNECT_BASE_URL
    delete process.env.BINANCE_CONNECT_MERCHANT_CODE
    delete process.env.BINANCE_CONNECT_MERCHANT_NAME
    vi.restoreAllMocks()
  })

  describe('config validation', () => {
    it('throws listing missing env vars', async () => {
      delete process.env.BINANCE_CONNECT_CLIENT_ID
      delete process.env.BINANCE_CONNECT_PRIVATE_KEY
      await expect(getTradingPairs()).rejects.toThrow('BINANCE_CONNECT_CLIENT_ID')
      await expect(getTradingPairs()).rejects.toThrow('BINANCE_CONNECT_PRIVATE_KEY')
    })

    it('throws when access token is missing', async () => {
      delete process.env.BINANCE_CONNECT_ACCESS_TOKEN
      await expect(getTradingPairs()).rejects.toThrow('BINANCE_CONNECT_ACCESS_TOKEN')
    })

    it('throws when base URL is missing', async () => {
      delete process.env.BINANCE_CONNECT_BASE_URL
      await expect(getTradingPairs()).rejects.toThrow('BINANCE_CONNECT_BASE_URL')
    })
  })

  describe('getTradingPairs', () => {
    it('calls correct endpoint with Tesla headers', async () => {
      const mock = mockFetch({ data: { fiatCurrencies: ['USD'], cryptoCurrencies: ['BTC'] } })
      vi.stubGlobal('fetch', mock)

      const result = await getTradingPairs()
      expect(result).toEqual({ fiatCurrencies: ['USD'], cryptoCurrencies: ['BTC'] })
      expect(mock).toHaveBeenCalledOnce()

      const [url, options] = mock.mock.calls[0]
      expect(url).toBe('https://test.example.com/papi/v1/ramp/connect/buy/trading-pairs')
      expect(options.method).toBe('POST')
      expect(options.headers['X-Tesla-ClientId']).toBe('test-client-id')
      expect(options.headers['X-Tesla-SignAccessToken']).toBe('test-access-token')
      expect(options.headers['X-Tesla-Signature']).toBeTruthy()
      expect(options.headers['X-Tesla-Timestamp']).toMatch(/^\d+$/)
      expect(options.headers['User-Agent']).toBe('onchain-pay-open-api/0.1.2 (Skill)')
      expect(options.body).toBeUndefined()
    })
  })

  describe('getNetworks', () => {
    it('calls crypto-network-list endpoint', async () => {
      const mock = mockFetch({ data: { networks: ['BSC', 'ETH'] } })
      vi.stubGlobal('fetch', mock)

      const result = await getNetworks()
      expect(result).toEqual({ networks: ['BSC', 'ETH'] })

      const [url] = mock.mock.calls[0]
      expect(url).toContain('/crypto-network')
    })
  })

  describe('getP2PTradingPairs', () => {
    it('calls p2p trading-pairs endpoint with optional fiatCurrency', async () => {
      const mock = mockFetch({ data: { fiatCurrencies: ['USD'] } })
      vi.stubGlobal('fetch', mock)

      const result = await getP2PTradingPairs({ fiatCurrency: 'USD' })

      expect(result).toEqual({ fiatCurrencies: ['USD'] })
      const [url, options] = mock.mock.calls[0]
      expect(url).toBe('https://test.example.com/papi/v1/ramp/connect/buy/p2p/trading-pairs')
      expect(JSON.parse(options.body)).toEqual({ fiatCurrency: 'USD' })
    })

    it('omits request body when optional fiatCurrency is not provided', async () => {
      const mock = mockFetch({ data: { fiatCurrencies: ['USD'] } })
      vi.stubGlobal('fetch', mock)

      await getP2PTradingPairs()

      const [, options] = mock.mock.calls[0]
      expect(options.body).toBeUndefined()
    })
  })

  describe('getPaymentMethods', () => {
    it('calls v2 payment-method-list when no pair is provided', async () => {
      const mock = mockFetch({ data: { methods: ['BUY_CARD'] } })
      vi.stubGlobal('fetch', mock)

      const result = await getPaymentMethods({ lang: 'en' })

      expect(result).toEqual({ methods: ['BUY_CARD'] })
      const [url, options] = mock.mock.calls[0]
      expect(url).toBe('https://test.example.com/papi/v2/ramp/connect/buy/payment-method-list')
      expect(JSON.parse(options.body)).toEqual({ lang: 'en' })
    })

    it('omits request body for v2 payment-method-list without lang', async () => {
      const mock = mockFetch({ data: { methods: ['BUY_CARD'] } })
      vi.stubGlobal('fetch', mock)

      await getPaymentMethods()

      const [url, options] = mock.mock.calls[0]
      expect(url).toBe('https://test.example.com/papi/v2/ramp/connect/buy/payment-method-list')
      expect(options.body).toBeUndefined()
    })

    it('calls v1 payment-method-list for a fiat/crypto amount', async () => {
      const mock = mockFetch({ data: { methods: ['BUY_CARD'] } })
      vi.stubGlobal('fetch', mock)

      await getPaymentMethods({
        fiatCurrency: 'USD',
        cryptoCurrency: 'USDT',
        totalAmount: 50,
        amountType: 2,
        network: 'BSC',
      })

      const [url, options] = mock.mock.calls[0]
      expect(url).toBe('https://test.example.com/papi/v1/ramp/connect/buy/payment-method-list')
      const body = JSON.parse(options.body)
      expect(body.fiatCurrency).toBe('USD')
      expect(body.cryptoCurrency).toBe('USDT')
      expect(body.totalAmount).toBe(50)
      expect(body.amountType).toBe(2)
      expect(body.network).toBe('BSC')
    })

    it('requires fiat, crypto, amount, and amountType for pair-specific payment methods', async () => {
      await expect(getPaymentMethods({ fiatCurrency: 'USD' })).rejects.toThrow(
        'requires --fiat, --crypto, --total-amount, and --amount-type',
      )
      await expect(
        getPaymentMethods({
          fiatCurrency: 'USD',
          cryptoCurrency: 'USDT',
          totalAmount: 50,
        }),
      ).rejects.toThrow('requires --fiat, --crypto, --total-amount, and --amount-type')
    })
  })

  describe('getQuote', () => {
    it('sends required params in body', async () => {
      const mock = mockFetch({ data: { cryptoAmount: '49.85', fee: '0.50' } })
      vi.stubGlobal('fetch', mock)

      const result = await getQuote({
        fiatCurrency: 'USD',
        requestedAmount: 50,
        payMethodCode: 'BUY_CARD',
        amountType: 1,
      })

      expect(result).toEqual({ cryptoAmount: '49.85', fee: '0.50' })
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.fiatCurrency).toBe('USD')
      expect(body.requestedAmount).toBe(50)
      expect(body.payMethodCode).toBe('BUY_CARD')
      expect(body.amountType).toBe(1)
    })

    it('requires amountType', async () => {
      await expect(
        getQuote({
          fiatCurrency: 'USD',
          requestedAmount: 50,
          payMethodCode: 'BUY_CARD',
        } as Parameters<typeof getQuote>[0]),
      ).rejects.toThrow('Estimated quote requires --amount-type')
    })

    it('includes optional quote params', async () => {
      const mock = mockFetch({ data: {} })
      vi.stubGlobal('fetch', mock)

      await getQuote({
        fiatCurrency: 'USD',
        requestedAmount: 50,
        payMethodCode: 'BUY_CARD',
        amountType: 2,
        cryptoCurrency: 'USDT',
        address: '0x1234567890123456789012345678901234567890',
        contractAddress: '0x0000000000000000000000000000000000000001',
      })

      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.payMethodCode).toBe('BUY_CARD')
      expect(body.amountType).toBe(2)
      expect(body.cryptoCurrency).toBe('USDT')
      expect(body.address).toBe('0x1234567890123456789012345678901234567890')
      expect(body.contractAddress).toBe('0x0000000000000000000000000000000000000001')
    })
  })

  describe('createOrder', () => {
    it('sends wallet address and network', async () => {
      const mock = mockFetch({
        data: { orderId: 'bc-123', redirectUrl: 'https://pay.binance.com/checkout/abc' },
      })
      vi.stubGlobal('fetch', mock)

      const result = await createOrder({
        fiatCurrency: 'USD',
        cryptoCurrency: 'USDT',
        requestedAmount: 50,
        amountType: 1,
        network: 'BSC',
        address: '0x1234567890123456789012345678901234567890',
      })

      expect(result).toEqual({
        orderId: 'bc-123',
        redirectUrl: 'https://pay.binance.com/checkout/abc',
        externalOrderId: expect.stringMatching(/^oc_unknown_\d+_[a-z0-9]+$/),
      })
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.network).toBe('BSC')
      expect(body.address).toBe('0x1234567890123456789012345678901234567890')
      expect(body.requestedAmount).toBe(50)
      expect(body.amountType).toBe(1)
      expect(body.externalOrderId).toMatch(/^oc_unknown_\d+_[a-z0-9]+$/)
      expect(body.ts).toEqual(expect.any(Number))
      expect(body.merchantCode).toBe('test-merchant-code')
      expect(body.merchantName).toBe('Test Merchant')
    })

    it('auto-generates externalOrderId', async () => {
      const mock = mockFetch({ data: {} })
      vi.stubGlobal('fetch', mock)

      await createOrder({
        fiatCurrency: 'USD',
        cryptoCurrency: 'USDT',
        requestedAmount: 50,
        amountType: 1,
        network: 'BSC',
        address: '0x1234567890123456789012345678901234567890',
      })

      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.externalOrderId).toMatch(/^oc_unknown_\d+_[a-z0-9]+$/)
    })

    it('uses custom externalOrderId when provided', async () => {
      const mock = mockFetch({ data: {} })
      vi.stubGlobal('fetch', mock)

      await createOrder({
        fiatCurrency: 'USD',
        cryptoCurrency: 'USDT',
        requestedAmount: 50,
        amountType: 1,
        network: 'BSC',
        address: '0x1234567890123456789012345678901234567890',
        externalOrderId: 'custom-id-123',
      })

      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.externalOrderId).toBe('custom-id-123')
    })

    it('includes optional merchant and redirect fields', async () => {
      const mock = mockFetch({ data: {} })
      vi.stubGlobal('fetch', mock)

      await createOrder({
        fiatCurrency: 'USD',
        fiatAmount: 50,
        cryptoCurrency: 'USDT',
        requestedAmount: 50,
        amountType: 2,
        network: 'BSC',
        address: '0x1234567890123456789012345678901234567890',
        payMethodCode: 'BUY_CARD',
        payMethodSubCode: 'card',
        merchantCode: 'merchant-code',
        merchantName: 'Merchant Name',
        redirectUrl: 'https://example.com/success',
        failRedirectUrl: 'https://example.com/fail',
        redirectDeepLink: 'app://success',
        failRedirectDeepLink: 'app://fail',
        contractAddress: '0x0000000000000000000000000000000000000001',
        customization: { SEND_PRIMARY: true },
        destContractAddress: '0x0000000000000000000000000000000000000002',
        destContractABI: 'deposit',
        destContractParams: { amount: 50 },
        affiliateCode: 'affiliate',
        gtrTemplateCode: 'OTHERS',
      })

      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.fiatAmount).toBe(50)
      expect(body.requestedAmount).toBe(50)
      expect(body.amountType).toBe(2)
      expect(body.payMethodCode).toBe('BUY_CARD')
      expect(body.payMethodSubCode).toBe('card')
      expect(body.merchantCode).toBe('merchant-code')
      expect(body.merchantName).toBe('Merchant Name')
      expect(body.redirectUrl).toBe('https://example.com/success')
      expect(body.failRedirectUrl).toBe('https://example.com/fail')
      expect(body.redirectDeepLink).toBe('app://success')
      expect(body.failRedirectDeepLink).toBe('app://fail')
      expect(body.contractAddress).toBe('0x0000000000000000000000000000000000000001')
      expect(body.customization).toEqual({ SEND_PRIMARY: true })
      expect(body.destContractAddress).toBe('0x0000000000000000000000000000000000000002')
      expect(body.destContractABI).toBe('deposit')
      expect(body.destContractParams).toEqual({ amount: 50 })
      expect(body.affiliateCode).toBe('affiliate')
      expect(body.gtrTemplateCode).toBe('OTHERS')
    })

    it('requires merchant identity from args or env', async () => {
      delete process.env.BINANCE_CONNECT_MERCHANT_CODE
      await expect(
        createOrder({
          fiatCurrency: 'USD',
          cryptoCurrency: 'USDT',
          requestedAmount: 50,
          amountType: 1,
          network: 'BSC',
          address: '0x1234567890123456789012345678901234567890',
        }),
      ).rejects.toThrow('Pre-order requires --merchant-code or BINANCE_CONNECT_MERCHANT_CODE')
    })

    it('requires fiatAmount or requestedAmount with amountType', async () => {
      await expect(
        createOrder({
          fiatCurrency: 'USD',
          cryptoCurrency: 'USDT',
          requestedAmount: 50,
          network: 'BSC',
          address: '0x1234567890123456789012345678901234567890',
        }),
      ).rejects.toThrow(
        'Pre-order requires --fiat-amount or both --requested-amount and --amount-type',
      )
    })
  })

  describe('queryOrder', () => {
    it('sends orderId and returns status', async () => {
      const mock = mockFetch({ data: { status: 'completed', cryptoAmount: '49.85' } })
      vi.stubGlobal('fetch', mock)

      const result = await queryOrder('bc-123')
      expect(result).toEqual({ status: 'completed', cryptoAmount: '49.85' })

      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.externalOrderId).toBe('bc-123')
    })
  })

  describe('error handling', () => {
    it('throws on HTTP error', async () => {
      const mock = mockFetch({ message: 'Bad Request' }, 400)
      vi.stubGlobal('fetch', mock)

      await expect(getTradingPairs()).rejects.toThrow('HTTP 400')
    })

    it('throws on API error code', async () => {
      const mock = mockFetch({ code: '100001', message: 'Invalid signature' })
      vi.stubGlobal('fetch', mock)

      await expect(getTradingPairs()).rejects.toThrow('Invalid signature')
    })

    it('passes through response when code is 000000 (success)', async () => {
      const mock = mockFetch({ code: '000000', data: { pairs: [] } })
      vi.stubGlobal('fetch', mock)

      const result = await getTradingPairs()
      expect(result).toEqual({ pairs: [] })
    })

    it('returns full response when no data field', async () => {
      const mock = mockFetch({ code: '000000', success: true })
      vi.stubGlobal('fetch', mock)

      const result = await getTradingPairs()
      expect(result).toEqual({ code: '000000', success: true })
    })
  })

  describe('RSA signing', () => {
    it('signs body + timestamp (not body alone)', async () => {
      const mock = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: {} }),
        })
      })
      vi.stubGlobal('fetch', mock)

      await getTradingPairs()

      const headers = mock.mock.calls[0][1].headers
      // Signature and timestamp must both exist
      expect(headers['X-Tesla-Signature']).toBeTruthy()
      expect(headers['X-Tesla-Timestamp']).toBeTruthy()
    })

    it('produces different signatures for different bodies', async () => {
      const signatures: string[] = []
      const mock = vi
        .fn()
        .mockImplementation((_url: string, options: { headers: Record<string, string> }) => {
          signatures.push(options.headers['X-Tesla-Signature'])
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: {} }),
          })
        })
      vi.stubGlobal('fetch', mock)

      await getQuote({
        fiatCurrency: 'USD',
        requestedAmount: 50,
        amountType: 1,
        payMethodCode: 'BUY_CARD',
      })
      await getQuote({
        fiatCurrency: 'EUR',
        requestedAmount: 100,
        amountType: 1,
        payMethodCode: 'BUY_CARD',
      })

      expect(signatures).toHaveLength(2)
      expect(signatures[0]).not.toBe(signatures[1])
    })
  })
})
