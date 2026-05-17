import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buyErc8183Card } from '@pieverseio/purr-plugin-erc8183/buy-card'

const originalFetch = globalThis.fetch
const ORIGINAL_ENV = { ...process.env }

const INSTANCE_ID = '4fd09ba9-3654-4f01-bfc7-f28c3a0779f2'
const PURCHASE_ID = '80fdb8b1-9230-4d78-9fd6-579d4e6136f0'

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

function mockServer(payload: unknown, ok = true) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/card/purchase')) {
      return new Response(
        JSON.stringify({ ok, data: ok ? payload : undefined, error: ok ? undefined : 'nope' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

describe('buyErc8183Card', () => {
  it('passes through whatever the server returns', async () => {
    globalThis.fetch = mockServer({
      purchaseId: PURCHASE_ID,
      status: 'completed',
      imageUrl: 'https://cdn.example/card.png',
      shareUrl: 'https://purr.example/cards/abc',
      suggestedTweetText: 'Pie name: linwe.pie',
    }) as unknown as typeof fetch

    const result = await buyErc8183Card()

    expect(result.purchaseId).toBe(PURCHASE_ID)
    expect(result.status).toBe('completed')
    expect(result.imageUrl).toBe('https://cdn.example/card.png')
    expect(result.shareUrl).toBe('https://purr.example/cards/abc')
    expect(result.suggestedTweetText).toBe('Pie name: linwe.pie')
    expect(result.xIntentUrl).toBe('https://x.com/intent/tweet?text=Pie%20name%3A%20linwe.pie')
  })

  it('returns intermediate state without local orchestration', async () => {
    globalThis.fetch = mockServer({
      purchaseId: PURCHASE_ID,
      status: 'funded',
      imageUrl: null,
      shareUrl: null,
      suggestedTweetText: null,
    }) as unknown as typeof fetch

    const result = await buyErc8183Card()

    // Server-driven: CLI surfaces whatever phase the server is in, no
    // local if/else cascade that would block the user on intermediate states.
    expect(result.status).toBe('funded')
    expect(result.imageUrl).toBeNull()
    expect(result.xIntentUrl).toBeNull()
  })

  it('throws when the server envelope is not ok', async () => {
    globalThis.fetch = mockServer(undefined, false) as unknown as typeof fetch
    await expect(buyErc8183Card()).rejects.toThrow(/nope/)
  })
})
