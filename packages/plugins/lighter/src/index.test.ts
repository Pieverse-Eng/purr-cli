import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  resolveCredentials: vi.fn(() => ({ instanceId: 'instance-123' })),
}))

vi.mock('@pieverseio/purr-core/api-client', () => ({
  ApiClientError: class ApiClientError extends Error {},
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  resolveCredentials: mocks.resolveCredentials,
}))

import { lighterCommand } from './index.js'

describe('lighter account opening', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset()
    mocks.apiPost.mockReset()
    mocks.apiPut.mockReset()
    mocks.resolveCredentials.mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends explicit funding parameters to the account opening endpoint', async () => {
    mocks.apiPost.mockResolvedValue({
      ok: true,
      data: {
        account: { status: 'initializing' },
        nextAction: 'resume_account_opening',
      },
    })

    await lighterCommand('open-account', {
      amount: '5',
      'source-chain-id': '8453',
      'route-type': 'perps',
    })

    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/instances/instance-123/lighter/account/open', {
      amount: '5',
      sourceChainId: 8453,
      routeType: 'perps',
    })
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          account: { status: 'initializing' },
          nextAction: 'resume_account_opening',
          resumeCommand:
            'purr lighter open-account --amount 5 --source-chain-id 8453 --route-type perps',
        },
        null,
        2,
      ),
    )
  })

  it('adds an exact account opening command only to the CLI error', async () => {
    mocks.apiPost.mockResolvedValue({
      ok: false,
      code: 'LIGHTER_ACCOUNT_NOT_READY',
      error: 'Lighter account must be opened before depositing',
    })

    await expect(
      lighterCommand('deposit', {
        amount: '5',
        'source-chain-id': '42161',
      }),
    ).rejects.toMatchObject({
      code: 'LIGHTER_ACCOUNT_NOT_READY',
      message:
        'Lighter account must be opened before depositing\nRun: purr lighter open-account --amount 5 --source-chain-id 42161',
    })
  })

  it('prints help before validating deposit arguments', async () => {
    await lighterCommand('deposit', { help: 'true' })

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deposit --amount <amount>'))
    expect(mocks.apiPost).not.toHaveBeenCalled()
  })

  it('exposes partner fee status and approval commands', async () => {
    mocks.apiGet.mockResolvedValue({
      ok: true,
      data: { status: 'approval_required', feeBps: 5 },
    })
    mocks.apiPost.mockResolvedValue({
      ok: true,
      data: { status: 'succeeded' },
    })

    await lighterCommand('partner-fee-status', {})
    expect(mocks.apiGet).toHaveBeenCalledWith(
      '/v1/instances/instance-123/lighter/partner-fee/status',
      { timeoutMs: 20_000 },
    )

    await lighterCommand('approve-partner-fee', {})
    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/instances/instance-123/lighter/partner-fee/approve',
      {},
    )
  })

  it('previews withdrawals and requires --yes before execution', async () => {
    await lighterCommand('withdraw', { help: 'true' })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Adding --yes fetches and executes the latest quote'),
    )
    vi.mocked(console.log).mockClear()

    mocks.apiPost.mockResolvedValue({
      ok: true,
      data: { requiresConfirmation: true },
    })

    await lighterCommand('fast-withdraw', { amount: '5.25' })

    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/instances/instance-123/lighter/fast-withdraw/preview',
      { amount: '5.25' },
      { timeoutMs: 20_000 },
    )

    mocks.apiPost.mockClear()
    mocks.apiPost.mockResolvedValue({
      ok: true,
      data: { actionType: 'fastWithdraw', status: 'succeeded' },
    })
    await lighterCommand('fast-withdraw', { amount: '5.25', yes: 'true' })
    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/instances/instance-123/lighter/fast-withdraw', {
      amount: '5.25',
      confirmed: true,
    })

    mocks.apiPost.mockClear()
    await lighterCommand('withdraw', { amount: '1.5' })
    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/instances/instance-123/lighter/withdraw/preview',
      { amount: '1.5' },
      { timeoutMs: 20_000 },
    )

    mocks.apiPost.mockClear()
    await lighterCommand('withdraw', { amount: '1.5', yes: 'true' })
    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/instances/instance-123/lighter/withdraw', {
      amount: '1.5',
      confirmed: true,
    })
  })

  it('forwards the complete official candle query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, candles: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await lighterCommand('candles', {
      'market-id': '0',
      resolution: '1m',
      'start-at': '2026-07-27T00:00:00Z',
      'end-at': '2026-07-27T01:00:00Z',
      'count-back': '3',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=0&resolution=1m&start_timestamp=1785110400&end_timestamp=1785114000&count_back=3',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mocks.resolveCredentials).not.toHaveBeenCalled()
  })

  it('reads markets from the public API without platform credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, order_books: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await lighterCommand('markets', { 'market-type': 'perp' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks?filter=perp',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mocks.resolveCredentials).not.toHaveBeenCalled()
  })

  it('resolves one market entirely through the public API', async () => {
    const btc = {
      market_id: 1,
      symbol: 'BTC',
      market_type: 'perp',
      status: 'active',
      supported_size_decimals: 5,
      supported_price_decimals: 1,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, order_books: [btc] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, order_books: [btc] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await lighterCommand('market', { market: 'BTC', 'market-type': 'perp' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks?filter=perp',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks?market_id=1&filter=perp',
    )
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(btc, null, 2))
    expect(mocks.resolveCredentials).not.toHaveBeenCalled()
  })

  it('resolves a candle symbol entirely through the public API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            order_books: [{ market_id: 0, symbol: 'BTC', market_type: 'perp' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, candles: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await lighterCommand('candles', {
      market: 'BTC',
      'market-type': 'perp',
      resolution: '1h',
      'start-at': '2026-07-27T00:00:00Z',
      'end-at': '2026-07-27T01:00:00Z',
      'count-back': '1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks?filter=perp',
    )
    expect(fetchMock.mock.calls[1][0]).toContain('/api/v1/candles?market_id=0&')
    expect(mocks.resolveCredentials).not.toHaveBeenCalled()
  })

  it('forwards the complete official PnL query', async () => {
    mocks.apiGet.mockResolvedValue({ ok: true, data: {} })

    await lighterCommand('pnl', {
      resolution: '1h',
      'start-at': '2026-07-27T09:00:00+09:00',
      'end-at': '2026-07-27T10:00:00+09:00',
      'count-back': '3',
    })

    expect(mocks.apiGet).toHaveBeenCalledWith(
      '/v1/instances/instance-123/lighter/pnl?resolution=1h&startTimestamp=1785110400&endTimestamp=1785114000&countBack=3',
      { timeoutMs: 20_000 },
    )
  })

  it('supports the daily PnL resolution available on Lighter mainnet', async () => {
    mocks.apiGet.mockResolvedValue({ ok: true, data: {} })

    await lighterCommand('pnl', {
      resolution: '1d',
      'start-at': '2026-07-26T00:00:00Z',
      'end-at': '2026-07-27T00:00:00Z',
      'count-back': '1',
    })

    expect(mocks.apiGet).toHaveBeenCalledWith(
      '/v1/instances/instance-123/lighter/pnl?resolution=1d&startTimestamp=1785024000&endTimestamp=1785110400&countBack=1',
      { timeoutMs: 20_000 },
    )
  })

  it('rejects resolutions unsupported by the corresponding official endpoint', async () => {
    await expect(
      lighterCommand('candles', {
        'market-id': '0',
        resolution: '2m',
        'start-at': '2026-07-27T00:00:00Z',
        'end-at': '2026-07-27T01:00:00Z',
        'count-back': '3',
      }),
    ).rejects.toThrow('--resolution must be one of: 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, 1w')

    await expect(
      lighterCommand('pnl', {
        resolution: '5m',
        'start-at': '2026-07-27T00:00:00Z',
        'end-at': '2026-07-27T01:00:00Z',
        'count-back': '3',
      }),
    ).rejects.toThrow('--resolution must be one of: 1h, 1d')

    expect(mocks.apiGet).not.toHaveBeenCalled()
  })

  it('requires explicit timezones for candle and PnL timestamps', async () => {
    await expect(
      lighterCommand('candles', {
        'market-id': '0',
        resolution: '1m',
        'start-at': '2026-07-27T00:00:00',
        'end-at': '2026-07-27T01:00:00Z',
        'count-back': '3',
      }),
    ).rejects.toThrow('--start-at must be an RFC 3339 timestamp with a timezone')

    await expect(
      lighterCommand('pnl', {
        resolution: '1h',
        'start-at': '2026-07-27T00:00:00Z',
        'end-at': '2026-07-27T01:00:00',
        'count-back': '1',
      }),
    ).rejects.toThrow('--end-at must be an RFC 3339 timestamp with a timezone')

    expect(mocks.apiGet).not.toHaveBeenCalled()
  })

  it('rejects invalid calendar dates and reversed time ranges', async () => {
    await expect(
      lighterCommand('candles', {
        'market-id': '0',
        resolution: '1m',
        'start-at': '2026-02-30T00:00:00Z',
        'end-at': '2026-03-02T01:00:00Z',
        'count-back': '3',
      }),
    ).rejects.toThrow('--start-at must be a valid RFC 3339 timestamp')

    await expect(
      lighterCommand('pnl', {
        resolution: '1h',
        'start-at': '2026-07-27T02:00:00Z',
        'end-at': '2026-07-27T01:00:00Z',
        'count-back': '1',
      }),
    ).rejects.toThrow('--start-at must be earlier than or equal to --end-at')

    expect(mocks.apiGet).not.toHaveBeenCalled()
  })

  it('preserves wallet policy approval details from a deferred deposit', async () => {
    mocks.apiPost.mockResolvedValue({
      code: 'POLICY_DEFERRED',
      reason: 'manual_approval_required',
      request_id: 'req-policy-123',
      matched_rule_id: 'policy-123:0:claw:manual_approval',
      matched_policy_id: 'policy-123',
      expires_at: '2026-07-26T10:00:00.000Z',
    })

    await expect(
      lighterCommand('deposit', {
        amount: '5',
        'source-chain-id': '1',
      }),
    ).rejects.toMatchObject({
      code: 'POLICY_DEFERRED',
      message: 'manual_approval_required',
      data: {
        request_id: 'req-policy-123',
        matched_rule_id: 'policy-123:0:claw:manual_approval',
        matched_policy_id: 'policy-123',
        expires_at: '2026-07-26T10:00:00.000Z',
      },
    })
  })
})
