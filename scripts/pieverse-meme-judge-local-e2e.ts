import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi } from 'viem'
import {
  createPieverseMemeJudgeJob,
  fundPieverseMemeJudge,
  getPieverseMemeJudgeInput,
  getPieverseMemeJudgeResult,
  purchasePieverseMemeJudge,
} from '../packages/plugins/pieverse-card/src/purrfect-yap.ts'

const INSTANCE_ID = '4fd09ba9-3654-4f01-bfc7-f28c3a0779f2'
const PURCHASE_ID = '2e0bc8f2-b9f2-4629-88ff-0aee7a564eef'
const JOB_INTENT_ID = '8a1f6e57-d857-4086-80e8-1635f7680f72'
const CONTRACT = '0x1234567890123456789012345678901234567890'
const ROUTER = '0x5555555555555555555555555555555555555555'
const POLICY = '0x6666666666666666666666666666666666666666'
const CLIENT = '0x2222222222222222222222222222222222222222'
const PROVIDER = '0x3333333333333333333333333333333333333333'
const TOKEN = '0x4444444444444444444444444444444444444444'
const JOB_ID = '8183001'

const HASHES = {
  create: `0x${'21'.repeat(32)}`,
  register: `0x${'22'.repeat(32)}`,
  setBudget: `0x${'23'.repeat(32)}`,
  approve: `0x${'24'.repeat(32)}`,
  fund: `0x${'25'.repeat(32)}`,
  submit: `0x${'26'.repeat(32)}`,
  complete: `0x${'27'.repeat(32)}`,
}

const JOB_STATUS = {
  OPEN: 0,
  FUNDED: 1,
  SUBMITTED: 2,
  COMPLETED: 3,
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
  purchaseReads: number
  progressCalls: string[]
  walletCalls: Array<{ labels: string[] }>
}

const originalEnv = {
  WALLET_API_URL: process.env.WALLET_API_URL,
  WALLET_API_TOKEN: process.env.WALLET_API_TOKEN,
  INSTANCE_ID: process.env.INSTANCE_ID,
  EVM_RPC_56: process.env.EVM_RPC_56,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  all_proxy: process.env.all_proxy,
}

async function main() {
  try {
    await runHappyPathScenario()
    console.log('[pieverse-meme-judge-local-e2e] PASS')
  } finally {
    restoreEnv()
  }
}

