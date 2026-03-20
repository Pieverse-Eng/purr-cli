import { describe, expect, it } from 'vitest'
import {
  buildOkxApproveSteps,
  buildOkxSwapSteps,
  getOkxSwapChains,
  getOkxSwapLiquidity,
  quoteOkxSwap,
} from '../vendors/okx.js'
import { NATIVE_EVM } from '../shared.js'

const WALLET = '0x1234567890123456789012345678901234567890'
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
const USDC_XLAYER = '0x74b7f16337b8972027f6196a17a631ac6de26d22'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OKX_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

describe('OKX swap helpers', () => {
  it('rejects Solana swaps and points callers to dflow', async () => {
    await expect(
      buildOkxSwapSteps(
        {
          fromToken: 'SOL',
          toToken: 'USDC',
          amount: '1',
          chain: 'solana',
          wallet: WALLET,
        },
        {
          getTokenDecimals: async () => 9,
          swapApprove: async () => {
            throw new Error('should not call swapApprove for solana')
          },
          swapSwap: async () => {
            throw new Error('should not call swapSwap for solana')
          },
        },
      ),
    ).rejects.toThrow('Solana swaps are routed through dflow')
  })

  it('filters supported OKX chains down to platform EVM coverage', async () => {
    const chains = await getOkxSwapChains({
      listChains: async () => [
        { chainId: 8453, chainIndex: 8453, chainName: 'Base', dexTokenApproveAddress: '0x1' },
        { chainId: 196, chainIndex: 196, chainName: 'X Layer', dexTokenApproveAddress: '0x2' },
        { chainId: 501, chainIndex: 501, chainName: 'Solana', dexTokenApproveAddress: '' },
        { chainId: 195, chainIndex: 195, chainName: 'TRON', dexTokenApproveAddress: 'T1' },
      ],
    })

    expect(chains).toEqual([
      { chainId: 8453, chainIndex: 8453, chainName: 'Base', dexTokenApproveAddress: '0x1' },
      { chainId: 196, chainIndex: 196, chainName: 'X Layer', dexTokenApproveAddress: '0x2' },
    ])
  })

  it('routes liquidity lookups through the resolved EVM chain name', async () => {
    const liquidity = await getOkxSwapLiquidity(
      { chain: 'bnb' },
      {
        listLiquidity: async (params) => {
          expect(params).toEqual({ chain: 'bsc' })
          return [{ id: '30', name: 'PancakeSwap', logo: 'https://example.com/pancake.png' }]
        },
      },
    )

    expect(liquidity).toEqual([
      { id: '30', name: 'PancakeSwap', logo: 'https://example.com/pancake.png' },
    ])
  })

  it('builds quote requests for exactIn using from-token decimals', async () => {
    const quote = await quoteOkxSwap(
      {
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '0.001',
        chain: 'base',
      },
      {
        getTokenDecimals: async (token, chainId) => {
          expect(token).toBe(NATIVE_EVM)
          expect(chainId).toBe(8453)
          return 18
        },
        swapQuote: async (params) => {
          expect(params).toEqual({
            fromToken: OKX_NATIVE,
            toToken: USDC_BASE,
            amount: '1000000000000000',
            chain: 'base',
            swapMode: 'exactIn',
          })
          return { toTokenAmount: '2150609', fromTokenAmount: '1000000000000000' }
        },
      },
    )

    expect(quote).toMatchObject({
      toTokenAmount: '2150609',
      fromTokenAmount: '1000000000000000',
    })
  })

  it('builds quote requests for exactOut using to-token decimals', async () => {
    const quote = await quoteOkxSwap(
      {
        fromToken: 'USDC',
        toToken: 'ETH',
        amount: '0.001',
        chain: 'base',
        swapMode: 'exactOut',
      },
      {
        getTokenDecimals: async (token) => {
          expect(token).toBe(NATIVE_EVM)
          return 18
        },
        swapQuote: async (params) => {
          expect(params).toEqual({
            fromToken: USDC_BASE,
            toToken: OKX_NATIVE,
            amount: '1000000000000000',
            chain: 'base',
            swapMode: 'exactOut',
          })
          return { toTokenAmount: '1000000000000000', fromTokenAmount: '2135167' }
        },
      },
    )

    expect(quote).toMatchObject({
      toTokenAmount: '1000000000000000',
      fromTokenAmount: '2135167',
    })
  })

  it('builds a conditional OKX approval step from a human amount', async () => {
    const result = await buildOkxApproveSteps(
      {
        token: 'USDC',
        amount: '2',
        chain: 'xlayer',
      },
      {
        getTokenDecimals: async (token, chainId) => {
          expect(token).toBe(USDC_XLAYER)
          expect(chainId).toBe(196)
          return 6
        },
        swapApprove: async (params) => {
          expect(params).toEqual({
            token: USDC_XLAYER,
            amount: '2000000',
            chain: 'xlayer',
          })
          return {
            data: '0xdeadbeef',
            dexContractAddress: '0x5555555555555555555555555555555555555555',
            gasLimit: '70000',
          }
        },
      },
    )

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({
      to: USDC_XLAYER,
      value: '0x0',
      chainId: 196,
      label: 'Approve token for OKX router',
      gasLimit: '70000',
      conditional: {
        type: 'allowance_lt',
        token: USDC_XLAYER,
        spender: '0x5555555555555555555555555555555555555555',
        amount: '2000000',
      },
    })
  })

  it('rejects approval for native tokens', async () => {
    await expect(
      buildOkxApproveSteps(
        {
          token: 'ETH',
          amount: '1',
          chain: 'base',
        },
        {
          getTokenDecimals: async () => 18,
          swapApprove: async () => {
            throw new Error('should not call swapApprove for native token approvals')
          },
        },
      ),
    ).rejects.toThrow('Native tokens do not require OKX approval')
  })

  it('rejects approval responses that omit dexContractAddress', async () => {
    await expect(
      buildOkxApproveSteps(
        {
          token: 'USDC',
          amount: '1',
          chain: 'base',
        },
        {
          getTokenDecimals: async () => 6,
          swapApprove: async () => ({
            data: '0xdeadbeef',
          }),
        },
      ),
    ).rejects.toThrow('OKX approve returned no dexContractAddress')
  })

  it('builds a native-token swap without an approval step', async () => {
    const calls: Array<{ kind: string; params: Record<string, unknown> }> = []
    const result = await buildOkxSwapSteps(
      {
        fromToken: 'ETH',
        toToken: USDT_BSC,
        amount: '0.5',
        chain: 'base',
        wallet: WALLET,
        slippage: 0.03,
      },
      {
        getTokenDecimals: async () => 18,
        swapApprove: async (params) => {
          calls.push({ kind: 'approve', params: params as Record<string, unknown> })
          return {
            data: '0xdeadbeef',
            dexContractAddress: '0x1111111111111111111111111111111111111111',
          }
        },
        swapSwap: async (params) => {
          calls.push({ kind: 'swap', params: params as Record<string, unknown> })
          return {
            tx: {
              from: WALLET,
              to: '0x2222222222222222222222222222222222222222',
              data: '0xabcdef',
              gas: '210000',
              value: '500000000000000000',
            },
          }
        },
      },
    )

    expect(calls).toEqual([
      {
        kind: 'swap',
        params: {
          fromToken: OKX_NATIVE,
          toToken: USDT_BSC,
          amount: '500000000000000000',
          chain: 'base',
          wallet: WALLET,
          slippagePercent: 3,
          swapMode: 'exactIn',
          gasLevel: undefined,
          maxAutoSlippagePercent: undefined,
        },
      },
    ])
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({
      to: '0x2222222222222222222222222222222222222222',
      data: '0xabcdef',
      value: '0x6f05b59d3b20000',
      chainId: 8453,
      label: 'OKX swap',
      gasLimit: '210000',
    })
  })

  it('normalizes slippage ratios into percentage literals for swap requests', async () => {
    await buildOkxSwapSteps(
      {
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '0.5',
        chain: 'base',
        wallet: WALLET,
        slippage: 0.03,
        gasLevel: 'fast',
      },
      {
        getTokenDecimals: async () => 18,
        swapSwap: async (params) => {
          expect(params).toMatchObject({
            slippagePercent: 3,
            gasLevel: 'fast',
          })
          return {
            tx: {
              from: WALLET,
              to: '0x9999999999999999999999999999999999999999',
              data: '0xabcdef',
              gas: '210000',
              value: '500000000000000000',
            },
          }
        },
      },
    )
  })

  it('accepts percent literals for slippage without rescaling', async () => {
    await buildOkxSwapSteps(
      {
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '0.5',
        chain: 'base',
        wallet: WALLET,
        slippage: 3,
      },
      {
        getTokenDecimals: async () => 18,
        swapSwap: async (params) => {
          expect(params.slippagePercent).toBe(3)
          return {
            tx: {
              from: WALLET,
              to: '0x9999999999999999999999999999999999999999',
              data: '0xabcdef',
              gas: '210000',
              value: '500000000000000000',
            },
          }
        },
      },
    )
  })

  it('builds conditional approval + swap for exactIn ERC-20 sells', async () => {
    const calls: Array<{ kind: string; params: Record<string, unknown> }> = []
    const result = await buildOkxSwapSteps(
      {
        fromToken: USDT_BSC,
        toToken: 'BNB',
        amount: '1.5',
        chain: 'bnb',
        wallet: WALLET,
      },
      {
        getTokenDecimals: async (token) => {
          expect(token).toBe(USDT_BSC)
          return 6
        },
        swapApprove: async (params) => {
          calls.push({ kind: 'approve', params: params as Record<string, unknown> })
          return {
            data: '0xdeadbeef',
            dexContractAddress: '0x3333333333333333333333333333333333333333',
            gasLimit: '70000',
          }
        },
        swapSwap: async (params) => {
          calls.push({ kind: 'swap', params: params as Record<string, unknown> })
          return {
            routerResult: {
              fromTokenAmount: '1500000',
            },
            tx: {
              from: WALLET,
              to: '0x4444444444444444444444444444444444444444',
              data: '0xabcdef',
              gas: '250000',
              value: '0',
            },
          }
        },
      },
    )

    expect(calls).toEqual([
      {
        kind: 'swap',
        params: {
          fromToken: USDT_BSC,
          toToken: OKX_NATIVE,
          amount: '1500000',
          chain: 'bsc',
          wallet: WALLET,
          slippagePercent: undefined,
          swapMode: 'exactIn',
          gasLevel: undefined,
          maxAutoSlippagePercent: undefined,
        },
      },
      {
        kind: 'approve',
        params: {
          token: USDT_BSC,
          amount: '1500000',
          chain: 'bsc',
        },
      },
    ])
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].conditional).toMatchObject({
      type: 'allowance_lt',
      token: USDT_BSC,
      spender: '0x3333333333333333333333333333333333333333',
      amount: '1500000',
    })
    expect(result.steps[1]).toMatchObject({
      to: '0x4444444444444444444444444444444444444444',
      data: '0xabcdef',
      value: '0x0',
      chainId: 56,
      label: 'OKX swap',
      gasLimit: '250000',
    })
  })

  it('uses exactOut maxSpendAmount for the approval bound', async () => {
    const result = await buildOkxSwapSteps(
      {
        fromToken: 'USDC',
        toToken: 'ETH',
        amount: '0.001',
        chain: 'base',
        wallet: WALLET,
        swapMode: 'exactOut',
        maxAutoSlippage: 0.5,
      },
      {
        getTokenDecimals: async (token) => {
          if (token === NATIVE_EVM) return 18
          expect(token).toBe(USDC_BASE)
          return 6
        },
        swapApprove: async (params) => {
          expect(params).toEqual({
            token: USDC_BASE,
            amount: '2145843',
            chain: 'base',
          })
          return {
            data: '0xdeadbeef',
            dexContractAddress: '0x7777777777777777777777777777777777777777',
          }
        },
        swapSwap: async (params) => {
          expect(params).toEqual({
            fromToken: USDC_BASE,
            toToken: OKX_NATIVE,
            amount: '1000000000000000',
            chain: 'base',
            wallet: WALLET,
            slippagePercent: undefined,
            swapMode: 'exactOut',
            gasLevel: undefined,
            maxAutoSlippagePercent: 0.5,
          })
          return {
            routerResult: {
              fromTokenAmount: '2135167',
              toTokenAmount: '1000000000000000',
            },
            tx: {
              from: WALLET,
              to: '0x8888888888888888888888888888888888888888',
              data: '0xabcdef',
              gas: '423000',
              value: '0',
              maxSpendAmount: '2145843',
            },
          }
        },
      },
    )

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].conditional?.amount).toBe('2145843')
    expect(result.steps[1]).toMatchObject({
      to: '0x8888888888888888888888888888888888888888',
      chainId: 8453,
      gasLimit: '423000',
    })
  })

  it('falls back to routerResult.fromTokenAmount when exactOut omits maxSpendAmount', async () => {
    const result = await buildOkxSwapSteps(
      {
        fromToken: 'USDC',
        toToken: 'ETH',
        amount: '0.001',
        chain: 'base',
        wallet: WALLET,
        swapMode: 'exactOut',
      },
      {
        getTokenDecimals: async (token) => {
          if (token === NATIVE_EVM) return 18
          return 6
        },
        swapApprove: async (params) => {
          expect(params).toEqual({
            token: USDC_BASE,
            amount: '2135167',
            chain: 'base',
          })
          return {
            data: '0xdeadbeef',
            dexContractAddress: '0x7777777777777777777777777777777777777777',
          }
        },
        swapSwap: async () => ({
          routerResult: {
            fromTokenAmount: '2135167',
            toTokenAmount: '1000000000000000',
          },
          tx: {
            from: WALLET,
            to: '0x8888888888888888888888888888888888888888',
            data: '0xabcdef',
            gas: '423000',
            value: '0',
          },
        }),
      },
    )

    expect(result.steps[0].conditional?.amount).toBe('2135167')
  })

  it('rejects invalid swap mode values', async () => {
    await expect(
      buildOkxSwapSteps(
        {
          fromToken: 'ETH',
          toToken: 'USDC',
          amount: '0.5',
          chain: 'base',
          wallet: WALLET,
          swapMode: 'exactly-out' as never,
        },
        {
          getTokenDecimals: async () => 18,
          swapSwap: async () => {
            throw new Error('should not call swapSwap for invalid swap mode')
          },
        },
      ),
    ).rejects.toThrow('Invalid --swap-mode')
  })

  it('rejects invalid gas level values', async () => {
    await expect(
      buildOkxSwapSteps(
        {
          fromToken: 'ETH',
          toToken: 'USDC',
          amount: '0.5',
          chain: 'base',
          wallet: WALLET,
          gasLevel: 'warp-speed' as never,
        },
        {
          getTokenDecimals: async () => 18,
          swapSwap: async () => {
            throw new Error('should not call swapSwap for invalid gas level')
          },
        },
      ),
    ).rejects.toThrow('Invalid --gas-level')
  })

  it('rejects slippage inputs outside the supported range', async () => {
    await expect(
      buildOkxSwapSteps(
        {
          fromToken: 'ETH',
          toToken: 'USDC',
          amount: '0.5',
          chain: 'base',
          wallet: WALLET,
          slippage: 101,
        },
        {
          getTokenDecimals: async () => 18,
          swapSwap: async () => {
            throw new Error('should not call swapSwap for invalid slippage')
          },
        },
      ),
    ).rejects.toThrow('--slippage must be between 0 and 1, or between 0 and 100 as a percentage')
  })

  it('rejects incomplete swap transaction payloads', async () => {
    await expect(
      buildOkxSwapSteps(
        {
          fromToken: 'ETH',
          toToken: 'USDC',
          amount: '0.5',
          chain: 'base',
          wallet: WALLET,
        },
        {
          getTokenDecimals: async () => 18,
          swapSwap: async () => ({
            tx: {
              from: WALLET,
              data: '0xabcdef',
            },
          }),
        },
      ),
    ).rejects.toThrow('OKX swap returned incomplete transaction data')
  })

  it('supports xlayer aliases and native OKB resolution for swaps', async () => {
    const calls: Array<{ kind: string; params: Record<string, unknown> }> = []
    await buildOkxSwapSteps(
      {
        fromToken: 'USDC',
        toToken: 'OKB',
        amount: '2',
        chain: 'xlayer',
        wallet: WALLET,
      },
      {
        getTokenDecimals: async (token, chainId) => {
          expect(token).toBe(USDC_XLAYER)
          expect(chainId).toBe(196)
          return 6
        },
        swapApprove: async (params) => {
          calls.push({ kind: 'approve', params: params as Record<string, unknown> })
          return {
            data: '0xdeadbeef',
            dexContractAddress: '0x5555555555555555555555555555555555555555',
          }
        },
        swapSwap: async (params) => {
          calls.push({ kind: 'swap', params: params as Record<string, unknown> })
          return {
            routerResult: {
              fromTokenAmount: '2000000',
            },
            tx: {
              from: WALLET,
              to: '0x6666666666666666666666666666666666666666',
              data: '0xabcdef',
              gas: '190000',
              value: '0',
            },
          }
        },
      },
    )

    expect(calls).toEqual([
      {
        kind: 'swap',
        params: {
          fromToken: USDC_XLAYER,
          toToken: OKX_NATIVE,
          amount: '2000000',
          chain: 'xlayer',
          wallet: WALLET,
          slippagePercent: undefined,
          swapMode: 'exactIn',
          gasLevel: undefined,
          maxAutoSlippagePercent: undefined,
        },
      },
      {
        kind: 'approve',
        params: {
          token: USDC_XLAYER,
          amount: '2000000',
          chain: 'xlayer',
        },
      },
    ])
  })

  it('routes xlayer liquidity lookups through the canonical chain name', async () => {
    const liquidity = await getOkxSwapLiquidity(
      { chain: '196' },
      {
        listLiquidity: async (params) => {
          expect(params).toEqual({ chain: 'xlayer' })
          return [{ id: '1', name: 'OKX', logo: 'https://example.com/okx.png' }]
        },
      },
    )

    expect(liquidity).toEqual([{ id: '1', name: 'OKX', logo: 'https://example.com/okx.png' }])
  })
})
