import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __testing,
  redpacketClaim,
  redpacketPending,
  redpacketSend,
  redpacketSent,
} from '@pieverseio/purr-plugin-wallet/redpacket'

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

function pendingEnvelope(id: string, amountBaseUnits = '100000') {
  return {
    envelopeId: id,
    amountBaseUnits,
    expiresAt: '2026-05-16T00:00:00.000Z',
    token: {
      chainId: 196,
      address: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
      symbol: 'USDT0',
      decimals: 6,
    },
    sender: {
      handle: 'bob',
      renderedHandle: 'bob.pie',
      walletAddress: '0x0000000000000000000000000000000000000001',
      instanceId: 'sender-instance',
      ownerUserId: 'sender-user',
    },
  }
}

describe('redpacket helpers', () => {
  it('parses decimal USDT0 amounts exactly', () => {
    expect(__testing.parseAmountToBaseUnits('0.1')).toBe('100000')
    expect(__testing.parseAmountToBaseUnits('$1.25')).toBe('1250000')
    expect(__testing.parseAmountToBaseUnits('1 USDT0')).toBe('1000000')
    expect(() => __testing.parseAmountToBaseUnits('0.0000001')).toThrow(/6 decimals/)
  })

  it('rejects bare redpacket recipients for send flows', () => {
    expect(__testing.assertSendRecipient('alice.pie')).toBe('alice.pie')
    expect(__testing.assertSendRecipient('0x0000000000000000000000000000000000000001')).toBe(
      '0x0000000000000000000000000000000000000001',
    )
    expect(() => __testing.assertSendRecipient('Alice.pie')).toThrow(/valid lowercase/)
    expect(() => __testing.assertSendRecipient('a.pie')).toThrow(/valid lowercase/)
    expect(() => __testing.assertSendRecipient('alice')).toThrow(/bare names/)
    expect(() => __testing.assertSendRecipient('@alice')).toThrow(/bare names/)
  })
})

