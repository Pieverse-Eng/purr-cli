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
})
