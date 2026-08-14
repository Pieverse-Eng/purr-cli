import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  dflowExecuteOrder,
  dflowMetadata,
  dflowOrder,
  dflowPositions,
  dflowPriorityFees,
  dflowQuote,
  dflowPredictionOrderStatus,
  dflowStream,
} from '@pieverseio/purr-plugin-vendors/dflow'

const originalFetch = globalThis.fetch
const SOLANA_ADDRESS = 'DZttmKxhq1H7v5fFVPbejCkqHiTDjq9J6Q1muQT2ouWD'
const OTHER_SOLANA_ADDRESS = '2QDSRUp5Xa8SSKceKLxeYpEDgjWCpxRDWBQQA43qX4vn'
const RECENT_BLOCKHASH = '11111111111111111111111111111111'

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body)
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => text,
  } as unknown as Response
}

function jsonErrorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = JSON.stringify(body)
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => text,
  } as unknown as Response
}

function dflowTransactionBase64(options: { payer?: string; extraSigner?: string } = {}): string {
  const payer = new PublicKey(options.payer ?? SOLANA_ADDRESS)
  const extraSigner = options.extraSigner ? new PublicKey(options.extraSigner) : undefined
  const instructions = [
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: payer,
      lamports: 1,
    }),
  ]
  if (extraSigner) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: extraSigner,
        toPubkey: extraSigner,
        lamports: 1,
      }),
    )
  }
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: RECENT_BLOCKHASH,
    instructions,
  }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64')
}