describe('redpacket commands', () => {
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
    process.exitCode = undefined
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
    process.exitCode = undefined
    vi.restoreAllMocks()
  })

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    Object.defineProperty(globalThis, 'fetch', {
      value: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        return await handler(url, init)
      }) as typeof globalThis.fetch,
      configurable: true,
      writable: true,
    })
  }

  it('sends a redpacket with converted amount and optional channel', async () => {
    mockFetch((url) => {
      if (url.endsWith('/v2/instances/test-instance/redpackets')) {
        expect(calls.at(-1)?.body).toEqual({
          recipient: 'alice.pie',
          amountBaseUnits: '100000',
          senderChatContext: { channel: 'telegram' },
        })
        return jsonResponse(
          {
            ok: true,
            data: {
              envelopeId: 'env-1',
              expiresAt: '2026-05-16T00:00:00.000Z',
              amountBaseUnits: '100000',
              token: pendingEnvelope('env-1').token,
              sender: pendingEnvelope('env-1').sender,
              recipient: {
                handle: 'alice',
                renderedHandle: 'alice.pie',
                walletAddress: '0x0000000000000000000000000000000000000002',
              },
              ackText: 'Sent 0.1 USDT0 redpacket to alice.pie. Expires in 24h.',
            },
          },
          201,
        )
      }
      return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
    })

    await redpacketSend({ recipient: 'alice.pie', amount: '0.1', channel: 'telegram' })

    const output = JSON.parse(stdoutCapture) as {
      ok: boolean
      data: { text: string; amount: string; amountBaseUnits: string; recipient: string }
    }
    expect(output.ok).toBe(true)
    expect(output.data.text).toContain('Sent 0.1 USDT0')
    expect(output.data.amount).toBe('0.1')
    expect(output.data.amountBaseUnits).toBe('100000')
    expect(output.data.recipient).toBe('alice.pie')
  })

  it('returns raw platform shape with --raw', async () => {
    mockFetch((url) => {
      if (url.endsWith('/v2/instances/test-instance/redpackets')) {
        return jsonResponse(
          {
            ok: true,
            data: {
              envelopeId: 'env-raw',
              expiresAt: '2026-05-16T00:00:00.000Z',
              amountBaseUnits: '100000',
              token: pendingEnvelope('env-raw').token,
              sender: pendingEnvelope('env-raw').sender,
              recipient: {
                handle: 'alice',
                renderedHandle: 'alice.pie',
                walletAddress: '0x0000000000000000000000000000000000000002',
              },
              ackText: 'Sent 0.1 USDT0 redpacket to alice.pie. Expires in 24h.',
            },
          },
          201,
        )
      }
      return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
    })

    await redpacketSend({ recipient: 'alice.pie', amount: '0.1', raw: 'true' })

    const output = JSON.parse(stdoutCapture) as { ok: boolean; data: { ackText: string } }
    expect(output.ok).toBe(true)
    expect(output.data.ackText).toContain('Sent 0.1 USDT0')
    expect(output.data).not.toHaveProperty('text')
  })

  it('preserves platform error envelopes and adds hint when send fails for insufficient balance', async () => {
    mockFetch((url) => {
      if (url.endsWith('/v2/instances/test-instance/redpackets')) {
        return jsonResponse(
          {
            ok: false,
            code: 'REDPACKET_INSUFFICIENT_BALANCE',
            error: 'Insufficient XLayer USDT0 balance',
            data: { requiredBaseUnits: '100000' },
          },
          402,
        )
      }
      if (url.endsWith('/v1/instances/test-instance/wallet/ensure')) {
        return jsonResponse({
          ok: true,
          data: {
            address: '0x0000000000000000000000000000000000000003',
            chainId: 196,
            chainType: 'ethereum',
            createdNow: false,
          },
        })
      }
      return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
    })

    await redpacketSend({ recipient: 'alice.pie', amount: '0.1' })

    const output = JSON.parse(stdoutCapture) as {
      ok: boolean
      code: string
      data: { requiredBaseUnits: string }
      hint: string
      deposit: { address: string; chainId: number; token: string }
    }
    expect(output.ok).toBe(false)
    expect(output.code).toBe('REDPACKET_INSUFFICIENT_BALANCE')
    expect(output.data).toEqual({ requiredBaseUnits: '100000' })
    expect(output.hint).toContain('Deposit XLayer USDT0')
    expect(output.deposit).toEqual({
      address: '0x0000000000000000000000000000000000000003',
      chainId: 196,
      token: 'USDT0',
    })
    expect(process.exitCode).toBe(1)
  })

  it('lists pending redpackets with sender filtering and formatted amounts', async () => {
    mockFetch((url) => {
      expect(url).toContain('/v2/instances/test-instance/redpackets/pending?senderHandle=bob.pie')
      return jsonResponse({ ok: true, data: { pending: [pendingEnvelope('env-1')] } })
    })

    await redpacketPending({ sender: 'bob.pie' })

    const output = JSON.parse(stdoutCapture) as {
      ok: boolean
      data: { count: number; pending: Array<{ amount: string; sender: string }> }
    }
    expect(output.ok).toBe(true)
    expect(output.data.count).toBe(1)
    expect(output.data.pending[0]).toMatchObject({
      amount: '0.1',
      sender: 'bob.pie',
    })
  })

  it('claims redpackets by sender after resolving matching pending ids', async () => {
    mockFetch((url) => {
      if (url.endsWith('/v2/instances/test-instance/redpackets/pending?senderHandle=bob.pie')) {
        return jsonResponse({
          ok: true,
          data: { pending: [pendingEnvelope('env-1'), pendingEnvelope('env-2', '250000')] },
        })
      }
      if (url.endsWith('/v2/instances/test-instance/redpackets/claim')) {
        expect(calls.at(-1)?.body).toEqual({ envelopeIds: ['env-1', 'env-2'] })
        return jsonResponse({
          ok: true,
          data: {
            claimed: [
              {
                envelopeId: 'env-1',
                txHash: '0xtx',
                amountBaseUnits: '100000',
                sender: pendingEnvelope('env-1').sender,
                ackText: 'Claimed 2 redpackets totalling 0.35 USDT0 from bob.pie.',
              },
            ],
            failed: [],
            ackText: 'Claimed 2 redpackets totalling 0.35 USDT0 from bob.pie.',
          },
        })
      }
      return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
    })

    await redpacketClaim({ sender: 'bob.pie' })

    const output = JSON.parse(stdoutCapture) as {
      ok: boolean
      data: {
        text: string
        claimedCount: number
        failedCount: number
        claimed: Array<{ envelopeId: string }>
        failed: unknown[]
      }
    }
    expect(output.ok).toBe(true)
    expect(output.data.text).toContain('Claimed 2 redpackets')
    expect(output.data.claimedCount).toBe(1)
    expect(output.data.failedCount).toBe(0)
    expect(output.data.claimed).toEqual([
      {
        envelopeId: 'env-1',
        txHash: '0xtx',
        amount: '0.1',
        symbol: 'USDT0',
        amountBaseUnits: '100000',
        sender: 'bob.pie',
        senderWalletAddress: '0x0000000000000000000000000000000000000001',
      },
    ])
    expect(output.data.failed).toEqual([])
  })

  it('preserves settlement failures from claim responses', async () => {
    mockFetch((url) => {
      if (url.endsWith('/v2/instances/test-instance/redpackets/claim')) {
        return jsonResponse({
          ok: true,
          data: {
            claimed: [],
            failed: [{ envelopeId: 'env-1', error: 'sender has insufficient USDT0 balance' }],
            ackText: null,
          },
        })
      }
      return jsonResponse({ ok: false, error: 'unexpected route' }, 404)
    })

    await redpacketClaim({})

    const output = JSON.parse(stdoutCapture) as {
      ok: boolean
      data: {
        text: string | null
        failedCount: number
        failed: Array<{ envelopeId: string; error: string }>
      }
    }
    expect(output.ok).toBe(true)
    expect(output.data.text).toBeNull()
    expect(output.data.failedCount).toBe(1)
    expect(output.data.failed).toEqual([
      { envelopeId: 'env-1', error: 'sender has insufficient USDT0 balance' },
    ])
  })

  it('lists sent redpackets with normalized agent-friendly shape', async () => {
    mockFetch((url) => {
      expect(url).toContain('/v2/instances/test-instance/redpackets/sent?limit=20&offset=2')
      return jsonResponse({
        ok: true,
        data: {
          sent: [
            {
              envelopeId: 'env-1',
              amountBaseUnits: '100000',
              status: 'claimed',
              createdAt: '2026-05-15T00:00:00.000Z',
              expiresAt: '2026-05-16T00:00:00.000Z',
              claimedAt: '2026-05-15T01:00:00.000Z',
              expiredAt: null,
              claimTxHash: '0xtx',
              token: pendingEnvelope('env-1').token,
              recipient: {
                handle: 'alice',
                renderedHandle: 'alice.pie',
                walletAddress: '0x0000000000000000000000000000000000000002',
                instanceId: 'recipient-instance',
                ownerUserId: 'recipient-user',
              },
            },
          ],
          total: 1,
          limit: 20,
          offset: 2,
          hasMore: false,
        },
      })
    })

    await redpacketSent({ limit: '20', offset: '2' })

    const output = JSON.parse(stdoutCapture) as {
      ok: boolean
      data: {
        sent: Array<{ envelopeId: string; amount: string; recipient: string }>
        limit: number
      }
    }
    expect(output.ok).toBe(true)
    expect(output.data.limit).toBe(20)
    expect(output.data.sent[0]).toMatchObject({
      envelopeId: 'env-1',
      amount: '0.1',
      recipient: 'alice.pie',
    })
  })
})
