import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { walletSignTypedData } from '../wallet/sign-typed-data.js'

const WALLET = '0x1234567890123456789012345678901234567890'
const OTHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const originalFetch = globalThis.fetch

describe('walletSignTypedData', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://test.example.com'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
  })

  afterEach(() => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('rejects when the platform returns a different signing address', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            ok: true,
            data: {
              address: OTHER,
              signature: '0xsig',
            },
          }) as const,
        text: async () => 'ok',
      })),
      configurable: true,
      writable: true,
    })

    await expect(
      walletSignTypedData({
        address: WALLET,
        data: JSON.stringify({
          domain: { name: 'Test', version: '1', chainId: 1, verifyingContract: OTHER },
          types: { Test: [{ name: 'value', type: 'string' }] },
          primaryType: 'Test',
          message: { value: 'hello' },
        }),
      }),
    ).rejects.toThrow('unexpected address')
  })
})
