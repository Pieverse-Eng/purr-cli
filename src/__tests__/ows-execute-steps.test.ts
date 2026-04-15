import { afterEach, describe, expect, it } from 'vitest'
import { __testing, OwsStepExecutionError } from '../wallet/ows-execute-steps.js'

const {
  parseEvmSig,
  resolveRpcUrl,
  owsEvmChainId,
  normalizeHex,
  validateStep,
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

  it('falls back to hardcoded default for known chains', () => {
    expect(resolveRpcUrl(56)).toMatch(/bsc-rpc/)
    expect(resolveRpcUrl(8453)).toMatch(/base-rpc/)
    expect(resolveRpcUrl(1)).toMatch(/ethereum-rpc/)
  })

  it('throws for unknown chainId without override', () => {
    expect(() => resolveRpcUrl(99999)).toThrow(/No RPC URL for chainId 99999/)
  })
})

// ---------------------------------------------------------------------------
// Signature parsing — same format handling as ows-sign-transaction
// ---------------------------------------------------------------------------

describe('parseEvmSig', () => {
  it('accepts 65-byte r||s||v signature', () => {
    const sig = '1'.repeat(64) + '2'.repeat(64) + '00'
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
    const sig = '1'.repeat(64) + '2'.repeat(64) + '93' // v=147 (BSC EIP-155)
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
// SUPPORTED_CHAIN_IDS — must match server (Codex Finding #3a)
// ---------------------------------------------------------------------------

describe('SUPPORTED_CHAIN_IDS', () => {
  it('includes all 9 server-supported chains', () => {
    // From api-server services/evm.ts CHAIN_CONFIG
    const expected = [1, 10, 56, 97, 137, 2818, 8453, 42161, 46630]
    expect(SUPPORTED_CHAIN_IDS).toEqual(expected)
  })

  it('contains BSC testnet 97, Morph 2818, Robinhood 46630 (Codex flagged missing)', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(97)
    expect(SUPPORTED_CHAIN_IDS).toContain(2818)
    expect(SUPPORTED_CHAIN_IDS).toContain(46630)
  })
})
