import { readPages } from './market-reader'
import { snapshot } from './market-snapshot'
import exclusions from './market-exclusions.json'

type Chain = 'bsc' | 'robinhood' | 'solana'
type Token = { address: string; name?: string; symbol?: string }
type Pair = {
  chainId: string
  pairAddress: string
  baseToken: Token
  quoteToken: Token
  liquidity?: { usd?: number }
  txns?: { h6?: { buys?: number; sells?: number } }
}
type Pool = {
  id: string
  tokens: { id: string }[]
  liquidity_usd?: unknown
  volume_usd_24h?: unknown
  candidate?: string
}
type Candidate = {
  token: string
  name: string
  symbol: string
  pool_names: string[]
  website: string | null
  social: string | null
}
type Row = Candidate & { volume: number; rank: number }
export type GetJson = (url: string) => Promise<unknown>
const DEX = 'https://api.dexscreener.com'
const GECKO = 'https://api.geckoterminal.com/api/v2'
const MIN_LIQUIDITY = 100_000
const normalize = (address: string, chain: Chain) =>
  chain === 'solana' ? address : address.toLowerCase()
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid market provider response')
  return value as Record<string, unknown>
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid market provider list')
  return value
}
function token(value: unknown): Token {
  const t = record(value)
  if (typeof t.address !== 'string' || !t.address) throw new Error('Missing token address')
  return {
    address: t.address,
    name: typeof t.name === 'string' ? t.name : undefined,
    symbol: typeof t.symbol === 'string' ? t.symbol : undefined,
  }
}
function pair(value: unknown): Pair {
  const p = record(value)
  if (typeof p.chainId !== 'string' || typeof p.pairAddress !== 'string' || !p.pairAddress)
    throw new Error('Missing pool identity')
  return { ...p, baseToken: token(p.baseToken), quoteToken: token(p.quoteToken) } as Pair
}
function liquid(p: Pair): number | undefined {
  const amount = number(p.liquidity?.usd)
  const buys = number(p.txns?.h6?.buys),
    sells = number(p.txns?.h6?.sells)
  if (
    amount === undefined ||
    amount < MIN_LIQUIDITY ||
    buys === undefined ||
    sells === undefined ||
    buys + sells === 0
  )
    return
  return amount
}

// Public catalog includes stock and ETF deployments, including inactive assets.
export function stockAddresses(data: unknown): Set<string> {
  const assets = list(record(data).assets)
  const addresses = new Set<string>()
  for (const asset of assets) {
    for (const value of list(record(asset).deployments)) {
      const deployment = record(value)
      if (String(deployment.chainId) !== '4663') continue
      const address = deployment.contractAddress
      if (typeof address !== 'string' || !/^0x[\da-f]{40}$/i.test(address))
        throw new Error('Invalid Robinhood stock/ETF address')
      addresses.add(address.toLowerCase())
    }
  }
  if (!addresses.size) throw new Error('Robinhood stock/ETF catalog unavailable; discovery stopped')
  return addresses
}

export function projectLinks(
  data: unknown,
  chain: Chain,
  address: string,
): { website: string | null; social: string | null } {
  const websites: string[] = [],
    socials: string[] = []
  for (const value of list(data)) {
    const p = pair(value)
    // DEXScreener profiles describe the base token, even when the requested CA is the quote.
    if (p.chainId !== chain || normalize(p.baseToken.address, chain) !== normalize(address, chain))
      continue
    const info = record(value).info
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue
    for (const [field, output] of [
      ['websites', websites],
      ['socials', socials],
    ] as const) {
      const entries = (info as Record<string, unknown>)[field]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') continue
        try {
          if (!['http:', 'https:'].includes(new URL(entry.url).protocol)) continue
        } catch {
          continue
        }
        if (output.includes(entry.url)) continue
        output.push(entry.url)
      }
    }
  }
  return { website: websites[0] ?? null, social: socials[0] ?? null }
}

export function bestPool(data: unknown, chain: Chain, address: string): string[] {
  const pairs = list(data)
    .map(pair)
    .filter(
      (p) =>
        p.chainId === chain &&
        [p.baseToken, p.quoteToken].some(
          (t) => normalize(t.address, chain) === normalize(address, chain),
        ) &&
        liquid(p) !== undefined,
    )
  pairs.sort(
    (a, b) => (liquid(b) ?? 0) - (liquid(a) ?? 0) || a.pairAddress.localeCompare(b.pairAddress),
  )
  const best = pairs[0]
  return best
    ? [[best.baseToken, best.quoteToken].map((t) => t.symbol || t.address).join(' / ')]
    : []
}

