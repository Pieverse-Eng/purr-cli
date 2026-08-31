import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hyperliquidCommand } from '@pieverseio/purr-plugin-hyperliquid/index'
import { mockFetch } from '../../helpers.js'

interface ReadRouteCase {
  command: string
  args: Record<string, string>
  expectedUrl: string
}

interface WriteRouteCase {
  command: string
  args: Record<string, string>
  expectedPath: string
  expectedBody: Record<string, unknown>
}

describe('hyperliquid plugin', () => {
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

  it('searches raw perp tickers and enriches matches with public annotations', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const responses: Record<string, unknown> = {
      'perpAnnotation:xyz:SKHX': {
        category: 'stocks',
        displayName: 'SKHYNIX',
        keywords: ['000660', 'memory'],
        description: 'References 1 SK hynix Inc. common share.',
      },
      perpDexs: [null, { name: 'xyz', assetToStreamingOiCap: [] }],
      allPerpMetas: [
        { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] },
        {
          universe: [
            { name: 'xyz:SKHX', szDecimals: 3, maxLeverage: 10 },
            { name: 'xyz:SKHY', szDecimals: 2, maxLeverage: 10 },
          ],
        },
      ],
      spotMeta: {
        tokens: [],
        universe: [],
      },
    }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string; coin?: string }
      const key = body.type === 'perpAnnotation' ? `${body.type}:${body.coin}` : body.type
      return {
        ok: true,
        status: 200,
        json: async () => responses[key],
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('search', { query: 'SKHX' })

    const result = JSON.parse(String(log.mock.calls[0][0]))
    expect(result).toMatchObject({
      network: 'mainnet',
      query: 'SKHX',
      matches: [
        {
          kind: 'perp',
          symbol: 'xyz:SKHX',
          assetId: 110000,
          dex: 'xyz',
          displayName: 'SKHYNIX',
          description: 'References 1 SK hynix Inc. common share.',
          active: true,
        },
      ],
    })
    expect(mock.mock.calls.map((call) => JSON.parse(String(call[1].body)).type)).toEqual(
      expect.arrayContaining([
        'perpDexs',
        'allPerpMetas',
        'spotMeta',
        'perpAnnotation',
      ]),
    )
    expect(mock.mock.calls.every((call) => call[0] === 'https://api.hyperliquid.xyz/info')).toBe(
      true,
    )
  })

  it('does not use annotations to select search candidates', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const responses: Record<string, unknown> = {
      perpDexs: [null, { name: 'xyz', assetToStreamingOiCap: [] }],
      allPerpMetas: [
        { universe: [{ name: 'BTC', szDecimals: 5 }] },
        { universe: [{ name: 'xyz:SKHX', szDecimals: 3 }] },
      ],
      spotMeta: { tokens: [], universe: [] },
    }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string }
      return {
        ok: true,
        status: 200,
        json: async () => responses[body.type],
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('search', { query: 'SK Hynix' })

    expect(mock).toHaveBeenCalledTimes(3)
    expect(
      mock.mock.calls.some((call) => JSON.parse(String(call[1].body)).type === 'perpAnnotation'),
    ).toBe(false)
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      network: 'mainnet',
      query: 'SK Hynix',
      matches: [],
    })
  })

  it('finds an unannotated perp from the complete public market directory', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const responses: Record<string, unknown> = {
      perpDexs: [null],
      allPerpMetas: [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }],
      spotMeta: { tokens: [], universe: [] },
      'perpAnnotation:BTC': null,
    }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string; coin?: string }
      const key = body.type === 'perpAnnotation' ? `${body.type}:${body.coin}` : body.type
      return {
        ok: true,
        status: 200,
        json: async () => responses[key],
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('search', { query: 'BTC' })

    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      network: 'mainnet',
      query: 'BTC',
      matches: [
        {
          kind: 'perp',
          symbol: 'BTC',
          dex: 'default',
          assetId: 0,
          szDecimals: 5,
          maxLeverage: 40,
          active: true,
          score: 100,
          matchedFields: ['symbol'],
        },
      ],
    })
  })

  it('searches spot pairs by public token names', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const responses: Record<string, unknown> = {
      perpDexs: [null],
      allPerpMetas: [{ universe: [] }],
      spotMeta: {
        tokens: [
          { index: 0, name: 'USDC', szDecimals: 6 },
          { index: 150, name: 'HYPE', szDecimals: 2 },
        ],
        universe: [{ index: 107, name: '@107', tokens: [150, 0] }],
      },
    }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string }
      return {
        ok: true,
        status: 200,
        json: async () => responses[body.type],
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('search', { query: 'HYPE' })

    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      network: 'mainnet',
      query: 'HYPE',
      matches: [
        {
          kind: 'spot',
          symbol: 'HYPE/USDC',
          pairId: '@107',
          assetId: 10107,
          base: 'HYPE',
          quote: 'USDC',
          szDecimals: 2,
          active: true,
          score: 100,
          matchedFields: ['symbol', 'base'],
        },
      ],
    })
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('uses raw spot token names for selection and returns full names as enrichment', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const responses: Record<string, unknown> = {
      perpDexs: [null],
      allPerpMetas: [{ universe: [] }],
      spotMeta: {
        tokens: [
          { index: 0, name: 'USDC', szDecimals: 6 },
          {
            index: 849,
            name: 'MUX',
            fullName: 'Wrapped Micron Technology xStock',
            szDecimals: 2,
          },
        ],
        universe: [{ index: 708, name: '@708', tokens: [849, 0] }],
      },
    }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string }
      return {
        ok: true,
        status: 200,
        json: async () => responses[body.type],
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('search', { query: 'Micron Technology' })
    await hyperliquidCommand('search', { query: 'MUX' })

    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      network: 'mainnet',
      query: 'Micron Technology',
      matches: [],
    })
    expect(JSON.parse(String(log.mock.calls[1][0]))).toEqual({
      network: 'mainnet',
      query: 'MUX',
      matches: [
        {
          kind: 'spot',
          symbol: 'MUX/USDC',
          pairId: '@708',
          assetId: 10708,
          base: 'MUX',
          baseFullName: 'Wrapped Micron Technology xStock',
          quote: 'USDC',
          szDecimals: 2,
          active: true,
          score: 100,
          matchedFields: ['symbol', 'base'],
        },
      ],
    })
  })

  it('keeps a matching spot pair when several perp listings rank ahead of it', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const responses: Record<string, unknown> = {
      perpDexs: [
        null,
        { name: 'hyna', assetToStreamingOiCap: [] },
        { name: 'cash', assetToStreamingOiCap: [] },
        { name: 'flx', assetToStreamingOiCap: [] },
        { name: 'xyz', assetToStreamingOiCap: [] },
      ],
      allPerpMetas: [
        { universe: [{ name: 'BTC', szDecimals: 5 }] },
        { universe: [{ name: 'hyna:BTC', szDecimals: 5 }] },
        { universe: [{ name: 'cash:BTC', szDecimals: 5 }] },
        { universe: [{ name: 'flx:BTC', szDecimals: 5 }] },
        { universe: [{ name: 'xyz:BTC', szDecimals: 5 }] },
      ],
      spotMeta: {
        tokens: [
          { index: 0, name: 'USDC', szDecimals: 6 },
          { index: 197, name: 'UBTC', szDecimals: 5 },
        ],
        universe: [{ index: 142, name: '@142', tokens: [197, 0] }],
      },
    }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string }
      return {
        ok: true,
        status: 200,
        json: async () => (body.type === 'perpAnnotation' ? null : responses[body.type]),
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('search', { query: 'BTC' })

    const result = JSON.parse(String(log.mock.calls[0][0]))
    expect(result.matches).toContainEqual(
      expect.objectContaining({
        kind: 'spot',
        symbol: 'UBTC/USDC',
        pairId: '@142',
      }),
    )
  })

  it('resolves a builder-dex symbol from the public API without wallet credentials', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const universe = Array.from({ length: 102 }, (_, index) => ({
      name: index === 101 ? 'xyz:CXMT' : `xyz:ASSET-${index}`,
      szDecimals: index === 101 ? 1 : 2,
    }))
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          null,
          { name: 'xyz', assetToStreamingOiCap: [['xyz:CXMT', '250000000.0']] },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ universe }),
      })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('symbol', { coin: 'CXMT', dex: 'xyz' })

    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock.mock.calls[0][0]).toBe('https://api.hyperliquid.xyz/info')
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ type: 'perpDexs' })
    expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({
      type: 'meta',
      dex: 'xyz',
    })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      network: 'mainnet',
      inputCoin: 'CXMT',
      coin: 'xyz:CXMT',
      dex: 'xyz',
      assetId: 110101,
      szDecimals: 1,
    })
  })

  it('resolves a default perp symbol from the public API without wallet credentials', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const mock = mockFetch({ universe: [{ name: 'BTC', szDecimals: 5 }] })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('symbol', { coin: 'BTC', dex: 'default' })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe('https://api.hyperliquid.xyz/info')
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ type: 'meta' })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      network: 'mainnet',
      inputCoin: 'BTC',
      coin: 'BTC',
      assetId: 0,
      szDecimals: 5,
      dex: 'default',
    })
  })

  it.each<ReadRouteCase>([
    {
      command: 'status',
      args: {},
      expectedUrl: 'https://api.test/v1/instances/inst-123/integrations/hyperliquid-trading',
    },
    {
      command: 'snapshot',
      args: {},
      expectedUrl:
        'https://api.test/v1/instances/inst-123/integrations/hyperliquid-trading/snapshot',
    },
  ])(
    'maps integration read command $command to the platform route',
    async ({ command, args, expectedUrl }) => {
      const mock = mockFetch({
        ok: true,
        data: {
          command,
        },
      })
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', mock)

      await hyperliquidCommand(command, args)

      expect(mock).toHaveBeenCalledOnce()
      expect(mock.mock.calls[0][0]).toBe(expectedUrl)
      expect(mock.mock.calls[0][1]).toMatchObject({
        method: 'GET',
        headers: {
          Authorization: 'Bearer test-token',
        },
      })
    },
  )

  it.each([
    { command: 'enable', enabled: true },
    { command: 'disable', enabled: false },
  ])('maps $command to the Hyperliquid Trading integration toggle route', async (testCase) => {
    const mock = mockFetch({
      ok: true,
      data: {
        integration: 'hyperliquid-trading',
        enabled: testCase.enabled,
      },
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand(testCase.command, {})

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v1/instances/inst-123/integrations/hyperliquid-trading',
    )
    expect(mock.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ enabled: testCase.enabled })
  })

  it.each<ReadRouteCase>([
    {
      command: 'account',
      args: {},
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/account',
    },
    {
      command: 'abstraction',
      args: {},
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/abstraction',
    },
    {
      command: 'builder-fee-status',
      args: {},
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/builder-fee/status',
    },
    {
      command: 'prices',
      args: { dex: 'xyz' },
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/prices?dex=xyz',
    },
    {
      command: 'l2',
      args: { coin: 'ETH', 'n-sig-figs': '5', mantissa: '2' },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/l2?coin=ETH&nSigFigs=5&mantissa=2',
    },
    {
      command: 'funding',
      args: { coin: 'ETH', 'start-time': '123', 'end-time': '456' },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/funding?coin=ETH&startTime=123&endTime=456',
    },
    {
      command: 'state',
      args: { kind: 'perp', dex: 'xyz' },
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/state?kind=perp&dex=xyz',
    },
    {
      command: 'orders',
      args: { kind: 'historical', dex: 'xyz' },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/orders?kind=historical&dex=xyz',
    },
    {
      command: 'fills',
      args: {
        'start-time': '123',
        'end-time': '456',
        'aggregate-by-time': 'true',
        reversed: 'false',
      },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/fills?startTime=123&endTime=456&aggregateByTime=true&reversed=false',
    },
    {
      command: 'order-status',
      args: { oid: '0x00000000000000000000000000000001' },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/order-status?oid=0x00000000000000000000000000000001',
    },
    {
      command: 'withdraw-status',
      args: { nonce: '1784552760585' },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/withdraw-status?nonce=1784552760585',
    },
  ])('maps read command $command to the platform route', async ({ command, args, expectedUrl }) => {
    const mock = mockFetch({
      ok: true,
      data: {
        command,
      },
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand(command, args)

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe(expectedUrl)
    expect(mock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    })
  })

  it('reads markets from the public API without wallet credentials', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const mock = mockFetch([{ universe: [] }, []])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('markets', { kind: 'perp', dex: 'xyz' })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe('https://api.hyperliquid.xyz/info')
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
      type: 'metaAndAssetCtxs',
      dex: 'xyz',
    })
  })

  it('reads candles from the public API without wallet credentials', async () => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    const mock = mockFetch([])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('candles', {
      coin: 'ETH',
      interval: '1h',
      'start-time': '123',
      'end-time': '456',
    })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe('https://api.hyperliquid.xyz/info')
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'ETH', interval: '1h', startTime: 123, endTime: 456 },
    })
  })

  it.each([
    {
      command: 'order',
      replacement: 'Use limit-order, bracket-order, stop-loss, take-profit, or protect-position',
    },
    {
      command: 'modify',
      replacement: 'Use modify-limit-order, modify-stop-loss, or modify-take-profit',
    },
  ])(
    'rejects removed raw $command commands without an HTTP request',
    async ({ command, replacement }) => {
      const mock = mockFetch({ ok: true, data: {} })
      vi.stubGlobal('fetch', mock)

      await expect(hyperliquidCommand(command, { 'body-json': '{}' })).rejects.toThrow(
        `purr hyperliquid ${command} was removed. ${replacement}`,
      )
      expect(mock).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      command: 'limit-order',
      args: {
        asset: '159',
        side: 'sell',
        size: '0.45',
        price: '100',
        tif: 'Gtc',
        'reduce-only': 'true',
      },
      expectedPath: '/order',
      expectedBody: {
        orders: [
          {
            a: 159,
            b: false,
            p: '100',
            s: '0.45',
            r: true,
            t: { limit: { tif: 'Gtc' } },
          },
        ],
        grouping: 'na',
      },
    },
    {
      command: 'bracket-order',
      args: {
        asset: '159',
        side: 'sell',
        size: '0.45',
        'entry-price': '72',
        'entry-tif': 'Gtc',
        'take-profit-price': '60',
        'stop-loss-price': '80',
        execution: 'limit',
        'take-profit-limit-price': '60.5',
        'stop-loss-limit-price': '81',
        cloid: '0xABCDEFABCDEFABCDEFABCDEFABCDEFAB',
      },
      expectedPath: '/order',
      expectedBody: {
        orders: [
          {
            a: 159,
            b: false,
            p: '72',
            s: '0.45',
            r: false,
            t: { limit: { tif: 'Gtc' } },
            c: '0xabcdefabcdefabcdefabcdefabcdefab',
          },
          {
            a: 159,
            b: true,
            p: '60.5',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: false, triggerPx: '60', tpsl: 'tp' } },
          },
          {
            a: 159,
            b: true,
            p: '81',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: false, triggerPx: '80', tpsl: 'sl' } },
          },
        ],
        grouping: 'normalTpsl',
      },
    },
    {
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'worst-price': '62',
      },
      expectedPath: '/order',
      expectedBody: {
        orders: [
          {
            a: 159,
            b: false,
            p: '62',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '69', tpsl: 'sl' } },
          },
        ],
        grouping: 'positionTpsl',
      },
    },
    {
      command: 'take-profit',
      args: {
        asset: '159',
        'position-side': 'short',
        size: '0.45',
        'trigger-price': '60',
        execution: 'market',
        'worst-price': '65',
        cloid: '0xABCDEFABCDEFABCDEFABCDEFABCDEFAB',
      },
      expectedPath: '/order',
      expectedBody: {
        orders: [
          {
            a: 159,
            b: true,
            p: '65',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '60', tpsl: 'tp' } },
            c: '0xabcdefabcdefabcdefabcdefabcdefab',
          },
        ],
        grouping: 'positionTpsl',
      },
    },
    {
      command: 'protect-position',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'take-profit-price': '100',
        'stop-loss-price': '69',
        execution: 'market',
        'take-profit-worst-price': '90',
        'stop-loss-worst-price': '62',
      },
      expectedPath: '/order',
      expectedBody: {
        orders: [
          {
            a: 159,
            b: false,
            p: '90',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '100', tpsl: 'tp' } },
          },
          {
            a: 159,
            b: false,
            p: '62',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '69', tpsl: 'sl' } },
          },
        ],
        grouping: 'positionTpsl',
      },
    },
    {
      command: 'modify-limit-order',
      args: {
        oid: '511423165557',
        asset: '159',
        side: 'buy',
        size: '0.45',
        price: '71.5',
        tif: 'Gtc',
        'reduce-only': 'false',
      },
      expectedPath: '/modify',
      expectedBody: {
        oid: 511423165557,
        order: {
          a: 159,
          b: true,
          p: '71.5',
          s: '0.45',
          r: false,
          t: { limit: { tif: 'Gtc' } },
        },
      },
    },
    {
      command: 'modify-stop-loss',
      args: {
        oid: '511423165558',
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'worst-price': '62',
        'always-place': 'true',
      },
      expectedPath: '/modify',
      expectedBody: {
        oid: 511423165558,
        order: {
          a: 159,
          b: false,
          p: '62',
          s: '0.45',
          r: true,
          t: { trigger: { isMarket: true, triggerPx: '69', tpsl: 'sl' } },
        },
        a: true,
      },
    },
    {
      command: 'modify-take-profit',
      args: {
        oid: '0x00000000000000000000000000000002',
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '100',
        execution: 'limit',
        'limit-price': '99.5',
        'always-place': 'true',
      },
      expectedPath: '/modify',
      expectedBody: {
        oid: '0x00000000000000000000000000000002',
        order: {
          a: 159,
          b: false,
          p: '99.5',
          s: '0.45',
          r: true,
          t: { trigger: { isMarket: false, triggerPx: '100', tpsl: 'tp' } },
        },
        a: true,
      },
    },
    {
      command: 'modify-limit-order',
      args: {
        oid: '511423165559',
        asset: '159',
        side: 'buy',
        size: '0.45',
        price: '72',
        tif: 'FrontendMarket',
        'reduce-only': 'false',
        'always-place': 'true',
      },
      expectedPath: '/modify',
      expectedBody: {
        oid: 511423165559,
        order: {
          a: 159,
          b: true,
          p: '72',
          s: '0.45',
          r: false,
          t: { limit: { tif: 'FrontendMarket' } },
        },
        a: true,
      },
    },
    {
      command: 'modify-limit-order',
      args: {
        oid: '511423165560',
        asset: '159',
        side: 'sell',
        size: '0.45',
        price: '71',
        tif: 'Gtc',
        'reduce-only': 'false',
        'always-place': 'true',
      },
      expectedPath: '/modify',
      expectedBody: {
        oid: 511423165560,
        order: {
          a: 159,
          b: false,
          p: '71',
          s: '0.45',
          r: false,
          t: { limit: { tif: 'Gtc' } },
        },
        a: true,
      },
    },
  ])(
    'builds a typed $command request without raw JSON',
    async ({ command, args, expectedPath, expectedBody }) => {
      const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', mock)

      await hyperliquidCommand(command, args)

      expect(mock).toHaveBeenCalledOnce()
      expect(mock.mock.calls[0][0]).toBe(
        `https://api.test/v1/instances/inst-123/hyperliquid${expectedPath}`,
      )
      expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(expectedBody)
    },
  )

  it.each([
    {
      name: 'trigger modification without always-place',
      command: 'modify-stop-loss',
      args: {
        oid: '511423165558',
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'worst-price': '62',
      },
      error: '--always-place true is required when modifying a trigger order',
    },
    {
      name: 'false always-place',
      command: 'modify-stop-loss',
      args: {
        oid: '511423165558',
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'worst-price': '62',
        'always-place': 'false',
      },
      error: 'Invalid --always-place: expected true; false is not supported',
    },
    {
      name: 'FrontendMarket modification without always-place',
      command: 'modify-limit-order',
      args: {
        oid: '511423165559',
        asset: '159',
        side: 'buy',
        size: '0.45',
        price: '72',
        tif: 'FrontendMarket',
        'reduce-only': 'false',
      },
      error: '--always-place true is required when modifying an order with --tif FrontendMarket',
    },
    {
      name: 'missing required size',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        'trigger-price': '69',
        execution: 'market',
      },
      error: 'Missing required argument: --size',
    },
    {
      name: 'unknown extra option',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        tpsl: 'sl',
      },
      error: 'Unknown option for purr hyperliquid stop-loss: --tpsl',
    },
    {
      name: 'invalid position side',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'sell',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
      },
      error: 'Invalid --position-side: "sell". Expected one of: long, short',
    },
    {
      name: 'market trigger with a limit price',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'limit-price': '68.5',
      },
      error: '--limit-price is not allowed when --execution is market',
    },
    {
      name: 'market trigger without a worst price',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
      },
      error: '--worst-price is required when --execution is market',
    },
    {
      name: 'market trigger with an equal long worst price',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'worst-price': '69',
      },
      error: '--worst-price must be less than --trigger-price when closing a long position',
    },
    {
      name: 'market trigger with a wrong short worst-price direction',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'short',
        size: '0.45',
        'trigger-price': '69',
        execution: 'market',
        'worst-price': '68',
      },
      error: '--worst-price must be greater than --trigger-price when closing a short position',
    },
    {
      name: 'limit trigger without a limit price',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'limit',
      },
      error: '--limit-price is required when --execution is limit',
    },
    {
      name: 'limit trigger with a market worst price',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '69',
        execution: 'limit',
        'worst-price': '62',
        'limit-price': '68.5',
      },
      error: '--worst-price is not allowed when --execution is limit',
    },
    {
      name: 'market bracket with trigger limit prices',
      command: 'bracket-order',
      args: {
        asset: '159',
        side: 'buy',
        size: '0.45',
        'entry-price': '72',
        'entry-tif': 'Gtc',
        'take-profit-price': '100',
        'stop-loss-price': '69',
        execution: 'market',
        'take-profit-limit-price': '99.5',
      },
      error: '--take-profit-limit-price is not allowed when --execution is market',
    },
    {
      name: 'market bracket without both worst prices',
      command: 'bracket-order',
      args: {
        asset: '159',
        side: 'buy',
        size: '0.45',
        'entry-price': '72',
        'entry-tif': 'Gtc',
        'take-profit-price': '100',
        'stop-loss-price': '69',
        execution: 'market',
        'take-profit-worst-price': '90',
      },
      error: '--stop-loss-worst-price is required when --execution is market',
    },
    {
      name: 'limit bracket without both trigger limit prices',
      command: 'bracket-order',
      args: {
        asset: '159',
        side: 'buy',
        size: '0.45',
        'entry-price': '72',
        'entry-tif': 'Gtc',
        'take-profit-price': '100',
        'stop-loss-price': '69',
        execution: 'limit',
        'take-profit-limit-price': '99.5',
      },
      error: '--stop-loss-limit-price is required when --execution is limit',
    },
    {
      name: 'zero trigger price',
      command: 'stop-loss',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '0',
        execution: 'market',
      },
      error: 'Invalid --trigger-price: "0". Expected a positive decimal',
    },
    {
      name: 'invalid long protection price relationship',
      command: 'protect-position',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'take-profit-price': '65',
        'stop-loss-price': '69',
        execution: 'market',
      },
      error: '--take-profit-price must be greater than --stop-loss-price for a long position',
    },
    {
      name: 'invalid cloid',
      command: 'take-profit',
      args: {
        asset: '159',
        'position-side': 'long',
        size: '0.45',
        'trigger-price': '100',
        execution: 'market',
        'worst-price': '90',
        cloid: 'not-a-cloid',
      },
      error: 'Invalid --cloid: "not-a-cloid". Expected 0x followed by 32 hex characters',
    },
    {
      name: 'cancel without an oid',
      command: 'cancel',
      args: { asset: '159' },
      error: 'Missing required argument: --oid',
    },
    {
      name: 'cancel with an invalid oid',
      command: 'cancel',
      args: { asset: '159', oid: '-1' },
      error: 'Invalid --oid: "-1"',
    },
    {
      name: 'cancel-by-cloid without a cloid',
      command: 'cancel-by-cloid',
      args: { asset: '159' },
      error: 'Missing required argument: --cloid',
    },
    {
      name: 'cancel-by-cloid with an invalid cloid',
      command: 'cancel-by-cloid',
      args: { asset: '159', cloid: 'not-a-cloid' },
      error: 'Invalid --cloid: "not-a-cloid". Expected 0x followed by 32 hex characters',
    },
    {
      name: 'removed raw cancel body option',
      command: 'cancel',
      args: { 'body-json': '{"cancels":[]}' },
      error: 'Unknown option for purr hyperliquid cancel: --body-json',
    },
  ])('rejects $name before making an HTTP request', async ({ command, args, error }) => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand(command, args)).rejects.toThrow(error)
    expect(mock).not.toHaveBeenCalled()
  })

  it.each<WriteRouteCase>([
    {
      command: 'approve-builder-fee',
      args: {},
      expectedPath: '/builder-fee/approve',
      expectedBody: {},
    },
    {
      command: 'cancel',
      args: { asset: '0', oid: '123' },
      expectedPath: '/cancel',
      expectedBody: {
        cancels: [{ a: 0, o: 123 }],
      },
    },
    {
      command: 'cancel-by-cloid',
      args: { asset: '0', cloid: '0xABCDEFABCDEFABCDEFABCDEFABCDEFAB' },
      expectedPath: '/cancel-by-cloid',
      expectedBody: {
        cancels: [{ asset: 0, cloid: '0xabcdefabcdefabcdefabcdefabcdefab' }],
      },
    },
    {
      command: 'update-leverage',
      args: { asset: '1', 'is-cross': 'false', leverage: '3' },
      expectedPath: '/update-leverage',
      expectedBody: {
        asset: 1,
        isCross: false,
        leverage: 3,
      },
    },
    {
      command: 'schedule-cancel',
      args: { time: '123456' },
      expectedPath: '/schedule-cancel',
      expectedBody: {
        time: 123456,
      },
    },
    {
      command: 'schedule-cancel',
      args: {},
      expectedPath: '/schedule-cancel',
      expectedBody: {},
    },
    {
      command: 'set-abstraction',
      args: { mode: 'disabled' },
      expectedPath: '/abstraction',
      expectedBody: {
        abstraction: 'disabled',
      },
    },
    {
      command: 'set-abstraction',
      args: { mode: 'unifiedAccount' },
      expectedPath: '/abstraction',
      expectedBody: {
        abstraction: 'unifiedAccount',
      },
    },
    {
      command: 'set-abstraction',
      args: { mode: 'portfolioMargin' },
      expectedPath: '/abstraction',
      expectedBody: {
        abstraction: 'portfolioMargin',
      },
    },
    {
      command: 'set-abstraction',
      args: { abstraction: 'disabled' },
      expectedPath: '/abstraction',
      expectedBody: {
        abstraction: 'disabled',
      },
    },
    {
      command: 'usd-class-transfer',
      args: { amount: '10.25', 'to-perp': 'true' },
      expectedPath: '/usd-class-transfer',
      expectedBody: {
        amount: '10.25',
        toPerp: true,
      },
    },
    {
      command: 'send-asset',
      args: { 'source-dex': 'abc', 'destination-dex': 'xyz', amount: '1.5' },
      expectedPath: '/send-asset',
      expectedBody: {
        sourceDex: 'abc',
        destinationDex: 'xyz',
        amount: '1.5',
      },
    },
    {
      command: 'deposit',
      args: { amount: '25' },
      expectedPath: '/deposit',
      expectedBody: {
        amount: '25',
      },
    },
    {
      command: 'withdraw',
      args: { amount: '7.5' },
      expectedPath: '/withdraw',
      expectedBody: {
        amount: '7.5',
      },
    },
  ])(
    'maps write command $command to the platform route and body',
    async ({ command, args, expectedPath, expectedBody }) => {
      const mock = mockFetch({
        ok: true,
        data: {
          actionRequestId: 'request-id',
          status: 'succeeded',
        },
      })
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', mock)

      await hyperliquidCommand(command, args)

      expect(mock).toHaveBeenCalledOnce()
      expect(mock.mock.calls[0][0]).toBe(
        `https://api.test/v1/instances/inst-123/hyperliquid${expectedPath}`,
      )
      expect(mock.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      })
      expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(expectedBody)
    },
  )

  it.each([
    {
      status: 'approved',
      actionRequestId: 'approval-request-id',
    },
    {
      status: 'already_approved',
      actionRequestId: undefined,
    },
  ])('prints a $status builder fee approval result', async (approval) => {
    const mock = mockFetch({
      ok: true,
      data: {
        network: 'mainnet',
        walletAddress: '0x1234567890123456789012345678901234567890',
        ...approval,
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('approve-builder-fee', {})

    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      status: approval.status,
      ...(approval.actionRequestId ? { actionRequestId: approval.actionRequestId } : {}),
    })
  })

  it('builds convenience write bodies for send-asset and update-leverage', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        actionRequestId: 'request-id',
        status: 'succeeded',
      },
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('send-asset', {
      'destination-dex': 'xyz',
      amount: '1.5',
    })
    await hyperliquidCommand('update-leverage', {
      asset: '0',
      'is-cross': 'true',
      leverage: '5',
    })

    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v1/instances/inst-123/hyperliquid/send-asset',
    )
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
      sourceDex: '',
      destinationDex: 'xyz',
      amount: '1.5',
    })
    expect(mock.mock.calls[1][0]).toBe(
      'https://api.test/v1/instances/inst-123/hyperliquid/update-leverage',
    )
    expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({
      asset: 0,
      isCross: true,
      leverage: 5,
    })
  })

  it('preserves Hyperliquid symbol error codes for automation', async () => {
    const candidates = [
      {
        network: 'mainnet',
        inputCoin: 'BTC',
        coin: 'BTC',
        dex: 'default',
        assetId: 0,
        szDecimals: 5,
      },
      {
        network: 'mainnet',
        inputCoin: 'BTC',
        coin: 'hyna:BTC',
        dex: 'hyna',
        assetId: 120000,
        szDecimals: 5,
      },
    ]
    const mock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body)
      const data =
        body.type === 'perpDexs'
          ? [null, null, { name: 'hyna', assetToStreamingOiCap: [['hyna:BTC', '1.0']] }]
          : body.type === 'spotMeta'
            ? { tokens: [], universe: [] }
            : body.dex === 'hyna'
              ? { universe: [{ name: 'hyna:BTC', szDecimals: 5 }] }
              : { universe: [{ name: 'BTC', szDecimals: 5 }] }
      return { ok: true, status: 200, json: async () => data }
    })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('symbol', { coin: 'BTC' })).rejects.toMatchObject({
      code: 'HYPERLIQUID_SYMBOL_AMBIGUOUS',
      message: 'Hyperliquid symbol is ambiguous: BTC',
      data: { coin: 'BTC', candidates },
    })
  })

  it('returns builder fee approval requirements without automatically approving or retrying', async () => {
    const mock = mockFetch(
      {
        ok: false,
        code: 'HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED',
        error: 'Builder fee approval is required',
      },
      428,
    )
    vi.stubGlobal('fetch', mock)

    await expect(
      hyperliquidCommand('limit-order', {
        asset: '0',
        side: 'buy',
        size: '0.01',
        price: '100',
        tif: 'Gtc',
        'reduce-only': 'false',
      }),
    ).rejects.toMatchObject({
      code: 'HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED',
      message: 'Builder fee approval is required',
      status: 428,
    })
    expect(mock).toHaveBeenCalledOnce()
  })

  it('rejects network overrides before calling the platform', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('account', { network: 'testnet' })).rejects.toThrow(
      '--network is not supported',
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('requires a numeric withdraw nonce before calling the platform', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('withdraw-status', {})).rejects.toThrow(
      'Missing required argument: --nonce',
    )
    await expect(hyperliquidCommand('withdraw-status', { nonce: 'abc' })).rejects.toThrow(
      'Invalid --nonce: "abc"',
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('matches the platform L2 mantissa requirement before calling the platform', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('l2', { coin: 'ETH', mantissa: '2' })).rejects.toThrow(
      '--n-sig-figs 5 is required when --mantissa is provided',
    )
    await expect(
      hyperliquidCommand('l2', { coin: 'ETH', 'n-sig-figs': '4', mantissa: '2' }),
    ).rejects.toThrow('--n-sig-figs 5 is required when --mantissa is provided')
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects removed or unsupported abstraction write modes', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('set-abstraction', { mode: 'dexAbstraction' })).rejects.toThrow(
      'Invalid abstraction mode: "dexAbstraction"',
    )
    await expect(hyperliquidCommand('set-abstraction', { mode: 'default' })).rejects.toThrow(
      'Invalid abstraction mode: "default"',
    )
    expect(mock).not.toHaveBeenCalled()
  })
})
