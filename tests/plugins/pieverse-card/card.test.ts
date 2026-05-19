import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
} from 'viem'
import {
  acceptPieverseCard,
  createPieverseCardJob,
  pieverseCard,
  fundPieverseCard,
  getPieverseCardDeliverable,
  getPieverseCardStatus,
  purchasePieverseCard,
  refundPieverseCard,
  resolveRpcUrl,
} from '@pieverseio/purr-plugin-pieverse-card/card'

const originalFetch = globalThis.fetch

const INSTANCE_ID = '4fd09ba9-3654-4f01-bfc7-f28c3a0779f2'
const PURCHASE_ID = '80fdb8b1-9230-4d78-9fd6-579d4e6136f0'
const CARD_ID = '401d39ea-7ebd-4c43-887c-45617f3843cc'
const CONTRACT = '0x1234567890123456789012345678901234567890'
const ROUTER = '0x5555555555555555555555555555555555555555'
const POLICY = '0x6666666666666666666666666666666666666666'
const CLIENT = '0x2222222222222222222222222222222222222222'
const PROVIDER = '0x3333333333333333333333333333333333333333'
const TOKEN = '0x4444444444444444444444444444444444444444'
const ZERO = '0x0000000000000000000000000000000000000000'

const HASHES = {
  create: `0x${'01'.repeat(32)}`,
  register: `0x${'11'.repeat(32)}`,
  setBudget: `0x${'02'.repeat(32)}`,
  approve: `0x${'03'.repeat(32)}`,
  fund: `0x${'04'.repeat(32)}`,
  submit: `0x${'05'.repeat(32)}`,
  complete: `0x${'06'.repeat(32)}`,
  reject: `0x${'09'.repeat(32)}`,
  refund: `0x${'10'.repeat(32)}`,
}

const JOB_STATUS = {
  CREATED: 1,
  FUNDED: 2,
  SUBMITTED: 3,
  COMPLETED: 4,
  REJECTED: 5,
} as const

