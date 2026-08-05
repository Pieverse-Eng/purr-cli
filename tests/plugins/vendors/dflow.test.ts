import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { dflowExecuteOrder, dflowOrder, dflowStatus } from '@pieverseio/purr-plugin-vendors/dflow'

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
    process.env.DFLOW_API_KEY = 'test-dflow-key'
    delete process.env.DFLOW_TRADE_API_BASE_URL
    delete process.env.SOLANA_RPC_URL
  })

  afterEach(() => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.DFLOW_API_KEY
    delete process.env.DFLOW_TRADE_API_BASE_URL
    delete process.env.SOLANA_RPC_URL
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
        if (url.startsWith('https://quote-api.dflow.net/order?')) {
          const parsed = new URL(url)
          expect(parsed.searchParams.get('userPublicKey')).toBe(SOLANA_ADDRESS)
          expect(parsed.searchParams.get('inputMint')).toBe(
            'So11111111111111111111111111111111111111112',
          )
          expect(parsed.searchParams.get('outputMint')).toBe(
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          )
          expect(parsed.searchParams.get('amount')).toBe('1000000')
          expect(parsed.searchParams.get('slippageBps')).toBe('auto')
          expect(parsed.searchParams.get('dynamicComputeUnitLimit')).toBe('true')
          return jsonResponse({
            inAmount: '1000000',
            outAmount: '24000000',
            slippageBps: 'auto',
            transaction: dflowTransactionBase64(),
            lastValidBlockHeight: 12345,
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
      apiBaseUrl: 'https://quote-api.dflow.net',
      apiKeyPresent: true,
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

  it('requires a DFlow API key before resolving the wallet', async () => {
    delete process.env.DFLOW_API_KEY
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({ inputMint: 'input', outputMint: 'output', amount: '1' }),
    ).rejects.toThrow(/Missing required DFlow API key/)
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

  it('signs, broadcasts, and confirms a DFlow order using the original blockhash', async () => {
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
        if (url.startsWith('https://quote-api.dflow.net/order-status?')) {
          const parsed = new URL(url)
          expect(parsed.searchParams.get('signature')).toBe('5sig')
          expect(init?.headers).toMatchObject({ 'x-api-key': 'test-dflow-key' })
          return jsonResponse({ status: 'closed', signature: '5sig' })
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
        orderAddress: 'order-address-1',
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
      orderAddress: 'order-address-1',
      status: {
        signature: '5sig',
        terminal: true,
        status: { status: 'closed' },
      },
    })
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

  it('requires a DFlow API key before signing an async order that will be polled', async () => {
    delete process.env.DFLOW_API_KEY
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
          orderAddress: 'order-address-1',
        }),
        rpcUrl: 'https://rpc.example.com',
        poll: true,
      }),
    ).rejects.toThrow(/Missing required DFlow API key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks DFlow order status by transaction signature', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        const parsed = new URL(url)
        expect(parsed.origin).toBe('https://quote-api.dflow.net')
        expect(parsed.pathname).toBe('/order-status')
        expect(parsed.searchParams.get('signature')).toBe('transaction-signature-1')
        return jsonResponse({ status: 'closed', signature: 'transaction-signature-1' })
      }),
      configurable: true,
      writable: true,
    })

    await expect(dflowStatus({ signature: 'transaction-signature-1' })).resolves.toMatchObject({
      type: 'dflow-status',
      signature: 'transaction-signature-1',
      terminal: true,
      status: { status: 'closed' },
    })
  })

  it('requires a DFlow API key before checking order status', async () => {
    delete process.env.DFLOW_API_KEY
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(dflowStatus({ signature: 'transaction-signature-1' })).rejects.toThrow(
      /Missing required DFlow API key/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
