import { describe, expect, it, vi } from 'vitest'
import { boundedText, extractPage, mapThree, readPages } from './market-reader'
import { selectSnapshot, snapshot } from './market-snapshot'
import { marketArgv } from './market'

describe('market research commands', () => {
  it('extracts text, entities and relevant links without scripts or navigation', () => {
    const result = extractPage(
      '<title>Dog &amp; Coin</title><meta name="description" content="A project"><nav>menu</nav><main><p>Community &amp; compute.</p><script>secret noise</script><a href="/docs">Docs</a></main><footer>No redemption rights.</footer>',
      'https://example.com/',
    )
    expect(result.title).toBe('Dog & Coin')
    expect(result.text).toContain('Community & compute.')
    expect(result.text).toContain('No redemption rights.')
    expect(result.text).not.toMatch(/menu|secret noise/)
    expect(result.related_links).toEqual(['https://example.com/docs'])
  })
  it('marks challenges unavailable', () => {
    expect(
      extractPage('<title>Just a moment</title><p>Challenge</p>', 'https://example.com').status,
    ).toBe('unavailable')
  })
  it('limits concurrency and preserves input ordering', async () => {
    let active = 0,
      max = 0
    const result = await mapThree([0, 1, 2, 3, 4], async (n) => {
      active++
      max = Math.max(max, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return n
    })
    expect(result).toEqual([0, 1, 2, 3, 4])
    expect(max).toBe(3)
  })
  it('rejects oversized bodies and preserves per-page errors', async () => {
    await expect(boundedText(new Response('12345'), 4)).rejects.toThrow('size limit')
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(url.endsWith('/bad') ? '' : '{"name":"Coin"}', {
          status: url.endsWith('/bad') ? 403 : 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const result = await readPages(['https://example.com/bad', 'https://example.com/good'], fetcher)
    expect(result.pages.map((p) => p.status)).toEqual(['unavailable', 'ok'])
    await expect(readPages(['file:///etc/passwd'], fetcher)).rejects.toThrow('HTTP(S)')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('never uses quote-token metrics or mismatched Solana case; keeps negative changes', () => {
    const pair = (base: string, liquidity: number) => ({
      chainId: 'solana',
      pairAddress: base,
      baseToken: { address: base, symbol: base },
      quoteToken: { address: 'AbC', symbol: 'SOL' },
      liquidity: { usd: liquidity },
      txns: { h6: { buys: 1, sells: 1 } },
      priceChange: { h24: -12 },
      priceUsd: '2',
    })
    const result = selectSnapshot(
      [pair('other', 900000), pair('abc', 800000), pair('AbC', 200000)],
      'solana',
      'AbC',
    )
    expect(result.pair).toBe('AbC')
    expect(result.price_change_pct?.h24).toBe(-12)
    expect(result.volume_usd?.h24).toBeNull()
    expect(selectSnapshot([pair('other', 900000)], 'solana', 'AbC').status).toBe('unavailable')
  })
  it('retains provider failures as unavailable and rejects malformed CAs', async () => {
    const result = await snapshot(
      'bsc',
      ['0x' + '1'.repeat(40)],
      async () => new Response('', { status: 429 }),
    )
    expect(result.candidates[0].status).toBe('unavailable')
    await expect(snapshot('bsc', ['bad'])).rejects.toThrow('Invalid')
  })
  it('rejects unexpected options, missing chain and extra trending positionals', async () => {
    await expect(marketArgv('snapshot', ['--chain'])).rejects.toThrow('Missing')
    await expect(marketArgv('snapshot', ['--chain', 'bnb', '--chain', 'solana'])).rejects.toThrow(
      'Duplicate',
    )
    await expect(marketArgv('trending', ['--chain', 'bnb', 'extra'])).rejects.toThrow('positional')
    await expect(
      marketArgv('read-pages', ['--chain', 'bnb', 'https://example.com']),
    ).rejects.toThrow('only URLs')
  })
})
