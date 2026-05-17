import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buyCard } from '@pieverseio/purr-plugin-erc8183/buy-card'
import { completeCard } from '@pieverseio/purr-plugin-erc8183/complete-card'
import { fundCard } from '@pieverseio/purr-plugin-erc8183/fund-card'

const originalFetch = globalThis.fetch
const ORIGINAL_ENV = { ...process.env }

const INSTANCE_ID = '4fd09ba9-3654-4f01-bfc7-f28c3a0779f2'
const PURCHASE_ID = '80fdb8b1-9230-4d78-9fd6-579d4e6136f0'
const CARD_ID = '401d39ea-7ebd-4c43-887c-45617f3843cc'
const CONTRACT = '0x1234567890123456789012345678901234567890'
const CLIENT = '0x2222222222222222222222222222222222222222'
const PROVIDER = '0x3333333333333333333333333333333333333333'
const TOKEN = '0x4444444444444444444444444444444444444444'
const ZERO = '0x0000000000000000000000000000000000000000'

const HASHES = {
  create: `0x${'01'.repeat(32)}`,
  setBudget: `0x${'02'.repeat(32)}`,
  approve: `0x${'03'.repeat(32)}`,
  fund: `0x${'04'.repeat(32)}`,
  complete: `0x${'06'.repeat(32)}`,
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 56,
    contractAddress: CONTRACT,
    clientWalletAddress: CLIENT,
    providerWalletAddress: PROVIDER,
    evaluatorWalletAddress: CLIENT,
    hookAddress: ZERO,
    paymentTokenAddress: TOKEN,
    paymentTokenSymbol: 'USDT',
    budgetAmount: '1000000',
    jobUri: 'https://purr.example/jobs/job.json',
    deliverableUri: null,
    jobExpirationSeconds: 86400,
    onChainJobId: null,
    status: 'initiated',
    txHashes: {
      create: null,
      setBudget: null,
      approve: null,
      fund: null,
      submit: null,
      complete: null,
      reject: null,
    },
    ...overrides,
  }
}

function purchase(status: string, intentOverrides: Record<string, unknown> = {}) {
  return {
    purchaseId: PURCHASE_ID,
    instanceId: INSTANCE_ID,
    status,
    cardId: CARD_ID,
    imageUrl: null,
    shareUrl: null,
    suggestedTweetText: null,
    erc8183: intent({ status, ...intentOverrides }),
  }
}

type Handler = (url: string, init: RequestInit | undefined) => unknown

function mock(routes: Record<string, Handler>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.endsWith(pattern)) {
        const body = handler(url, init)
        return new Response(JSON.stringify({ ok: true, data: body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  process.env.WALLET_API_URL = 'https://api.test.local'
  process.env.WALLET_API_TOKEN = 'test-token'
  process.env.INSTANCE_ID = INSTANCE_ID
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...ORIGINAL_ENV }
  vi.restoreAllMocks()
})

describe('erc8183 atomic commands', () => {
  it('buyCard creates the purchase, executes createJob, and reports progress', async () => {
    const executeCalls: unknown[] = []
    globalThis.fetch = mock({
      '/card/purchase': () => purchase('initiated'),
      '/wallet/execute': (_url, init) => {
        executeCalls.push(JSON.parse((init?.body ?? '{}') as string))
        return {
          results: [
            {
              stepIndex: 0,
              label: 'ERC-8183 createJob',
              hash: HASHES.create,
              status: 'success',
            },
          ],
        }
      },
      [`/purchases/${PURCHASE_ID}/progress`]: () =>
        purchase('created', { onChainJobId: '42', txHashes: { create: HASHES.create } }),
    })

    const result = await buyCard()

    expect(result.purchaseId).toBe(PURCHASE_ID)
    expect(result.status).toBe('created')
    expect(result.createTxHash).toBe(HASHES.create)
    expect(result.onChainJobId).toBe('42')

    // Exactly one /wallet/execute with one createJob step — no orchestration.
    expect(executeCalls).toHaveLength(1)
    const steps = (executeCalls[0] as { steps: unknown[] }).steps
    expect(steps).toHaveLength(1)
  })

  it('fundCard refuses to build calldata before the server has the onChainJobId', async () => {
    globalThis.fetch = mock({
      [`/purchases/${PURCHASE_ID}`]: () => purchase('created', { onChainJobId: null }),
    })

    await expect(fundCard(PURCHASE_ID)).rejects.toThrow(/onChainJobId/)
  })

  it('fundCard bundles setBudget + approve + fund into one /wallet/execute', async () => {
    const executed: unknown[] = []
    globalThis.fetch = mock({
      [`/purchases/${PURCHASE_ID}/progress`]: () => purchase('funded', { onChainJobId: '42' }),
      [`/purchases/${PURCHASE_ID}`]: () => purchase('created', { onChainJobId: '42' }),
      '/wallet/execute': (_url, init) => {
        executed.push(JSON.parse((init?.body ?? '{}') as string))
        return {
          results: [
            {
              stepIndex: 0,
              label: 'ERC-8183 setBudget',
              hash: HASHES.setBudget,
              status: 'success',
            },
            {
              stepIndex: 1,
              label: 'ERC-8183 approve payment token',
              hash: HASHES.approve,
              status: 'success',
            },
            { stepIndex: 2, label: 'ERC-8183 fund', hash: HASHES.fund, status: 'success' },
          ],
        }
      },
    })

    const result = await fundCard(PURCHASE_ID)

    expect(result.setBudgetTxHash).toBe(HASHES.setBudget)
    expect(result.approveTxHash).toBe(HASHES.approve)
    expect(result.fundTxHash).toBe(HASHES.fund)

    const steps = (executed[0] as { steps: unknown[] }).steps
    expect(steps).toHaveLength(3)
  })

  it('completeCard submits complete and surfaces server-rendered share metadata', async () => {
    globalThis.fetch = mock({
      [`/purchases/${PURCHASE_ID}`]: () => purchase('submitted', { onChainJobId: '42' }),
      '/wallet/execute': () => ({
        results: [
          { stepIndex: 0, label: 'ERC-8183 complete', hash: HASHES.complete, status: 'success' },
        ],
      }),
      [`/purchases/${PURCHASE_ID}/progress`]: () => ({
        ...purchase('completed', { onChainJobId: '42' }),
        imageUrl: 'https://cdn.example/card.png',
        shareUrl: 'https://purr.example/cards/abc',
        suggestedTweetText: 'Pie name: linwe.pie',
      }),
    })

    const result = await completeCard(PURCHASE_ID)

    expect(result.completeTxHash).toBe(HASHES.complete)
    expect(result.imageUrl).toBe('https://cdn.example/card.png')
    expect(result.xIntentUrl).toBe('https://x.com/intent/tweet?text=Pie%20name%3A%20linwe.pie')
  })
})
