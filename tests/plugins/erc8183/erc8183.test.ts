import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData } from 'viem'
import {
  ERC8183_ABI,
  encodeClaimRefund,
  encodeComplete,
  encodeCreateJob,
  encodeFund,
  encodeSetBudget,
} from '@pieverseio/purr-plugin-erc8183/calldata'
import { executeOne, firstHash } from '@pieverseio/purr-plugin-erc8183/execute'

const ORIGINAL_ENV = { ...process.env }
const originalFetch = globalThis.fetch

const CONTRACT = '0x1234567890123456789012345678901234567890'
const PROVIDER = '0x3333333333333333333333333333333333333333'
const EVALUATOR = '0x2222222222222222222222222222222222222222'
const TX_HASH = `0x${'01'.repeat(32)}`

beforeEach(() => {
  process.env.WALLET_API_URL = 'https://api.test.local'
  process.env.WALLET_API_TOKEN = 'test-token'
  process.env.INSTANCE_ID = '4fd09ba9-3654-4f01-bfc7-f28c3a0779f2'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...ORIGINAL_ENV }
  vi.restoreAllMocks()
})

describe('erc8183 calldata builders', () => {
  it('encodes createJob with the right argument order', () => {
    const data = encodeCreateJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: 1_750_000_000,
      description: 'https://purr.example/job.json',
      hook: '0x0000000000000000000000000000000000000000',
    })
    const decoded = decodeFunctionData({ abi: ERC8183_ABI, data })
    expect(decoded.functionName).toBe('createJob')
    expect(decoded.args[0].toLowerCase()).toBe(PROVIDER)
    expect(decoded.args[1].toLowerCase()).toBe(EVALUATOR)
    expect(decoded.args[2]).toBe(1_750_000_000n)
    expect(decoded.args[3]).toBe('https://purr.example/job.json')
  })

  it('encodes setBudget, fund, complete, claimRefund with the jobId', () => {
    const setBudget = decodeFunctionData({
      abi: ERC8183_ABI,
      data: encodeSetBudget({ jobId: '42', amountWei: '1000000' }),
    })
    expect(setBudget.functionName).toBe('setBudget')
    expect(setBudget.args).toEqual([42n, 1_000_000n, '0x'])

    const fund = decodeFunctionData({
      abi: ERC8183_ABI,
      data: encodeFund({ jobId: '42', amountWei: '1000000' }),
    })
    expect(fund.functionName).toBe('fund')

    const reason = `0x${'ab'.repeat(32)}` as `0x${string}`
    const complete = decodeFunctionData({
      abi: ERC8183_ABI,
      data: encodeComplete({ jobId: '42', reason }),
    })
    expect(complete.functionName).toBe('complete')
    expect(complete.args[1]).toBe(reason)

    const refund = decodeFunctionData({
      abi: ERC8183_ABI,
      data: encodeClaimRefund({ jobId: '42' }),
    })
    expect(refund.functionName).toBe('claimRefund')
    expect(refund.args).toEqual([42n])
  })

  it('rejects malformed addresses with a helpful message', () => {
    expect(() =>
      encodeCreateJob({
        provider: 'not-an-address',
        evaluator: EVALUATOR,
        expiredAt: 1,
        description: '',
      }),
    ).toThrow(/provider/)
  })
})

describe('executeOne', () => {
  it('POSTs a single step to /wallet/execute and surfaces the first hash', async () => {
    let captured: unknown
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toMatch(/\/wallet\/execute$/)
      captured = JSON.parse((init?.body ?? '{}') as string)
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            results: [{ stepIndex: 0, label: 'l', hash: TX_HASH, status: 'success' }],
            from: '0x',
            chainId: 56,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await executeOne({
      to: CONTRACT,
      data: '0xdeadbeef',
      value: '0x0',
      chainId: 56,
      label: 'l',
    })

    expect(firstHash(result)).toBe(TX_HASH)
    expect((captured as { steps: unknown[] }).steps).toHaveLength(1)
  })

  it('throws when the server envelope is not ok', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'nope' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    await expect(
      executeOne({ to: CONTRACT, data: '0x', value: '0x0', chainId: 56, label: 'l' }),
    ).rejects.toThrow(/nope/)
  })
})
