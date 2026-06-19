import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asterApi } from '@pieverseio/purr-plugin-vendors/aster'
import { privateKeyToAccount } from 'viem/accounts'

const USER = '0x1111111111111111111111111111111111111111'
const SIGNER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001'
const PRIVATE_KEY_SIGNER = privateKeyToAccount(PRIVATE_KEY).address
const ASTER_DOMAIN = {
  name: 'AsterSignTransaction',
  version: '1',
  chainId: 1666,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const
const ASTER_SIGN_DOMAIN = {
  ...ASTER_DOMAIN,
  chainId: 1666n,
} as const
const ASTER_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Message: [{ name: 'msg', type: 'string' }],
} as const
const ASTER_SIGN_TYPES = {
  Message: ASTER_TYPES.Message,
} as const

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response
}

describe('asterApi', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://platform.example'
    process.env.WALLET_API_TOKEN = 'token'
    process.env.INSTANCE_ID = 'instance-1'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...originalEnv }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('signs Aster API requests with the platform wallet when signer is omitted', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'platform.example' && url.pathname.endsWith('/wallet/ensure')) {
        expect(JSON.parse(String(init?.body))).toEqual({ chainType: 'ethereum', chainId: 56 })
        return jsonResponse({
          ok: true,
          data: { address: SIGNER, chainId: 56, chainType: 'ethereum' },
        })
      }
      if (url.hostname === 'platform.example' && url.pathname.endsWith('/wallet/sign-typed-data')) {
        const body = JSON.parse(String(init?.body)) as {
          domain: unknown
          types: unknown
          primaryType: string
          message: { msg: string }
          intent: unknown
        }
        expect(body.domain).toEqual(ASTER_DOMAIN)
        expect(body.types).toEqual(ASTER_TYPES)
        expect(body.primaryType).toBe('Message')
        expect(body.message.msg).toBe(`nonce=1781827200000000&signer=${SIGNER}&timestamp=1781827200000&user=${USER}`)
        expect(body.intent).toEqual({
          kind: 'typed_data',
          primaryType: 'Message',
          verifyingContract: ASTER_DOMAIN.verifyingContract,
          chainId: 'eip155:56',
        })
        return jsonResponse({
          ok: true,
          data: {
            address: SIGNER,
            signature: '0xplatformsignature',
          },
        })
      }
      if (url.hostname === 'fapi.asterdex.com' && url.pathname === '/fapi/v3/balance') {
        expect(url.searchParams.get('user')).toBe(USER)
        expect(url.searchParams.get('signer')).toBe(SIGNER)
        expect(url.searchParams.get('signature')).toBe('0xplatformsignature')
        expect(url.searchParams.get('nonce')).toBe('1781827200000000')
        return jsonResponse([{ asset: 'USDT', balance: '1' }])
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })
    globalThis.fetch = fetchMock as typeof fetch

    const result = await asterApi({
      method: 'GET',
      endpoint: '/fapi/v3/balance',
      user: USER,
    })

    expect(result).toEqual([{ asset: 'USDT', balance: '1' }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('signs Aster API requests with a local private key using the same EIP-712 payload', async () => {
    vi.setSystemTime(new Date('2026-06-19T00:00:01.000Z'))

    const expectedParamString = `nonce=1781827201000000&signer=${PRIVATE_KEY_SIGNER}&symbol=BTCUSDT&timestamp=1781827201000&user=${USER}`
    const expectedSignature = await privateKeyToAccount(PRIVATE_KEY).signTypedData({
      domain: ASTER_SIGN_DOMAIN,
      types: ASTER_SIGN_TYPES,
      primaryType: 'Message',
      message: { msg: expectedParamString },
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'fapi.asterdex.com' && url.pathname === '/fapi/v3/balance') {
        expect(url.searchParams.get('user')).toBe(USER)
        expect(url.searchParams.get('signer')).toBe(PRIVATE_KEY_SIGNER)
        expect(url.searchParams.get('symbol')).toBe('BTCUSDT')
        expect(url.searchParams.get('timestamp')).toBe('1781827201000')
        expect(url.searchParams.get('nonce')).toBe('1781827201000000')
        expect(url.searchParams.get('signature')).toBe(expectedSignature)
        return jsonResponse([{ asset: 'USDT', balance: '2' }])
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })
    globalThis.fetch = fetchMock as typeof fetch

    const result = await asterApi({
      method: 'GET',
      endpoint: '/fapi/v3/balance',
      user: USER,
      privateKey: PRIVATE_KEY,
      params: { symbol: 'BTCUSDT' },
    })

    expect(result).toEqual([{ asset: 'USDT', balance: '2' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects platform wallet signer mismatches before calling Aster', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'platform.example' && url.pathname.endsWith('/wallet/ensure')) {
        return jsonResponse({
          ok: true,
          data: { address: OTHER, chainId: 56, chainType: 'ethereum' },
        })
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })
    globalThis.fetch = fetchMock as typeof fetch

    await expect(
      asterApi({
        method: 'GET',
        endpoint: '/fapi/v3/balance',
        user: USER,
        signer: SIGNER,
      }),
    ).rejects.toThrow('does not match Aster API signer')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