async function runHappyPathScenario() {
  await runLocalScenario('happy-path', createBackendState(), async (state) => {
    const started = await purchasePieverseMemeJudge()
    assert.equal(started.status, 'initiated')
    assert.equal(started.serviceSlug, 'social-meme-booster-judge')

    const input = (await getPieverseMemeJudgeInput({ purchaseId: started.purchaseId })) as {
      posts?: Array<{ tweetId?: string }>
    }
    assert.deepEqual(
      input.posts?.map((post) => post.tweetId),
      ['2059000000000000000'],
    )

    const created = await createPieverseMemeJudgeJob({
      purchaseId: started.purchaseId,
      receiptPollMs: 10,
      receiptTimeoutMs: 2_000,
    })
    assert.equal(created.status, 'created')
    assert.equal(created.erc8183?.onChainJobId, JOB_ID)

    const funded = await fundPieverseMemeJudge({
      purchaseId: started.purchaseId,
      receiptPollMs: 10,
      receiptTimeoutMs: 2_000,
    })
    assert.equal(funded.status, 'funded')

    const result = await getPieverseMemeJudgeResult({
      purchaseId: started.purchaseId,
      wait: true,
      resultPollMs: 10,
      resultTimeoutMs: 2_000,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.completedAt, '2026-06-08T12:00:00.000Z')

    assert.deepEqual(state.progressCalls, ['created', 'funded'])
    assert.deepEqual(
      state.walletCalls.map((call) => call.labels),
      [
        ['ERC-8183 createJob'],
        ['ERC-8183 registerJob'],
        ['ERC-8183 setBudget', 'ERC-8183 approve payment token', 'ERC-8183 fund'],
      ],
    )
    console.log('[pieverse-meme-judge-local-e2e] happy-path PASS')
  })
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
  clearProxyEnv()

  try {
    await test(state)
  } finally {
    await Promise.all([api.close(), rpc.close()])
    console.log(`[pieverse-meme-judge-local-e2e] ${name} closed`)
  }
}

function createBackendState(): BackendState {
  return {
    status: 'initiated',
    jobStatus: JOB_STATUS.OPEN,
    purchaseReads: 0,
    progressCalls: [],
    walletCalls: [],
  }
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  state: BackendState,
) {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://local-api')
  const basePath = `/v1/instances/${INSTANCE_ID}/erc8183/services/social-meme-booster-judge`

  if (method !== 'GET') {
    assert.equal(req.headers.authorization, 'Bearer local-e2e-instance-token')
  }

  if (method === 'POST' && url.pathname === `${basePath}/purchase`) {
    sendJson(res, 200, { ok: true, data: purchase(state.status) })
    return
  }

  if (method === 'GET' && url.pathname === `${basePath}/purchases/${PURCHASE_ID}`) {
    state.purchaseReads++
    if (state.status === 'funded' && state.purchaseReads >= 4) {
      state.status = 'completed'
      state.jobStatus = JOB_STATUS.COMPLETED
    }
    sendJson(res, 200, { ok: true, data: purchase(state.status) })
    return
  }

  if (
    method === 'GET' &&
    url.pathname === `/v1/erc8183/services/social-meme-booster-judge/purchases/${PURCHASE_ID}/input`
  ) {
    sendJson(res, 200, {
      ok: true,
      data: {
        serviceSlug: 'social-meme-booster-judge',
        serviceId: 'social-meme-booster-judge',
        purchaseId: PURCHASE_ID,
        jobId: JOB_INTENT_ID,
        campaignSlug: 'bnb-survivor-quest',
        campaignDay: '2026-06-08',
        instanceId: INSTANCE_ID,
        pieName: 'local-test.pie',
        posts: [
          {
            postId: 'post-1',
            tweetId: '2059000000000000000',
            tweetUrl: 'https://x.com/local/status/2059000000000000000',
            textPreview: 'Meme booster post',
            tweetCreatedAt: '2026-06-08T11:00:00.000Z',
          },
        ],
        requirements: {
          engagementSnapshot: {
            source: 'x_live_fetch',
            timing: 'after_payment_before_completion',
            staleDiscoveryMetricsAllowed: false,
            requiredMetrics: ['likes', 'reposts', 'replies', 'quotes', 'impressions'],
            endpoint: {
              method: 'POST',
              href: 'https://x-agent.example/api/twitter/engagement-snapshots',
              authorization: 'bearer_token_required',
            },
          },
        },
      },
    })
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
      state.jobStatus = JOB_STATUS.OPEN
      sendJson(res, 200, { ok: true, data: purchase('created') })
      return
    }

    if (next === 'funded') {
      assert.equal(progress.setBudgetTxHash, HASHES.setBudget)
      assert.equal(progress.approveTxHash, HASHES.approve)
      assert.equal(progress.fundTxHash, HASHES.fund)
      state.status = 'funded'
      state.jobStatus = JOB_STATUS.FUNDED
      sendJson(res, 200, { ok: true, data: purchase('funded') })
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
          evaluator: ROUTER,
          description: `https://local.purr.test/judgements/${PURCHASE_ID}/input`,
          budget: 1000000n,
          expiredAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
          status: state.jobStatus,
          hook: ROUTER,
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
        blockHash: `0x${'a1'.repeat(32)}`,
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
          blockHash: `0x${'a2'.repeat(32)}`,
          logIndex: '0x0',
          removed: false,
        },
      ],
      ROUTER,
    )
  }

  if (hash === HASHES.fund) {
    return baseReceipt(hash)
  }
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
  const hasResult = status === 'completed'
  return {
    serviceSlug: 'social-meme-booster-judge',
    serviceId: 'social-meme-booster-judge',
    purchaseId: PURCHASE_ID,
    instanceId: INSTANCE_ID,
    campaignSlug: 'bnb-survivor-quest',
    campaignDay: '2026-06-08',
    pieName: 'local-test.pie',
    status,
    completedAt: hasResult ? '2026-06-08T12:00:00.000Z' : null,
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
      jobUri: `https://local.purr.test/v1/erc8183/services/social-meme-booster-judge/purchases/${PURCHASE_ID}/input`,
      deliverableUri: hasResult ? `https://local.purr.test/judgements/${PURCHASE_ID}` : null,
      jobExpirationSeconds: 86400,
      onChainJobId: hasCreate ? JOB_ID : null,
      status,
      txHashes: {
        create: hasCreate ? HASHES.create : null,
        setBudget: hasFunding ? HASHES.setBudget : null,
        approve: hasFunding ? HASHES.approve : null,
        fund: hasFunding ? HASHES.fund : null,
        submit: hasResult ? HASHES.submit : null,
        complete: hasResult ? HASHES.complete : null,
        reject: null,
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
  setEnv('HTTP_PROXY', originalEnv.HTTP_PROXY)
  setEnv('HTTPS_PROXY', originalEnv.HTTPS_PROXY)
  setEnv('ALL_PROXY', originalEnv.ALL_PROXY)
  setEnv('http_proxy', originalEnv.http_proxy)
  setEnv('https_proxy', originalEnv.https_proxy)
  setEnv('all_proxy', originalEnv.all_proxy)
}

function clearProxyEnv() {
  setEnv('HTTP_PROXY', undefined)
  setEnv('HTTPS_PROXY', undefined)
  setEnv('ALL_PROXY', undefined)
  setEnv('http_proxy', undefined)
  setEnv('https_proxy', undefined)
  setEnv('all_proxy', undefined)
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
  console.error('[pieverse-meme-judge-local-e2e] FAIL')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