describe('dflow execution helpers', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://platform.example.com'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
    delete process.env.SOLANA_RPC_URL
  })

  it('routes quote, positions, priority fees, and Metadata API through the platform', async () => {
    const calls: Array<{ url: URL; init?: RequestInit; body?: unknown }> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString())
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, init, body })
        if (url.pathname.endsWith('/dflow/quote')) {
          return jsonResponse({ ok: true, data: { inAmount: '1', outAmount: '2' } })
        }
        if (url.pathname.endsWith('/dflow/positions')) {
          return jsonResponse({ ok: true, data: { wallet: SOLANA_ADDRESS, tokens: [] } })
        }
        if (url.pathname.endsWith('/dflow/priority-fees')) {
          return jsonResponse({ ok: true, data: { high: 1000 } })
        }
        if (url.pathname.endsWith('/dflow/metadata/markets')) {
          return jsonResponse({ ok: true, data: { markets: [] } })
        }
        if (url.pathname.endsWith('/dflow/metadata/filter_outcome_mints')) {
          return jsonResponse({ ok: true, data: { outcomeMints: [] } })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await dflowQuote({ inputMint: 'input', outputMint: 'output', amount: '1' })
    await dflowPositions()
    await dflowPriorityFees()
    await dflowMetadata({ path: '/api/v1/markets', queryJson: '{"status":"active"}' })
    await dflowMetadata({
      path: 'filter_outcome_mints',
      bodyJson: `{"addresses":["${SOLANA_ADDRESS}"]}`,
    })

    expect(calls).toHaveLength(5)
    expect(calls[0].body).toEqual({ inputMint: 'input', outputMint: 'output', amount: '1' })
    expect(calls[3].url.searchParams.get('status')).toBe('active')
    expect(calls[4].body).toEqual({ addresses: [SOLANA_ADDRESS] })
    for (const call of calls) {
      expect(call.url.origin).toBe('https://platform.example.com')
      expect(call.init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
      expect(call.init?.headers).not.toHaveProperty('x-api-key')
    }
  })

  it('reads DFlow market events from the platform SSE proxy', async () => {
    const encoder = new TextEncoder()
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: connected\ndata: {"channel":"prices"}\n\n' +
              'event: message\ndata: {"ticker":"KXTEST","yes_bid":"0.4000"}\n\n',
          ),
        )
        controller.close()
      },
    })
    const fetchMock = vi.fn(
      async () =>
        new Response(responseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    )
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowStream({ channel: 'prices', tickers: 'KXTEST', maxEvents: 1 }),
    ).resolves.toMatchObject({
      type: 'dflow-stream',
      transport: 'platform',
      eventCount: 1,
      events: [{ ticker: 'KXTEST', yes_bid: '0.4000' }],
    })
    const [input, init] = fetchMock.mock.calls[0]
    expect(String(input)).toContain('/dflow/stream?channel=prices&tickers=KXTEST')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    expect(init?.headers).not.toHaveProperty('x-api-key')
  })

  afterEach(() => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.SOLANA_RPC_URL
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('creates a DFlow order using the purr Solana address', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, body })

        if (url.endsWith('/wallet/ensure')) {
          expect(body).toEqual({ chainType: 'solana' })
          return jsonResponse({
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
        }
        if (url.endsWith('/v1/instances/test-instance/dflow/order')) {
          expect(init?.method).toBe('POST')
          expect(init?.headers).toMatchObject({
            Authorization: 'Bearer test-token',
          })
          expect(init?.headers).not.toHaveProperty('x-api-key')
          expect(body).toEqual({
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            amount: '1000000',
            options: { slippageBps: 'auto' },
          })
          return jsonResponse({
            ok: true,
            data: {
              inAmount: '1000000',
              outAmount: '24000000',
              slippageBps: 'auto',
              transaction: dflowTransactionBase64(),
              lastValidBlockHeight: 12345,
            },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await dflowOrder({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000',
      paramsJson: JSON.stringify({ slippageBps: 'auto' }),
    })

    expect(result).toMatchObject({
      type: 'dflow-order',
      userPublicKey: SOLANA_ADDRESS,
      transport: 'platform',
      platformApiBaseUrl: 'https://platform.example.com',
      summary: {
        inAmount: '1000000',
        outAmount: '24000000',
        slippageBps: 'auto',
        hasTransaction: true,
      },
    })
    expect(calls.map((c) => c.url)).toHaveLength(2)
  })

  it('rejects explicit dynamic compute flags before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ dynamicComputeUnitLimit: false }),
      }),
    ).rejects.toThrow(/dynamicComputeUnitLimit is not supported in --params-json/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects sponsor parameters before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ sponsor: SOLANA_ADDRESS }),
      }),
    ).rejects.toThrow(/one signer only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects reserved DFlow order parameters before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ userPublicKey: OTHER_SOLANA_ADDRESS }),
      }),
    ).rejects.toThrow(/userPublicKey is managed by purr/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects response-only DFlow order parameters before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ computeUnitLimit: 400000 }),
      }),
    ).rejects.toThrow(/response field/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('polls an async DFlow order by executionMode without requiring orderAddress', async () => {
    const transaction = dflowTransactionBase64()
    const sendSpy = vi
      .spyOn(Connection.prototype, 'sendRawTransaction')
      .mockResolvedValue('5sig' as never)
    const confirmSpy = vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({
      context: { slot: 123 },
      value: { err: null },
    } as never)

    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined

        if (url.endsWith('/wallet/ensure')) {
          expect(body).toEqual({ chainType: 'solana' })
          return jsonResponse({
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
        }
        if (url.endsWith('/wallet/sign-solana-transaction')) {
          expect(body).toEqual({
            transaction,
            intent: { kind: 'raw_hash', chainId: 'solana:mainnet' },
          })
          return jsonResponse({
            ok: true,
            data: { signedTransaction: transaction, address: SOLANA_ADDRESS },
          })
        }
        if (url.includes('/v1/instances/test-instance/dflow/order-status?')) {
          const parsed = new URL(url)
          expect(parsed.searchParams.get('signature')).toBe('5sig')
          expect(parsed.searchParams.get('lastValidBlockHeight')).toBe('999')
          expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
          expect(init?.headers).not.toHaveProperty('x-api-key')
          return jsonResponse({
            ok: true,
            data: { status: 'closed', signature: '5sig' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await dflowExecuteOrder({
      orderJson: JSON.stringify({
        transaction,
        lastValidBlockHeight: 999,
        executionMode: 'async',
      }),
      rpcUrl: 'https://rpc.example.com',
      poll: true,
    })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith(
      {
        signature: '5sig',
        blockhash: RECENT_BLOCKHASH,
        lastValidBlockHeight: 999,
      },
      'confirmed',
    )
    expect(result).toMatchObject({
      type: 'dflow-execute-order',
      signerAddress: SOLANA_ADDRESS,
      signature: '5sig',
      recentBlockhash: RECENT_BLOCKHASH,
      lastValidBlockHeight: 999,
      executionMode: 'async',
      status: {
        signature: '5sig',
        terminal: true,
        status: { status: 'closed' },
      },
    })
  })

  it('does not query prediction order status for a synchronous DFlow order', async () => {
    const transaction = dflowTransactionBase64()
    vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('5sig' as never)
    vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({
      context: { slot: 123 },
      value: { err: null },
    } as never)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/wallet/ensure')) {
        return jsonResponse({
          ok: true,
          data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
        })
      }
      if (url.endsWith('/wallet/sign-solana-transaction')) {
        return jsonResponse({
          ok: true,
          data: { signedTransaction: transaction, address: SOLANA_ADDRESS },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({
          transaction,
          lastValidBlockHeight: 999,
          executionMode: 'sync',
        }),
        rpcUrl: 'https://rpc.example.com',
        poll: true,
      }),
    ).resolves.toMatchObject({
      type: 'dflow-execute-order',
      executionMode: 'sync',
      signature: '5sig',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves the confirmed signature when async status polling fails', async () => {
    const transaction = dflowTransactionBase64()
    vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('5sig' as never)
    vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({
      context: { slot: 123 },
      value: { err: null },
    } as never)

    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
        }
        if (url.endsWith('/wallet/sign-solana-transaction')) {
          return jsonResponse({
            ok: true,
            data: { signedTransaction: transaction, address: SOLANA_ADDRESS },
          })
        }
        if (url.includes('/v1/instances/test-instance/dflow/order-status?')) {
          return jsonErrorResponse(502, {
            ok: false,
            code: 'dflow_upstream_error',
            error: 'DFlow is temporarily unavailable.',
            retryable: true,
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({
          transaction,
          lastValidBlockHeight: 999,
          executionMode: 'async',
        }),
        rpcUrl: 'https://rpc.example.com',
        poll: true,
      }),
    ).resolves.toMatchObject({
      type: 'dflow-execute-order',
      executionMode: 'async',
      signature: '5sig',
      confirmation: { slot: 123, err: null },
      statusError: {
        status: 502,
        code: 'dflow_upstream_error',
        message: 'DFlow is temporarily unavailable.',
        retryable: true,
      },
    })
  })

  it('rejects polling without executionMode before signing or broadcasting', async () => {
    const fetchMock = vi.fn()
    const sendSpy = vi.spyOn(Connection.prototype, 'sendRawTransaction')
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({
          transaction: dflowTransactionBase64(),
          lastValidBlockHeight: 999,
        }),
        rpcUrl: 'https://rpc.example.com',
        poll: true,
      }),
    ).rejects.toThrow(/executionMode is missing/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('accepts the wrapped output from purr dflow order during execution', async () => {
    const transaction = dflowTransactionBase64()
    vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('5sig' as never)
    vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({
      context: { slot: 123 },
      value: { err: null },
    } as never)

    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()

        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
        }
        if (url.endsWith('/wallet/sign-solana-transaction')) {
          return jsonResponse({
            ok: true,
            data: { signedTransaction: transaction, address: SOLANA_ADDRESS },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({
          type: 'dflow-order',
          order: {
            transaction,
            lastValidBlockHeight: 999,
            orderAddress: 'order-address-1',
          },
        }),
        rpcUrl: 'https://rpc.example.com',
      }),
    ).resolves.toMatchObject({
      type: 'dflow-execute-order',
      signature: '5sig',
      orderAddress: 'order-address-1',
    })
  })

  it('rejects multi-signer DFlow transactions before platform signing', async () => {
    const transaction = dflowTransactionBase64({ extraSigner: OTHER_SOLANA_ADDRESS })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/wallet/ensure')) {
        return jsonResponse({
          ok: true,
          data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({ transaction, lastValidBlockHeight: 999 }),
        rpcUrl: 'https://rpc.example.com',
      }),
    ).rejects.toThrow(/supports exactly one signer/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects DFlow transactions whose signer is not the purr Solana address', async () => {
    const transaction = dflowTransactionBase64({ payer: OTHER_SOLANA_ADDRESS })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/wallet/ensure')) {
        return jsonResponse({
          ok: true,
          data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({ transaction, lastValidBlockHeight: 999 }),
        rpcUrl: 'https://rpc.example.com',
      }),
    ).rejects.toThrow(/does not match purr Solana address/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the default Solana RPC for execution when no override is set', async () => {
    const transaction = dflowTransactionBase64()
    vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('5sig' as never)
    vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({
      context: { slot: 123 },
      value: { err: null },
    } as never)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/wallet/ensure')) {
        return jsonResponse({
          ok: true,
          data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
        })
      }
      if (url.endsWith('/wallet/sign-solana-transaction')) {
        return jsonResponse({
          ok: true,
          data: { signedTransaction: transaction, address: SOLANA_ADDRESS },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    const result = await dflowExecuteOrder({
      orderJson: JSON.stringify({
        transaction,
        lastValidBlockHeight: 999,
      }),
      raw: true,
    })

    expect(result).toMatchObject({
      type: 'dflow-execute-order',
      signature: '5sig',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses SOLANA_RPC_URL before the public fallback', async () => {
    process.env.SOLANA_RPC_URL = 'https://solana.example.com'
    const transaction = dflowTransactionBase64()
    vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('5sig' as never)
    vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({
      context: { slot: 123 },
      value: { err: null },
    } as never)

    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
        }
        if (url.endsWith('/wallet/sign-solana-transaction')) {
          return jsonResponse({
            ok: true,
            data: { signedTransaction: transaction, address: SOLANA_ADDRESS },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({
          transaction,
          lastValidBlockHeight: 999,
        }),
        raw: true,
      }),
    ).resolves.toMatchObject({
      rpcUrl: 'https://solana.example.com',
    })
  })

  it('validates poll options before platform signing', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowExecuteOrder({
        orderJson: JSON.stringify({
          transaction: dflowTransactionBase64(),
          lastValidBlockHeight: 999,
        }),
        rpcUrl: 'https://rpc.example.com',
        poll: true,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/poll-interval-ms must be a positive integer/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks DFlow prediction order status by transaction signature', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const parsed = new URL(url)
        expect(parsed.origin).toBe('https://platform.example.com')
        expect(parsed.pathname).toBe('/v1/instances/test-instance/dflow/order-status')
        expect(parsed.searchParams.get('signature')).toBe('transaction-signature-1')
        expect(parsed.searchParams.get('lastValidBlockHeight')).toBe('12345')
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
        expect(init?.headers).not.toHaveProperty('x-api-key')
        return jsonResponse({
          ok: true,
          data: { status: 'closed', signature: 'transaction-signature-1' },
        })
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      dflowPredictionOrderStatus({
        signature: 'transaction-signature-1',
        lastValidBlockHeight: '12345',
      }),
    ).resolves.toMatchObject({
      type: 'dflow-prediction-order-status',
      signature: 'transaction-signature-1',
      terminal: true,
      status: { status: 'closed' },
    })
  })

  it('honors the platform Retry-After header while polling order status', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonErrorResponse(
          429,
          {
            ok: false,
            code: 'dflow_rate_limited',
            error: 'DFlow rate limit exceeded.',
            retryable: true,
            retryAfterSeconds: 1,
          },
          { 'Retry-After': '1' },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: { status: 'closed', signature: 'transaction-signature-1' },
        }),
      )
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    const statusPromise = dflowPredictionOrderStatus({
      signature: 'transaction-signature-1',
      poll: true,
      timeoutMs: 5_000,
      intervalMs: 50,
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(statusPromise).resolves.toMatchObject({
      type: 'dflow-prediction-order-status',
      terminal: true,
      status: { status: 'closed' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
