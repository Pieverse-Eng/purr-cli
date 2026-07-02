import { describe, expect, it } from 'vitest'
import { NATIVE_EVM } from '@pieverseio/purr-core/shared'
import { inferChainId, resolveToken } from '@pieverseio/purr-core/token-registry'

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

  it('resolves KAIA to native on Kaia mainnet', () => {
    expect(resolveToken('KAIA', 8217)).toBe(NATIVE_EVM)
  })

  it('resolves KLAY legacy alias to native on Kairos', () => {
    expect(resolveToken('KLAY', 1001)).toBe(NATIVE_EVM)
  })

  it('resolves OKB to native on X Layer', () => {
    expect(resolveToken('OKB', 196)).toBe(NATIVE_EVM)
  })

  it('resolves USDC on X Layer (6 decimals, OKX-bridged)', () => {
    expect(resolveToken('USDC', 196)).toBe('0x74b7F16337b8972027F6196A17a631aC6dE26d22')
  })

  it('resolves USDT0 on X Layer (canonical Tether-family asset)', () => {
    expect(resolveToken('USDT0', 196)).toBe('0x779ded0c9e1022225f8e0630b35a9b54be713736')
  })

  it('does not resolve bare USDT on X Layer (deprecated legacy bridged Tether is intentionally unmapped)', () => {
    expect(() => resolveToken('USDT', 196)).toThrow(/Unknown token "USDT" on chain 196/)
    expect(() => resolveToken('USDT', 196)).toThrow(/USDT0/)
  })

  it('resolves USDG on X Layer', () => {
    expect(resolveToken('USDG', 196)).toBe('0x4ae46a509f6b1d9056937ba4500cb143933d2dc8')
  })

  // --- Robinhood Chain tokens ---
  it('resolves ETH to native on Robinhood Chain', () => {
    expect(resolveToken('ETH', 4663)).toBe(NATIVE_EVM)
  })

  it('resolves WETH and USDG on Robinhood Chain', () => {
    expect(resolveToken('WETH', 4663)).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73')
    expect(resolveToken('USDG', 4663)).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
  })

  it('resolves Robinhood Chain stock and ETF token tickers', () => {
    expect(resolveToken('NVDA', 4663)).toBe('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC')
    expect(resolveToken('SPY', 4663)).toBe('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
    expect(resolveToken('USO', 4663)).toBe('0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344')
  })

  it('uses the on-chain USO symbol for United States Oil Fund on Robinhood Chain', () => {
    expect(() => resolveToken('CUSO', 4663)).toThrow(/Unknown token "CUSO" on chain 4663/)
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

  it('resolves JTO on Solana', () => {
    expect(resolveToken('JTO', -1)).toBe('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL')
  })

  it('resolves JITOSOL on Solana', () => {
    expect(resolveToken('JITOSOL', -1)).toBe('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn')
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
    expect(inferChainId({ chain: 'kaia' })).toBe(8217)
    expect(inferChainId({ chain: 'kairos' })).toBe(1001)
    expect(inferChainId({ chain: 'xlayer' })).toBe(196)
    expect(inferChainId({ chain: 'x-layer' })).toBe(196)
    expect(inferChainId({ chain: 'okx' })).toBe(196)
    expect(inferChainId({ chain: 'robinhood' })).toBe(4663)
    expect(inferChainId({ chain: 'robinhood-chain' })).toBe(4663)
    expect(inferChainId({ chain: 'rhc' })).toBe(4663)
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
