import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

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
        return { txHash: 'solana-signature-111' }
      },
    ),
  }
})

const { owsExecuteSteps } = await import('@pieverseio/purr-plugin-ows/execute-steps')

describe('owsExecuteSteps Solana', () => {
  beforeEach(() => {
    owsCalls.signAndSend.length = 0
    owsGetWalletMock.mockReset()
    owsGetWalletMock.mockReturnValue({
      accounts: [
        {
          chainId: 'eip155:1',
          address: '0x1234567890123456789012345678901234567890',
        },
        {
          chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          address: '11111111111111111111111111111111',
        },
      ],
    })
  })

  it('signs and broadcasts a Solana unsignedTxHex step', async () => {
    const result = await owsExecuteSteps({
      stepsJson: JSON.stringify({
        steps: [
          {
            chainType: 'solana',
            unsignedTxHex: '0x010203',
            label: 'Transfer SOL',
          },
        ],
      }),
      owsWallet: 'treasury',
      owsToken: 'ows_key_test',
      rpcUrl: 'https://solana-rpc.example',
      vaultPath: '/tmp/ows-vault',
    })

    expect(result).toEqual({
      from: '11111111111111111111111111111111',
      chainId: 501,
      chainType: 'solana',
      results: [
        {
          stepIndex: 0,
          label: 'Transfer SOL',
          hash: 'solana-signature-111',
          status: 'success',
        },
      ],
    })
    expect(owsCalls.signAndSend).toEqual([
      {
        wallet: 'treasury',
        chain: 'solana',
        txHex: '0x010203',
        passphrase: 'ows_key_test',
        rpcUrl: 'https://solana-rpc.example',
        vaultPath: '/tmp/ows-vault',
      },
    ])
  })

  it('accepts base58 serializedTransaction payloads', async () => {
    const serialized = bs58.encode(Uint8Array.from([1, 2, 3]))

    await owsExecuteSteps({
      stepsJson: JSON.stringify({
        steps: [
          {
            chain: 'solana',
            deriveTransaction: {
              serializedTransaction: serialized,
            },
          },
        ],
      }),
      owsWallet: 'treasury',
      rpcUrl: 'https://solana-rpc.example',
    })

    expect(owsCalls.signAndSend).toHaveLength(1)
    expect(owsCalls.signAndSend[0]).toMatchObject({
      chain: 'solana',
      txHex: '0x010203',
      rpcUrl: 'https://solana-rpc.example',
    })
  })

  it('accepts a single Solana build-transfer output object', async () => {
    await owsExecuteSteps({
      stepsJson: JSON.stringify({
        chain: 'solana',
        kind: 'solana',
        from: '11111111111111111111111111111111',
        to: '22222222222222222222222222222222',
        amount: '0.01',
        unsignedTxHex: '0x0a0b0c',
      }),
      owsWallet: 'treasury',
      rpcUrl: 'https://solana-rpc.example',
    })

    expect(owsCalls.signAndSend).toHaveLength(1)
    expect(owsCalls.signAndSend[0]).toMatchObject({
      chain: 'solana',
      txHex: '0x0a0b0c',
      rpcUrl: 'https://solana-rpc.example',
    })
  })

  it('does not treat a single EVM build-transfer output object as Solana', async () => {
    await expect(
      owsExecuteSteps({
        stepsJson: JSON.stringify({
          chain: 'eip155:8453',
          kind: 'evm-eip1559',
          from: '0x1234567890123456789012345678901234567890',
          to: '0x3333333333333333333333333333333333333333',
          amount: '0.01',
          unsignedTxHex: '0x010203',
        }),
        owsWallet: 'treasury',
      }),
    ).rejects.toThrow(/non-empty steps array/)
    expect(owsCalls.signAndSend).toHaveLength(0)
  })

  it('rejects mixed EVM and Solana steps', async () => {
    await expect(
      owsExecuteSteps({
        stepsJson: JSON.stringify({
          steps: [
            {
              chainType: 'solana',
              unsignedTxHex: '0x010203',
            },
            {
              to: '0x3333333333333333333333333333333333333333',
              data: '0x',
              value: '0x0',
              chainId: 8453,
            },
          ],
        }),
        owsWallet: 'treasury',
      }),
    ).rejects.toThrow(/Mixed chainTypes/)
  })

  it('requires a Solana account in the OWS wallet', async () => {
    owsGetWalletMock.mockReturnValue({
      accounts: [
        {
          chainId: 'eip155:1',
          address: '0x1234567890123456789012345678901234567890',
        },
      ],
    })

    await expect(
      owsExecuteSteps({
        stepsJson: JSON.stringify({
          steps: [
            {
              chainType: 'solana',
              unsignedTxHex: '0x010203',
            },
          ],
        }),
        owsWallet: 'treasury',
      }),
    ).rejects.toThrow(/has no Solana account/)
  })
})
