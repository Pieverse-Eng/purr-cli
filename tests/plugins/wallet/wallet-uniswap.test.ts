import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { walletUniswap } from '@pieverseio/purr-plugin-wallet/uniswap'
import { resolveApiCredentials } from '@pieverseio/purr-core/api-client'
import { mockFetch } from '../../helpers.js'

const SPCX = '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const NATIVE = '0x0000000000000000000000000000000000000000'

describe('walletUniswap', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'inst-123'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.FX_PLATFORM_QUOTE_TOKEN
    delete process.env.FX_PLATFORM_UNISWAP_QUOTE_URL
  })

  it('uses only the research capability even when full wallet credentials exist', async () => {
    process.env.FX_PLATFORM_QUOTE_TOKEN = 'read-only'
    process.env.FX_PLATFORM_UNISWAP_QUOTE_URL =
      'https://api.test/v1/instances/inst-123/wallet/uniswap/quote'
    const mock = mockFetch({ ok: true, data: { provider: 'uniswap', gasEstimateUsd: '0.02' } })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await walletUniswap({ from: 'USDG', to: 'SPCX', amount: '100' })
    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      'x-pieverse-market-quote-capability': 'read-only',
    })
    expect(mock.mock.calls[0][1].redirect).toBe('error')
    expect(() => resolveApiCredentials()).toThrow('read-only research context')
  })

  it('rejects execution and incomplete research credentials without wallet fallback', async () => {
    process.env.FX_PLATFORM_QUOTE_TOKEN = 'read-only'
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(
      walletUniswap({ from: 'USDG', to: 'SPCX', amount: '100', execute: 'true' }),
    ).rejects.toThrow('Execution is unavailable')
    await expect(walletUniswap({ from: 'USDG', to: 'SPCX', amount: '100' })).rejects.toThrow(
      'Missing read-only',
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('does not retry a rejected research quote with full wallet credentials', async () => {
    process.env.FX_PLATFORM_QUOTE_TOKEN = 'read-only'
    process.env.FX_PLATFORM_UNISWAP_QUOTE_URL =
      'https://api.test/v1/instances/inst-123/wallet/uniswap/quote'
    const mock = vi.fn().mockResolvedValue({ ok: false, status: 403 })
    vi.stubGlobal('fetch', mock)
    await expect(walletUniswap({ from: 'USDG', to: 'SPCX', amount: '100' })).rejects.toThrow('403')
    expect(mock).toHaveBeenCalledOnce()
  })

  it('quotes Robinhood swaps by default', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        provider: 'uniswap',
        chainId: 4663,
        fromToken: NATIVE,
        toToken: SPCX,
        fromAmount: '0.003',
        estimatedToAmountFormatted: '0.031',
        minimumToAmount: '30845000000000000',
        quoteSource: 'amm',
      },
    })
    vi.stubGlobal('fetch', mock)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletUniswap({ from: 'ETH', to: 'SPCX', amount: '0.003', chain: 'robinhood' })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v1/instances/inst-123/wallet/uniswap/quote',
    )
    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body).toEqual({
      fromToken: NATIVE,
      toToken: SPCX,
      fromAmount: '0.003',
      chainId: 4663,
    })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      provider: 'uniswap',
      quoteSource: 'amm',
    })
  })

  it('executes the same swap shape when --execute is set', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        mode: 'transaction',
        hash: '0xabc',
        chainId: 4663,
        fromToken: SPCX,
        toToken: NATIVE,
      },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletUniswap({
      from: 'SPCX',
      to: 'ETH',
      amount: '0.031',
      chain: 'robinhood',
      execute: 'true',
    })

    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v1/instances/inst-123/wallet/uniswap/execute',
    )
    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body).toEqual({
      fromToken: SPCX,
      toToken: NATIVE,
      fromAmount: '0.031',
      chainId: 4663,
    })
  })

  it('passes optional execution controls only when provided', async () => {
    const mock = mockFetch({
      ok: true,
      data: { provider: 'uniswap', chainId: 4663 },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletUniswap({
      from: 'USDG',
      to: 'SPCX',
      amount: '5',
      'chain-id': '4663',
      slippage: '1',
      recipient: '0x0000000000000000000000000000000000000001',
      'min-amount-out': '123',
      'dedup-key': 'swap-1',
      protocols: 'v3, v4',
      execute: 'true',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body).toEqual({
      fromToken: USDG,
      toToken: SPCX,
      fromAmount: '5',
      chainId: 4663,
      slippageTolerance: 1,
      recipient: '0x0000000000000000000000000000000000000001',
      minAmountOut: '123',
      dedupKey: 'swap-1',
      protocols: ['v3', 'v4'],
    })
  })

  it('defaults to Robinhood Chain when chain is omitted', async () => {
    const mock = mockFetch({
      ok: true,
      data: { provider: 'uniswap', chainId: 4663 },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletUniswap({ from: 'ETH', to: 'SPCX', amount: '0.003' })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.chainId).toBe(4663)
    expect(body.toToken).toBe(SPCX)
  })

  it('rejects unsupported or unknown chains', async () => {
    await expect(
      walletUniswap({ from: 'ETH', to: 'SPCX', amount: '0.003', chain: 'base' }),
    ).rejects.toThrow('Robinhood Chain only')

    await expect(
      walletUniswap({ from: 'ETH', to: 'SPCX', amount: '0.003', chain: 'wat' }),
    ).rejects.toThrow('Unknown --chain: wat')
  })

  it('throws API errors', async () => {
    const mock = mockFetch({ ok: false, error: 'Latest Uniswap quote is below minAmountOut' })
    vi.stubGlobal('fetch', mock)

    await expect(
      walletUniswap({
        from: 'SPCX',
        to: 'ETH',
        amount: '0.031',
        chain: 'robinhood',
        execute: 'true',
      }),
    ).rejects.toThrow('Latest Uniswap quote is below minAmountOut')
  })
})
