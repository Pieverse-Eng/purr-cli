import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bitgetOrderExecute,
  bitgetTransferExecute,
  bitgetX402SignEip3009,
  type BitgetWalletSigner,
} from '@pieverseio/purr-plugin-vendors/bitget'

const originalFetch = globalThis.fetch
const WALLET = '0x1234567890123456789012345678901234567890'

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text)
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

function makeOwsSigner(
  signedPayloads: Array<{ orderId?: string; txs: Array<Record<string, unknown>> }>,
  address = WALLET,
): BitgetWalletSigner {
  return {
    label: 'OWS wallet',
    supportsRawDigest: false,
    resolveEvmAddress: async () => address,
    signTransactions: async (payload) => {
      signedPayloads.push(payload)
      return {
        ...(payload.orderId ? { orderId: payload.orderId } : {}),
        address,
        txs: payload.txs.map((tx) => ({
          ...tx,
          sig: tx.function === 'signTypeData' ? '0xows-typed-data' : '0xows-signed-tx',
        })),
      }
    },
  }
}

describe('bitget execution helpers', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://platform.example.com'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
    process.env.BITGET_WALLET_API_BASE_URL = 'https://bitget.example.com'
  })

  afterEach(() => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.BITGET_WALLET_API_BASE_URL
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('signs a prepared Bitget order with the platform wallet and submits it', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, body })

        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: { address: WALLET, chainId: 56, chainType: 'ethereum' },
          })
        }
        if (url.endsWith('/wallet/sign-transaction')) {
          const txs = (body as { txs: Array<Record<string, unknown>> }).txs
          return jsonResponse({
            ok: true,
            data: {
              address: WALLET,
              txs: txs.map((tx) => ({ ...tx, sig: '0xsigned-order' })),
            },
          })
        }
        if (url.endsWith('/swap-go/swapx/send')) {
          expect(body).toMatchObject({
            orderId: 'order-1',
            txs: [{ sig: '0xsigned-order' }],
          })
          return jsonResponse({
            status: 0,
            error_code: 0,
            data: { orderId: 'order-1', state: 'submitted' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await bitgetOrderExecute({
      fromAddress: WALLET,
      makeOrderJson: JSON.stringify({
        status: 0,
        error_code: 0,
        data: {
          orderId: 'order-1',
          txs: [
            {
              chainId: 56,
              deriveTransaction: {
                to: '0x2222222222222222222222222222222222222222',
                calldata: '0x',
                gasLimit: '21000',
                gasPrice: '1000000000',
                nonce: 1,
                chainId: 56,
                value: '0',
              },
            },
          ],
        },
      }),
    })

    expect(result).toMatchObject({
      type: 'bitget-order-execute',
      orderId: 'order-1',
      signerAddress: WALLET,
      txCount: 1,
    })
    expect(calls.map((c) => c.url)).toEqual([
      'https://platform.example.com/v1/instances/test-instance/wallet/ensure',
      'https://platform.example.com/v1/instances/test-instance/wallet/sign-transaction',
      'https://bitget.example.com/swap-go/swapx/send',
    ])
  })

  it('rejects Bitget orders when the platform wallet does not match from-address', async () => {
    const calls: string[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push(url)
        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: {
              address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              chainId: 56,
              chainType: 'ethereum',
            },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      bitgetOrderExecute({
        fromAddress: WALLET,
        makeOrderJson: JSON.stringify({
          data: {
            orderId: 'order-1',
            txs: [
              {
                chainId: 56,
                deriveTransaction: {
                  to: '0x2222222222222222222222222222222222222222',
                  calldata: '0x',
                  gasLimit: '21000',
                  gasPrice: '1000000000',
                  nonce: 1,
                  chainId: 56,
                  value: '0',
                },
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow(/does not match --from-address/)
    expect(calls).toEqual(['https://platform.example.com/v1/instances/test-instance/wallet/ensure'])
  })

  it('signs EVM 7702 transfer hashes and submits the original msg shape with sigs', async () => {
    let submittedSig = ''
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined

        if (url.endsWith('/wallet/sign-transaction')) {
          const msgs = (body as { txs: Array<{ msgs: Array<Record<string, unknown>> }> }).txs[0]
            .msgs
          return jsonResponse({
            ok: true,
            data: {
              address: WALLET,
              txs: [{ msgs: msgs.map((msg) => ({ ...msg, sig: '0xsigned-hash' })) }],
            },
          })
        }
        if (url.endsWith('/userv2/order/submitTransferOrder')) {
          submittedSig = (body as { sig: string }).sig
          return jsonResponse({
            status: 0,
            error_code: 0,
            data: { orderId: 'transfer-1', orderStatus: 'PROCESSING' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await bitgetTransferExecute({
      transferOrderJson: JSON.stringify({
        status: 0,
        error_code: 0,
        data: {
          orderId: 'transfer-1',
          source: {
            type: 'evm_7702',
            evm7702: {
              msgToSign: [{ hash: `0x${'11'.repeat(32)}`, auth: 'keep-me' }],
            },
          },
        },
      }),
    })

    const parsedSig = JSON.parse(submittedSig) as Array<Record<string, unknown>>
    expect(parsedSig).toEqual([
      { hash: `0x${'11'.repeat(32)}`, auth: 'keep-me', sig: '0xsigned-hash' },
    ])
    expect(result).toMatchObject({
      type: 'bitget-transfer-execute',
      orderId: 'transfer-1',
      sourceType: 'evm_7702',
    })
  })

  it('rejects Bitget transfers when the platform wallet does not match from-address', async () => {
    const calls: string[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push(url)
        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: {
              address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              chainId: 8453,
              chainType: 'ethereum',
            },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      bitgetTransferExecute({
        fromAddress: WALLET,
        transferOrderJson: JSON.stringify({
          data: {
            orderId: 'transfer-1',
            source: {
              type: 'evm_legacy',
              evm: {
                to: '0x2222222222222222222222222222222222222222',
                data: '0x',
                gasLimit: '21000',
                gasPrice: '1000000000',
                nonce: 1,
                chainId: 8453,
                value: '0',
              },
            },
          },
        }),
      }),
    ).rejects.toThrow(/does not match --from-address/)
    expect(calls).toEqual(['https://platform.example.com/v1/instances/test-instance/wallet/ensure'])
  })

  it('rejects Solana order execution as out of scope', async () => {
    await expect(
      bitgetOrderExecute({
        makeOrderJson: JSON.stringify({
          data: {
            orderId: 'sol-order',
            txs: [{ chain: 'sol', data: 'serialized-tx' }],
          },
        }),
      }),
    ).rejects.toThrow(/Solana order execution is out of scope/)
  })

  it('rejects nested Solana serializedTx order execution as out of scope', async () => {
    await expect(
      bitgetOrderExecute({
        makeOrderJson: JSON.stringify({
          data: {
            orderId: 'sol-nested-order',
            txs: [
              {
                kind: 'transaction',
                data: { serializedTx: 'base58-serialized-solana-tx' },
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow(/Solana order execution is out of scope/)
  })

  it('signs a prepared Bitget order with an OWS signer and submits it', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const signedPayloads: Array<{ orderId?: string; txs: Array<Record<string, unknown>> }> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, body })

        if (url.endsWith('/swap-go/swapx/send')) {
          expect(body).toMatchObject({
            orderId: 'ows-order-1',
            txs: [{ sig: '0xows-signed-tx' }],
          })
          return jsonResponse({
            status: 0,
            error_code: 0,
            data: { orderId: 'ows-order-1', state: 'submitted' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await bitgetOrderExecute({
      fromAddress: WALLET,
      signer: makeOwsSigner(signedPayloads),
      makeOrderJson: JSON.stringify({
        data: {
          orderId: 'ows-order-1',
          txs: [
            {
              chainId: 56,
              deriveTransaction: {
                to: '0x2222222222222222222222222222222222222222',
                calldata: '0x',
                gasLimit: '21000',
                gasPrice: '1000000000',
                nonce: 1,
                chainId: 56,
                value: '0',
              },
            },
          ],
        },
      }),
    })

    expect(result).toMatchObject({
      type: 'bitget-order-execute',
      orderId: 'ows-order-1',
      signerAddress: WALLET,
      txCount: 1,
    })
    expect(signedPayloads).toHaveLength(1)
    expect(signedPayloads[0].orderId).toBe('ows-order-1')
    expect(calls.map((c) => c.url)).toEqual(['https://bitget.example.com/swap-go/swapx/send'])
  })

  it('signs an EVM transfer source with an OWS signer and submits it', async () => {
    const signedPayloads: Array<{ orderId?: string; txs: Array<Record<string, unknown>> }> = []
    let submittedSig = ''
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined

        if (url.endsWith('/userv2/order/submitTransferOrder')) {
          submittedSig = (body as { sig: string }).sig
          return jsonResponse({
            status: 0,
            error_code: 0,
            data: { orderId: 'ows-transfer-1', orderStatus: 'PROCESSING' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await bitgetTransferExecute({
      fromAddress: WALLET,
      signer: makeOwsSigner(signedPayloads),
      transferOrderJson: JSON.stringify({
        data: {
          orderId: 'ows-transfer-1',
          source: {
            type: 'evm_1559',
            from: WALLET,
            evm: {
              to: '0x2222222222222222222222222222222222222222',
              data: '0x',
              gasLimit: '21000',
              maxFeePerGas: '1000000000',
              maxPriorityFeePerGas: '100000000',
              nonce: 1,
              chainId: 8453,
              value: '0',
            },
          },
        },
      }),
    })

    expect(submittedSig).toBe('0xows-signed-tx')
    expect(signedPayloads).toHaveLength(1)
    expect(signedPayloads[0].txs[0]).toHaveProperty('deriveTransaction')
    expect(result).toMatchObject({
      type: 'bitget-transfer-execute',
      orderId: 'ows-transfer-1',
      sourceType: 'evm_1559',
    })
  })

  it('rejects OWS transfer signatures when the signed address does not match from-address', async () => {
    const signedPayloads: Array<{ orderId?: string; txs: Array<Record<string, unknown>> }> = []

    await expect(
      bitgetTransferExecute({
        fromAddress: WALLET,
        signer: makeOwsSigner(signedPayloads, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        transferOrderJson: JSON.stringify({
          data: {
            orderId: 'ows-transfer-mismatch',
            source: {
              type: 'evm_1559',
              from: WALLET,
              evm: {
                to: '0x2222222222222222222222222222222222222222',
                data: '0x',
                gasLimit: '21000',
                maxFeePerGas: '1000000000',
                maxPriorityFeePerGas: '100000000',
                nonce: 1,
                chainId: 8453,
                value: '0',
              },
            },
          },
        }),
      }),
    ).rejects.toThrow(/does not match --from-address/)
    expect(signedPayloads).toHaveLength(0)
  })

  it('rejects Bitget EVM 7702 transfer payloads with an OWS signer', async () => {
    const signedPayloads: Array<{ orderId?: string; txs: Array<Record<string, unknown>> }> = []

    await expect(
      bitgetTransferExecute({
        fromAddress: WALLET,
        signer: makeOwsSigner(signedPayloads),
        transferOrderJson: JSON.stringify({
          data: {
            orderId: 'ows-7702-transfer',
            source: {
              type: 'evm_7702',
              from: WALLET,
              evm7702: {
                msgToSign: [{ hash: `0x${'11'.repeat(32)}` }],
              },
            },
          },
        }),
      }),
    ).rejects.toThrow(/OWS wallet cannot sign Bitget EVM 7702 raw-digest payloads/)
    expect(signedPayloads).toHaveLength(0)
  })

  it('builds EIP-3009 x402 authorization through an OWS signer', async () => {
    const signedPayloads: Array<{ orderId?: string; txs: Array<Record<string, unknown>> }> = []

    const result = await bitgetX402SignEip3009({
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amount: '1000',
      signer: makeOwsSigner(signedPayloads),
    })

    expect(signedPayloads).toHaveLength(1)
    expect(signedPayloads[0].txs[0]).toMatchObject({
      function: 'signTypeData',
      signTypeData: {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: WALLET,
          to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          value: '1000',
        },
      },
    })
    expect(result).toMatchObject({
      signature: '0xows-typed-data',
      authorization: {
        from: WALLET,
        to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        value: '1000',
      },
    })
  })

  it('builds EIP-3009 x402 authorization through platform typed-data signing', async () => {
    const signedMessages: Array<Record<string, unknown>> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined

        if (url.endsWith('/wallet/ensure')) {
          return jsonResponse({
            ok: true,
            data: { address: WALLET, chainId: 8453, chainType: 'ethereum' },
          })
        }
        if (url.endsWith('/wallet/sign-typed-data')) {
          signedMessages.push((body as { message: Record<string, unknown> }).message)
          return jsonResponse({
            ok: true,
            data: { address: WALLET, signature: '0xeip3009' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await bitgetX402SignEip3009({
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amount: '1000',
    })

    expect(signedMessages).toHaveLength(1)
    expect(signedMessages[0]).toMatchObject({
      from: WALLET,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      value: '1000',
    })
    expect(result).toMatchObject({
      signature: '0xeip3009',
      authorization: {
        from: WALLET,
        to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        value: '1000',
      },
    })
  })
})