function publicClient(): GetJson {
  const deadline = Date.now() + 70_000
  const last = new Map<string, number>()
  return async (url) => {
    const host = new URL(url).hostname
    const pause = Math.max(
      0,
      (host === 'api.geckoterminal.com' ? 2100 : 300) - (Date.now() - (last.get(host) ?? 0)),
    )
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause))
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Market retrieval time budget exhausted')
    last.set(host, Date.now())
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'purr-market/1.0' },
      signal: AbortSignal.timeout(Math.min(10_000, remaining)),
    })
    if (!response.ok) throw new Error(`Market provider ${host} returned HTTP ${response.status}`)
    return await response.json()
  }
}

export async function trending(
  chain: Chain,
  get: GetJson = publicClient(),
): Promise<{ chain: Chain; candidates: Candidate[] }> {
  const excluded = new Set<string>(exclusions[chain])
  if (chain === 'robinhood') {
    for (const address of stockAddresses(await get('https://api.robinhood.com/rhj/assets')))
      excluded.add(address)
  }
  let pools: Pool[]
  const ranks = new Map<string, number>()
  if (chain === 'solana') {
    const data = record(
      await get(`${GECKO}/networks/solana/trending_pools?include=base_token,quote_token,dex`),
    )
    const included = new Map(
      list(data.included).map((value) => {
        const item = record(value)
        return [item.id, record(item.attributes)]
      }),
    )
    pools = list(data.data).flatMap((value, rank) => {
      const item = record(value),
        attributes = record(item.attributes),
        rel = record(item.relationships)
      const base = included.get(record(record(rel.base_token).data).id)
      const quote = included.get(record(record(rel.quote_token).data).id)
      if (!base || !quote || typeof attributes.address !== 'string') return []
      const b = token(base),
        q = token(quote)
      if (!ranks.has(b.address)) ranks.set(b.address, rank)
      return [
        {
          id: attributes.address,
          tokens: [{ id: b.address }, { id: q.address }],
          liquidity_usd: attributes.reserve_in_usd,
          volume_usd_24h: record(attributes.volume_usd).h24,
          candidate: b.address,
        },
      ]
    })
  } else {
    const data = record(
      await get(
        `https://api.dexpaprika.com/networks/${chain}/pools/search?order_by=volume_usd_24h&sort=desc&limit=100`,
      ),
    )
    pools = list(data.results).map((value) => {
      const p = record(value)
      if (typeof p.id !== 'string') throw new Error('Missing discovery pool address')
      const tokens = list(p.tokens).map((value) => {
        const t = record(value)
        if (typeof t.id !== 'string') throw new Error('Missing discovery token address')
        return { id: t.id }
      })
      return { id: p.id, tokens, liquidity_usd: p.liquidity_usd, volume_usd_24h: p.volume_usd_24h }
    })
  }
  pools = [...new Map(pools.map((p) => [normalize(p.id, chain), p])).values()]
  const rows = new Map<string, Row>()
  for (let start = 0; start < pools.length; start += 20) {
    const batch = pools.slice(start, start + 20)
    const data = record(
      await get(
        `${DEX}/latest/dex/pairs/${chain}/${batch.map((p) => encodeURIComponent(p.id)).join(',')}`,
      ),
    )
    const pairs = list(data.pairs ?? []).map(pair)
    for (const pool of batch) {
      const p = pairs.find(
        (p) => p.chainId === chain && normalize(p.pairAddress, chain) === normalize(pool.id, chain),
      )
      if (!p) continue
      const tokens = [p.baseToken, p.quoteToken]
      const ids = new Set(tokens.map((t) => normalize(t.address, chain)))
      if (
        pool.tokens.length !== 2 ||
        new Set(pool.tokens.map((t) => normalize(t.id, chain))).size !== 2 ||
        pool.tokens.some((t) => !ids.has(normalize(t.id, chain)))
      )
        continue
      const liquidity = liquid(p),
        discoveryLiquidity = number(pool.liquidity_usd),
        volume = number(pool.volume_usd_24h)
      if (
        liquidity === undefined ||
        !discoveryLiquidity ||
        volume === undefined ||
        Math.max(liquidity, discoveryLiquidity) / Math.min(liquidity, discoveryLiquidity) > 10
      )
        continue
      for (const t of tokens) {
        const ca = normalize(t.address, chain)
        if (
          excluded.has(ca) ||
          (chain === 'solana' && ca !== pool.candidate) ||
          (chain === 'robinhood' && t.name?.toLowerCase().includes('robinhood token'))
        )
          continue
        const row = rows.get(ca) ?? {
          token: ca,
          name: t.name ?? '',
          symbol: t.symbol ?? '',
          pool_names: [],
          website: null,
          social: null,
          volume: 0,
          rank: ranks.get(ca) ?? Infinity,
        }
        row.volume += volume
        rows.set(ca, row)
      }
    }
  }
  const ranked = [...rows.values()]
    .sort((a, b) => (chain === 'solana' ? a.rank - b.rank : b.volume - a.volume))
    .slice(0, 5)
  for (const row of ranked) {
    const data = await get(`${DEX}/token-pairs/v1/${chain}/${encodeURIComponent(row.token)}`)
    row.pool_names = bestPool(data, chain, row.token)
    Object.assign(row, projectLinks(data, chain, row.token))
  }
  return {
    chain,
    candidates: ranked.map(({ token, name, symbol, pool_names, website, social }) => ({
      token,
      name,
      symbol,
      pool_names,
      website,
      social,
    })),
  }
}

