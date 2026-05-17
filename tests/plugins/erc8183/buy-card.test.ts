import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
} from 'viem'
import {
  buyErc8183Card,
  erc8183BuyCard,
  resolveRpcUrl,
} from '@pieverseio/purr-plugin-erc8183/buy-card'

const originalFetch = globalThis.fetch
let tempStateDir: string | null = null

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
  submit: `0x${'05'.repeat(32)}`,
  complete: `0x${'06'.repeat(32)}`,
  reject: `0x${'09'.repeat(32)}`,
}

const EVENT_ABI = parseAbi([
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])
const JOB_VIEW_ABI = parseAbi([
  'function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))',
])

function purchase(status: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    serviceSlug: 'agent-self-intro',
    serviceId: 'pieverse-card-generation-v1',
    purchaseId: PURCHASE_ID,
    instanceId: INSTANCE_ID,
    pieName: 'linwe.pie',
    status,
    cardId: CARD_ID,
    templateId: 'template-1',
    imageUrl: 'https://cdn.example/card.png',
    shareUrl: 'https://purr.example/cards/card',
    suggestedTweetText: 'Pie name: linwe.pie\n@pieverse @purrfectagent0',
    completedAt: status === 'completed' ? '2026-05-17T00:00:00.000Z' : null,
    idempotent: false,
    erc8183: {
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
      deliverableUri:
        status === 'submitted' || status === 'completed' ? 'https://purr.example/card.json' : null,
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
    ...overrides,
  }
}

function ok<T>(data: T) {
  return { ok: true, data }
}

function walletResult(
  results: Array<{ label: string; hash: string; status?: 'success' | 'skipped' }>,
) {
  return ok({
    results: results.map((result, stepIndex) => ({
      stepIndex,
      label: result.label,
      hash: result.hash,
      status: result.status ?? 'success',
    })),
    from: CLIENT,
    chainId: 56,
    chainType: 'ethereum',
  })
}

function createJobReceipt() {
  const topics = encodeEventTopics({
    abi: EVENT_ABI,
    eventName: 'JobCreated',
    args: {
      jobId: 42n,
      client: CLIENT,
      provider: PROVIDER,
    },
  })
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }],
    [CLIENT, 1234567890n, ZERO],
  )
  return rpcReceipt(HASHES.create, [
    {
      address: CONTRACT,
      topics,
      data,
      blockNumber: '0x1',
      transactionHash: HASHES.create,
      transactionIndex: '0x0',
      blockHash: `0x${'99'.repeat(32)}`,
      logIndex: '0x0',
      removed: false,
    },
  ])
}

function rpcReceipt(hash: string, logs: unknown[] = [], status: '0x0' | '0x1' = '0x1') {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      status,
      to: CONTRACT,
      transactionHash: hash,
      blockNumber: '0x1',
      logs,
    },
  }
}

function getJobResult(status: number, expiredAt: bigint) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: encodeFunctionResult({
      abi: JOB_VIEW_ABI,
      functionName: 'getJob',
      result: {
        id: 42n,
        client: CLIENT,
        provider: PROVIDER,
        evaluator: CLIENT,
        description: 'https://purr.example/jobs/job.json',
        budget: 1000000n,
        expiredAt,
        status,
        hook: ZERO,
      },
    }),
  }
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

