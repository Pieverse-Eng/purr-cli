import { boundedText, mapThree, type Fetcher } from './market-reader'

type Chain = 'bsc' | 'robinhood' | 'solana'
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const num = (v: unknown): number | null =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null
const nonnegative = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n >= 0 ? n : null
}
const normalize = (s: string, chain: Chain) => (chain === 'solana' ? s : s.toLowerCase())

export function selectSnapshot(data: unknown, chain: Chain, token: string) {
  if (!Array.isArray(data)) throw new Error('Invalid market provider list')
  const rows = data
    .map(obj)
    .filter((p) => {
      const base = obj(p.baseToken),
        activity = obj(obj(p.txns).h6)
      const buys = nonnegative(activity.buys),
        sells = nonnegative(activity.sells)
      return (
        p.chainId === chain &&
        typeof p.pairAddress === 'string' &&
        typeof base.address === 'string' &&
        normalize(base.address, chain) === normalize(token, chain) &&
        (nonnegative(obj(p.liquidity).usd) ?? 0) >= 100_000 &&
        buys !== null &&
        sells !== null &&
        buys + sells > 0
      )
    })
    .sort(
      (a, b) =>
        (nonnegative(obj(b.liquidity).usd) ?? 0) - (nonnegative(obj(a.liquidity).usd) ?? 0) ||
        String(a.pairAddress).localeCompare(String(b.pairAddress)),
    )
  const p = rows[0]
  if (!p)
    return { status: 'unavailable', reason: 'No active base-token pool with >=100k USD liquidity' }
  const windows = (value: unknown, signed = false) =>
    Object.fromEntries(
      ['h1', 'h6', 'h24'].map((k) => [k, (signed ? num : nonnegative)(obj(value)[k])]),
    )
  return {
    status: 'ok',
    pair: p.pairAddress,
    pool_name: `${obj(p.baseToken).symbol || obj(p.baseToken).address} / ${obj(p.quoteToken).symbol || obj(p.quoteToken).address || '?'}`,
    market_url: typeof p.url === 'string' ? p.url : null,
    price_usd: nonnegative(p.priceUsd),
    liquidity_usd: nonnegative(obj(p.liquidity).usd),
    price_change_pct: windows(p.priceChange, true),
    volume_usd: windows(p.volume),
    pair_created_at_ms: nonnegative(p.pairCreatedAt),
    transactions: Object.fromEntries(
      ['h1', 'h6', 'h24'].map((k) => [
        k,
        {
          buys: nonnegative(obj(obj(p.txns)[k]).buys),
          sells: nonnegative(obj(obj(p.txns)[k]).sells),
        },
      ]),
    ),
  }
}

export async function snapshot(chain: Chain, tokens: string[], request: Fetcher = fetch) {
  if (!tokens.length || tokens.length > 5) throw new Error('Provide 1–5 token addresses')
  for (const t of tokens)
    if (!(chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(t))
      throw new Error(`Invalid ${chain} token address: ${t}`)
  const candidates = await mapThree(
    [...new Set(tokens.map((t) => normalize(t, chain)))],
    async (token) => {
      const source = `https://api.dexscreener.com/token-pairs/v1/${chain}/${encodeURIComponent(token)}`
      try {
        const response = await request(source, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return {
          token,
          source,
          ...selectSnapshot(JSON.parse(await boundedText(response, 4_000_000)), chain, token),
        }
      } catch (error) {
        return {
          token,
          source,
          status: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )
  return {
    chain,
    observed_at: new Date().toISOString(),
    scope:
      'One most-liquid eligible base-token pool per candidate; not chain-wide or token-wide volume',
    candidates,
  }
}
