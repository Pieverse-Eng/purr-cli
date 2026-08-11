import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executeStepsFromJson, type ExecuteResult } from '@pieverseio/purr-core/executor'

const EXECUTE_RESULT: ExecuteResult = {
  results: [
    {
      stepIndex: 0,
      hash: `0x${'1'.repeat(64)}`,
      status: 'success',
    },
  ],
  from: '0x1111111111111111111111111111111111111111',
  chainId: 97,
  chainType: 'ethereum',
}

const STEPS_JSON = JSON.stringify({
  steps: [
    {
      to: '0x2222222222222222222222222222222222222222',
      data: '0x',
      value: '0x0',
      chainId: 97,
    },
  ],
})

describe('executeStepsFromJson', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    vi.restoreAllMocks()
  })

  function mockResponse(body: unknown): void {
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      configurable: true,
      writable: true,
    })
  }

  it('unwraps the production API envelope', async () => {
    mockResponse({ ok: true, data: EXECUTE_RESULT })

    await expect(executeStepsFromJson(STEPS_JSON)).resolves.toEqual(EXECUTE_RESULT)
  })

  it('rejects a response without the API envelope', async () => {
    mockResponse(EXECUTE_RESULT)

    await expect(executeStepsFromJson(STEPS_JSON)).rejects.toThrow(
      'Invalid wallet execution response',
    )
  })

  it('rejects an unsuccessful API envelope', async () => {
    mockResponse({ ok: false, error: 'execution rejected' })

    await expect(executeStepsFromJson(STEPS_JSON)).rejects.toThrow('execution rejected')
  })
})
