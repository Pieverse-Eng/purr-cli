import { afterEach, describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { __testing, OwsStepExecutionError } from '@pieverseio/purr-plugin-ows/execute-steps'

const {
  parseEvmSig,
  resolveRpcUrl,
  resolveSolanaRpcUrl,
  owsEvmChainId,
  normalizeHex,
  validateStep,
  validateSolanaStep,
  isSolanaStep,
  extractSolanaTxHex,
  SUPPORTED_CHAIN_IDS,
} = __testing

// ---------------------------------------------------------------------------
// CAIP-2 chain string
// ---------------------------------------------------------------------------

describe('owsEvmChainId', () => {
  it('formats EVM chainId as eip155:N (drives OWS policy evaluation)', () => {
    expect(owsEvmChainId(1)).toBe('eip155:1')
    expect(owsEvmChainId(56)).toBe('eip155:56')
    expect(owsEvmChainId(8453)).toBe('eip155:8453')
    expect(owsEvmChainId(42161)).toBe('eip155:42161')
  })
})

// ---------------------------------------------------------------------------
// RPC URL resolution: explicit > env > default
// ---------------------------------------------------------------------------

describe('resolveRpcUrl', () => {
  const ORIG = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('EVM_RPC_') || k === 'EVM_RPC_URL') delete process.env[k]
    }
    Object.assign(process.env, ORIG)
  })

  it('uses explicit override when provided', () => {
    expect(resolveRpcUrl(56, 'https://custom-rpc.example')).toBe('https://custom-rpc.example')
  })

  it('uses chain-specific env var when no override', () => {
    process.env.EVM_RPC_56 = 'https://my-bsc-rpc'
    expect(resolveRpcUrl(56)).toBe('https://my-bsc-rpc')
  })

  it('uses generic EVM_RPC_URL env when chain-specific missing', () => {
    process.env.EVM_RPC_URL = 'https://generic-rpc'
    expect(resolveRpcUrl(56)).toBe('https://generic-rpc')
  })

  it('keeps Robinhood mainnet on the official public RPC by default', () => {
    process.env.EVM_RPC_4663 = 'https://chain-specific-rpc'
    process.env.EVM_RPC_URL = 'https://generic-rpc'
    expect(resolveRpcUrl(4663)).toBe('https://rpc.mainnet.chain.robinhood.com')
  })

  it('falls back to hardcoded default for known chains', () => {
    expect(resolveRpcUrl(56)).toMatch(/bsc-rpc/)
    expect(resolveRpcUrl(8217)).toMatch(/kaia/)
    expect(resolveRpcUrl(1001)).toMatch(/kairos/)
    expect(resolveRpcUrl(8453)).toMatch(/base-rpc/)
    expect(resolveRpcUrl(1)).toMatch(/ethereum-rpc/)
    expect(resolveRpcUrl(4663)).toBe('https://rpc.mainnet.chain.robinhood.com')
  })

  it('throws for unknown chainId without override', () => {
    expect(() => resolveRpcUrl(99999)).toThrow(/No RPC URL for chainId 99999/)
  })
})

describe('resolveSolanaRpcUrl', () => {
  const ORIG = { ...process.env }
  afterEach(() => {
    delete process.env.SOLANA_RPC_URL
    Object.assign(process.env, ORIG)
  })

  it('uses explicit override when provided', () => {
    expect(resolveSolanaRpcUrl('https://custom-solana-rpc.example')).toBe(
      'https://custom-solana-rpc.example',
    )
  })

  it('uses SOLANA_RPC_URL env when no override', () => {
    process.env.SOLANA_RPC_URL = 'https://my-solana-rpc'
    expect(resolveSolanaRpcUrl()).toBe('https://my-solana-rpc')
  })

  it('falls back to Solana mainnet public RPC', () => {
    expect(resolveSolanaRpcUrl()).toBe('https://api.mainnet-beta.solana.com')
  })
})

// ---------------------------------------------------------------------------
// Signature parsing — same format handling as sign-transaction
// ---------------------------------------------------------------------------

