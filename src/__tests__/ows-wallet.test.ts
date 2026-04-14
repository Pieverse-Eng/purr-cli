import { describe, expect, it } from 'vitest'
import { __testing, GasPayMasterUnsupportedError } from '../wallet/ows-sign-transaction.js'

const {
  parseGasPrice,
  parseWeiValue,
  parseDecimalToBigInt,
  isSolanaTxItem,
  hasGasPayMasterMsgs,
  buildEvmTxRequest,
  normalizeDomain,
  extractSolanaSerializedTx,
} = __testing

// ---------------------------------------------------------------------------
// Decimal parsers — verify byte-level equivalence to Privy signSingleTxItem.
// ---------------------------------------------------------------------------

describe('parseDecimalToBigInt', () => {
  it('handles integer strings', () => {
    expect(parseDecimalToBigInt('123', 18)).toBe(123n * 10n ** 18n)
  })

  it('pads fractional parts', () => {
    expect(parseDecimalToBigInt('1.5', 18)).toBe(15n * 10n ** 17n)
  })

  it('truncates excess fraction digits', () => {
    // "0.123456789012345678901" at 18 decimals → truncates to 18 digits
    expect(parseDecimalToBigInt('0.123456789012345678901', 18)).toBe(123456789012345678n)
  })

  it('handles zero integer part', () => {
    expect(parseDecimalToBigInt('.5', 18)).toBe(5n * 10n ** 17n)
  })
})

describe('parseGasPrice', () => {
  it('treats integer as wei', () => {
    expect(parseGasPrice('5000000000')).toBe(5_000_000_000n)
  })

  it('treats decimal < 1 as ether (×1e18)', () => {
    expect(parseGasPrice('0.00000001')).toBe(10_000_000_000n) // 1e-8 × 1e18 = 1e10
  })

  it('treats decimal >= 1 as gwei (×1e9)', () => {
    expect(parseGasPrice('5.5')).toBe(5_500_000_000n) // 5.5 × 1e9
  })

  it('handles undefined → 0', () => {
    expect(parseGasPrice(undefined)).toBe(0n)
  })
})

