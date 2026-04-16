/**
 * Integration tests for owsWalletSignTransaction — exercise the actual OWS
 * call sites with a mocked SDK. These cover the doc-sensitive parts that the
 * pure-helper tests in ows-wallet.test.ts can't catch:
 *   - Chain string passed to OWS (CAIP-2 per-chain, not hardcoded 'ethereum')
 *   - Signature format handling (65-byte r||s||v, 64-byte + recoveryId)
 *   - Dispatch order across all 4 shapes end-to-end
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock @open-wallet-standard/core BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const owsCalls = {
  signTransaction: [] as Array<{
    wallet: string
    chain: string
    txHex: string
    passphrase?: string
  }>,
  signTypedData: [] as Array<{
    wallet: string
    chain: string
    typedDataJson: string
    passphrase?: string
  }>,
}

type MockResult = { signature: string; recoveryId?: number | null }
let nextEvmResult: MockResult = {
  signature:
    'fed08348661ad4d78d770e92cce498fbc4fe935ec4b4e839bbbd926326a5e257609a0ee6dffdca45e5fdb6885320f5210c86a2e3e06334164dda9edcbaf6d4361b',
  recoveryId: 27,
}
let nextSolanaResult: MockResult = {
  signature: '0'.repeat(128), // 64 bytes of 0x00
  recoveryId: null,
}
let nextTypedResult: MockResult = {
  signature: 'a'.repeat(130), // 65 bytes all 0xAA
  recoveryId: 27,
}

vi.mock('@open-wallet-standard/core', () => {
  return {
    getWallet: vi.fn((name: string) => ({
      id: 'mock-uuid',
      name,
      createdAt: '2026-04-13T00:00:00Z',
      accounts: [
        {
          chainId: 'eip155:1',
          address: '0x1234567890123456789012345678901234567890',
          derivationPath: "m/44'/60'/0'/0/0",
        },
        {
          chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          address: '11111111111111111111111111111111',
          derivationPath: "m/44'/501'/0'/0'",
        },
      ],
    })),
    signTransaction: vi.fn((wallet: string, chain: string, txHex: string, passphrase?: string) => {
      owsCalls.signTransaction.push({ wallet, chain, txHex, passphrase })
      // Solana chain returns 64-byte sig with null recoveryId; EVM returns 65-byte.
      return chain === 'solana' ? nextSolanaResult : nextEvmResult
    }),
    signTypedData: vi.fn(
      (wallet: string, chain: string, typedDataJson: string, passphrase?: string) => {
        owsCalls.signTypedData.push({ wallet, chain, typedDataJson, passphrase })
        return nextTypedResult
      },
    ),
  }
})

// Import AFTER vi.mock so the mock takes effect.
const { owsWalletSignTransaction, GasPayMasterUnsupportedError } = await import(
  '../wallet/ows-sign-transaction.js'
)

beforeEach(() => {
  owsCalls.signTransaction.length = 0
  owsCalls.signTypedData.length = 0
  nextEvmResult = {
    signature:
      'fed08348661ad4d78d770e92cce498fbc4fe935ec4b4e839bbbd926326a5e257609a0ee6dffdca45e5fdb6885320f5210c86a2e3e06334164dda9edcbaf6d4361b',
    recoveryId: 27,
  }
  nextSolanaResult = { signature: '0'.repeat(128), recoveryId: null }
  nextTypedResult = { signature: 'a'.repeat(130), recoveryId: 27 }
})

// ---------------------------------------------------------------------------
// Chain string — the #1 finding from code review.
// ---------------------------------------------------------------------------

describe('chain string passed to OWS (CAIP-2)', () => {
  it('BSC (chainId 56) → eip155:56, NOT hardcoded "ethereum"', async () => {
    await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            chainId: 56,
            deriveTransaction: {
              to: '0x55d398326f99059fF775485246999027B3197955',
              calldata: '0x',
              value: '0',
              gasLimit: '21000',
              gasPrice: '1000000000',
              nonce: 0,
              chainId: 56,
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    expect(owsCalls.signTransaction).toHaveLength(1)
    expect(owsCalls.signTransaction[0].chain).toBe('eip155:56')
  })

  it('Base (chainId 8453) → eip155:8453', async () => {
    await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            chainId: 8453,
            deriveTransaction: {
              to: '0x0000000000000000000000000000000000000001',
              calldata: '0x',
              value: '0',
              gasLimit: '21000',
              maxFeePerGas: '1000000000',
              maxPriorityFeePerGas: '100000000',
              nonce: 0,
              chainId: 8453,
              supportEIP1559: true,
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    expect(owsCalls.signTransaction[0].chain).toBe('eip155:8453')
  })

  it('EIP-712 uses domain.chainId (not fallback)', async () => {
    await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            function: 'signTypeData',
            signTypeData: {
              domain: { name: 'X', chainId: '0x38' }, // hex 56
              types: {},
              primaryType: 'Order',
              message: {},
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    expect(owsCalls.signTypedData).toHaveLength(1)
    expect(owsCalls.signTypedData[0].chain).toBe('eip155:56')
  })

  it('EIP-712 falls back to CLI --chain-id when domain.chainId missing', async () => {
    await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            function: 'signTypeData',
            signTypeData: {
              domain: { name: 'X' }, // no chainId
              types: {},
              primaryType: 'Order',
              message: {},
            },
          },
        ],
      }),
      42161, // Arbitrum
      { owsWallet: 'w' },
    )
    expect(owsCalls.signTypedData[0].chain).toBe('eip155:42161')
  })

  it('Solana uses chain="solana", not CAIP-2', async () => {
    // Build a minimal legacy solana tx (well-formed enough for VersionedTransaction)
    // — we use a pre-known valid serializedTx fixture below.
    const bs58 = await import('bs58')
    const { VersionedTransaction, Message, PublicKey } = await import('@solana/web3.js')
    // Construct a minimal legacy message with 1 signer (user)
    const userPubkey = '11111111111111111111111111111111'
    const msg = new Message({
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 0,
      },
      accountKeys: [new PublicKey(userPubkey)],
      recentBlockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
      instructions: [],
    })
    const vtx = new VersionedTransaction(msg)
    const base58 = bs58.default.encode(vtx.serialize())
    nextSolanaResult = {
      signature: Buffer.alloc(64, 0xab).toString('hex'),
      recoveryId: null,
    }
    await owsWalletSignTransaction(
      JSON.stringify({
        txs: [{ chainId: 501, data: { serializedTx: base58 } }],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    expect(owsCalls.signTransaction).toHaveLength(1)
    expect(owsCalls.signTransaction[0].chain).toBe('solana')
  })
})

// ---------------------------------------------------------------------------
// Signature format handling — the #2 finding.
// ---------------------------------------------------------------------------

describe('signature format handling', () => {
  it('accepts 65-byte r||s||v signature (current SDK behavior)', async () => {
    nextEvmResult = {
      signature: `${'1'.repeat(64) + '2'.repeat(64)}00`, // r=1s s=2s v=0
      recoveryId: 27,
    }
    const result = await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            chainId: 56,
            deriveTransaction: {
              to: '0x0000000000000000000000000000000000000001',
              calldata: '0x',
              value: '0',
              gasLimit: '21000',
              gasPrice: '1000000000',
              nonce: 0,
              chainId: 56,
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    expect(typeof result.txs[0].sig).toBe('string')
    // Signed tx should be a 0x-prefixed hex string longer than the unsigned.
    expect((result.txs[0].sig as string).startsWith('0x')).toBe(true)
  })

  it('accepts 64-byte r||s + recoveryId (future-proof SDK behavior)', async () => {
    nextEvmResult = {
      signature: '3'.repeat(64) + '4'.repeat(64), // 64 bytes, no v
      recoveryId: 1,
    }
    const result = await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            chainId: 56,
            deriveTransaction: {
              to: '0x0000000000000000000000000000000000000001',
              calldata: '0x',
              value: '0',
              gasLimit: '21000',
              gasPrice: '1000000000',
              nonce: 0,
              chainId: 56,
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    expect(typeof result.txs[0].sig).toBe('string')
    expect((result.txs[0].sig as string).startsWith('0x')).toBe(true)
  })

  it('rejects 64-byte signature when recoveryId missing', async () => {
    nextEvmResult = {
      signature: '3'.repeat(128),
      recoveryId: null,
    }
    await expect(
      owsWalletSignTransaction(
        JSON.stringify({
          txs: [
            {
              chainId: 56,
              deriveTransaction: {
                to: '0x0000000000000000000000000000000000000001',
                calldata: '0x',
                value: '0',
                gasLimit: '21000',
                gasPrice: '1000000000',
                nonce: 0,
                chainId: 56,
              },
            },
          ],
        }),
        undefined,
        { owsWallet: 'w' },
      ),
    ).rejects.toThrow(/64-byte.*without recoveryId/)
  })

  it('rejects malformed signature length', async () => {
    nextEvmResult = { signature: 'ab', recoveryId: 27 }
    await expect(
      owsWalletSignTransaction(
        JSON.stringify({
          txs: [
            {
              chainId: 56,
              deriveTransaction: {
                to: '0x0000000000000000000000000000000000000001',
                calldata: '0x',
                value: '0',
                gasLimit: '21000',
                gasPrice: '1000000000',
                nonce: 0,
                chainId: 56,
              },
            },
          ],
        }),
        undefined,
        { owsWallet: 'w' },
      ),
    ).rejects.toThrow(/Unexpected EVM signature length/)
  })
})

// ---------------------------------------------------------------------------
// Dispatch order — the #1/#2 findings from the prior review.
// ---------------------------------------------------------------------------

describe('dispatch order', () => {
  it('mixed signTypeData + msgs[] → routes to EIP-712 (NOT rejected)', async () => {
    const result = await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            function: 'signTypeData',
            msgs: [{ signType: 'eth_sign', hash: '0xabc' }],
            signTypeData: {
              domain: { name: 'X', chainId: 1 },
              types: {},
              primaryType: 'Order',
              message: {},
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w' },
    )
    // Must have called signTypedData, NOT thrown GasPayMaster error.
    expect(owsCalls.signTypedData).toHaveLength(1)
    expect(owsCalls.signTransaction).toHaveLength(0)
    expect(result.txs[0].sig).toBeDefined()
  })

  it('msgs-only tx (no signTypeData) → rejects with exit code 2', async () => {
    await expect(
      owsWalletSignTransaction(
        JSON.stringify({
          txs: [{ chainId: 56, msgs: [{ signType: 'eth_sign', hash: '0xabc' }] }],
        }),
        undefined,
        { owsWallet: 'w' },
      ),
    ).rejects.toBeInstanceOf(GasPayMasterUnsupportedError)
    expect(owsCalls.signTransaction).toHaveLength(0)
    expect(owsCalls.signTypedData).toHaveLength(0)
  })

  it('unknown msgs signType (no eth_sign) → still rejects, not silent fallthrough', async () => {
    await expect(
      owsWalletSignTransaction(
        JSON.stringify({
          txs: [{ chainId: 56, msgs: [{ signType: 'weird' }] }],
        }),
        undefined,
        { owsWallet: 'w' },
      ),
    ).rejects.toBeInstanceOf(GasPayMasterUnsupportedError)
  })
})

// ---------------------------------------------------------------------------
// Token plumbing — verify OWS_PASSPHRASE / --ows-token reaches SDK.
// ---------------------------------------------------------------------------

describe('token passthrough', () => {
  it('passes owsToken as passphrase to OWS SDK', async () => {
    await owsWalletSignTransaction(
      JSON.stringify({
        txs: [
          {
            chainId: 56,
            deriveTransaction: {
              to: '0x0000000000000000000000000000000000000001',
              calldata: '0x',
              value: '0',
              gasLimit: '21000',
              gasPrice: '1000000000',
              nonce: 0,
              chainId: 56,
            },
          },
        ],
      }),
      undefined,
      { owsWallet: 'w', owsToken: 'ows_key_test123' },
    )
    expect(owsCalls.signTransaction[0].passphrase).toBe('ows_key_test123')
  })
})
