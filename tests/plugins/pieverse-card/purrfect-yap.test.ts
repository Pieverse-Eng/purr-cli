import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPieverseMemeJudgeInput,
  getPieverseMemeJudgeResult,
} from '@pieverseio/purr-plugin-pieverse-card/purrfect-yap'

const originalFetch = globalThis.fetch

const INSTANCE_ID = '4fd09ba9-3654-4f01-bfc7-f28c3a0779f2'
const PURCHASE_ID = '80fdb8b1-9230-4d78-9fd6-579d4e6136f0'
const HASHES = {
  create: `0x${'01'.repeat(32)}`,
  setBudget: `0x${'02'.repeat(32)}`,
  approve: `0x${'03'.repeat(32)}`,
  fund: `0x${'04'.repeat(32)}`,
  submit: `0x${'05'.repeat(32)}`,
  complete: `0x${'06'.repeat(32)}`,
  reject: `0x${'09'.repeat(32)}`,
}

function ok<T>(data: T) {
  return { ok: true, data }
}

function mockFetchSequence(responses: unknown[]) {
  let index = 0
  return vi.fn().mockImplementation(async () => {
    const response = responses[index++]
    if (response === undefined) throw new Error(`unexpected fetch call ${index}`)
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    }
  })
}

function memeJudgePurchase(status: string) {
  return {
    serviceSlug: 'social-meme-booster-judge',
    serviceId: 'social-meme-booster-judge',
    purchaseId: PURCHASE_ID,
    instanceId: INSTANCE_ID,
    pieName: 'linwe.pie',
    status,
    campaignSlug: 'bnb-survivor-quest',
    campaignDay: '2026-06-08',
    completedAt: status === 'completed' ? '2026-06-08T12:00:00.000Z' : null,
    erc8183: {
      chainId: 56,
      commerceAddress: '0x1234567890123456789012345678901234567890',
      routerAddress: '0x5555555555555555555555555555555555555555',
      policyAddress: '0x6666666666666666666666666666666666666666',
      clientWalletAddress: '0x2222222222222222222222222222222222222222',
      providerWalletAddress: '0x3333333333333333333333333333333333333333',
      evaluatorWalletAddress: '0x5555555555555555555555555555555555555555',
      hookAddress: '0x5555555555555555555555555555555555555555',
      paymentTokenAddress: '0x4444444444444444444444444444444444444444',
      paymentTokenSymbol: 'USDT',
      budgetAmount: '1000000',
      jobUri: `https://purr.example/v1/erc8183/services/social-meme-booster-judge/purchases/${PURCHASE_ID}/input`,
      deliverableUri:
        status === 'completed' ? 'https://purr.example/judgements/no-posts.json' : null,
      jobExpirationSeconds: 86400,
      onChainJobId: status === 'initiated' ? null : '42',
      status,
      txHashes: {
        create: status === 'initiated' ? null : HASHES.create,
        setBudget: status === 'initiated' || status === 'created' ? null : HASHES.setBudget,
        approve: status === 'initiated' || status === 'created' ? null : HASHES.approve,
        fund: status === 'initiated' || status === 'created' ? null : HASHES.fund,
        submit: status === 'submitted' || status === 'completed' ? HASHES.submit : null,
        complete: status === 'completed' ? HASHES.complete : null,
        reject: status === 'rejected' ? HASHES.reject : null,
      },
    },
  }
}

describe('pieverse PurrfectYap staged commands', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'token'
    process.env.INSTANCE_ID = INSTANCE_ID
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('returns funded judge input when no posts are present', async () => {
    const mock = mockFetchSequence([
      ok({
        serviceSlug: 'social-meme-booster-judge',
        serviceId: 'social-meme-booster-judge',
        purchaseId: PURCHASE_ID,
        jobId: 'job-1',
        campaignSlug: 'bnb-survivor-quest',
        campaignDay: '2026-06-08',
        instanceId: INSTANCE_ID,
        pieName: 'linwe.pie',
        posts: [],
        requirements: {
          engagementSnapshot: {
            source: 'x_live_fetch',
            timing: 'after_payment_before_completion',
            staleDiscoveryMetricsAllowed: false,
            requiredMetrics: ['likes', 'reposts', 'replies', 'quotes', 'impressions'],
            endpoint: null,
          },
        },
      }),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const input = await getPieverseMemeJudgeInput({ purchaseId: PURCHASE_ID })

    expect(input.posts).toEqual([])
    expect(String(mock.mock.calls[0][0])).toBe(
      `https://api.test/v1/erc8183/services/social-meme-booster-judge/purchases/${PURCHASE_ID}/input`,
    )
  })

  it('treats completed no-posts judge results as ready', async () => {
    const mock = mockFetchSequence([ok(memeJudgePurchase('completed'))])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await getPieverseMemeJudgeResult({ purchaseId: PURCHASE_ID, wait: true })

    expect(result.status).toBe('completed')
    expect(result.erc8183?.txHashes.fund).toBe(HASHES.fund)
    expect(result.erc8183?.txHashes.submit).toBe(HASHES.submit)
    expect(result.erc8183?.txHashes.complete).toBe(HASHES.complete)
    expect(mock).toHaveBeenCalledTimes(1)
  })
})
