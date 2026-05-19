import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi } from 'viem'
import {
  acceptPieverseCard,
  createPieverseCardJob,
  fundPieverseCard,
  getPieverseCardDeliverable,
  purchasePieverseCard,
  refundPieverseCard,
} from '../packages/plugins/pieverse-card/src/card.ts'

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
const JOB_ID = '42'

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

const ERC8183_ABI = parseAbi([
  'function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
  'event JobRegistered(uint256 indexed jobId,address indexed policy,address indexed client)',
])

type PurchaseStatus =
  | 'initiated'
  | 'created'
  | 'funded'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'rejected'
type JsonRecord = Record<string, unknown>
type StartedServer = { url: string; close: () => Promise<void> }

interface BackendState {
  status: PurchaseStatus
  jobStatus: number
  jobExpiredAt: bigint
  progressCalls: string[]
  walletCalls: Array<{ labels: string[] }>
}

const originalEnv = {
  WALLET_API_URL: process.env.WALLET_API_URL,
  WALLET_API_TOKEN: process.env.WALLET_API_TOKEN,
  INSTANCE_ID: process.env.INSTANCE_ID,
  EVM_RPC_56: process.env.EVM_RPC_56,
}

async function main() {
  try {
    await runHappyPathScenario()
    await runRejectedRefundScenario()
    await runExpiredRefundScenario()
    console.log('[pieverse-card-local-e2e] PASS')
  } finally {
    restoreEnv()
  }
}

async function runHappyPathScenario() {
  await runLocalScenario('happy-path', createBackendState(), async (state) => {
    const started = await purchasePieverseCard()
    assert.equal(started.status, 'initiated')

    const created = await createPieverseCardJob({
      purchaseId: started.purchaseId,
      receiptPollMs: 10,
      receiptTimeoutMs: 2_000,
    })
    assert.equal(created.status, 'created')
    assert.equal(created.erc8183?.onChainJobId, JOB_ID)

    const funded = await fundPieverseCard({
      purchaseId: started.purchaseId,
      receiptPollMs: 10,
      receiptTimeoutMs: 2_000,
    })
    assert.equal(funded.status, 'submitted')

    const delivered = await getPieverseCardDeliverable({
      purchaseId: started.purchaseId,
      wait: true,
      submittedPollMs: 10,
      submittedTimeoutMs: 2_000,
    })
    assert.equal(delivered.status, 'submitted')
    assert.equal(delivered.imageUrl, 'https://local.purr.test/cards/card.png')

    const completed = await acceptPieverseCard({
      purchaseId: started.purchaseId,
      receiptPollMs: 10,
      receiptTimeoutMs: 2_000,
    })
    assert.equal(completed.status, 'completed')

    assert.deepEqual(state.progressCalls, ['created', 'funded', 'completed'])
    assert.deepEqual(
      state.walletCalls.map((call) => call.labels),
      [
        ['ERC-8183 createJob'],
        ['ERC-8183 registerJob'],
        ['ERC-8183 setBudget', 'ERC-8183 approve payment token', 'ERC-8183 fund'],
        ['ERC-8183 settle'],
      ],
    )
    console.log('[pieverse-card-local-e2e] happy-path PASS')
  })
}

async function runRejectedRefundScenario() {
  await runLocalScenario(
    'rejected-refund',
    createBackendState({ status: 'rejected', jobStatus: JOB_STATUS.REJECTED }),
    async (state) => {
      const result = await refundPieverseCard({
        purchaseId: PURCHASE_ID,
        receiptPollMs: 10,
        receiptTimeoutMs: 2_000,
      })
      assert.equal(result.refundTxHash, HASHES.refund)
      assert.deepEqual(state.progressCalls, ['rejected'])
      assert.deepEqual(
        state.walletCalls.map((call) => call.labels),
        [['ERC-8183 claimRefund']],
      )
      console.log('[pieverse-card-local-e2e] rejected-refund PASS')
    },
  )
}

async function runExpiredRefundScenario() {
  await runLocalScenario(
    'expired-refund',
    createBackendState({ status: 'funded', jobStatus: JOB_STATUS.FUNDED, jobExpiredAt: 1n }),
    async (state) => {
      const result = await refundPieverseCard({
        purchaseId: PURCHASE_ID,
        receiptPollMs: 10,
        receiptTimeoutMs: 2_000,
      })
      assert.equal(result.refundTxHash, HASHES.refund)
      assert.deepEqual(state.progressCalls, ['failed'])
      assert.deepEqual(
        state.walletCalls.map((call) => call.labels),
        [['ERC-8183 claimRefund']],
      )
      console.log('[pieverse-card-local-e2e] expired-refund PASS')
    },
  )
}

