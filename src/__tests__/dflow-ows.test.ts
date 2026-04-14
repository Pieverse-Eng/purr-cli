import { describe, expect, it } from 'vitest'
import {
	__testing,
	wrapDflowOwsResponse,
	type DflowOwsSwapResult,
} from '../vendors/dflow-ows.js'

const {
	slippageToBps,
	formatBaseUnits,
	extractRoot,
	normalizeSolMint,
	isNativeSol,
	asString,
	asNumber,
} = __testing

// ---------------------------------------------------------------------------
// slippageToBps — Privy parity (decimal 0–1 → integer bps string, 'auto' for undefined)
// ---------------------------------------------------------------------------

describe('slippageToBps', () => {
	it('undefined → "auto"', () => {
		expect(slippageToBps(undefined)).toBe('auto')
	})
	it('0.01 → "100" bps', () => {
		expect(slippageToBps(0.01)).toBe('100')
	})
	it('0.5 → "5000" bps', () => {
		expect(slippageToBps(0.5)).toBe('5000')
	})
	it('rejects negative', () => {
		expect(() => slippageToBps(-0.01)).toThrow(/between 0 and 1/)
	})
	it('rejects > 1', () => {
		expect(() => slippageToBps(1.5)).toThrow(/between 0 and 1/)
	})
	it('rejects NaN', () => {
		expect(() => slippageToBps(Number.NaN)).toThrow()
	})
})

// ---------------------------------------------------------------------------
// formatBaseUnits — base units → human readable string
// ---------------------------------------------------------------------------

describe('formatBaseUnits', () => {
	it('exact integer amounts', () => {
		expect(formatBaseUnits('1000000000', 9)).toBe('1') // 1 SOL
		expect(formatBaseUnits('1000000', 6)).toBe('1') // 1 USDC
	})
	it('fractional amounts trim trailing zeros', () => {
		expect(formatBaseUnits('123450000', 9)).toBe('0.12345')
		expect(formatBaseUnits('1500000', 6)).toBe('1.5')
	})
	it('zero base units → "0"', () => {
		expect(formatBaseUnits('0', 9)).toBe('0')
	})
	it('decimals=0 → integer passthrough', () => {
		expect(formatBaseUnits('42', 0)).toBe('42')
	})
})

// ---------------------------------------------------------------------------
// normalizeSolMint / isNativeSol — system program alias mapping
// ---------------------------------------------------------------------------

