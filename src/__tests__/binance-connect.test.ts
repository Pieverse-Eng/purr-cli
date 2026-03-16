import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createOrder,
	getNetworks,
	getQuote,
	getTradingPairs,
	queryOrder,
} from '../vendors/binance-connect.js'

// Generate a test RSA key pair for signing
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
})

function mockFetch(data: unknown, status = 200) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(data),
		text: () => Promise.resolve(JSON.stringify(data)),
	})
}

describe('binance-connect', () => {
	beforeEach(() => {
		process.env.BINANCE_CONNECT_CLIENT_ID = 'test-client-id'
		process.env.BINANCE_CONNECT_ACCESS_TOKEN = 'test-access-token'
		process.env.BINANCE_CONNECT_PRIVATE_KEY = TEST_PRIVATE_KEY
		process.env.BINANCE_CONNECT_BASE_URL = 'https://test.example.com'
	})

	afterEach(() => {
		delete process.env.BINANCE_CONNECT_CLIENT_ID
		delete process.env.BINANCE_CONNECT_ACCESS_TOKEN
		delete process.env.BINANCE_CONNECT_PRIVATE_KEY
		delete process.env.BINANCE_CONNECT_BASE_URL
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
		})
	})

	describe('getNetworks', () => {
		it('calls crypto-network-list endpoint', async () => {
			const mock = mockFetch({ data: { networks: ['BSC', 'ETH'] } })
			vi.stubGlobal('fetch', mock)

			const result = await getNetworks()
			expect(result).toEqual({ networks: ['BSC', 'ETH'] })

			const [url] = mock.mock.calls[0]
			expect(url).toContain('/crypto-network-list')
		})
	})

	describe('getQuote', () => {
		it('sends required params in body', async () => {
			const mock = mockFetch({ data: { cryptoAmount: '49.85', fee: '0.50' } })
			vi.stubGlobal('fetch', mock)

			const result = await getQuote({
				fiatCurrency: 'USD',
				cryptoCurrency: 'USDT',
				fiatAmount: '50',
			})

			expect(result).toEqual({ cryptoAmount: '49.85', fee: '0.50' })
			const body = JSON.parse(mock.mock.calls[0][1].body)
			expect(body.fiatCurrency).toBe('USD')
			expect(body.cryptoCurrency).toBe('USDT')
			expect(body.fiatAmount).toBe('50')
			expect(body).not.toHaveProperty('paymentMethod')
		})

		it('includes optional paymentMethod', async () => {
			const mock = mockFetch({ data: {} })
			vi.stubGlobal('fetch', mock)

			await getQuote({
				fiatCurrency: 'USD',
				cryptoCurrency: 'USDT',
				fiatAmount: '50',
				paymentMethod: 'CARD',
			})

			const body = JSON.parse(mock.mock.calls[0][1].body)
			expect(body.paymentMethod).toBe('CARD')
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
				fiatAmount: '50',
				cryptoNetwork: 'BSC',
				walletAddress: '0x1234567890123456789012345678901234567890',
			})

			expect(result).toEqual({
				orderId: 'bc-123',
				redirectUrl: 'https://pay.binance.com/checkout/abc',
			})
			const body = JSON.parse(mock.mock.calls[0][1].body)
			expect(body.cryptoNetwork).toBe('BSC')
			expect(body.walletAddress).toBe('0x1234567890123456789012345678901234567890')
			expect(body.fiatAmount).toBe('50')
		})

		it('auto-generates externalOrderId', async () => {
			const mock = mockFetch({ data: {} })
			vi.stubGlobal('fetch', mock)

			await createOrder({
				fiatCurrency: 'USD',
				cryptoCurrency: 'USDT',
				fiatAmount: '50',
				cryptoNetwork: 'BSC',
				walletAddress: '0x1234567890123456789012345678901234567890',
			})

			const body = JSON.parse(mock.mock.calls[0][1].body)
			expect(body.externalOrderId).toMatch(/^oc_[^_]+_\d+_[a-f0-9]+$/)
		})

		it('uses custom externalOrderId when provided', async () => {
			const mock = mockFetch({ data: {} })
			vi.stubGlobal('fetch', mock)

			await createOrder({
				fiatCurrency: 'USD',
				cryptoCurrency: 'USDT',
				fiatAmount: '50',
				cryptoNetwork: 'BSC',
				walletAddress: '0x1234567890123456789012345678901234567890',
				externalOrderId: 'custom-id-123',
			})

			const body = JSON.parse(mock.mock.calls[0][1].body)
			expect(body.externalOrderId).toBe('custom-id-123')
		})
	})

	describe('queryOrder', () => {
		it('sends orderId and returns status', async () => {
			const mock = mockFetch({ data: { status: 'completed', cryptoAmount: '49.85' } })
			vi.stubGlobal('fetch', mock)

			const result = await queryOrder('bc-123')
			expect(result).toEqual({ status: 'completed', cryptoAmount: '49.85' })

			const body = JSON.parse(mock.mock.calls[0][1].body)
			expect(body.orderId).toBe('bc-123')
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

			await getQuote({ fiatCurrency: 'USD', cryptoCurrency: 'USDT', fiatAmount: '50' })
			await getQuote({ fiatCurrency: 'EUR', cryptoCurrency: 'BTC', fiatAmount: '100' })

			expect(signatures).toHaveLength(2)
			expect(signatures[0]).not.toBe(signatures[1])
		})
	})
})