const EVENT_ABI = parseAbi([
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])
const ROUTER_EVENT_ABI = parseAbi([
  'event JobRegistered(uint256 indexed jobId,address indexed policy,address indexed client)',
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
      commerceAddress: CONTRACT,
      routerAddress: ROUTER,
      policyAddress: POLICY,
      clientWalletAddress: CLIENT,
      providerWalletAddress: PROVIDER,
      evaluatorWalletAddress: ROUTER,
      hookAddress: ROUTER,
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
    [ROUTER, 1234567890n, ROUTER],
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

function registerJobReceipt() {
  const topics = encodeEventTopics({
    abi: ROUTER_EVENT_ABI,
    eventName: 'JobRegistered',
    args: {
      jobId: 42n,
      policy: POLICY,
      client: CLIENT,
    },
  })
  return rpcReceipt(
    HASHES.register,
    [
      {
        address: ROUTER,
        topics,
        data: '0x',
        blockNumber: '0x1',
        transactionHash: HASHES.register,
        transactionIndex: '0x0',
        blockHash: `0x${'98'.repeat(32)}`,
        logIndex: '0x0',
        removed: false,
      },
    ],
    '0x1',
    ROUTER,
  )
}

function rpcReceipt(
  hash: string,
  logs: unknown[] = [],
  status: '0x0' | '0x1' = '0x1',
  to = CONTRACT,
) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      status,
      to,
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

describe('pieverse card staged commands', () => {
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
    delete process.env.EVM_RPC_56
    delete process.env.EVM_RPC_URL
    delete process.env.BNB_RPC_URL
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

  it('keeps RPC configuration out of CLI arguments', async () => {
    await expect(pieverseCard('purchase', { 'rpc-url': 'https://rpc.example' })).rejects.toThrow(
      /do not accept --rpc-url/,
    )
  })

  it('creates or resumes a purchase without sending wallet transactions', async () => {
    const mock = mockFetchSequence([ok(purchase('initiated'))])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await purchasePieverseCard()

    expect(result.purchaseId).toBe(PURCHASE_ID)
    expect(result.status).toBe('initiated')
    expect(result).not.toHaveProperty('xIntentUrl')
    expect(mock).toHaveBeenCalledTimes(1)
    expect(String(mock.mock.calls[0][0])).toBe(
      `https://api.test/v1/instances/${INSTANCE_ID}/erc8183/services/agent-self-intro/card/purchase`,
    )
  })

  it('runs create-job, decodes JobCreated, and records created progress', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('initiated')),
      walletResult([{ label: 'ERC-8183 createJob', hash: HASHES.create }]),
      createJobReceipt(),
      walletResult([{ label: 'ERC-8183 registerJob', hash: HASHES.register }]),
      registerJobReceipt(),
      ok(purchase('created')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await createPieverseCardJob({
      purchaseId: PURCHASE_ID,
      receiptPollMs: 1,
    })

    expect(result.status).toBe('created')
    const calls = mock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }))
    expect(calls[1].body.steps[0].label).toBe('ERC-8183 createJob')
    expect(calls[3].body.steps[0].label).toBe('ERC-8183 registerJob')
    expect(calls[5].body).toMatchObject({
      status: 'created',
      onChainJobId: '42',
      createTxHash: HASHES.create,
    })
  })

  it('resumes create-job from an explicit create tx hash', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('initiated')),
      createJobReceipt(),
      registerJobReceipt(),
      ok(purchase('created')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await createPieverseCardJob({
      purchaseId: PURCHASE_ID,
      createTxHash: HASHES.create,
      registerTxHash: HASHES.register,
      receiptPollMs: 1,
    })

    expect(result.status).toBe('created')
    const walletCalls = mock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/v1/instances/${INSTANCE_ID}/wallet/execute`),
    )
    expect(walletCalls).toHaveLength(0)
  })

  it('runs fund and accepts backend auto-submit as the returned status', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('created')),
      walletResult([
        { label: 'ERC-8183 setBudget', hash: HASHES.setBudget },
        { label: 'ERC-8183 approve payment token', hash: HASHES.approve },
        { label: 'ERC-8183 fund', hash: HASHES.fund },
      ]),
      rpcReceipt(HASHES.fund),
      ok(purchase('submitted')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await fundPieverseCard({ purchaseId: PURCHASE_ID, receiptPollMs: 1 })

    expect(result.status).toBe('submitted')
    expect(result.erc8183?.txHashes.submit).toBe(HASHES.submit)
    const calls = mock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }))
    expect(calls[1].body.steps.map((step: { label: string }) => step.label)).toEqual([
      'ERC-8183 setBudget',
      'ERC-8183 approve payment token',
      'ERC-8183 fund',
    ])
    expect(calls[3].body).toMatchObject({
      status: 'funded',
      setBudgetTxHash: HASHES.setBudget,
      approveTxHash: HASHES.approve,
      fundTxHash: HASHES.fund,
    })
  })

  it('skips approve when the payment token is native', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const nativePurchase = purchase('created', {
      erc8183: {
        ...(purchase('created').erc8183 as Record<string, unknown>),
        paymentTokenAddress: ZERO,
        paymentTokenSymbol: 'BNB',
      },
    })
    const mock = mockFetchSequence([
      ok(nativePurchase),
      walletResult([
        { label: 'ERC-8183 setBudget', hash: HASHES.setBudget },
        { label: 'ERC-8183 fund', hash: HASHES.fund },
      ]),
      rpcReceipt(HASHES.fund),
      ok(purchase('funded')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await fundPieverseCard({ purchaseId: PURCHASE_ID, receiptPollMs: 1 })

    expect(result.status).toBe('funded')
    const fundSteps = JSON.parse(String(mock.mock.calls[1][1]?.body)).steps
    expect(fundSteps.map((step: { label: string }) => step.label)).toEqual([
      'ERC-8183 setBudget',
      'ERC-8183 fund',
    ])
  })

  it('waits for deliverable without sending user-side transactions', async () => {
    const mock = mockFetchSequence([ok(purchase('funded')), ok(purchase('submitted'))])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await getPieverseCardDeliverable({
      purchaseId: PURCHASE_ID,
      wait: true,
      submittedPollMs: 1,
    })

    expect(result.status).toBe('submitted')
    expect(result.imageUrl).toBe('https://cdn.example/card.png')
    expect(result.suggestedTweetText).toContain('@purrfectagent0')
    const walletCalls = mock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/v1/instances/${INSTANCE_ID}/wallet/execute`),
    )
    expect(walletCalls).toHaveLength(0)
  })

  it('accepts a submitted card by completing as evaluator', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('submitted')),
      getJobResult(JOB_STATUS.SUBMITTED, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 settle', hash: HASHES.complete }]),
      rpcReceipt(HASHES.complete, [], '0x1', ROUTER),
      ok(purchase('completed')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await acceptPieverseCard({ purchaseId: PURCHASE_ID, receiptPollMs: 1 })

    expect(result.status).toBe('completed')
    const progressBody = JSON.parse(String(mock.mock.calls[4][1]?.body))
    expect(progressBody).toMatchObject({
      status: 'completed',
      completeTxHash: HASHES.complete,
    })
  })

  it('claims refund for rejected jobs explicitly', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('rejected')),
      getJobResult(JOB_STATUS.REJECTED, 9_999_999_999n),
      walletResult([{ label: 'ERC-8183 claimRefund', hash: HASHES.refund }]),
      rpcReceipt(HASHES.refund),
      ok(purchase('rejected')),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await refundPieverseCard({ purchaseId: PURCHASE_ID, receiptPollMs: 1 })

    expect(result.refundTxHash).toBe(HASHES.refund)
    const refundBody = JSON.parse(String(mock.mock.calls[2][1]?.body))
    expect(refundBody.steps[0].label).toBe('ERC-8183 claimRefund')
    const progressBody = JSON.parse(String(mock.mock.calls[4][1]?.body))
    expect(progressBody).toMatchObject({
      status: 'rejected',
      rejectTxHash: HASHES.reject,
      errorMessage: `ERC-8183 refund claimed: ${HASHES.refund}`,
    })
  })

  it('returns status without adding derived X intent URL', async () => {
    const mock = mockFetchSequence([ok(purchase('completed'))])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    const result = await getPieverseCardStatus({ purchaseId: PURCHASE_ID })

    expect(result.status).toBe('completed')
    expect(result).not.toHaveProperty('xIntentUrl')
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
      createPieverseCardJob({ purchaseId: PURCHASE_ID, receiptPollMs: 1 }),
    ).rejects.toThrow('JobCreated.provider')
  })

  it('does not send complete when the on-chain submitted job is expired', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('submitted')),
      getJobResult(JOB_STATUS.SUBMITTED, 1n),
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(acceptPieverseCard({ purchaseId: PURCHASE_ID, receiptPollMs: 1 })).rejects.toThrow(
      `ERC-8183 job expired for purchase ${PURCHASE_ID}`,
    )
    const walletCalls = mock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/v1/instances/${INSTANCE_ID}/wallet/execute`),
    )
    expect(walletCalls).toHaveLength(0)
  })

  it('surfaces on-chain job read failures before completing', async () => {
    process.env.EVM_RPC_56 = 'https://rpc.test'
    const mock = mockFetchSequence([
      ok(purchase('submitted')),
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'upstream RPC unavailable' },
      },
    ])
    Object.defineProperty(globalThis, 'fetch', {
      value: mock,
      configurable: true,
      writable: true,
    })

    await expect(acceptPieverseCard({ purchaseId: PURCHASE_ID, receiptPollMs: 1 })).rejects.toThrow(
      'EVM RPC eth_call error -32000: upstream RPC unavailable',
    )
    const walletCalls = mock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/v1/instances/${INSTANCE_ID}/wallet/execute`),
    )
    expect(walletCalls).toHaveLength(0)
  })
})
