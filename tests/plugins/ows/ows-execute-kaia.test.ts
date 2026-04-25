import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const owsCalls = {
  signAndSend: [] as Array<{
    wallet: string
    chain: string
    txHex: string
    passphrase?: string
    rpcUrl?: string
    vaultPath?: string
  }>,
}

const owsGetWalletMock = vi.fn()
const originalFetch = globalThis.fetch

vi.mock('@open-wallet-standard/core', () => {
  return {
    getWallet: owsGetWalletMock,
    signAndSend: vi.fn(
      (
        wallet: string,
        chain: string,
        txHex: string,
        passphrase?: string,
        _index?: number,
        rpcUrl?: string,
        vaultPath?: string,
      ) => {
        owsCalls.signAndSend.push({ wallet, chain, txHex, passphrase, rpcUrl, vaultPath })
        return { txHash: `0x${'a'.repeat(64)}` }
      },
    ),
  }
})

const { owsExecuteSteps } = await import('@pieverseio/purr-plugin-ows/execute-steps')

describe('owsExecuteSteps Kaia', () => {
  beforeEach(() => {
    owsCalls.signAndSend.length = 0
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

  it('signs and broadcasts Kaia steps against the default Kaia RPC', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2019' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 2, result: '0x9' }),
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

    const result = await owsExecuteSteps({
      stepsJson: JSON.stringify({
        steps: [
          {
            to: '0x3333333333333333333333333333333333333333',
            data: '0x',
            value: '0x2386f26fc10000',
            chainId: 8217,
            gasLimit: '0x5208',
            label: 'Transfer native KAIA',
          },
        ],
      }),
      owsWallet: 'treasury',
      owsToken: 'ows_key_test',
    })

    expect(result).toMatchObject({
      from: '0x1234567890123456789012345678901234567890',
      chainId: 8217,
      chainType: 'ethereum',
    })
    expect(result.results).toEqual([
      {
        stepIndex: 0,
        label: 'Transfer native KAIA',
        hash: `0x${'a'.repeat(64)}`,
        status: 'success',
      },
    ])
    expect(owsCalls.signAndSend).toHaveLength(1)
    expect(owsCalls.signAndSend[0]).toMatchObject({
      wallet: 'treasury',
      chain: 'eip155:8217',
      passphrase: 'ows_key_test',
      rpcUrl: 'https://public-en.node.kaia.io',
    })
    expect(owsCalls.signAndSend[0].txHex.startsWith('02')).toBe(true)
  })

  it('signs and broadcasts Kairos steps against the default Kairos RPC', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x3e9' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 2, result: '0x5' }),
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

    const result = await owsExecuteSteps({
      stepsJson: JSON.stringify({
        steps: [
          {
            to: '0x3333333333333333333333333333333333333333',
            data: '0x',
            value: '0x2386f26fc10000',
            chainId: 1001,
            gasLimit: '0x5208',
            label: 'Transfer native KAIA on Kairos',
          },
        ],
      }),
      owsWallet: 'treasury',
      owsToken: 'ows_key_test',
    })

    expect(result).toMatchObject({
      from: '0x1234567890123456789012345678901234567890',
      chainId: 1001,
      chainType: 'ethereum',
    })
    expect(result.results).toEqual([
      {
        stepIndex: 0,
        label: 'Transfer native KAIA on Kairos',
        hash: `0x${'a'.repeat(64)}`,
        status: 'success',
      },
    ])
    expect(owsCalls.signAndSend).toHaveLength(1)
    expect(owsCalls.signAndSend[0]).toMatchObject({
      wallet: 'treasury',
      chain: 'eip155:1001',
      passphrase: 'ows_key_test',
      rpcUrl: 'https://public-en-kairos.node.kaia.io',
    })
    expect(owsCalls.signAndSend[0].txHex.startsWith('02')).toBe(true)
  })
})
