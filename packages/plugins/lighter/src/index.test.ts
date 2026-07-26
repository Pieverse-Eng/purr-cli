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

  it('preserves wallet policy approval details from a deferred write', async () => {
    mocks.apiPost.mockResolvedValue({
      code: 'POLICY_DEFERRED',
      reason: 'manual_approval_required',
      request_id: 'req-policy-123',
      matched_rule_id: 'policy-123:0:claw:manual_approval',
      matched_policy_id: 'policy-123',
      expires_at: '2026-07-26T10:00:00.000Z',
    })

    await expect(
      lighterCommand('order', {
        'market-id': '0',
        side: 'buy',
        size: '0.006',
        price: '1800',
        type: 'limit',
        'time-in-force': 'gtt',
        'expires-in': '10m',
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
