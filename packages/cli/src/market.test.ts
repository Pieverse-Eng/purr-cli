import { describe, expect, it, vi } from 'vitest'
import { bestPool, marketCommand, projectLinks, stockAddresses, trending } from './market.js'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const makePair = (id: string, base: string, quote: string, liquidity = 200_000, chain = 'bsc') => ({
  chainId: chain,
  pairAddress: id,
  baseToken: { address: base, name: base, symbol: 'MEME' },
  quoteToken: { address: quote, name: quote, symbol: 'STOCK' },
  liquidity: { usd: liquidity },
  txns: { h6: { buys: 2, sells: 1 } },
})

describe('market trending', () => {
  it('finds a more liquid pool outside discovery, including quote-side tokens', async () => {
    const discovery = makePair(address(1), address(2), address(3))
    discovery.quoteToken.address = '0x55d398326f99059ff775485246999027b3197955'
    const best = makePair(address(4), address(5), address(2), 2_000_000)
    best.baseToken.symbol = 'SPCXB'
    best.quoteToken.symbol = 'MarsCoin'
    const urls: string[] = []
    const get = async (url: string) => {
      urls.push(url)
      if (url.includes('dexpaprika'))
        return {
          results: [
            {
              id: discovery.pairAddress,
              tokens: [discovery.baseToken, discovery.quoteToken].map((t) => ({ id: t.address })),
              liquidity_usd: 200_000,
              volume_usd_24h: 1000,
            },
          ],
        }
      if (url.includes('/latest/dex/pairs/')) return { pairs: [discovery] }
      return [discovery, best]
    }
    const result = await trending('bsc', get)
    expect(result.candidates).toEqual([
      {
        token: address(2),
        name: address(2),
        symbol: 'MEME',
        pool_names: ['SPCXB / MarsCoin'],
        websites: [],
        socials: [],
      },
    ])
    expect(urls.some((url) => url.endsWith(`/token-pairs/v1/bsc/${address(2)}`))).toBe(true)
  })

  it('rejects stale, illiquid, wrong-chain and wrong-CA pools', () => {
    const valid = makePair(address(1), address(2), address(3))
    const stale = {
      ...makePair(address(4), address(2), address(3), 9e9),
      txns: { h6: { buys: 0, sells: 0 } },
    }
    expect(
      bestPool(
        [
          stale,
          makePair(address(5), address(2), address(3), 9e9, 'robinhood'),
          makePair(address(6), address(7), address(8), 9e9),
          valid,
        ],
        'bsc',
        address(2),
      ),
    ).toEqual(['MEME / STOCK'])
    expect(bestPool([makePair(address(1), address(2), address(3), 1)], 'bsc', address(2))).toEqual(
      [],
    )
    expect(
      bestPool([makePair('Pool', 'AbC', 'Quote', 200_000, 'solana')], 'solana', 'abc'),
    ).toEqual([])
  })

  it('excludes stock/ETF deployments by CA even with arbitrary names or inactive status', async () => {
    const stock = address(2),
      meme = address(3)
    const p = makePair(address(1), stock, meme, 200_000, 'robinhood')
    const catalog = {
      assets: [
        {
          status: 'ASSET_STATUS_INACTIVE',
          deployments: [
            { chainId: 4663, contractAddress: stock.toUpperCase().replace('0X', '0x') },
          ],
        },
      ],
    }
    expect(stockAddresses(catalog).has(stock)).toBe(true)
    const result = await trending('robinhood', async (url) => {
      if (url.includes('/rhj/assets')) return catalog
      if (url.includes('dexpaprika'))
        return {
          results: [
            {
              id: p.pairAddress,
              tokens: [{ id: stock }, { id: meme }],
              liquidity_usd: 200_000,
              volume_usd_24h: 100,
            },
          ],
        }
      if (url.includes('/latest/dex/pairs')) return { pairs: [p] }
      return [p]
    })
    expect(result.candidates.map((c) => c.token)).toEqual([meme])
    expect(result.candidates[0].pool_names).toEqual(['MEME / STOCK'])
  })

  it('stops if the stock catalog is missing or invalid', async () => {
    for (const data of [
      {},
      { assets: [] },
      { assets: [{ deployments: [{ chainId: 4663, contractAddress: 'bad' }] }] },
    ]) {
      expect(() => stockAddresses(data)).toThrow()
    }
    await expect(
      trending('robinhood', async () => {
        throw new Error('HTTP 503')
      }),
    ).rejects.toThrow('503')
  })

  it('keeps Solana trending order and base-only candidates, capped at five', async () => {
    const pairs = Array.from({ length: 7 }, (_, i) =>
      makePair(`Pool${i}`, `Token${i}`, 'Quote', 200_000, 'solana'),
    )
    const result = await trending('solana', async (url) => {
      if (url.includes('geckoterminal'))
        return {
          included: [
            ...pairs.map((p) => ({ id: p.baseToken.address, attributes: p.baseToken })),
            { id: 'Quote', attributes: { address: 'Quote' } },
          ],
          data: pairs.map((p, i) => ({
            attributes: {
              address: p.pairAddress,
              reserve_in_usd: 200_000,
              volume_usd: { h24: 100 + i },
            },
            relationships: {
              base_token: { data: { id: p.baseToken.address } },
              quote_token: { data: { id: 'Quote' } },
            },
          })),
        }
      if (url.includes('/latest/dex/pairs')) return { pairs }
      return pairs
    })
    expect(result.candidates.map((c) => c.token)).toEqual([
      'Token0',
      'Token1',
      'Token2',
      'Token3',
      'Token4',
    ])
  })

  it('rejects unsupported chains and --top without fetching', async () => {
    await expect(marketCommand('trending', { chain: 'bnb', top: '5' })).rejects.toThrow(
      'Unknown market option',
    )
    await expect(marketCommand('trending', { chain: 'eth' })).rejects.toThrow('Use --chain')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await marketCommand('help', {})
    expect(log).toHaveBeenCalledWith(expect.stringContaining('purr market trending'))
    log.mockRestore()
  })
})

it('extracts only exact base-token profile links, deduplicating and ignoring invalid URLs', () => {
  const profile = {
    websites: [{ url: 'https://meme.example', label: 'Website' }, { url: 'javascript:alert(1)' }],
    socials: [{ url: 'https://x.com/meme', type: 'twitter' }],
  }
  const owned = { ...makePair(address(1), address(2), address(3)), info: profile }
  const counter = {
    ...makePair(address(4), address(3), address(2)),
    info: { websites: [{ url: 'https://stock.example' }] },
  }
  const otherChain = { ...owned, chainId: 'robinhood' }
  expect(projectLinks([owned, owned, counter, otherChain], 'bsc', address(2))).toEqual({
    websites: [{ url: 'https://meme.example', label: 'Website' }],
    socials: [{ url: 'https://x.com/meme', type: 'twitter' }],
  })
  expect(projectLinks([counter], 'bsc', address(2))).toEqual({ websites: [], socials: [] })
  expect(
    projectLinks([{ ...owned, chainId: 'solana', baseToken: { address: 'AbC' } }], 'solana', 'abc'),
  ).toEqual({ websites: [], socials: [] })
})