export async function marketToken(
  chain: Chain,
  address: string,
  get: GetJson = publicClient(),
): Promise<{ chain: Chain; candidates: Candidate[] }> {
  if (!(chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(address))
    throw new Error(`Invalid ${chain} token address: ${address}`)
  const ca = normalize(address, chain)
  const data = list(await get(`${DEX}/token-pairs/v1/${chain}/${encodeURIComponent(ca)}`))
  const matches = data
    .map(pair)
    .filter(
      (p) =>
        p.chainId === chain &&
        [p.baseToken, p.quoteToken].some((t) => normalize(t.address, chain) === ca),
    )
  // Prefer base-side metadata; quote-side matches still resolve exact token identity.
  const identity =
    matches.flatMap((p) => [p.baseToken]).find((t) => normalize(t.address, chain) === ca) ??
    matches.flatMap((p) => [p.quoteToken]).find((t) => normalize(t.address, chain) === ca)
  if (!identity) return { chain, candidates: [] }
  return {
    chain,
    candidates: [
      {
        token: ca,
        name: identity.name ?? '',
        symbol: identity.symbol ?? '',
        pool_names: bestPool(data, chain, ca),
        ...projectLinks(data, chain, ca),
      },
    ],
  }
}

export const marketHelp = `Usage: purr market trending --chain <robinhood|bnb|bsc|solana>
       purr market token --chain <robinhood|bnb|bsc|solana> <ca>
       purr market read-pages <url...>
       purr market snapshot --chain <robinhood|bnb|bsc|solana> <ca...>

token: exact CA lookup, same candidate shape as trending; no discovery exclusions.
read-pages: 1–10 URLs, concurrency 3, bounded HTML/JSON extraction.
snapshot: 1–5 CAs, most-liquid active base-token pool metrics.

Returns up to five filtered candidates and their most liquid active pool.
Uses public APIs; no API key or wallet is required. Output is JSON.
Discovery is bounded to provider rankings, not an exhaustive meme or safety classification.`

export async function marketCommand(
  command: string | undefined,
  args: Record<string, string>,
  positionals: string[] = [],
): Promise<void> {
  if (
    !command ||
    ['help', '--help', '-h'].includes(command) ||
    args.help === 'true' ||
    args.h === 'true'
  ) {
    console.log(marketHelp)
    return
  }
  if (command === 'read-pages') {
    if (Object.keys(args).length) throw new Error('read-pages accepts only URLs')
    console.log(JSON.stringify(await readPages(positionals)))
    return
  }
  if (!['trending', 'snapshot', 'token'].includes(command))
    throw new Error(`Unknown market command: ${command}`)
  for (const key of Object.keys(args))
    if (key !== 'chain') throw new Error(`Unknown market option: --${key}`)
  const aliases: Record<string, Chain> = {
    bnb: 'bsc',
    'bnb-chain': 'bsc',
    bsc: 'bsc',
    robinhood: 'robinhood',
    'robinhood-chain': 'robinhood',
    solana: 'solana',
  }
  const chain = aliases[args.chain?.toLowerCase()]
  if (!chain) throw new Error('Use --chain robinhood, bnb, bsc, or solana')
  if (command === 'token') {
    if (positionals.length !== 1) throw new Error('token requires exactly one CA')
    console.log(JSON.stringify(await marketToken(chain, positionals[0])))
    return
  }
  if (command === 'trending' && positionals.length)
    throw new Error('trending accepts no positional arguments')
  console.log(
    JSON.stringify(
      command === 'snapshot' ? await snapshot(chain, positionals) : await trending(chain),
    ),
  )
}

export async function marketArgv(command: string | undefined, argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h'))
    return marketCommand(command, { help: 'true' })
  const options: Record<string, string> = {},
    values: string[] = []
  let literal = false
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!literal && value === '--') {
      literal = true
      continue
    }
    if (!literal && (value === '--chain' || value.startsWith('--chain='))) {
      if (options.chain !== undefined) throw new Error('Duplicate --chain')
      const chain = value === '--chain' ? argv[++i] : value.slice(8)
      if (!chain || chain.startsWith('-')) throw new Error('Missing --chain value')
      options.chain = chain
    } else if (!literal && value.startsWith('-')) throw new Error(`Unknown market option: ${value}`)
    else values.push(value)
  }
  return marketCommand(command, options, values)
}
