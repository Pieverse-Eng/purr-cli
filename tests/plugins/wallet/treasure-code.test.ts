import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  treasureCodeAttempt,
  treasureCodeFinalUnlock,
} from '@pieverseio/purr-plugin-wallet/treasure-code'

const { signOkxX402FromExpectedMock } = vi.hoisted(() => ({
  signOkxX402FromExpectedMock: vi.fn(async () => ({
    paymentSignature: 'signed-payment',
    payerAddress: '0x0000000000000000000000000000000000000001',
    authorizationNonce: '0xnonce',
  })),
}))

vi.mock('../../../packages/plugins/wallet/src/sign-okx-x402.js', () => ({
  signOkxX402FromExpected: signOkxX402FromExpectedMock,
}))

const EXPECTED = {
  orderCode: 'tc-1',
  amountBaseUnits: '1',
  chainId: 196,
  tokenAddress: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
  payTo: '0x273ca4028abc050d8b6edf2fd5b9bc25d26845be',
  resourceUrl: 'https://purr.example/treasure-code',
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('treasure-code helpers', () => {
  let originalFetch: typeof globalThis.fetch
  let calls: FetchCall[]
  let stdoutCapture: string

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
    stdoutCapture = ''
    process.env.WALLET_API_URL = 'https://test.example.com'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
    signOkxX402FromExpectedMock.mockClear()
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

  it('uses the canonical payment-required header for attempts', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ url, method: init?.method ?? 'GET', body })

        if (url.endsWith('/v1/treasure-code/attempts/payment-required')) {
          expect(body).toEqual({ word: 'crocodile' })
          return jsonResponse({
            ok: true,
            data: {
              expected: EXPECTED,
              paymentRequiredHeader: 'attempt-payment-required-header',
              wordRequested: 'crocodile',
            },
          })
        }
        if (url.endsWith('/v1/treasure-code/attempts')) {
          expect(body).toMatchObject({
            paymentSignature: 'signed-payment',
            expected: EXPECTED,
            idempotency_key: '0xnonce',
            word: 'crocodile',
          })
          return jsonResponse({ ok: true, data: { attempt_id: 'attempt-1', status: 'queued' } })
        }
        if (url.endsWith('/v1/treasure-code/attempts/attempt-1')) {
          return jsonResponse({
            ok: true,
            data: {
              attempt_id: 'attempt-1',
              status: 'ready',
              position: 20,
              word: 'crocodile',
              result: 'miss',
              settle_failed_reason: null,
            },
          })
        }
        return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
      }) as typeof globalThis.fetch,
      configurable: true,
      writable: true,
    })

    await treasureCodeAttempt({ guess: 'crocodile' })

    expect(signOkxX402FromExpectedMock).toHaveBeenCalledWith(
      JSON.stringify(EXPECTED),
      'attempt-payment-required-header',
    )
    expect(JSON.parse(stdoutCapture)).toMatchObject({
      attempt_id: 'attempt-1',
      status: 'ready',
      position: 20,
      word: 'crocodile',
      result: 'miss',
      cost_base_units: '1',
    })
  })

  it('requests final-unlock payment requirements with an empty strict body', async () => {
    const words = Array.from({ length: 24 }, (_, i) => `word${i + 1}`)
    Object.defineProperty(globalThis, 'fetch', {
      value: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ url, method: init?.method ?? 'GET', body })

        if (url.endsWith('/v1/treasure-code/final-unlocks/payment-required')) {
          expect(body).toEqual({})
          return jsonResponse({
            ok: true,
            data: {
              expected: EXPECTED,
              paymentRequiredHeader: 'final-unlock-payment-required-header',
            },
          })
        }
        if (url.endsWith('/v1/treasure-code/final-unlocks')) {
          expect(body).toMatchObject({
            paymentSignature: 'signed-payment',
            expected: EXPECTED,
            idempotency_key: '0xnonce',
            words,
          })
          return jsonResponse({ ok: true, data: { status: 'accepted', unlock_id: 'unlock-1' } })
        }
        return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
      }) as typeof globalThis.fetch,
      configurable: true,
      writable: true,
    })

    await treasureCodeFinalUnlock({ words: JSON.stringify(words) })

    expect(signOkxX402FromExpectedMock).toHaveBeenCalledWith(
      JSON.stringify(EXPECTED),
      'final-unlock-payment-required-header',
    )
    expect(JSON.parse(stdoutCapture)).toEqual({ status: 'accepted', unlock_id: 'unlock-1' })
  })
})