describe('erc8183 buy-card', () => {
  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), 'purr-erc8183-test-'))
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'token'
    process.env.INSTANCE_ID = INSTANCE_ID
    process.env.PURR_ERC8183_STATE_FILE = join(tempStateDir, 'state.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.EVM_RPC_56
    delete process.env.EVM_RPC_URL
    delete process.env.BNB_RPC_URL
    delete process.env.PURR_ERC8183_STATE_FILE
    if (tempStateDir) rmSync(tempStateDir, { recursive: true, force: true })
    tempStateDir = null
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('uses chain-specific RPC env, BNB env, generic env, then BSC fallback', () => {
    process.env.EVM_RPC_56 = 'https://chain-specific.example'
    process.env.BNB_RPC_URL = 'https://bnb.example'
    process.env.EVM_RPC_URL = 'https://generic.example'
    expect(resolveRpcUrl(56)).toBe('https://chain-specific.example')
    delete process.env.EVM_RPC_56
    expect(resolveRpcUrl(56)).toBe('https://bnb.example')
    delete process.env.BNB_RPC_URL
    expect(resolveRpcUrl(56)).toBe('https://generic.example')
    delete process.env.EVM_RPC_URL
    expect(resolveRpcUrl(56)).toBe('https://bsc-rpc.publicnode.com')
  })

  it('keeps RPC configuration out of the buy-card CLI arguments', async () => {
    await expect(erc8183BuyCard({ 'rpc-url': 'https://rpc.example' })).rejects.toThrow(
      'does not accept --rpc-url',
    )
  })

  it('runs initiated purchase through create, fund, provider submit wait, and complete', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('initiated')),
      walletResult([{ label: 'ERC-8183 createJob', hash: HASHES.create }]),
      createJobReceipt(),
      ok(purchase('created')),
      walletResult([
        { label: 'ERC-8183 setBudget', hash: HASHES.setBudget },
        { label: 'ERC-8183 approve payment token', hash: HASHES.approve },
        { label: 'ERC-8183 fund', hash: HASHES.fund },
      ]),
      rpcReceipt(HASHES.fund),
      ok(purchase('submitted')),
      getJobResult(2, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 complete', hash: HASHES.complete }]),
      rpcReceipt(HASHES.complete),
      ok(purchase('completed')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await buyErc8183Card({
      receiptPollMs: 1,
      submittedPollMs: 1,
    })

    expect(result.status).toBe('completed')
    expect(result.erc8183?.onChainJobId).toBe('42')
    expect(result.xIntentUrl).toContain('https://x.com/intent/tweet?text=')

    const calls = mock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }))

    expect(calls[0].url).toBe(
      `https://api.test/v1/instances/${INSTANCE_ID}/erc8183/services/agent-self-intro/card/purchase`,
    )
    expect(calls[1].body).not.toHaveProperty('dedupKey')
    expect(calls[2].url).toBe('https://rpc.test')
    expect(calls[3].body).toMatchObject({
      status: 'created',
      onChainJobId: '42',
      createTxHash: HASHES.create,
    })
    expect(calls[4].body).not.toHaveProperty('dedupKey')
    expect(calls[6].body).toMatchObject({
      status: 'funded',
      setBudgetTxHash: HASHES.setBudget,
      approveTxHash: HASHES.approve,
      fundTxHash: HASHES.fund,
    })
    expect(calls[8].body).not.toHaveProperty('dedupKey')
    expect(calls[10].body).toMatchObject({
      status: 'completed',
      completeTxHash: HASHES.complete,
    })
  })

  it('resumes create progress from an existing create tx hash instead of sending createJob again', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const initiatedWithCreateTxHash = purchase('initiated', {
      erc8183: {
        ...(purchase('initiated').erc8183 as Record<string, unknown>),
        txHashes: {
          ...(purchase('initiated').erc8183 as { txHashes: Record<string, unknown> }).txHashes,
          create: HASHES.create,
        },
      },
    })
    const mock = mockFetchSequence([
      ok(initiatedWithCreateTxHash),
      createJobReceipt(),
      ok(purchase('created')),
      walletResult([
        { label: 'ERC-8183 setBudget', hash: HASHES.setBudget },
        { label: 'ERC-8183 approve payment token', hash: HASHES.approve },
        { label: 'ERC-8183 fund', hash: HASHES.fund },
      ]),
      rpcReceipt(HASHES.fund),
      ok(purchase('submitted')),
      getJobResult(2, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 complete', hash: HASHES.complete }]),
      rpcReceipt(HASHES.complete),
      ok(purchase('completed')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await buyErc8183Card({
      receiptPollMs: 1,
      submittedPollMs: 1,
    })

    expect(result.status).toBe('completed')

    const calls = mock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }))
    const walletBodies = calls
      .filter((call) => call.url.endsWith(`/v1/instances/${INSTANCE_ID}/wallet/execute`))
      .map((call) => call.body)

    expect(calls[1].url).toBe('https://rpc.test')
    expect(calls[2].body).toMatchObject({
      status: 'created',
      onChainJobId: '42',
      createTxHash: HASHES.create,
    })
    expect(walletBodies).toHaveLength(2)
    expect(walletBodies[0].steps.map((step: { label: string }) => step.label)).toEqual([
      'ERC-8183 setBudget',
      'ERC-8183 approve payment token',
      'ERC-8183 fund',
    ])
    expect(
      walletBodies.some((body) =>
        body.steps.some((step: { label: string }) => step.label === 'ERC-8183 createJob'),
      ),
    ).toBe(false)
  })

  it('recovers a locally cached create tx hash after progress recording fails', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('initiated')),
      walletResult([{ label: 'ERC-8183 createJob', hash: HASHES.create }]),
      createJobReceipt(),
      { ok: false, error: 'temporary progress failure' },
      ok(purchase('initiated')),
      createJobReceipt(),
      ok(purchase('created')),
      walletResult([
        { label: 'ERC-8183 setBudget', hash: HASHES.setBudget },
        { label: 'ERC-8183 approve payment token', hash: HASHES.approve },
        { label: 'ERC-8183 fund', hash: HASHES.fund },
      ]),
      rpcReceipt(HASHES.fund),
      ok(purchase('submitted')),
      getJobResult(2, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 complete', hash: HASHES.complete }]),
      rpcReceipt(HASHES.complete),
      ok(purchase('completed')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(
      buyErc8183Card({
        receiptPollMs: 1,
        submittedPollMs: 1,
      }),
    ).rejects.toThrow('temporary progress failure')

    const result = await buyErc8183Card({
      receiptPollMs: 1,
      submittedPollMs: 1,
    })

    expect(result.status).toBe('completed')
    const walletBodies = mock.mock.calls
      .map(([url, init]) => ({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }))
      .filter((call) => call.url.endsWith(`/v1/instances/${INSTANCE_ID}/wallet/execute`))
      .map((call) => call.body)
    const walletLabels = walletBodies.flatMap((body) =>
      body.steps.map((step: { label: string }) => step.label),
    )
    expect(walletLabels.filter((label) => label === 'ERC-8183 createJob')).toHaveLength(1)
  })

  it('returns completed purchases without sending wallet transactions', async () => {
    const mock = mockFetchSequence([ok(purchase('completed'))])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await buyErc8183Card()

    expect(result.status).toBe('completed')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('skips ERC-20 approve when the payment token is native', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const nativeFunded = purchase('funded', {
      erc8183: {
        ...(purchase('funded').erc8183 as Record<string, unknown>),
        paymentTokenAddress: ZERO,
        paymentTokenSymbol: 'BNB',
      },
    })
    const mock = mockFetchSequence([
      ok(
        purchase('created', {
          erc8183: {
            ...(purchase('created').erc8183 as Record<string, unknown>),
            paymentTokenAddress: ZERO,
            paymentTokenSymbol: 'BNB',
          },
        }),
      ),
      walletResult([
        { label: 'ERC-8183 setBudget', hash: HASHES.setBudget },
        { label: 'ERC-8183 fund', hash: HASHES.fund },
      ]),
      rpcReceipt(HASHES.fund),
      ok(nativeFunded),
      ok(purchase('submitted')),
      getJobResult(2, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 complete', hash: HASHES.complete }]),
      rpcReceipt(HASHES.complete),
      ok(purchase('completed')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await buyErc8183Card({
      receiptPollMs: 1,
      submittedPollMs: 1,
    })

    expect(result.status).toBe('completed')
    const fundSteps = JSON.parse(String(mock.mock.calls[1][1]?.body)).steps
    expect(fundSteps.map((step: { label: string }) => step.label)).toEqual([
      'ERC-8183 setBudget',
      'ERC-8183 fund',
    ])
  })

  it('claims refund when a funded job has expired before provider submit', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const refundHash = `0x${'07'.repeat(32)}`
    const mock = mockFetchSequence([
      ok(purchase('funded')),
      getJobResult(1, 1n),
      walletResult([{ label: 'ERC-8183 claimRefund', hash: refundHash }]),
      rpcReceipt(refundHash),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(
      buyErc8183Card({
        receiptPollMs: 1,
        submittedPollMs: 1,
        submittedTimeoutMs: -1,
      }),
    ).rejects.toThrow(`refundTxHash=${refundHash}`)

    const refundBody = JSON.parse(String(mock.mock.calls[2][1]?.body))
    expect(refundBody).not.toHaveProperty('dedupKey')
    expect(refundBody.steps[0].label).toBe('ERC-8183 claimRefund')
  })

  it('claims refund when a submitted job has expired before completion', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const refundHash = `0x${'08'.repeat(32)}`
    const mock = mockFetchSequence([
      ok(purchase('submitted')),
      getJobResult(2, 1n),
      walletResult([{ label: 'ERC-8183 claimRefund', hash: refundHash }]),
      rpcReceipt(refundHash),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(
      buyErc8183Card({
        receiptPollMs: 1,
        submittedPollMs: 1,
      }),
    ).rejects.toThrow(`refundTxHash=${refundHash}`)

    const refundBody = JSON.parse(String(mock.mock.calls[2][1]?.body))
    expect(refundBody.steps[0].label).toBe('ERC-8183 claimRefund')
  })

  it('claims refund when the purchase is rejected and the on-chain job is rejected', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const refundHash = `0x${'10'.repeat(32)}`
    const mock = mockFetchSequence([
      ok(purchase('rejected')),
      getJobResult(4, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 claimRefund', hash: refundHash }]),
      rpcReceipt(refundHash),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(
      buyErc8183Card({
        receiptPollMs: 1,
        submittedPollMs: 1,
      }),
    ).rejects.toThrow(`rejectTxHash=${HASHES.reject} refundTxHash=${refundHash}`)

    const refundBody = JSON.parse(String(mock.mock.calls[2][1]?.body))
    expect(refundBody.steps[0].label).toBe('ERC-8183 claimRefund')
  })

  it('surfaces failed purchases without attempting refund', async () => {
    const mock = mockFetchSequence([ok(purchase('failed'))])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(buyErc8183Card()).rejects.toThrow(
      `ERC-8183 buy-card failed for purchase ${PURCHASE_ID}`,
    )
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('does not claim refund for expired jobs that are only created on-chain', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('submitted')),
      getJobResult(0, 1n),
      walletResult([{ label: 'ERC-8183 complete', hash: HASHES.complete }]),
      rpcReceipt(HASHES.complete),
      ok(purchase('completed')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await buyErc8183Card({
      receiptPollMs: 1,
      submittedPollMs: 1,
    })

    expect(result.status).toBe('completed')
    const walletBody = JSON.parse(String(mock.mock.calls[2][1]?.body))
    expect(walletBody.steps[0].label).toBe('ERC-8183 complete')
  })

  it('fails immediately when an on-chain transaction receipt reverted', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('initiated')),
      walletResult([{ label: 'ERC-8183 createJob', hash: HASHES.create }]),
      rpcReceipt(HASHES.create, [], '0x0'),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(
      buyErc8183Card({
        receiptPollMs: 1,
        receiptTimeoutMs: 1_000,
        submittedPollMs: 1,
      }),
    ).rejects.toThrow(`transaction reverted: ${HASHES.create}`)
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('fails if JobCreated does not match the purchase provider', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const badReceipt = createJobReceipt()
    const createdLog = badReceipt.result.logs[0]
    const badTopics = encodeEventTopics({
      abi: EVENT_ABI,
      eventName: 'JobCreated',
      args: {
        jobId: 42n,
        client: CLIENT,
        provider: '0x5555555555555555555555555555555555555555',
      },
    }) as [Hex, ...Hex[]]
    badReceipt.result.logs[0] = { ...createdLog, topics: badTopics }

    const mock = mockFetchSequence([
      ok(purchase('initiated')),
      walletResult([{ label: 'ERC-8183 createJob', hash: HASHES.create }]),
      badReceipt,
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(
      buyErc8183Card({
        receiptPollMs: 1,
        submittedPollMs: 1,
      }),
    ).rejects.toThrow('JobCreated.provider')
  })
})
