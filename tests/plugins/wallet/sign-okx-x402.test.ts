/**
 * sign-okx-x402 handler tests.
 *
 * Pure-helper coverage for the input parsing + requirements reconstruction
 * paths (no network). End-to-end signing flow is mocked at the fetch level —
 * we don't sign with a real key, we just verify the SDK is invoked with the
 * correct inputs and the wrapper enriches `accepted` before encoding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __testing } from '@pieverseio/purr-plugin-wallet/sign-okx-x402'

const {
  parseExpected,
  buildPaymentRequirements,
  stringifyBigInts,
  extractAuthorizationNonce,
  UserInputError,
  DEFAULT_MAX_TIMEOUT_SECONDS,
} = __testing

const USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736'
const VALID_EXPECTED = {
  amountBaseUnits: '1',
  chainId: 196,
  tokenAddress: USDT0,
  payTo: '0x273ca4028abc050d8b6edf2fd5b9bc25d26845be',
}

describe('parseExpected', () => {
  it('parses a minimal valid envelope', () => {
    const parsed = parseExpected(JSON.stringify(VALID_EXPECTED))
    expect(parsed.amountBaseUnits).toBe('1')
    expect(parsed.chainId).toBe(196)
    expect(parsed.tokenAddress).toBe(USDT0)
    expect(parsed.payTo).toBe('0x273ca4028abc050d8b6edf2fd5b9bc25d26845be')
  })

  it('preserves optional metadata fields', () => {
    const parsed = parseExpected(
      JSON.stringify({
        ...VALID_EXPECTED,
        orderCode: 'tc-1',
        description: 'attempt',
        resourceUrl: 'https://x.example/y',
      }),
    )
    expect(parsed.orderCode).toBe('tc-1')
    expect(parsed.description).toBe('attempt')
    expect(parsed.resourceUrl).toBe('https://x.example/y')
  })

  it('rejects malformed JSON', () => {
    expect(() => parseExpected('not json')).toThrow(UserInputError)
    expect(() => parseExpected('not json')).toThrow(/valid JSON/)
  })

  it('rejects non-object envelopes', () => {
    expect(() => parseExpected('[]')).toThrow(/JSON object/)
    expect(() => parseExpected('42')).toThrow(/JSON object/)
  })

  it('rejects missing amountBaseUnits', () => {
    const { amountBaseUnits: _omit, ...rest } = VALID_EXPECTED
    expect(() => parseExpected(JSON.stringify(rest))).toThrow(/amountBaseUnits/)
  })

  it('rejects non-positive chainId', () => {
    expect(() => parseExpected(JSON.stringify({ ...VALID_EXPECTED, chainId: 0 }))).toThrow(
      /chainId/,
    )
    expect(() => parseExpected(JSON.stringify({ ...VALID_EXPECTED, chainId: -1 }))).toThrow(
      /chainId/,
    )
  })

  it('rejects non-address tokenAddress', () => {
    expect(() =>
      parseExpected(JSON.stringify({ ...VALID_EXPECTED, tokenAddress: '0xshort' })),
    ).toThrow(/tokenAddress/)
  })

  it('rejects non-address payTo', () => {
    expect(() =>
      parseExpected(JSON.stringify({ ...VALID_EXPECTED, payTo: 'not-an-address' })),
    ).toThrow(/payTo/)
  })
})

describe('buildPaymentRequirements (no header override)', () => {
  it('reconstructs canonical PaymentRequirements for USDT0 on X Layer', async () => {
    const reqs = await buildPaymentRequirements(VALID_EXPECTED, undefined)
    expect(reqs.scheme).toBe('exact')
    expect(reqs.network).toBe('eip155:196')
    expect(reqs.amount).toBe('1')
    expect(reqs.asset).toBe(USDT0)
    expect(reqs.payTo).toBe('0x273ca4028abc050d8b6edf2fd5b9bc25d26845be')
    expect(reqs.maxTimeoutSeconds).toBe(DEFAULT_MAX_TIMEOUT_SECONDS)
    expect(reqs.extra).toEqual({ name: 'USD₮0', version: '1' })
  })

  it('throws UserInputError for tokens missing from the x402 registry', async () => {
    await expect(
      buildPaymentRequirements(
        { ...VALID_EXPECTED, tokenAddress: '0x0000000000000000000000000000000000000001' },
        undefined,
      ),
    ).rejects.toThrow(UserInputError)
  })
})

describe('stringifyBigInts', () => {
  it('coerces bigint to string', () => {
    expect(stringifyBigInts(42n)).toBe('42')
  })

  it('recursively coerces in nested objects', () => {
    const input = {
      authorization: {
        value: 1000000n,
        validBefore: 1735689600n,
      },
      meta: { count: 7n },
    }
    expect(stringifyBigInts(input)).toEqual({
      authorization: {
        value: '1000000',
        validBefore: '1735689600',
      },
      meta: { count: '7' },
    })
  })

  it('preserves non-bigint values', () => {
    expect(stringifyBigInts({ a: 1, b: 'x', c: true, d: null })).toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: null,
    })
  })

  it('handles arrays', () => {
    expect(stringifyBigInts([1n, 'x', { v: 2n }])).toEqual(['1', 'x', { v: '2' }])
  })
})

describe('extractAuthorizationNonce', () => {
  it('returns the nonce when present (EIP-3009 path)', () => {
    const payload = {
      authorization: {
        from: '0xabc',
        nonce: '0xdeadbeef',
      },
    }
    expect(extractAuthorizationNonce(payload)).toBe('0xdeadbeef')
  })

  it('returns empty string when authorization missing (Permit2 path)', () => {
    expect(extractAuthorizationNonce({})).toBe('')
    expect(extractAuthorizationNonce({ permit2Authorization: {} })).toBe('')
  })

  it('returns empty string when nonce is not a string', () => {
    expect(extractAuthorizationNonce({ authorization: { nonce: 42 } })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// End-to-end signing flow — mocked fetch + real OKX SDK + real viem signature.
//
// Builds a tiny in-memory `privateKey` signer, mocks the platform endpoints
// to behave like the live ones, then verifies that:
//   1. The CLI computes the right payerAddress (from /wallet/ensure)
//   2. The CLI passes the OKX-shaped typed data to /wallet/sign-typed-data
//   3. The returned base64 envelope decodes back to a full PaymentPayload
//      with `accepted` populated (the workaround OKX requires)
// ---------------------------------------------------------------------------

import { privateKeyToAccount } from 'viem/accounts'
import { signTypedData as viemSignTypedData } from 'viem/accounts'
import { walletSignOkxX402 } from '@pieverseio/purr-plugin-wallet/sign-okx-x402'

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

interface MockFetchCall {
  url: string
  method: string
  body: unknown
}

function makeMockFetch(
  privKey: `0x${string}`,
  recordedCalls: MockFetchCall[],
): typeof globalThis.fetch {
  const account = privateKeyToAccount(privKey)
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    recordedCalls.push({ url, method: init?.method ?? 'GET', body })

    if (url.endsWith('/wallet/ensure')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { address: account.address, chainId: body?.chainId ?? 196, chainType: 'ethereum' },
        }),
        text: async () => 'ok',
      } as unknown as Response
    }
    if (url.endsWith('/wallet/sign-typed-data')) {
      // Mirror what the platform does — sign with the account's key.
      const signature = await viemSignTypedData({
        privateKey: privKey,
        domain: body.domain,
        types: body.types,
        primaryType: body.primaryType,
        message: body.message,
      })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { address: account.address, signature },
        }),
        text: async () => 'ok',
      } as unknown as Response
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'unexpected route' }),
      text: async () => `unexpected route: ${url}`,
    } as unknown as Response
  }) as typeof globalThis.fetch
}

describe('walletSignOkxX402 (end-to-end with mocked fetch + real SDK)', () => {
  let originalFetch: typeof globalThis.fetch
  let recordedCalls: MockFetchCall[]
  let stdoutCapture: string

  beforeEach(() => {
    originalFetch = globalThis.fetch
    recordedCalls = []
    stdoutCapture = ''
    Object.defineProperty(globalThis, 'fetch', {
      value: makeMockFetch(TEST_PRIVATE_KEY, recordedCalls),
      configurable: true,
      writable: true,
    })
    process.env.WALLET_API_URL = 'https://test.example.com'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      stdoutCapture += line
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    vi.restoreAllMocks()
  })

  it('produces a base64 X-PAYMENT signature with accepted populated', async () => {
    await walletSignOkxX402({ expected: JSON.stringify(VALID_EXPECTED) })

    // Output is a single JSON line — parse it.
    const output = JSON.parse(stdoutCapture) as {
      paymentSignature: string
      payerAddress: string
      authorizationNonce: string
    }

    // 1. payerAddress matches the mock account
    const expectedAddress = privateKeyToAccount(TEST_PRIVATE_KEY).address
    expect(output.payerAddress.toLowerCase()).toBe(expectedAddress.toLowerCase())

    // 2. authorizationNonce is a 32-byte hex string (EIP-3009)
    expect(output.authorizationNonce).toMatch(/^0x[0-9a-f]{64}$/i)

    // 3. paymentSignature decodes to a PaymentPayload with `accepted`.
    // Decode manually (base64 → utf-8 → JSON) to avoid pulling the OKX SDK
    // into the test's import graph; the runtime code uses the SDK to encode.
    const decoded = JSON.parse(
      Buffer.from(output.paymentSignature, 'base64').toString('utf-8'),
    ) as {
      x402Version: number
      accepted?: {
        scheme: string
        network: string
        asset: string
        extra: { name: string; version: string }
      }
      payload: { authorization: { from: string; nonce: string }; signature: string }
    }
    expect(decoded.x402Version).toBe(2)
    expect(decoded.accepted).toBeDefined()
    expect(decoded.accepted?.scheme).toBe('exact')
    expect(decoded.accepted?.network).toBe('eip155:196')
    expect(decoded.accepted?.asset.toLowerCase()).toBe(USDT0)
    expect(decoded.accepted?.extra).toEqual({ name: 'USD₮0', version: '1' })
    expect(decoded.payload.authorization.from.toLowerCase()).toBe(expectedAddress.toLowerCase())
    expect(decoded.payload.authorization.nonce).toBe(output.authorizationNonce)
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]{130}$/i)
  })

  it('records exactly the expected platform endpoints', async () => {
    await walletSignOkxX402({ expected: JSON.stringify(VALID_EXPECTED) })
    const paths = recordedCalls.map((c) => c.url)
    expect(paths.some((p) => p.endsWith('/wallet/ensure'))).toBe(true)
    expect(paths.some((p) => p.endsWith('/wallet/sign-typed-data'))).toBe(true)
  })

  it('rejects --chain-id that contradicts --expected.chainId', async () => {
    let exitCode: number | undefined
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error(`process.exit(${code})`)
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      walletSignOkxX402({
        expected: JSON.stringify(VALID_EXPECTED),
        'chain-id': '1',
      }),
    ).rejects.toThrow(/process\.exit\(1\)/)

    expect(exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalled()
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })
})
