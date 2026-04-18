import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const owsGetWalletMock = vi.fn()
const originalFetch = globalThis.fetch

vi.mock('@open-wallet-standard/core', () => {
  return {
    getWallet: owsGetWalletMock,
  }
})

const { owsBuildTransfer } = await import('../wallet/ows-build-transfer.js')

describe('owsBuildTransfer EVM', () => {
  beforeEach(() => {
    owsGetWalletMock.mockReset()
    owsGetWalletMock.mockReturnValue({
      accounts: [
        {
          chainId: 'eip155:1',
          address: '0x1234567890123456789012345678901234567890',
        },
      ],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('builds a Kaia native transfer using the default Kaia RPC and CAIP-2 chain id', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2019' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 2, result: '0x7' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 3, result: '0x3b9aca00' }),
      })
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    const result = await owsBuildTransfer({
      owsWallet: 'treasury',
      to: '0x3333333333333333333333333333333333333333',
      amount: '0.01',
      chainId: 8217,
    })

    expect(result.chain).toBe('eip155:8217')
    expect(result.kind).toBe('evm-eip1559')
    expect(result.from).toBe('0x1234567890123456789012345678901234567890')
    expect(result.nextStep).toContain('ows sign send-tx --chain eip155:8217 --wallet treasury')
    expect(result.unsignedTxHex.startsWith('0x')).toBe(true)
    expect(result.meta).toMatchObject({
      rpcUrl: 'https://public-en.node.kaia.io',
      rpcUrlOverridden: false,
      nonce: 7,
      gasLimit: '0x5208',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://public-en.node.kaia.io',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"method":"eth_chainId"'),
      }),
    )
  })

  it('builds a Kairos native transfer using the default Kairos RPC and CAIP-2 chain id', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x3e9' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 2, result: '0x4' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 3, result: '0x3b9aca00' }),
      })
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    const result = await owsBuildTransfer({
      owsWallet: 'treasury',
      to: '0x3333333333333333333333333333333333333333',
      amount: '0.01',
      chainId: 1001,
    })

    expect(result.chain).toBe('eip155:1001')
    expect(result.kind).toBe('evm-eip1559')
    expect(result.from).toBe('0x1234567890123456789012345678901234567890')
    expect(result.nextStep).toContain('ows sign send-tx --chain eip155:1001 --wallet treasury')
    expect(result.unsignedTxHex.startsWith('0x')).toBe(true)
    expect(result.meta).toMatchObject({
      rpcUrl: 'https://public-en-kairos.node.kaia.io',
      rpcUrlOverridden: false,
      nonce: 4,
      gasLimit: '0x5208',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://public-en-kairos.node.kaia.io',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"method":"eth_chainId"'),
      }),
    )
  })
})
