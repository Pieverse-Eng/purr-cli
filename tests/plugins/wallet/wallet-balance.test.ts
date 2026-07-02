import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { walletBalance } from '@pieverseio/purr-plugin-wallet/balance'
import { mockFetch } from '../../helpers.js'

describe('walletBalance', () => {
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
  })

  it('resolves Solana token ticker to mint address', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        address: 'DZttmKxhq1H7v5fFVPbejCkqHiTDjq9J6Q1muQT2ouWD',
        chainId: 0,
        chainType: 'solana',
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        balance: '0',
        balanceFormatted: '0',
        symbol: 'USDC',
        decimals: 6,
      },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletBalance({ 'chain-type': 'solana', token: 'USDC' })

    expect(mock).toHaveBeenCalledOnce()
    const url = new URL(String(mock.mock.calls[0][0]))
    expect(url.pathname).toBe('/v1/instances/inst-123/wallet')
    expect(url.searchParams.get('balance')).toBe('true')
    expect(url.searchParams.get('chain_type')).toBe('solana')
    expect(url.searchParams.get('token')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(url.searchParams.get('chain_id')).toBeNull()
  })

  it('keeps EVM token ticker resolution based on chain-id', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        address: '0xa5253d9226F13d141A352Cf1613dD65Ad162ceF3',
        chainId: 8453,
        chainType: 'ethereum',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        balance: '0',
        balanceFormatted: '0',
        symbol: 'USDC',
        decimals: 6,
      },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletBalance({ token: 'USDC', 'chain-id': '8453' })

    const url = new URL(String(mock.mock.calls[0][0]))
    expect(url.searchParams.get('chain_type')).toBe('ethereum')
    expect(url.searchParams.get('chain_id')).toBe('8453')
    expect(url.searchParams.get('token')).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  })

  it('uses chain aliases for EVM token balance chain_id forwarding', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        address: '0xa5253d9226F13d141A352Cf1613dD65Ad162ceF3',
        chainId: 4663,
        chainType: 'ethereum',
        tokenAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        balance: '0',
        balanceFormatted: '0',
        symbol: 'USDG',
        decimals: 6,
      },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletBalance({ token: 'USDG', chain: 'robinhood' })

    const url = new URL(String(mock.mock.calls[0][0]))
    expect(url.searchParams.get('chain_type')).toBe('ethereum')
    expect(url.searchParams.get('chain_id')).toBe('4663')
    expect(url.searchParams.get('token')).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
  })

  it('uses chain aliases for native EVM balance chain_id forwarding', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        address: '0xa5253d9226F13d141A352Cf1613dD65Ad162ceF3',
        chainId: 4663,
        chainType: 'ethereum',
        balance: '0',
        balanceFormatted: '0',
        currency: 'ETH',
      },
    })
    vi.stubGlobal('fetch', mock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await walletBalance({ chain: 'robinhood' })

    const url = new URL(String(mock.mock.calls[0][0]))
    expect(url.searchParams.get('chain_type')).toBe('ethereum')
    expect(url.searchParams.get('chain_id')).toBe('4663')
    expect(url.searchParams.get('token')).toBeNull()
  })

  it('rejects unknown chain aliases instead of falling back to the default chain', async () => {
    await expect(walletBalance({ token: 'USDG', chain: 'unknown-chain' })).rejects.toThrow(
      'Unknown --chain: unknown-chain',
    )
  })
})