async function runLocalScenario(
  name: string,
  state: BackendState,
  test: (state: BackendState) => Promise<void>,
) {
  const rpc = await startJsonServer((req, res, body) => handleRpc(req, res, body, state))
  const api = await startJsonServer((req, res, body) => handleApi(req, res, body, state))

  process.env.WALLET_API_URL = api.url
  process.env.WALLET_API_TOKEN = 'local-e2e-instance-token'
  process.env.INSTANCE_ID = INSTANCE_ID
  process.env.EVM_RPC_56 = rpc.url

  try {
    await test(state)
  } finally {
    await Promise.all([api.close(), rpc.close()])
    console.log(`[pieverse-card-local-e2e] ${name} closed`)
  }
}

function createBackendState(overrides: Partial<BackendState> = {}): BackendState {
  return {
    status: 'initiated',
    jobStatus: JOB_STATUS.SUBMITTED,
    jobExpiredAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    progressCalls: [],
    walletCalls: [],
    ...overrides,
  }
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  state: BackendState,
) {
  assert.equal(req.headers.authorization, 'Bearer local-e2e-instance-token')
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://local-api')
  const basePath = `/v1/instances/${INSTANCE_ID}/erc8183/services/agent-self-intro/card`

  if (method === 'POST' && url.pathname === `${basePath}/purchase`) {
    sendJson(res, 200, { ok: true, data: purchase(state.status) })
    return
  }

  if (method === 'GET' && url.pathname === `${basePath}/purchases/${PURCHASE_ID}`) {
    sendJson(res, 200, { ok: true, data: purchase(state.status) })
    return
  }

  if (method === 'POST' && url.pathname === `${basePath}/purchases/${PURCHASE_ID}/progress`) {
    const progress = body as JsonRecord
    const next = progress.status as PurchaseStatus
    state.progressCalls.push(next)

    if (next === 'created') {
      assert.equal(progress.onChainJobId, JOB_ID)
      assert.equal(progress.createTxHash, HASHES.create)
      state.status = 'created'
      state.jobStatus = JOB_STATUS.CREATED
      sendJson(res, 200, { ok: true, data: purchase('created') })
      return
    }

    if (next === 'funded') {
      assert.equal(progress.setBudgetTxHash, HASHES.setBudget)
      assert.equal(progress.approveTxHash, HASHES.approve)
      assert.equal(progress.fundTxHash, HASHES.fund)
      state.status = 'submitted'
      state.jobStatus = JOB_STATUS.SUBMITTED
      sendJson(res, 200, { ok: true, data: purchase('submitted') })
      return
    }

    if (next === 'completed') {
      assert.equal(progress.completeTxHash, HASHES.complete)
      state.status = 'completed'
      state.jobStatus = JOB_STATUS.COMPLETED
      sendJson(res, 200, { ok: true, data: purchase('completed') })
      return
    }

    if (next === 'rejected') {
      assert.equal(progress.rejectTxHash, HASHES.reject)
      sendJson(res, 200, { ok: true, data: purchase('rejected') })
      return
    }

    if (next === 'failed') {
      state.status = 'failed'
      sendJson(res, 200, { ok: true, data: purchase('failed') })
      return
    }

    sendJson(res, 400, { ok: false, error: `unexpected progress status: ${String(next)}` })
    return
  }

  if (method === 'POST' && url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/execute`) {
    const request = body as { steps?: Array<JsonRecord> }
    const steps = request.steps ?? []
    const labels = steps.map((step) => String(step.label))
    state.walletCalls.push({ labels })

    sendJson(res, 200, {
      ok: true,
      data: {
        results: steps.map((step, stepIndex) => ({
          stepIndex,
          label: step.label,
          hash: hashForLabel(String(step.label)),
          status: 'success',
        })),
        from: CLIENT,
        chainId: 56,
        chainType: 'ethereum',
      },
    })
    return
  }

  sendJson(res, 404, { ok: false, error: `${method} ${url.pathname} not found` })
}

async function handleRpc(
  _req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  state: BackendState,
) {
  const payload = body as { id?: number; method?: string; params?: unknown[] }
  const id = payload.id ?? 1

  if (payload.method === 'eth_getTransactionReceipt') {
    const hash = String(payload.params?.[0])
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: receiptForHash(hash),
    })
    return
  }

  if (payload.method === 'eth_call') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: encodeFunctionResult({
        abi: ERC8183_ABI,
        functionName: 'getJob',
        result: {
          id: BigInt(JOB_ID),
          client: CLIENT,
          provider: PROVIDER,
          evaluator: CLIENT,
          description: 'https://local.purr.test/cards/card/metadata.json',
          budget: 1000000n,
          expiredAt: state.jobExpiredAt,
          status: state.jobStatus,
          hook: ZERO,
        },
      }),
    })
    return
  }

  sendJson(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${String(payload.method)}` },
  })
}