describe('parseEvmSig', () => {
  it('accepts 65-byte r||s||v signature', () => {
    const sig = `${'1'.repeat(64) + '2'.repeat(64)}00`
    const { r, s, v } = parseEvmSig(sig, undefined)
    expect(r).toBe(`0x${'1'.repeat(64)}`)
    expect(s).toBe(`0x${'2'.repeat(64)}`)
    expect(v).toBe(27n)
  })

  it('accepts 64-byte r||s + recoveryId', () => {
    const sig = '3'.repeat(64) + '4'.repeat(64)
    const { v } = parseEvmSig(sig, 1)
    expect(v).toBe(28n)
  })

  it('rejects 64-byte sig when recoveryId missing', () => {
    expect(() => parseEvmSig('a'.repeat(128), null)).toThrow(/recoveryId/)
  })

  it('rejects malformed sig length', () => {
    expect(() => parseEvmSig('ab', undefined)).toThrow(/Unexpected EVM sig/)
  })

  it('preserves v >= 27 (already EIP-155 form)', () => {
    const sig = `${'1'.repeat(64) + '2'.repeat(64)}93` // v=147 (BSC EIP-155)
    const { v } = parseEvmSig(sig, undefined)
    expect(v).toBe(147n)
  })
})

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

describe('OwsStepExecutionError', () => {
  it('carries partial results + failed index', () => {
    const partial = [{ stepIndex: 0, label: 'approve', hash: '0xabc', status: 'success' as const }]
    const err = new OwsStepExecutionError('boom', partial, 1)
    expect(err.partialResults).toEqual(partial)
    expect(err.failedStepIndex).toBe(1)
    expect(err.name).toBe('OwsStepExecutionError')
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// normalizeHex — odd-length calldata fix (Codex Finding #2)
// ---------------------------------------------------------------------------

describe('normalizeHex', () => {
  it('pads odd-length hex to even by inserting 0 after 0x', () => {
    expect(normalizeHex('0xabc')).toBe('0x0abc')
    expect(normalizeHex('0x1')).toBe('0x01')
  })
  it('passes through even-length hex unchanged', () => {
    expect(normalizeHex('0xdead')).toBe('0xdead')
    expect(normalizeHex('0xa9059cbb')).toBe('0xa9059cbb')
  })
  it('handles empty / zero hex', () => {
    expect(normalizeHex('0x')).toBe('0x')
    expect(normalizeHex('')).toBe('0x')
  })
})

// ---------------------------------------------------------------------------
// validateStep — Codex Finding #1: reject malformed payloads
// ---------------------------------------------------------------------------

describe('validateStep', () => {
  const baseStep = {
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    value: '0x0',
    chainId: 56,
  }

  it('accepts a well-formed step', () => {
    expect(() => validateStep(baseStep, 0)).not.toThrow()
  })

  it('rejects non-object', () => {
    expect(() => validateStep(null as never, 0)).toThrow(/not an object/)
  })

  it('rejects bad to address (not 0x-prefixed)', () => {
    expect(() => validateStep({ ...baseStep, to: 'abc' } as never, 0)).toThrow(/'to' address/)
  })

  it('rejects bad to address (wrong length)', () => {
    expect(() => validateStep({ ...baseStep, to: '0x123' } as never, 0)).toThrow(/'to' address/)
  })

  it('rejects non-hex value (Codex example: "1" instead of "0x1")', () => {
    expect(() => validateStep({ ...baseStep, value: '1' } as never, 0)).toThrow(
      /'value' must be a hex/,
    )
  })

  it('rejects non-hex data', () => {
    expect(() => validateStep({ ...baseStep, data: 'deadbeef' } as never, 0)).toThrow(
      /'data' must be a hex/,
    )
  })

  it('accepts empty/missing data', () => {
    expect(() => validateStep({ ...baseStep, data: '0x' }, 0)).not.toThrow()
    expect(() => validateStep({ ...baseStep, data: '' } as never, 0)).not.toThrow()
  })

  it('rejects non-hex gasLimit', () => {
    expect(() => validateStep({ ...baseStep, gasLimit: '21000' } as never, 0)).toThrow(/'gasLimit'/)
  })

  it('accepts hex gasLimit', () => {
    expect(() => validateStep({ ...baseStep, gasLimit: '0x5208' }, 0)).not.toThrow()
  })

  it('rejects non-positive chainId', () => {
    expect(() => validateStep({ ...baseStep, chainId: 0 } as never, 0)).toThrow(/'chainId'/)
    expect(() => validateStep({ ...baseStep, chainId: -1 } as never, 0)).toThrow(/'chainId'/)
  })

  it('rejects unsupported conditional type', () => {
    expect(() =>
      validateStep(
        {
          ...baseStep,
          conditional: { type: 'foo' as never, token: '0x1', spender: '0x2', amount: '1' },
        },
        0,
      ),
    ).toThrow(/conditional type/)
  })

  it('validates conditional addresses + amount', () => {
    expect(() =>
      validateStep(
        {
          ...baseStep,
          conditional: { type: 'allowance_lt', token: 'bad', spender: '0x2', amount: '1' },
        } as never,
        0,
      ),
    ).toThrow(/conditional.token/)
    expect(() =>
      validateStep(
        {
          ...baseStep,
          conditional: {
            type: 'allowance_lt',
            token: '0x0000000000000000000000000000000000000001',
            spender: 'bad',
            amount: '1',
          },
        } as never,
        0,
      ),
    ).toThrow(/conditional.spender/)
    expect(() =>
      validateStep(
        {
          ...baseStep,
          conditional: {
            type: 'allowance_lt',
            token: '0x0000000000000000000000000000000000000001',
            spender: '0x0000000000000000000000000000000000000002',
            amount: '',
          },
        } as never,
        0,
      ),
    ).toThrow(/conditional.amount/)
  })
})

// ---------------------------------------------------------------------------
// Solana step detection + extraction
// ---------------------------------------------------------------------------

describe('Solana execute step helpers', () => {
  it('detects explicit Solana markers', () => {
    expect(isSolanaStep({ chainType: 'solana', data: 'abc' })).toBe(true)
    expect(isSolanaStep({ chain: 'SOL', data: 'abc' })).toBe(true)
    expect(isSolanaStep({ chainId: 501, data: 'abc' })).toBe(true)
    expect(isSolanaStep({ deriveTransaction: { chainId: '501' }, data: 'abc' })).toBe(true)
  })

  it('detects serialized transaction fields without misclassifying EVM calldata', () => {
    expect(isSolanaStep({ unsignedTxHex: '0x0102' })).toBe(false)
    expect(isSolanaStep({ chain: 'solana', unsignedTxHex: '0x0102' })).toBe(true)
    expect(isSolanaStep({ deriveTransaction: { serializedTransaction: 'abc' } })).toBe(true)
    expect(
      isSolanaStep({
        to: '0x0000000000000000000000000000000000000001',
        data: '0xa9059cbb',
        value: '0x0',
        chainId: 8453,
      }),
    ).toBe(false)
    expect(
      isSolanaStep({
        chain: 'eip155:8453',
        kind: 'evm-eip1559',
        unsignedTxHex: '0x0102',
      }),
    ).toBe(false)
  })

  it('extracts hex with or without 0x', () => {
    expect(extractSolanaTxHex({ unsignedTxHex: '0x010203' })).toBe('010203')
    expect(extractSolanaTxHex({ serializedTx: '010203' })).toBe('010203')
  })

  it('extracts base58 serialized transactions', () => {
    const encoded = bs58.encode(Uint8Array.from([1, 2, 3]))
    expect(extractSolanaTxHex({ deriveTransaction: { serializedTransaction: encoded } })).toBe(
      '010203',
    )
  })

  it('treats serializedTransaction as base58 even when it looks hex-like', () => {
    expect(extractSolanaTxHex({ serializedTransaction: '1234' })).toBe(
      Buffer.from(bs58.decode('1234')).toString('hex'),
    )
  })

  it('rejects invalid explicit Solana hex', () => {
    expect(() => extractSolanaTxHex({ unsignedTxHex: 'not-hex' })).toThrow(/hex is invalid/)
  })

  it('validates presence of a serialized Solana transaction', () => {
    expect(() => validateSolanaStep({ chainType: 'solana' }, 0)).toThrow(
      /unsignedTxHex or serializedTransaction/,
    )
  })
})

// ---------------------------------------------------------------------------
// SUPPORTED_CHAIN_IDS — must match server (Codex Finding #3a)
// ---------------------------------------------------------------------------

describe('SUPPORTED_CHAIN_IDS', () => {
  it('includes all 14 server-supported chains', () => {
    // From api-server services/evm.ts CHAIN_CONFIG
    const expected = [1, 10, 56, 97, 137, 143, 1001, 2818, 4663, 8217, 8453, 10143, 42161, 46630]
    expect(SUPPORTED_CHAIN_IDS).toEqual(expected)
  })

  it('contains Monad and Kaia mainnet/testnet alongside existing extended chains', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(97)
    expect(SUPPORTED_CHAIN_IDS).toContain(143)
    expect(SUPPORTED_CHAIN_IDS).toContain(1001)
    expect(SUPPORTED_CHAIN_IDS).toContain(2818)
    expect(SUPPORTED_CHAIN_IDS).toContain(8217)
    expect(SUPPORTED_CHAIN_IDS).toContain(10143)
    expect(SUPPORTED_CHAIN_IDS).toContain(4663)
    expect(SUPPORTED_CHAIN_IDS).toContain(46630)
  })
})