describe('normalizeSolMint / isNativeSol', () => {
	const SYS = '11111111111111111111111111111111'
	const WSOL = 'So11111111111111111111111111111111111111112'
	const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

	it('system program alias → wrapped SOL', () => {
		expect(normalizeSolMint(SYS)).toBe(WSOL)
	})
	it('wrapped SOL stays wrapped', () => {
		expect(normalizeSolMint(WSOL)).toBe(WSOL)
	})
	it('other mints pass through', () => {
		expect(normalizeSolMint(USDC)).toBe(USDC)
	})
	it('isNativeSol matches both system program and wrapped SOL', () => {
		expect(isNativeSol(SYS)).toBe(true)
		expect(isNativeSol(WSOL)).toBe(true)
		expect(isNativeSol(USDC)).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// extractRoot — handles both wrapped and unwrapped DFlow responses
// ---------------------------------------------------------------------------

describe('extractRoot', () => {
	it('returns inner data when payload wrapped in {data: ...}', () => {
		expect(extractRoot({ data: { x: 1, transaction: 'abc' } })).toEqual({
			x: 1,
			transaction: 'abc',
		})
	})
	it('returns root when no data wrapper', () => {
		expect(extractRoot({ transaction: 'abc', outAmount: '100' })).toEqual({
			transaction: 'abc',
			outAmount: '100',
		})
	})
	it('returns empty object for non-object input', () => {
		expect(extractRoot(null)).toEqual({})
		expect(extractRoot([1, 2, 3])).toEqual({})
		expect(extractRoot('string')).toEqual({})
	})
})

// ---------------------------------------------------------------------------
// asString / asNumber — defensive type coercion
// ---------------------------------------------------------------------------

describe('asString', () => {
	it('returns valid strings', () => {
		expect(asString('hello')).toBe('hello')
	})
	it('rejects empty string', () => {
		expect(asString('')).toBeUndefined()
	})
	it('rejects non-strings', () => {
		expect(asString(123)).toBeUndefined()
		expect(asString(null)).toBeUndefined()
		expect(asString({})).toBeUndefined()
	})
})

describe('asNumber', () => {
	it('passes finite numbers', () => {
		expect(asNumber(42)).toBe(42)
		expect(asNumber(0)).toBe(0)
	})
	it('parses numeric strings', () => {
		expect(asNumber('42')).toBe(42)
		expect(asNumber('3.14')).toBe(3.14)
	})
	it('rejects NaN / Infinity', () => {
		expect(asNumber(Number.NaN)).toBeUndefined()
		expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
	})
	it('rejects non-numeric strings', () => {
		expect(asNumber('abc')).toBeUndefined()
		expect(asNumber('')).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Strict slippage parsing — regression test for Codex finding:
// `--slippage 0.01abc` was being silently accepted as 0.01 by parseFloat.
// ---------------------------------------------------------------------------

describe('strict slippage parsing (Number() vs parseFloat())', () => {
	// We test via slippageToBps which receives the parsed number — but the
	// boundary is in parseFloatArg in main.ts. Document the contract here:
	// any caller must pre-validate the string with Number() (or equivalent
	// strict parser) before passing to slippageToBps. parseFloat() is wrong.
	it('Number() rejects "0.01abc"; parseFloat() does not', () => {
		expect(Number('0.01abc')).toBeNaN() // strict
		expect(Number.parseFloat('0.01abc')).toBe(0.01) // lenient (BUG)
	})

	it('Number() accepts well-formed decimals', () => {
		expect(Number('0.01')).toBe(0.01)
		expect(Number('0.5')).toBe(0.5)
	})

	it('downstream slippageToBps handles NaN gracefully', () => {
		expect(() => slippageToBps(Number.NaN)).toThrow(/between 0 and 1/)
	})
})

// ---------------------------------------------------------------------------
// CLI envelope contract — `purr dflow-ows swap` stdout must match the shape of
// `purr dflow swap` stdout (`{ ok: true, data: {...} }`) so agents can swap
// one command for the other without re-parsing.
// ---------------------------------------------------------------------------

describe('wrapDflowOwsResponse (CLI envelope contract)', () => {
	const sample: DflowOwsSwapResult = {
		hash: '5Zk...sig',
		from: 'SoLAnAaddr111',
		fromToken: 'So11111111111111111111111111111111111111112',
		toToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		fromAmount: '0.1',
		fromAmountBaseUnits: '100000000',
		estimatedToAmount: '14500000',
		estimatedToAmountFormatted: '14.5',
		toTokenSymbol: 'USDC',
		toTokenDecimals: 6,
		chainId: 0,
		chainType: 'solana',
		provider: 'dflow',
		executionMode: 'sync',
		transactionId: '5Zk...sig',
	}

	it('wraps result in {ok:true, data} envelope', () => {
		const wrapped = wrapDflowOwsResponse(sample)
		expect(wrapped.ok).toBe(true)
		expect(wrapped.data).toBe(sample)
	})

	it('data field carries every DflowOwsSwapResult field at top level (parity with `purr dflow swap`)', () => {
		const wrapped = wrapDflowOwsResponse(sample)
		// Keys the Privy `purr dflow swap` path (DflowSwapApiResponse.data) emits —
		// this set must stay aligned with `src/vendors/dflow.ts`'s interface.
		// Keep sorted for diff stability.
		const requiredKeys = [
			'chainId',
			'chainType',
			'executionMode',
			'from',
			'fromAmount',
			'fromAmountBaseUnits',
			'fromToken',
			'hash',
			'provider',
			'toToken',
			'toTokenDecimals',
			'toTokenSymbol',
		] as const
		for (const k of requiredKeys) {
			expect(wrapped.data).toHaveProperty(k)
		}
	})

	it('JSON round-trips cleanly — no functions / undefined leaking into stdout', () => {
		const wrapped = wrapDflowOwsResponse(sample)
		const roundTripped = JSON.parse(JSON.stringify(wrapped)) as typeof wrapped
		expect(roundTripped.ok).toBe(true)
		expect(roundTripped.data.hash).toBe(sample.hash)
		expect(roundTripped.data.chainType).toBe('solana')
	})
})
