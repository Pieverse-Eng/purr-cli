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

  it('calls symbol resolution with optional dex selector', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        network: 'mainnet',
        inputCoin: 'CXMT',
        coin: 'xyz:CXMT',
        dex: 'xyz',
        assetId: 110101,
        szDecimals: 1,
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('symbol', { coin: 'CXMT', dex: 'xyz' })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v1/instances/inst-123/hyperliquid/symbol?coin=CXMT&dex=xyz',
    )
    expect(mock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      coin: 'xyz:CXMT',
      assetId: 110101,
    })
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
      command: 'symbol',
      args: { coin: 'CXMT', dex: 'xyz' },
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/symbol?coin=CXMT&dex=xyz',
    },
    {
      command: 'markets',
      args: { kind: 'both', dex: 'xyz' },
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/markets?kind=both&dex=xyz',
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
      command: 'candles',
      args: { coin: 'ETH', interval: '1h', 'start-time': '123', 'end-time': '456' },
      expectedUrl:
        'https://api.test/v1/instances/inst-123/hyperliquid/candles?coin=ETH&interval=1h&startTime=123&endTime=456',
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
      args: { oid: '0xabc' },
      expectedUrl: 'https://api.test/v1/instances/inst-123/hyperliquid/order-status?oid=0xabc',
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

  it('posts raw order JSON bodies for full exchange action fidelity', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        actionRequestId: 'request-id',
        actionType: 'order',
        status: 'succeeded',
        replayed: false,
      },
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await hyperliquidCommand('order', {
      'body-json': JSON.stringify({
        orders: [
          {
            a: 0,
            b: true,
            p: '100',
            s: '0.01',
            r: false,
            t: { limit: { tif: 'Gtc' } },
          },
        ],
        grouping: 'na',
      }),
    })

    expect(mock.mock.calls[0][0]).toBe('https://api.test/v1/instances/inst-123/hyperliquid/order')
    expect(mock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
      orders: [{ a: 0, p: '100', s: '0.01' }],
      grouping: 'na',
    })
  })

  it.each<WriteRouteCase>([
    {
      command: 'approve-builder-fee',
      args: {},
      expectedPath: '/builder-fee/approve',
      expectedBody: {},
    },
    {
      command: 'order',
      args: {
        'body-json': JSON.stringify({
          orders: [{ a: 0, b: true, p: '100', s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }],
          grouping: 'na',
        }),
      },
      expectedPath: '/order',
      expectedBody: {
        orders: [{ a: 0, b: true, p: '100', s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }],
        grouping: 'na',
      },
    },
    {
      command: 'cancel',
      args: {
        'body-json': JSON.stringify({
          cancels: [{ a: 0, o: 123 }],
        }),
      },
      expectedPath: '/cancel',
      expectedBody: {
        cancels: [{ a: 0, o: 123 }],
      },
    },
    {
      command: 'cancel-by-cloid',
      args: {
        'body-json': JSON.stringify({
          cancels: [{ asset: 0, cloid: '0x00000000000000000000000000000001' }],
        }),
      },
      expectedPath: '/cancel-by-cloid',
      expectedBody: {
        cancels: [{ asset: 0, cloid: '0x00000000000000000000000000000001' }],
      },
    },
    {
      command: 'modify',
      args: {
        'body-json': JSON.stringify({
          oid: 123,
          order: { a: 0, b: true, p: '101', s: '0.02', r: false, t: { limit: { tif: 'Gtc' } } },
        }),
      },
      expectedPath: '/modify',
      expectedBody: {
        oid: 123,
        order: { a: 0, b: true, p: '101', s: '0.02', r: false, t: { limit: { tif: 'Gtc' } } },
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

  it('preserves Hyperliquid platform error codes for automation', async () => {
    const mock = mockFetch(
      {
        ok: false,
        code: 'HYPERLIQUID_SYMBOL_AMBIGUOUS',
        error: 'Hyperliquid symbol is ambiguous: BTC',
        data: { coin: 'BTC' },
      },
      409,
    )
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('symbol', { coin: 'BTC' })).rejects.toMatchObject({
      code: 'HYPERLIQUID_SYMBOL_AMBIGUOUS',
      message: 'Hyperliquid symbol is ambiguous: BTC',
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
      hyperliquidCommand('order', {
        'body-json': JSON.stringify({
          orders: [
            {
              a: 0,
              b: true,
              p: '100',
              s: '0.01',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        }),
      }),
    ).rejects.toMatchObject({
      code: 'HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED',
      message: 'Builder fee approval is required',
      status: 428,
    })
    expect(mock).toHaveBeenCalledOnce()
  })

  it('rejects ambiguous raw body input before parsing JSON', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(
      hyperliquidCommand('order', {
        'body-json': '{bad json',
        'body-file': './valid-order.json',
      }),
    ).rejects.toThrow('Pass either --body-json or --body-file, not both')
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects network overrides before calling the platform', async () => {
    const mock = mockFetch({ ok: true, data: {} })
    vi.stubGlobal('fetch', mock)

    await expect(hyperliquidCommand('account', { network: 'testnet' })).rejects.toThrow(
      '--network is not supported',
    )
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
