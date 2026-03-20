import { describe, expect, it } from 'vitest'
import { NATIVE_EVM } from '../shared.js'
import { inferChainId, resolveToken } from '../token-registry.js'

describe('resolveToken', () => {
  // --- Address passthrough ---
  it('passes through a valid EVM address unchanged', () => {
    const addr = '0x55d398326f99059fF775485246999027B3197955'
    expect(resolveToken(addr, 56)).toBe(addr)
  })

  it('passes through a checksummed address on any chain', () => {
    const addr = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    expect(resolveToken(addr, 1)).toBe(addr)
    expect(resolveToken(addr, 56)).toBe(addr)
  })

  // --- Case-insensitive ticker lookup ---
  it('resolves uppercase ticker', () => {
    expect(resolveToken('USDT', 56)).toBe('0x55d398326f99059fF775485246999027B3197955')
  })

  it('resolves lowercase ticker', () => {
    expect(resolveToken('usdt', 56)).toBe('0x55d398326f99059fF775485246999027B3197955')
  })

  it('resolves mixed-case ticker', () => {
    expect(resolveToken('Usdc', 1)).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  })

  // --- Native token aliases ---
  it('resolves BNB to native zero address on chain 56', () => {
    expect(resolveToken('BNB', 56)).toBe(NATIVE_EVM)
  })

  it('resolves ETH to native zero address on chain 1', () => {
    expect(resolveToken('ETH', 1)).toBe(NATIVE_EVM)
  })

  it('resolves ETH to bridged ETH address on BSC (not native)', () => {
    expect(resolveToken('ETH', 56)).toBe('0x2170Ed0880ac9A755fd29B2688956BD959F933F8')
  })

  it('resolves ETH to native on Base', () => {
    expect(resolveToken('ETH', 8453)).toBe(NATIVE_EVM)
  })

  it('resolves ETH to native on Arbitrum', () => {
    expect(resolveToken('ETH', 42161)).toBe(NATIVE_EVM)
  })

  it('resolves ETH to native on Optimism', () => {
    expect(resolveToken('ETH', 10)).toBe(NATIVE_EVM)
  })

  it('resolves MATIC to native on Polygon', () => {
    expect(resolveToken('MATIC', 137)).toBe(NATIVE_EVM)
  })

  it('resolves POL to native on Polygon', () => {
    expect(resolveToken('POL', 137)).toBe(NATIVE_EVM)
  })

  // --- BNB Chain tokens ---
  it('resolves WBNB on BSC', () => {
    expect(resolveToken('WBNB', 56)).toBe('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c')
  })

  it('resolves CAKE on BSC', () => {
    expect(resolveToken('CAKE', 56)).toBe('0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82')
  })

  it('resolves BTCB on BSC', () => {
    expect(resolveToken('BTCB', 56)).toBe('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c')
  })

  // --- Base tokens ---
  it('resolves USDC on Base', () => {
    expect(resolveToken('USDC', 8453)).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  })

  it('resolves BRETT on Base', () => {
    expect(resolveToken('BRETT', 8453)).toBe('0x532f27101965dd16442E59d40670FaF5eBB142E4')
  })

  // --- Arbitrum tokens ---
  it('resolves ARB on Arbitrum', () => {
    expect(resolveToken('ARB', 42161)).toBe('0x912CE59144191C1204E64559FE8253a0e49E6548')
  })

  it('resolves USDC.E on Arbitrum', () => {
    expect(resolveToken('USDC.E', 42161)).toBe('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8')
  })

  // --- Optimism tokens ---
  it('resolves OP on Optimism', () => {
    expect(resolveToken('OP', 10)).toBe('0x4200000000000000000000000000000000000042')
  })

  // --- Polygon tokens ---
  it('resolves AAVE on Polygon', () => {
    expect(resolveToken('AAVE', 137)).toBe('0xD6DF932A45C0f255f85145f286eA0b292B21C90B')
  })

  // --- Solana tokens ---
  it('resolves SOL ticker', () => {
    expect(resolveToken('SOL', -1)).toBe('So11111111111111111111111111111111111111112')
  })

  it('resolves USDC on Solana', () => {
    expect(resolveToken('usdc', -1)).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  })

  it('passes through a Solana base58 address', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    expect(resolveToken(mint, -1)).toBe(mint)
  })

  it('resolves BONK on Solana', () => {
    expect(resolveToken('BONK', -1)).toBe('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
  })

  // --- Error cases ---
  it('throws for unknown ticker with available list', () => {
    expect(() => resolveToken('FAKECOIN', 56)).toThrow(/Unknown token "FAKECOIN" on chain 56/)
    expect(() => resolveToken('FAKECOIN', 56)).toThrow(/Available tickers:/)
  })

  it('throws for unsupported chain', () => {
    expect(() => resolveToken('USDT', 99999)).toThrow(/No token registry for chain 99999/)
    expect(() => resolveToken('USDT', 99999)).toThrow(/Supported chains:/)
  })

  it('throws for unknown Solana ticker', () => {
    expect(() => resolveToken('NOPE', -1)).toThrow(/Unknown Solana token "NOPE"/)
    expect(() => resolveToken('NOPE', -1)).toThrow(/Available tickers:/)
  })
})

describe('inferChainId', () => {
  it('returns chain-id when provided', () => {
    expect(inferChainId({ 'chain-id': '1' })).toBe(1)
    expect(inferChainId({ 'chain-id': '42161' })).toBe(42161)
  })

  it('resolves chain name to ID', () => {
    expect(inferChainId({ chain: 'bnb' })).toBe(56)
    expect(inferChainId({ chain: 'eth' })).toBe(1)
    expect(inferChainId({ chain: 'base' })).toBe(8453)
    expect(inferChainId({ chain: 'arbitrum' })).toBe(42161)
    expect(inferChainId({ chain: 'matic' })).toBe(137)
    expect(inferChainId({ chain: 'polygon' })).toBe(137)
    expect(inferChainId({ chain: 'optimism' })).toBe(10)
  })

  it('is case-insensitive for chain names', () => {
    expect(inferChainId({ chain: 'BNB' })).toBe(56)
    expect(inferChainId({ chain: 'Eth' })).toBe(1)
  })

  it('prefers chain-id over chain name', () => {
    expect(inferChainId({ 'chain-id': '1', chain: 'bnb' })).toBe(1)
  })

  it('defaults to 56 (BNB Chain) when nothing provided', () => {
    expect(inferChainId({})).toBe(56)
  })

  it('defaults to 56 for invalid chain-id', () => {
    expect(inferChainId({ 'chain-id': 'abc' })).toBe(56)
  })
})
