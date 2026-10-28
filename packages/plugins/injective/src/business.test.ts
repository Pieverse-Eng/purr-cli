import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { injectiveCommand } from './index.js'

const directory = mkdtempSync(join(tmpdir(), 'purr-injective-business-'))
const hash = '0x' + 'a'.repeat(64),
  generation = 'b'.repeat(64)
const reviewPath = join(directory, 'review.json'),
  bundlePath = join(directory, 'bundle.json')
const review = { stateHash: generation, cancelOrderHashes: [hash] }
const marginReviewPath = join(directory, 'margin-review.json')
writeFileSync(marginReviewPath, JSON.stringify({ stateHash: generation, cancelOrderHashes: [] }))
// Transport preservation fixture only; maker validation and chain effects belong to backend qualification.
const bundle = {
  request: { rfqId: '9007199254740993', margin: '20', quantity: '1.000' },
  quotes: [{ price: '100.000', expiry: { height: '9007199254740995', timestamp: '0' } }],
}
writeFileSync(reviewPath, JSON.stringify(review))
writeFileSync(bundlePath, JSON.stringify(bundle))
const common = ['--market-id', hash, '--max-fee-inj', '0.001']
const execute = [
  '--execute',
  'true',
  '--wallet-generation',
  generation,
  '--idempotency-key',
  'original:key',
]
const sent: Array<{ url: string; body: unknown; headers: Headers }> = []
let payload: unknown,
  status = 200
beforeEach(() => {
  vi.stubEnv('WALLET_API_URL', 'https://platform.example')
  vi.stubEnv('WALLET_API_TOKEN', 'offline-fixture')
  vi.stubEnv('INSTANCE_ID', 'owned-agent')
  vi.stubEnv('FX_PLATFORM_QUOTE_TOKEN', undefined)
  vi.stubEnv('FX_PLATFORM_UNISWAP_QUOTE_URL', undefined)
  vi.stubEnv('FX_PLATFORM_DFLOW_QUOTE_URL', undefined)
  sent.length = 0
  status = 200
  payload = { ok: true, data: { requestId: 'original', state: 'unknown' } }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init.headers),
    })
    return new Response(JSON.stringify(payload), { status, headers: { 'Retry-After': '3' } })
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.each([
  ['cancel', ['--order-hash', hash]],
  ['close', ['--side', 'sell', '--quantity', '1', '--price', '99', '--review-file', reviewPath]],
  [
    'protection',
    [
      '--quantity',
      '1',
      '--review-file',
      reviewPath,
      '--stop-loss-kind',
      'market',
      '--stop-loss-trigger',
      '90',
      '--stop-loss-price',
      '89',
    ],
  ],
  [
    'replace',
    [
      '--order-hash',
      hash,
      '--quantity',
      '1',
      '--price',
      '100',
      '--margin',
      '0',
      '--reduce-only',
      'true',
      '--review-file',
      reviewPath,
    ],
  ],
  ['cancel-batch', ['--review-file', reviewPath]],
  ['margin', ['--direction', 'add', '--amount', '2', '--review-file', marginReviewPath]],
] as const)(
  'builds a non-executing %s draft and submits exactly that reviewed body once',
  async (command, flags) => {
    const args = [command, ...common, ...flags]
    const draft = (await injectiveCommand(args)) as { body: unknown; executionEnabled: boolean }
    expect(draft.executionEnabled).toBe(false)
    expect(sent).toHaveLength(0)
    expect(await injectiveCommand([...args, ...execute])).toEqual({
      requestId: 'original',
      state: 'unknown',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual(draft.body)
    expect(sent[0].url).toBe(
      `https://platform.example/v1/instances/owned-agent/injective/${command}`,
    )
    expect(sent[0].headers.get('Idempotency-Key')).toBe('original:key')
    expect(sent[0].headers.get('X-Terminal-Connection-Version')).toBe(generation)
  },
)
it('preserves original RFQ decimal/uint64 strings and explicit cancellation scope', async () => {
  await injectiveCommand([
    'rfq',
    'accept',
    ...common,
    ...execute,
    '--authorization-state-hash',
    generation,
    '--bundle-file',
    bundlePath,
    '--intent',
    'open',
    '--maximum-settlement-fee',
    '1',
    '--review-file',
    reviewPath,
  ])
  expect(sent[0].body).toEqual({
    marketId: hash,
    maxFeeInj: '0.001',
    authorizationStateHash: generation,
    bundle,
    intent: 'open',
    maximumSettlementFee: '1',
    review,
  })
  expect(sent[0].url.endsWith('/injective/rfq-accept')).toBe(true)
})
it('makes preview a quote-only POST without an execution key and preserves policy holds', async () => {
  status = 202
  payload = { code: 'POLICY_DEFERRED', reason: 'manual_approval_required', request_id: 'policy-a' }
  expect(
    await injectiveCommand([
      'rfq',
      'preview',
      '--market-id',
      hash,
      '--direction',
      'long',
      '--quantity',
      '1',
      '--margin',
      '20',
      '--worst-price',
      '101',
      '--wallet-generation',
      generation,
    ]),
  ).toEqual(payload)
  expect(sent[0].headers.has('Idempotency-Key')).toBe(false)
  expect(sent[0].url.endsWith('/injective/rfq/preview')).toBe(true)
})
it('does not retry a failed execution and retains the original recovery command', async () => {
  status = 503
  payload = {
    ok: false,
    error: { code: 'INJECTIVE_EXECUTION_UNAVAILABLE', message: 'Unavailable' },
  }
  await expect(
    injectiveCommand(['cancel', ...common, '--order-hash', hash, ...execute]),
  ).rejects.toMatchObject({
    code: 'INJECTIVE_EXECUTION_UNAVAILABLE',
    data: {
      recovery: {
        originalKey: 'original:key',
        command: 'purr injective request --request-id original:key --by idempotency-key',
      },
    },
  })
  expect(sent).toHaveLength(1)
})
it('refuses execution without the reviewed identity/key and refuses ambiguous write flags before HTTP', async () => {
  for (const flags of [
    ['--execute', 'true'],
    [...execute, '--idempotency-key', 'another'],
    ['--execute', 'yes'],
  ])
    await expect(
      injectiveCommand(['cancel', ...common, '--order-hash', hash, ...flags]),
    ).rejects.toMatchObject({ code: 'INJECTIVE_INVALID_ARGUMENT' })
  expect(sent).toHaveLength(0)
})