function receiptForHash(hash: string) {
  if (hash === HASHES.create) {
    const topics = encodeEventTopics({
      abi: ERC8183_ABI,
      eventName: 'JobCreated',
      args: {
        jobId: BigInt(JOB_ID),
        client: CLIENT,
        provider: PROVIDER,
      },
    })
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }],
      [ROUTER, BigInt(Math.floor(Date.now() / 1000) + 86400), ROUTER],
    )
    return baseReceipt(hash, [
      {
        address: CONTRACT,
        topics,
        data,
        blockNumber: '0x1',
        transactionHash: hash,
        transactionIndex: '0x0',
        blockHash: `0x${'99'.repeat(32)}`,
        logIndex: '0x0',
        removed: false,
      },
    ])
  }

  if (hash === HASHES.register) {
    const topics = encodeEventTopics({
      abi: ERC8183_ABI,
      eventName: 'JobRegistered',
      args: {
        jobId: BigInt(JOB_ID),
        policy: POLICY,
        client: CLIENT,
      },
    })
    return baseReceipt(
      hash,
      [
        {
          address: ROUTER,
          topics,
          data: '0x',
          blockNumber: '0x1',
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: `0x${'98'.repeat(32)}`,
          logIndex: '0x0',
          removed: false,
        },
      ],
      ROUTER,
    )
  }

  if (hash === HASHES.fund || hash === HASHES.refund) {
    return baseReceipt(hash)
  }
  if (hash === HASHES.complete) return baseReceipt(hash, [], ROUTER)
  throw new Error(`unexpected receipt hash: ${hash}`)
}

function baseReceipt(hash: string, logs: unknown[] = [], to = CONTRACT) {
  return {
    status: '0x1',
    to,
    transactionHash: hash,
    blockNumber: '0x1',
    logs,
  }
}

function purchase(status: PurchaseStatus) {
  const hasCreate = status !== 'initiated'
  const hasFunding = hasCreate && status !== 'created'
  const hasProviderResult =
    status === 'submitted' || status === 'completed' || status === 'rejected'
  return {
    serviceSlug: 'agent-self-intro',
    serviceId: 'pieverse-card-generation-v1',
    purchaseId: PURCHASE_ID,
    instanceId: INSTANCE_ID,
    pieName: 'local-test.pie',
    status,
    cardId: CARD_ID,
    templateId: 'cat-card-001',
    imageUrl: 'https://local.purr.test/cards/card.png',
    shareUrl: 'https://local.purr.test/cards/card',
    suggestedTweetText:
      'Pie name: local-test.pie\n@pieverse @purrfectagent0\nhttps://local.purr.test/cards/card',
    completedAt: status === 'completed' ? new Date().toISOString() : null,
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
      jobUri: 'https://local.purr.test/cards/card/metadata.json',
      deliverableUri: hasProviderResult ? 'https://local.purr.test/cards/card/metadata.json' : null,
      jobExpirationSeconds: 86400,
      onChainJobId: hasCreate ? JOB_ID : null,
      status,
      txHashes: {
        create: hasCreate ? HASHES.create : null,
        setBudget: hasFunding ? HASHES.setBudget : null,
        approve: hasFunding ? HASHES.approve : null,
        fund: hasFunding ? HASHES.fund : null,
        submit: hasProviderResult ? HASHES.submit : null,
        complete: status === 'completed' ? HASHES.complete : null,
        reject: status === 'rejected' ? HASHES.reject : null,
      },
    },
  }
}

function hashForLabel(label: string): string {
  if (label === 'ERC-8183 createJob') return HASHES.create
  if (label === 'ERC-8183 registerJob') return HASHES.register
  if (label === 'ERC-8183 setBudget') return HASHES.setBudget
  if (label === 'ERC-8183 approve payment token') return HASHES.approve
  if (label === 'ERC-8183 fund') return HASHES.fund
  if (label === 'ERC-8183 settle') return HASHES.complete
  if (label === 'ERC-8183 claimRefund') return HASHES.refund
  throw new Error(`unexpected label: ${label}`)
}

async function startJsonServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void,
): Promise<StartedServer> {
  const server = createServer(async (req, res) => {
    try {
      const bodyText = await readBody(req)
      const body = bodyText ? JSON.parse(bodyText) : undefined
      await handler(req, res, body)
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'local e2e server handler failed',
      })
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function restoreEnv() {
  setEnv('WALLET_API_URL', originalEnv.WALLET_API_URL)
  setEnv('WALLET_API_TOKEN', originalEnv.WALLET_API_TOKEN)
  setEnv('INSTANCE_ID', originalEnv.INSTANCE_ID)
  setEnv('EVM_RPC_56', originalEnv.EVM_RPC_56)
}

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

main().catch((error) => {
  restoreEnv()
  console.error('[pieverse-card-local-e2e] FAIL')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
