import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lighterCommand } from '@pieverseio/purr-plugin-lighter/index'
import { mockFetch } from '../../helpers.js'

describe('lighter plugin', () => {
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

  it('calls read endpoints with the 20s timeout and without Idempotency-Key', async () => {
    const mock = mockFetch({ ok: true, data: { networks: [] } })
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await lighterCommand('deposit-networks', {})

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v1/instances/inst-123/lighter/deposit-networks',
    )
    expect(mock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    })
    expect(mock.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined()
    expect(mock.mock.calls[0][1].signal).toBeDefined()
    expect(timeoutSpy).toHaveBeenCalledWith(20_000)
  })

  it('calls side-effect write endpoints without client idempotency or timeout', async () => {
    const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await lighterCommand('order', {
      'market-id': '0',
      side: 'buy',
      size: '0.01',
      price: '3000',
    })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe('https://api.test/v1/instances/inst-123/lighter/order')
    expect(mock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
    })
    expect(mock.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined()
    expect(mock.mock.calls[0][1].signal).toBeUndefined()
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
      marketId: 0,
      side: 'buy',
      size: '0.01',
      price: '3000',
    })
  })

  it('covers the /orders write alias without client idempotency', async () => {
    const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await lighterCommand('place-orders', {
      'market-id': '0',
      side: 'buy',
      size: '0.01',
      price: '3000',
    })

    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe('https://api.test/v1/instances/inst-123/lighter/orders')
    expect(mock.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined()
  })

  it('passes a relative order expiry to Platform without resolving it in the CLI', async () => {
    const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await lighterCommand('order', {
      'market-id': '0',
      side: 'buy',
      size: '0.01',
      price: '3000',
      'expires-in': '5m',
    })

    expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
      expiresIn: '5m',
    })
  })

  it('normalizes an explicitly zoned order expiry to UTC', async () => {
    const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await lighterCommand('order', {
      'market-id': '0',
      side: 'buy',
      size: '0.01',
      price: '3000',
      'expires-at': '2026-07-26T12:00:00+09:00',
    })

    expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
      expiresAt: '2026-07-26T03:00:00.000Z',
    })
  })

  it('rejects an order expiry without an explicit timezone', async () => {
    const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
    vi.stubGlobal('fetch', mock)

    await expect(
      lighterCommand('order', {
        'market-id': '0',
        side: 'buy',
        size: '0.01',
        price: '3000',
        'expires-at': '2026-07-26T12:00:00',
      }),
    ).rejects.toThrow('must include Z or an explicit UTC offset')
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects multiple order expiry representations', async () => {
    const mock = mockFetch({ ok: true, data: { status: 'succeeded' } })
    vi.stubGlobal('fetch', mock)

    await expect(
      lighterCommand('order', {
        'market-id': '0',
        side: 'buy',
        size: '0.01',
        price: '3000',
        'expires-in': '24h',
        'order-expiry': '1785050939871',
      }),
    ).rejects.toThrow('are mutually exclusive')
    expect(mock).not.toHaveBeenCalled()
  })

  it('does not return unknown status when a read request times out', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout))

    await expect(lighterCommand('markets', {})).rejects.toMatchObject({
      code: 'LIGHTER_REQUEST_TIMEOUT',
      data: {
        timeoutMs: 20_000,
      },
    })

    await expect(lighterCommand('markets', {})).rejects.not.toMatchObject({
      data: {
        status: 'unknown',
      },
    })
  })
})
