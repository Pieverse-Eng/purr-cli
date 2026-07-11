import { describe, expect, it } from 'vitest'
import {
  buildBalancerAddBody,
  buildBalancerPoolsQuery,
  buildBalancerRemoveBody,
  buildBalancerSwapBody,
} from '@pieverseio/purr-plugin-balancer'

const NATIVE = '0x0000000000000000000000000000000000000000'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const POOL = '0x1111111111111111111111111111111111111111'
describe('Balancer CLI request builders', () => {
  it('builds reviewed pool filters with resolved token tickers', () => {
    const query = new URLSearchParams(
      buildBalancerPoolsQuery({
        chain: 'base',
        tokens: 'WETH,USDC',
        'protocol-version': '3',
        first: '20',
        'min-tvl': '1000',
        'reviewed-only': 'true',
      }),
    )

    expect(Object.fromEntries(query)).toEqual({
      chainId: '8453',
      first: '20',
      minTvl: '1000',
      protocolVersion: '3',
      reviewedOnly: 'true',
      tokens: `${WETH},${USDC}`,
    })
  })

  it('builds exact-input quotes and exact-output execution bodies', () => {
    expect(
      buildBalancerSwapBody(
        {
          chain: 'base',
          from: 'ETH',
          to: 'USDC',
          amount: '0.001',
          'slippage-bps': '100',
          'protocol-version': '3',
        },
        false,
      ),
    ).toEqual({
      chainId: 8453,
      tokenIn: NATIVE,
      tokenOut: USDC,
      swapKind: 'exact_in',
      amountIn: '0.001',
      slippageBps: 100,
      protocolVersion: 3,
    })

    expect(
      buildBalancerSwapBody(
        {
          chain: 'base',
          from: 'USDC',
          to: 'ETH',
          amount: '0.0001',
          kind: 'exact-out',
          'max-amount-in': '1000000',
        },
        true,
      ),
    ).toEqual({
      chainId: 8453,
      tokenIn: USDC,
      tokenOut: NATIVE,
      swapKind: 'exact_out',
      amountOut: '0.0001',
      maxAmountIn: '1000000',
    })
  })

  it('builds all standard add modes and execution limits', () => {
    expect(
      buildBalancerAddBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          kind: 'unbalanced',
          'amounts-in': 'ETH:0.001,USDC:1.5',
          'min-bpt-out': '123',
        },
        true,
      ),
    ).toEqual({
      chainId: 8453,
      poolId: POOL,
      protocolVersion: 3,
      poolType: 'standard',
      kind: 'unbalanced',
      amountsIn: [
        { token: NATIVE, amount: '0.001' },
        { token: USDC, amount: '1.5' },
      ],
      minBptOut: '123',
    })

    expect(
      buildBalancerAddBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          kind: 'single-token-exact-bpt',
          'token-in': 'WETH',
          'bpt-amount-out': '0.5',
          'max-amount-in': '456',
        },
        true,
      ),
    ).toMatchObject({
      kind: 'single_token_exact_bpt',
      tokenIn: WETH,
      bptAmountOut: '0.5',
      maxAmountIn: '456',
    })

    expect(
      buildBalancerAddBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          kind: 'proportional',
          'reference-token': 'USDC',
          'reference-amount': '5',
          'max-amounts-in': 'WETH:100,USDC:5000000',
          'min-bpt-out': '200',
        },
        true,
      ),
    ).toMatchObject({
      kind: 'proportional',
      referenceToken: USDC,
      referenceAmount: '5',
      maxAmountsIn: [
        { token: WETH, amountRaw: '100' },
        { token: USDC, amountRaw: '5000000' },
      ],
      minBptOut: '200',
    })
  })

  it('builds standard, boosted, and nested remove inputs', () => {
    expect(
      buildBalancerRemoveBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          kind: 'single-token',
          'bpt-amount-in': '0.1',
          'token-out': 'USDC',
          'min-amount-out': '100',
        },
        true,
      ),
    ).toMatchObject({
      kind: 'single_token_exact_in',
      bptAmountIn: '0.1',
      tokenOut: USDC,
      minAmountOut: '100',
    })

    expect(
      buildBalancerRemoveBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          'pool-type': 'boosted',
          'bpt-amount-in': '0.1',
          'tokens-out': 'WETH,USDC',
        },
        false,
      ),
    ).toMatchObject({
      poolType: 'boosted',
      kind: 'proportional',
      tokensOut: [WETH, USDC],
    })

    expect(
      buildBalancerRemoveBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          'pool-type': 'nested',
          'bpt-amount-in': '0.1',
        },
        false,
      ),
    ).toMatchObject({ poolType: 'nested', kind: 'proportional' })

    expect(
      buildBalancerRemoveBody(
        {
          chain: 'polygon',
          'pool-id': POOL,
          'protocol-version': '2',
          kind: 'unbalanced',
          'amounts-out': 'WETH:0.001,USDC:1',
          'max-bpt-in': '300',
        },
        true,
      ),
    ).toMatchObject({
      kind: 'unbalanced',
      amountsOut: [
        { token: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', amount: '0.001' },
        { token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', amount: '1' },
      ],
      maxBptIn: '300',
    })

    expect(
      buildBalancerRemoveBody(
        {
          chain: 'base',
          'pool-id': POOL,
          'protocol-version': '3',
          kind: 'recovery',
          'bpt-amount-in': '0.1',
          'min-amounts-out': 'WETH:1,USDC:1',
        },
        true,
      ),
    ).toMatchObject({ kind: 'recovery', bptAmountIn: '0.1' })
  })

  it('rejects unsupported chain/protocol combinations', () => {
    expect(() =>
      buildBalancerSwapBody(
        {
          chain: 'polygon',
          from: 'MATIC',
          to: 'USDC',
          amount: '1',
          'protocol-version': '3',
        },
        false,
      ),
    ).toThrow('supports protocol version 2')
  })
})
