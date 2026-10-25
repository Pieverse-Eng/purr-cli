import { createServer, type ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { injectiveCommand, injectiveHelp } from './index.js'

const HASH = `0x${'a'.repeat(64)}`
const OTHER_HASH = `0x${'b'.repeat(64)}`
const ID = `injective:perp:${HASH}`
const marketArgs = ['--market-id', HASH, '--market-type', 'perp']
const START = '2026-10-01T00:00:00Z'
const END = '2026-10-01T00:02:00Z'
const FROM = 1790812800000
const TO = 1790812920000
const row = (product = 'perp', hash = HASH) => ({
  id: `injective:${product}:${hash}`,
  venue: 'injective',
  environment: 'mainnet',
  product,
  nativeMarketId: hash,
  nativeSymbol: 'SAME/USDT',
  base: 'SAME',
  quote: 'USDT',
  baseTokenId: 'factory/inj1origin/token',
  quoteTokenId: 'peggy0xquote',
})
const catalog = () => ({
  identity: { venue: 'injective', environment: 'mainnet' },
  data: [row('spot'), row('perp', OTHER_HASH), row()],
  meta: { status: 'fresh', completeness: 'complete', asOf: FROM },
  missing: [],
})

describe('Injective read-only CLI over backend HTTP', () => {
  const requests: Array<{ url: URL; method: string | undefined; auth: string | undefined }> = []
  let payload: unknown
  let status = 200
  let handler: ((url: URL, res: ServerResponse) => void) | undefined
  let baseUrl: string
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    requests.push({ url, method: req.method, auth: req.headers.authorization })
    if (handler) return handler(url, res)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '7' })
    res.end(JSON.stringify(payload))
  })
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected listening server')
    baseUrl = `http://127.0.0.1:${address.port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  })
  beforeEach(() => {
    requests.length = 0
    status = 200
    handler = undefined
    payload = {
      ok: true,
      data: { identity: { walletGeneration: 'gen-1' }, mode: 'read_only', executionEnabled: false },
    }
    vi.stubEnv('WALLET_API_URL', baseUrl)
    vi.stubEnv('WALLET_API_TOKEN', 'test-token')
    vi.stubEnv('INSTANCE_ID', 'instance/owned')
    vi.stubEnv('FX_PLATFORM_QUOTE_TOKEN', undefined)
    vi.stubEnv('FX_PLATFORM_UNISWAP_QUOTE_URL', undefined)
    vi.stubEnv('FX_PLATFORM_DFLOW_QUOTE_URL', undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each(['status', 'account', 'balances', 'positions', 'orders', 'order-history', 'fills'])(
    'routes %s only to its owned backend GET path',
    async (command) => {
      const args = ['orders', 'order-history', 'fills'].includes(command)
        ? ['--market-type', 'spot']
        : []
      const result = await injectiveCommand([command, ...args])
      expect(result).toEqual((payload as { data: unknown }).data)
      expect(requests).toHaveLength(1)
      expect(requests[0].url.pathname).toBe(`/v1/instances/instance%2Fowned/injective/${command}`)
      expect(requests[0].method).toBe('GET')
      expect(requests[0].auth).toBe('Bearer test-token')
    },
  )

  it('preserves opaque cursors, native hashes, decimal strings, null and coverage', async () => {
    const page = {
      identity: { walletGeneration: 'gen-2' },
      component: {
        data: [{ marketId: HASH, quantity: '9007199254740993.000000000000000001', price: null }],
        meta: { status: 'stale', sourceHeight: '9007199254740999', reason: 'coverage_limited' },
      },
      nextCursor: 'opaque+/=next',
      coverage: 'partial',
    }
    payload = { ok: true, data: page }
    expect(
      await injectiveCommand([
        'fills',
        ...marketArgs,
        '--limit',
        '100',
        '--cursor',
        'opaque+/=old',
        '--start-at',
        START,
        '--end-at',
        END,
      ]),
    ).toEqual(page)
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      product: 'perp',
      marketId: HASH,
      limit: '100',
      cursor: 'opaque+/=old',
      from: String(FROM),
      to: String(TO),
    })
  })

  it('lets the backend fix the default history window and binds the original cursor', async () => {
    await injectiveCommand(['order-history', '--market-type=spot', '--cursor=bound+/='])
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      product: 'spot',
      limit: '50',
      cursor: 'bound+/=',
    })
  })

  it('uses API credentials for the public full catalog without an instance', async () => {
    vi.stubEnv('INSTANCE_ID', '')
    payload = { ok: true, data: catalog() }
    expect(await injectiveCommand(['markets', '--market-type', 'all'])).toEqual(catalog())
    expect(requests[0].url.pathname).toBe('/v1/market-data/reference/terminal/instruments')
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      venue: 'injective',
      environment: 'mainnet',
    })
  })

  it('selects the exact native ID/product among identical tickers and preserves catalog metadata', async () => {
    payload = { ok: true, data: catalog() }
    expect(await injectiveCommand(['market', ...marketArgs])).toEqual({
      ...catalog(),
      data: [row()],
    })
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      venue: 'injective',
      environment: 'mainnet',
      product: 'perp',
      ids: ID,
    })
  })

  it.each([
    ['order-book-depth', 'orderbook', 'levels', '20'],
    ['recent-trades', 'trades', 'limit', '50'],
  ])(
    'resolves %s from the catalog base before calling %s',
    async (command, endpoint, limitKey, defaultLimit) => {
      const book = {
        instrument: row(),
        source: { mode: 'native' },
        data: null,
        meta: { status: 'unavailable', reason: 'upstream_unavailable' },
      }
      handler = (url, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            data: url.pathname.endsWith('/instruments') ? catalog() : book,
          }),
        )
      }
      expect(await injectiveCommand([command, ...marketArgs])).toEqual(book)
      expect(requests).toHaveLength(2)
      expect(requests[1].url.pathname).toBe(`/v1/market-data/${endpoint}`)
      expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({
        underlying: 'SAME',
        instrumentId: ID,
        [limitKey]: defaultLimit,
      })
    },
  )

  it('derives bounded candle buckets and filters [from,to), preserving source/coverage', async () => {
    const data = {
      instrument: row(),
      tf: '1m',
      source: { mode: 'native' },
      candles: [{ t: FROM - 60000 }, { t: FROM }, { t: FROM + 60000 }, { t: TO }],
      nextCursor: FROM - 60000,
      requested: { from: FROM - 60000, to: TO },
      historyStatus: 'recent-window-only',
      historyAvailability: 'pending',
      historyLimitFrom: FROM - 86400000,
      retryAfterMs: 5000,
      asOf: TO,
    }
    handler = (url, res) => {
      res.end(
        JSON.stringify({
          ok: true,
          data: url.pathname.endsWith('/instruments') ? catalog() : data,
        }),
      )
    }
    const result = await injectiveCommand([
      'candles',
      ...marketArgs,
      '--resolution',
      '1m',
      '--start-at',
      START,
      '--end-at',
      END,
    ])
    expect(result).toEqual({ ...data, candles: [{ t: FROM }, { t: FROM + 60000 }] })
    expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({
      underlying: 'SAME',
      instrumentId: ID,
      tf: '1m',
      to: String(TO),
      limit: '2',
    })
  })

  it.each(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])(
    'routes the supported %s candle resolution with a bounded millisecond query',
    async (resolution) => {
      handler = (url, res) => {
        res.end(
          JSON.stringify({
            ok: true,
            data: url.pathname.endsWith('/instruments')
              ? catalog()
              : { candles: [], historyAvailability: 'pending' },
          }),
        )
      }
      await injectiveCommand([
        'candles',
        ...marketArgs,
        '--resolution',
        resolution,
        '--start-at',
        '2026-10-01T08:00:00+08:00',
        '--end-at',
        END,
      ])
      expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({
        underlying: 'SAME',
        instrumentId: ID,
        tf: resolution,
        to: String(TO),
        limit: resolution === '1m' ? '2' : '1',
      })
    },
  )

  it.each([
    'order',
    'cancel',
    'cancel-all',
    'close',
    'enable',
    'disable',
    'deposit',
    'open-account',
    'withdraw',
    'rfq',
    'accept',
    'sign',
    'broadcast',
  ])('rejects write/unsupported command %s without HTTP', async (command) => {
    await expect(injectiveCommand([command])).rejects.toMatchObject({ code: 'INJECTIVE_READ_ONLY' })
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['status', '--address', 'inj1other'],
    ['status', '--execute'],
    ['status', '--network', 'testnet'],
    ['account', '--subaccount-id', HASH],
    ['status', 'extra'],
    ['status', '--help', 'extra'],
    ['markets', '--market-type', 'perp', '--market-type=spot'],
    ['market', '--market-id', 'BTC', '--market-type', 'perp'],
    ['market', '--market-id', HASH],
    ['market', '--market-type', 'all', '--market-id', HASH],
    ['markets', '--market-type'],
    ['markets', '--market', 'SAME'],
    ['status', '--'],
    ['positions', '--market-type', 'spot'],
    ['orders'],
    ['orders', '--market-type', 'perp', '--limit', '101'],
    ['orders', '--market-type', 'perp', '--limit', '1.5'],
    ['orders', '--market-type', 'perp', '--limit', '0'],
    ['orders', '--market-type', 'perp', '--cursor='],
    ['order-book-depth', ...marketArgs, '--limit', '101'],
    ['fills', ...marketArgs, '--start-at', START],
    ['fills', ...marketArgs, '--start-at', '2026-02-30T00:00:00Z', '--end-at', END],
    ['fills', ...marketArgs, '--start-at', '2026-10-01', '--end-at', END],
    ['fills', ...marketArgs, '--start-at', END, '--end-at', START],
    ['fills', ...marketArgs, '--start-at', '2026-08-01T00:00:00Z', '--end-at', END],
    ['candles', ...marketArgs, '--resolution', '12h', '--start-at', START, '--end-at', END],
    ['candles', ...marketArgs, '--resolution', 'constructor', '--start-at', START, '--end-at', END],
    ['candles', ...marketArgs, '--resolution', '__proto__', '--start-at', START, '--end-at', END],
    [
      'candles',
      ...marketArgs,
      '--resolution',
      '1m',
      '--start-at',
      START,
      '--end-at',
      '2026-10-03T00:00:00Z',
    ],
  ])('rejects invalid input %j before any HTTP', async (...args) => {
    await expect(injectiveCommand(args)).rejects.toMatchObject({
      code: 'INJECTIVE_INVALID_ARGUMENT',
    })
    expect(requests).toHaveLength(0)
  })

  it.each(['markets', 'status'])(
    'requires API credentials for %s without HTTP',
    async (command) => {
      vi.stubEnv('WALLET_API_TOKEN', '')
      await expect(injectiveCommand([command])).rejects.toThrow(/Missing required credentials/)
      expect(requests).toHaveLength(0)
    },
  )

  it('requires instance credentials for owned reads without HTTP', async () => {
    vi.stubEnv('INSTANCE_ID', '')
    await expect(injectiveCommand(['status'])).rejects.toThrow(/INSTANCE_ID/)
    expect(requests).toHaveLength(0)
  })

  it.each(['status', 'account'])('preserves later backend capabilities in %s', async (command) => {
    const data = {
      identity: { walletGeneration: 'gen-1' },
      mode: 'execution',
      executionEnabled: true,
    }
    payload = { ok: true, data }
    expect(await injectiveCommand([command])).toEqual(data)
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('GET')
  })

  it.each([
    null,
    [],
    { mode: 'read_only', executionEnabled: 'false' },
    { mode: null, executionEnabled: false },
  ])('rejects malformed account capability responses %j', async (data) => {
    payload = { ok: true, data }
    await expect(injectiveCommand(['status'])).rejects.toMatchObject({
      code: 'INJECTIVE_INVALID_RESPONSE',
    })
  })

  it('keeps 429 code and Retry-After available to automation', async () => {
    status = 429
    payload = {
      error: { code: 'INJECTIVE_RATE_LIMITED', message: 'Shared budget exhausted' },
      data: { retryAfterMs: 7000 },
    }
    await expect(injectiveCommand(['status'])).rejects.toMatchObject({
      status: 429,
      code: 'INJECTIVE_RATE_LIMITED',
      data: { retryAfterMs: 7000, retryAfter: '7' },
    })
    expect(requests).toHaveLength(1)
  })

  it('makes old-backend route 404 actionable without hiding real market-not-found', async () => {
    status = 404
    payload = { error: 'Not Found' }
    await expect(injectiveCommand(['status'])).rejects.toMatchObject({
      code: 'INJECTIVE_CAPABILITY_UNAVAILABLE',
      message: expect.stringMatching(/backend.*upgrade/i),
    })
    payload = { error: { code: 'MARKET_NOT_FOUND', message: 'Native market missing' } }
    await expect(injectiveCommand(['market', ...marketArgs])).rejects.toMatchObject({
      code: 'MARKET_NOT_FOUND',
    })
  })

  it('rejects unknown exact market and unavailable catalog without returning an empty market', async () => {
    payload = { ok: true, data: { ...catalog(), data: [] } }
    await expect(injectiveCommand(['market', ...marketArgs])).rejects.toMatchObject({
      code: 'MARKET_NOT_FOUND',
    })
    payload = { ok: true, data: { ...catalog(), data: null, meta: { status: 'unavailable' } } }
    await expect(injectiveCommand(['recent-trades', ...marketArgs])).rejects.toMatchObject({
      code: 'INJECTIVE_SOURCE_UNAVAILABLE',
    })
  })

  it('preserves backend HTTP200 error envelopes', async () => {
    payload = { ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Indexer unavailable' } }
    await expect(injectiveCommand(['balances'])).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Indexer unavailable',
    })
  })

  it('distinguishes an absent exact identity from a source outage using the complete product catalog', async () => {
    handler = (url, res) => {
      const data = url.searchParams.has('ids')
        ? {
            ...catalog(),
            data: null,
            missing: [ID],
            meta: { status: 'unavailable', completeness: 'partial' },
          }
        : { ...catalog(), data: [row('perp', OTHER_HASH)] }
      res.end(JSON.stringify({ ok: true, data }))
    }
    await expect(injectiveCommand(['market', ...marketArgs])).rejects.toMatchObject({
      code: 'MARKET_NOT_FOUND',
    })
  })

  it('does not claim a market is absent when product coverage is partial', async () => {
    handler = (url, res) => {
      const data = url.searchParams.has('ids')
        ? {
            ...catalog(),
            data: null,
            missing: [ID],
            meta: { status: 'unavailable', completeness: 'partial' },
          }
        : {
            ...catalog(),
            data: [row('perp', OTHER_HASH)],
            meta: { status: 'fresh', completeness: 'partial' },
          }
      res.end(JSON.stringify({ ok: true, data }))
    }
    await expect(injectiveCommand(['market', ...marketArgs])).rejects.toMatchObject({
      code: 'INJECTIVE_SOURCE_UNAVAILABLE',
    })
  })

  it('explains an old backend rejecting the locally validated Injective catalog query', async () => {
    status = 400
    payload = {
      ok: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'A valid native venue and environment are required.',
      },
    }
    await expect(injectiveCommand(['markets', '--market-type=perp'])).rejects.toMatchObject({
      code: 'INJECTIVE_CAPABILITY_UNAVAILABLE',
      status: 400,
    })
    await expect(injectiveCommand(['positions'])).rejects.toMatchObject({ code: 'INVALID_QUERY' })
  })

  it('does not retry or substitute an empty collection on upstream HTTP failures', async () => {
    status = 503
    payload = {
      error: { code: 'INJECTIVE_UPSTREAM_UNAVAILABLE', message: 'Indexer failed' },
      data: { coverage: 'unknown' },
    }
    await expect(injectiveCommand(['positions'])).rejects.toMatchObject({
      code: 'INJECTIVE_UPSTREAM_UNAVAILABLE',
      status: 503,
      data: { coverage: 'unknown' },
    })
    expect(requests).toHaveLength(1)
  })

  it.each([
    { ...row(), venue: 'lighter' },
    { ...row(), product: 'spot' },
    { ...row(), nativeMarketId: OTHER_HASH },
    { ...row(), id: `injective:spot:${HASH}` },
  ])('cannot route an inconsistent catalog identity %j', async (instrument) => {
    payload = { ok: true, data: { ...catalog(), data: [instrument] } }
    await expect(injectiveCommand(['order-book-depth', ...marketArgs])).rejects.toMatchObject({
      code: 'MARKET_NOT_FOUND',
    })
    expect(requests).toHaveLength(1)
  })

  it('refuses ambiguous catalog identities rather than choosing one', async () => {
    payload = { ok: true, data: { ...catalog(), data: [row(), row()] } }
    await expect(injectiveCommand(['market', ...marketArgs])).rejects.toMatchObject({
      code: 'MARKET_NOT_FOUND',
    })
  })

  it('offers help without credentials or network', async () => {
    vi.stubEnv('WALLET_API_TOKEN', '')
    expect(await injectiveCommand(['--help'])).toBe(injectiveHelp())
    expect(injectiveHelp()).toContain('Read-only')
    expect(injectiveHelp()).not.toMatch(/^ {2}(order |cancel |deposit |rfq )/m)
    expect(requests).toHaveLength(0)
  })
})

it.each([
  [429, 'INJECTIVE_RATE_LIMITED', 'rate_limited', 1250],
  [503, 'INJECTIVE_READ_UNAVAILABLE', 'not_indexed', null],
])(
  'keeps the actual platform private-read error (%s)',
  async (httpStatus, code, reason, retryAfterMs) => {
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code, reason, retryAfterMs } }), {
        status: httpStatus as number,
        headers: { 'retry-after': '2' },
      }),
    )
    vi.stubEnv('WALLET_API_URL', 'http://127.0.0.1:1')
    vi.stubEnv('WALLET_API_TOKEN', 'fixture-token')
    vi.stubEnv('INSTANCE_ID', 'fixture-instance')
    try {
      await expect(injectiveCommand(['status'])).rejects.toMatchObject({
        code,
        status: httpStatus,
        data: { reason, retryAfterMs, retryAfter: '2' },
      })
    } finally {
      send.mockRestore()
      vi.unstubAllEnvs()
    }
  },
)