describe('parseWeiValue', () => {
  it('treats integer as wei', () => {
    expect(parseWeiValue('1000000000000000000')).toBe(1_000_000_000_000_000_000n)
  })

  it('treats decimal as ether (×1e18)', () => {
    expect(parseWeiValue('0.5')).toBe(5n * 10n ** 17n)
  })

  it('handles undefined → 0', () => {
    expect(parseWeiValue(undefined)).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

describe('isSolanaTxItem', () => {
  it('detects chainId 501', () => {
    expect(isSolanaTxItem({ chainId: 501 })).toBe(true)
    expect(isSolanaTxItem({ chainId: '501' })).toBe(true)
  })

  it('detects chain sol/solana', () => {
    expect(isSolanaTxItem({ chain: 'sol' })).toBe(true)
    expect(isSolanaTxItem({ chain: 'solana' })).toBe(true)
    expect(isSolanaTxItem({ chain: 'SOL' })).toBe(true)
  })

  it('detects via deriveTransaction.chainId', () => {
    expect(isSolanaTxItem({ deriveTransaction: { chainId: 501 } })).toBe(true)
  })

  it('detects via deriveTransaction.serializedTransaction presence', () => {
    expect(isSolanaTxItem({ deriveTransaction: { serializedTransaction: 'abc' } })).toBe(true)
  })

  it('detects via source.serializedTransaction', () => {
    expect(isSolanaTxItem({ source: { serializedTransaction: 'abc' } })).toBe(true)
  })

  it('returns false for EVM', () => {
    expect(isSolanaTxItem({ chainId: 56 })).toBe(false)
    expect(isSolanaTxItem({ chainId: 1 })).toBe(false)
    expect(isSolanaTxItem({})).toBe(false)
  })
})

describe('hasGasPayMasterMsgs', () => {
  it('detects eth_sign msgs at top level', () => {
    expect(
      hasGasPayMasterMsgs({
        msgs: [{ signType: 'eth_sign', hash: '0xabc' }],
      }),
    ).toBe(true)
  })

  it('detects msgs nested under deriveTransaction', () => {
    expect(
      hasGasPayMasterMsgs({
        deriveTransaction: { msgs: [{ signType: 'eth_sign', hash: '0xabc' }] },
      }),
    ).toBe(true)
  })

  it('returns false when msgs array is empty', () => {
    expect(hasGasPayMasterMsgs({ msgs: [] })).toBe(false)
  })

  // Behavior parity with Privy trusted-wallet-service.ts signTransaction (~line 749):
  // any non-empty msgs[] qualifies as Shape 3, regardless of msg content. Malformed /
  // unknown signTypes must NOT silently fall through to Shape 4 (EVM raw tx signing).
  it('returns true for unknown signType (must not fall through to EVM raw)', () => {
    expect(hasGasPayMasterMsgs({ msgs: [{ signType: 'unknown-type' }] })).toBe(true)
  })

  it('returns true for msgs with missing hash (not silently skipped)', () => {
    expect(hasGasPayMasterMsgs({ msgs: [{ signType: 'eth_sign' }] })).toBe(true)
  })

  it('returns false for plain EVM tx without msgs', () => {
    expect(hasGasPayMasterMsgs({ to: '0x1', data: '0x' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Shape 4 byte-level equivalence — parity with Privy signSingleTxItem.
// Given identical input fields, viem.serializeTransaction produces the same
// unsigned hex that OWS signTransaction will later parse + re-serialize.
// ---------------------------------------------------------------------------

describe('buildEvmTxRequest', () => {
  it('legacy tx — reads top-level fields', () => {
    const req = buildEvmTxRequest(
      {
        to: '0x1111111111111111111111111111111111111111',
        data: '0xdeadbeef',
        value: '1000000000000000000', // 1 ETH as wei integer
        gasLimit: '21000',
        gasPrice: '5000000000',
        nonce: 42,
        chainId: 56,
      },
      1,
    )
    expect(req.type).toBe('legacy')
    expect(req.chainId).toBe(56)
    expect(req.nonce).toBe(42)
    expect(req.value).toBe(10n ** 18n)
    expect(req.gas).toBe(21000n)
    if (req.type === 'legacy') {
      expect(req.gasPrice).toBe(5_000_000_000n)
    }
    expect(req.data).toBe('0xdeadbeef')
  })

  it('eip1559 tx — supportEIP1559 triggers type 2', () => {
    const req = buildEvmTxRequest(
      {
        deriveTransaction: {
          to: '0x2222222222222222222222222222222222222222',
          calldata: '0xabcd',
          value: '0',
          gasLimit: '100000',
          maxFeePerGas: '50000000000',
          maxPriorityFeePerGas: '2000000000',
          nonce: 5,
          chainId: 8453,
          supportEIP1559: true,
        },
      },
      1,
    )
    expect(req.type).toBe('eip1559')
    if (req.type === 'eip1559') {
      expect(req.maxFeePerGas).toBe(50_000_000_000n)
      expect(req.maxPriorityFeePerGas).toBe(2_000_000_000n)
    }
    expect(req.chainId).toBe(8453)
    expect(req.nonce).toBe(5)
  })

  it('prefers deriveTransaction fields over top-level', () => {
    const req = buildEvmTxRequest(
      {
        to: '0xAAAA',
        value: '100',
        deriveTransaction: {
          to: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          value: '200',
          calldata: '0xdeadbeef',
          gasLimit: '21000',
          gasPrice: '1000000000',
          nonce: 1,
          chainId: 56,
        },
      },
      1,
    )
    // to falls back to derive only if top-level is empty — top-level here is '0xAAAA'
    expect(req.to).toBe('0xAAAA')
    // value: uses `derive?.value ?? txItem.value` — derive wins
    expect(req.value).toBe(200n)
    // calldata: top-level data is absent, derive.calldata wins
    expect(req.data).toBe('0xdeadbeef')
  })

  it('falls back to chain-id arg when not in tx', () => {
    const req = buildEvmTxRequest(
      {
        to: '0xABCD',
        data: '0x',
      },
      42161,
    )
    expect(req.chainId).toBe(42161)
  })

  it('handles decimal gasPrice < 1 as ether (×1e18)', () => {
    const req = buildEvmTxRequest(
      {
        to: '0xABCD',
        data: '0x',
        gasLimit: '21000',
        gasPrice: '0.0000001', // 1e-7 × 1e18 = 1e11
        chainId: 56,
      },
      1,
    )
    if (req.type === 'legacy') {
      expect(req.gasPrice).toBe(100_000_000_000n) // 1e11
    } else {
      throw new Error('expected legacy')
    }
  })

  it('handles decimal gasPrice >= 1 as gwei (×1e9)', () => {
    const req = buildEvmTxRequest(
      {
        to: '0xABCD',
        data: '0x',
        gasLimit: '21000',
        gasPrice: '5.5',
        chainId: 56,
      },
      1,
    )
    if (req.type === 'legacy') {
      expect(req.gasPrice).toBe(5_500_000_000n)
    }
  })
})

// ---------------------------------------------------------------------------
// EIP-712 domain.chainId normalization
// ---------------------------------------------------------------------------

describe('normalizeDomain', () => {
  it('converts hex chainId to int', () => {
    expect(normalizeDomain({ chainId: '0x38' }).chainId).toBe(56)
  })

  it('converts decimal chainId string to int', () => {
    expect(normalizeDomain({ chainId: '8453' }).chainId).toBe(8453)
  })

  it('leaves number chainId intact', () => {
    expect(normalizeDomain({ chainId: 1 }).chainId).toBe(1)
  })

  it('preserves other fields', () => {
    expect(
      normalizeDomain({ name: 'X', version: '1', chainId: '0x1', verifyingContract: '0xabc' }),
    ).toEqual({ name: 'X', version: '1', chainId: 1, verifyingContract: '0xabc' })
  })
})

// ---------------------------------------------------------------------------
// Solana serialized-tx extraction — all 5 fallback paths
// ---------------------------------------------------------------------------

describe('extractSolanaSerializedTx', () => {
  it('finds data.serializedTx (nested)', () => {
    expect(extractSolanaSerializedTx({ data: { serializedTx: 'abc' } })).toBe('abc')
  })

  it('finds deriveTransaction.source.serializedTransaction', () => {
    expect(
      extractSolanaSerializedTx({
        deriveTransaction: { source: { serializedTransaction: 'xyz' } },
      }),
    ).toBe('xyz')
  })

  it('finds source.serializedTransaction at top level', () => {
    expect(extractSolanaSerializedTx({ source: { serializedTransaction: 'q' } })).toBe('q')
  })

  it('finds deriveTransaction.serializedTransaction', () => {
    expect(
      extractSolanaSerializedTx({ deriveTransaction: { serializedTransaction: 'r' } }),
    ).toBe('r')
  })

  it('falls back to data as raw string', () => {
    expect(extractSolanaSerializedTx({ data: 'rawstring' })).toBe('rawstring')
  })

  it('throws when nothing found', () => {
    expect(() => extractSolanaSerializedTx({ foo: 'bar' })).toThrow(/Cannot find/)
  })
})

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

describe('GasPayMasterUnsupportedError', () => {
  it('carries exit code 2', () => {
    const err = new GasPayMasterUnsupportedError()
    expect(err.code).toBe(2)
    expect(err.message).toMatch(/user_gas/)
  })

  it('is catchable as Error', () => {
    let caught: Error | null = null
    try {
      throw new GasPayMasterUnsupportedError()
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toBeInstanceOf(GasPayMasterUnsupportedError)
  })
})
