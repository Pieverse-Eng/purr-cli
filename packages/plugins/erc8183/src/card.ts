import {
  decodeFunctionResult,
  type Hex,
  type RpcLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  parseEventLogs,
} from 'viem'
import { apiGet, apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { isNative } from '@pieverseio/purr-core/shared'
import type { TxStep } from '@pieverseio/purr-core/types'

const SERVICE_SLUG = 'agent-self-intro'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const EMPTY_BYTES = '0x'
const BNB_CHAIN_ID = 56
const RECEIPT_POLL_MS = 2_000
const RECEIPT_TIMEOUT_MS = 120_000
const SUBMITTED_POLL_MS = 2_000
const SUBMITTED_TIMEOUT_MS = 120_000

const DEFAULT_RPCS: Record<number, string> = {
  56: 'https://bsc-rpc.publicnode.com',
}

const ERC8183_ABI = parseAbi([
  'function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)',
  'function setBudget(uint256 jobId,uint256 amount,bytes optParams)',
  'function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)',
  'function claimRefund(uint256 jobId)',
  'function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])

const ERC8183_ROUTER_ABI = parseAbi([
  'function registerJob(uint256 jobId,address policy)',
  'function settle(uint256 jobId,bytes evidence)',
  'event JobRegistered(uint256 indexed jobId,address indexed policy,address indexed client)',
  'event JobSettled(uint256 indexed jobId,address indexed policy,uint8 indexed verdict,bytes32 reason)',
])

const ERC20_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])

const ERC8183_JOB_STATUS = {
  NONE: 0,
  CREATED: 1,
  FUNDED: 2,
  SUBMITTED: 3,
  COMPLETED: 4,
  REJECTED: 5,
  REFUNDED: 6,
} as const

type PurchaseStatus =
  | 'initiated'
  | 'created'
  | 'funded'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'rejected'

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

interface WalletExecuteResult {
  results: Array<{
    stepIndex: number
    label?: string
    hash: string
    status: 'success' | 'skipped'
  }>
  from: string
  chainId: number
  chainType: string
}

export interface AgentSelfIntroPurchase {
  serviceSlug: string
  serviceId: string
  purchaseId: string
  instanceId: string
  pieName: string
  status: PurchaseStatus
  cardId: string | null
  templateId: string | null
  imageUrl: string | null
  shareUrl: string | null
  suggestedTweetText: string | null
  completedAt?: string | null
  idempotent?: boolean
  erc8183: {
    chainId: number
    commerceAddress: string
    routerAddress: string
    policyAddress: string
    clientWalletAddress: string
    providerWalletAddress: string
    evaluatorWalletAddress: string
    hookAddress: string
    paymentTokenAddress: string | null
    paymentTokenSymbol: string | null
    budgetAmount: string | null
    jobUri: string
    deliverableUri: string | null
    jobExpirationSeconds: number
    onChainJobId: string | null
    status: string
    txHashes: {
      create: string | null
      setBudget: string | null
      approve: string | null
      fund: string | null
      submit: string | null
      complete: string | null
      reject: string | null
    }
  } | null
}

export interface Erc8183CardOptions {
  purchaseId?: string
  receiptTimeoutMs?: number
  receiptPollMs?: number
  submittedTimeoutMs?: number
  submittedPollMs?: number
  wait?: boolean
  createTxHash?: string
  registerTxHash?: string
  setBudgetTxHash?: string
  approveTxHash?: string | null
  fundTxHash?: string
  completeTxHash?: string
}

export type Erc8183CardResult = AgentSelfIntroPurchase & {
  refundTxHash?: string
}

interface RpcReceipt {
  status: '0x0' | '0x1'
  to?: string
  transactionHash: string
  blockNumber: string
  logs: RpcLog[]
}

interface RpcResponse<T> {
  jsonrpc: string
  id: number
  result?: T
  error?: { code: number; message: string }
}

interface OnChainJob {
  id: bigint
  expiredAt: bigint
  status: number
}

let rpcReqId = 1

export async function erc8183Card(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (args['rpc-url']) {
    throw new Error(
      'purr pieverse card commands do not accept --rpc-url. Set EVM_RPC_56 or EVM_RPC_URL if an RPC override is needed.',
    )
  }
  const options = parseCardOptions(args)
  let result: Erc8183CardResult

  switch (command) {
    case 'purchase':
      result = await purchaseErc8183Card()
      break
    case 'create-job':
      result = await createErc8183CardJob(options)
      break
    case 'fund':
      result = await fundErc8183Card(options)
      break
    case 'deliverable':
      result = await getErc8183CardDeliverable(options)
      break
    case 'accept':
      result = await acceptErc8183Card(options)
      break
    case 'refund':
      result = await refundErc8183Card(options)
      break
    case 'status':
      result = await getErc8183CardStatus(options)
      break
    default:
      throw new Error(
        'Unknown pieverse card command. Use: purchase, create-job, fund, deliverable, accept, refund, status',
      )
  }

  console.log(JSON.stringify(result, null, 2))
}

export async function purchaseErc8183Card(): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  return purchaseCard(instanceId)
}

export async function getErc8183CardStatus(
  options: Erc8183CardOptions,
): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  return getPurchase(instanceId, requirePurchaseId(options))
}

export async function createErc8183CardJob(
  options: Erc8183CardOptions,
): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  assertNotTerminal(purchase)

  if (purchase.status !== 'initiated') {
    return purchase
  }

  return createJob(instanceId, purchase, options)
}

export async function fundErc8183Card(options: Erc8183CardOptions): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  assertNotTerminal(purchase)

  if (purchase.status === 'initiated') {
    throw new Error(`Purchase ${purchase.purchaseId} must be created before funding`)
  }
  if (purchase.status !== 'created') {
    return purchase
  }

  return fundJob(instanceId, purchase, options)
}

export async function getErc8183CardDeliverable(
  options: Erc8183CardOptions,
): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  assertNotTerminal(purchase)

  if (purchase.status === 'submitted' || purchase.status === 'completed' || !options.wait) {
    return purchase
  }

  return waitForSubmitted(instanceId, purchase, options)
}

export async function acceptErc8183Card(options: Erc8183CardOptions): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  assertNotTerminal(purchase)

  if (purchase.status === 'completed') return purchase
  if (purchase.status !== 'submitted') {
    throw new Error(`Purchase ${purchase.purchaseId} must be submitted before accept`)
  }

  return completeJob(instanceId, purchase, options)
}

export async function refundErc8183Card(options: Erc8183CardOptions): Promise<Erc8183CardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  const refundTxHash = await claimRefundIfEligible(instanceId, purchase, options)
  if (!refundTxHash) {
    throw new Error(`Purchase ${purchase.purchaseId} is not refundable yet`)
  }

  if (purchase.status === 'rejected') {
    const rejectTxHash = purchase.erc8183?.txHashes.reject
    if (!rejectTxHash) {
      return { ...purchase, refundTxHash }
    }
    const updated = await recordProgress(instanceId, purchase.purchaseId, {
      status: 'rejected',
      rejectTxHash,
      errorMessage: `ERC-8183 refund claimed: ${refundTxHash}`,
    })
    return { ...updated, refundTxHash }
  }

  const updated = await recordProgress(instanceId, purchase.purchaseId, {
    status: 'failed',
    errorMessage: `ERC-8183 refund claimed: ${refundTxHash}`,
  })
  return { ...updated, refundTxHash }
}

function basePath(instanceId: string): string {
  return `/v1/instances/${instanceId}/erc8183/services/${SERVICE_SLUG}/card`
}

async function purchaseCard(instanceId: string): Promise<AgentSelfIntroPurchase> {
  const res = await apiPost<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${basePath(instanceId)}/purchase`,
    {},
  )
  return unwrap(res)
}

async function getPurchase(
  instanceId: string,
  purchaseId: string,
): Promise<AgentSelfIntroPurchase> {
  const res = await apiGet<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${basePath(instanceId)}/purchases/${purchaseId}`,
  )
  return unwrap(res)
}

async function recordProgress(
  instanceId: string,
  purchaseId: string,
  body: Record<string, unknown>,
): Promise<AgentSelfIntroPurchase> {
  const res = await apiPost<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${basePath(instanceId)}/purchases/${purchaseId}/progress`,
    body,
  )
  return unwrap(res)
}

async function executeSteps(instanceId: string, steps: TxStep[]): Promise<WalletExecuteResult> {
  const res = await apiPost<ApiEnvelope<WalletExecuteResult>>(
    `/v1/instances/${instanceId}/wallet/execute`,
    { steps },
  )
  return unwrap(res)
}

async function createJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183CardOptions,
): Promise<AgentSelfIntroPurchase> {
  const intent = requireIntent(purchase)
  const createTxHash = options.createTxHash ?? intent.txHashes.create ?? null
  let createdJobId: string
  let resolvedCreateTxHash: string

  if (createTxHash) {
    const receipt = await waitForReceipt(intent.chainId, createTxHash, options)
    createdJobId = parseCreatedJobId(receipt, purchase)
    resolvedCreateTxHash = createTxHash
  } else {
    const expiredAt = Math.floor(Date.now() / 1000) + intent.jobExpirationSeconds
    const step: TxStep = {
      to: requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
      data: encodeFunctionData({
        abi: ERC8183_ABI,
        functionName: 'createJob',
        args: [
          requireAddress(intent.providerWalletAddress, 'erc8183.providerWalletAddress'),
          requireAddress(intent.evaluatorWalletAddress, 'erc8183.evaluatorWalletAddress'),
          BigInt(expiredAt),
          intent.jobUri,
          requireAddress(intent.hookAddress || ZERO_ADDRESS, 'erc8183.hookAddress'),
        ],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: 'ERC-8183 createJob',
    }
    const executed = await executeSteps(instanceId, [step])
    resolvedCreateTxHash = requiredStepHash(executed, 'ERC-8183 createJob')
    const receipt = await waitForReceipt(intent.chainId, resolvedCreateTxHash, options)
    createdJobId = parseCreatedJobId(receipt, purchase)
  }

  const registerTxHash = options.registerTxHash ?? null
  if (registerTxHash) {
    const receipt = await waitForReceipt(intent.chainId, registerTxHash, options)
    assertRegisteredJob(receipt, purchase, createdJobId)
  } else {
    const registerStep: TxStep = {
      to: requireAddress(intent.routerAddress, 'erc8183.routerAddress'),
      data: encodeFunctionData({
        abi: ERC8183_ROUTER_ABI,
        functionName: 'registerJob',
        args: [BigInt(createdJobId), requireAddress(intent.policyAddress, 'erc8183.policyAddress')],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: 'ERC-8183 registerJob',
    }
    const executed = await executeSteps(instanceId, [registerStep])
    const executedRegisterTxHash = requiredStepHash(executed, 'ERC-8183 registerJob')
    const receipt = await waitForReceipt(intent.chainId, executedRegisterTxHash, options)
    assertRegisteredJob(receipt, purchase, createdJobId)
  }

  return recordProgress(instanceId, purchase.purchaseId, {
    status: 'created',
    onChainJobId: createdJobId,
    createTxHash: resolvedCreateTxHash,
  })
}

async function fundJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183CardOptions,
): Promise<AgentSelfIntroPurchase> {
  const intent = requireIntent(purchase)
  const jobId = requireOnChainJobId(purchase)
  const budgetAmount = requireBudgetAmount(intent)
  const existingFundTxHash = options.fundTxHash ?? intent.txHashes.fund ?? null

  if (existingFundTxHash) {
    const setBudgetTxHash = options.setBudgetTxHash ?? intent.txHashes.setBudget
    if (!setBudgetTxHash) {
      throw new Error(
        `fund tx ${existingFundTxHash} is missing setBudget tx hash for purchase ${purchase.purchaseId}`,
      )
    }
    await waitForReceipt(intent.chainId, existingFundTxHash, options)
    return recordProgress(instanceId, purchase.purchaseId, {
      status: 'funded',
      setBudgetTxHash,
      approveTxHash: options.approveTxHash ?? intent.txHashes.approve ?? null,
      fundTxHash: existingFundTxHash,
    })
  }

  const steps: TxStep[] = [
    {
      to: requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
      data: encodeFunctionData({
        abi: ERC8183_ABI,
        functionName: 'setBudget',
        args: [BigInt(jobId), budgetAmount, EMPTY_BYTES],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: 'ERC-8183 setBudget',
    },
  ]

  if (intent.paymentTokenAddress && !isNative(intent.paymentTokenAddress) && budgetAmount > 0n) {
    const token = requireAddress(intent.paymentTokenAddress, 'erc8183.paymentTokenAddress')
    steps.push({
      to: token,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'), budgetAmount],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: 'ERC-8183 approve payment token',
      conditional: {
        type: 'allowance_lt',
        token,
        spender: requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
        amount: budgetAmount.toString(),
      },
    })
  }

  steps.push({
    to: requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'fund',
      args: [BigInt(jobId), budgetAmount, EMPTY_BYTES],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: 'ERC-8183 fund',
  })

  const executed = await executeSteps(instanceId, steps)
  const setBudgetTxHash = requiredStepHash(executed, 'ERC-8183 setBudget')
  const approveTxHash = optionalStepHash(executed, 'ERC-8183 approve payment token')
  const fundTxHash = requiredStepHash(executed, 'ERC-8183 fund')
  await waitForReceipt(intent.chainId, fundTxHash, options)

  return recordProgress(instanceId, purchase.purchaseId, {
    status: 'funded',
    setBudgetTxHash,
    approveTxHash,
    fundTxHash,
  })
}

async function waitForSubmitted(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183CardOptions,
): Promise<AgentSelfIntroPurchase> {
  const timeoutMs = options.submittedTimeoutMs ?? SUBMITTED_TIMEOUT_MS
  const pollMs = options.submittedPollMs ?? SUBMITTED_POLL_MS
  const deadline = Date.now() + timeoutMs
  let current = purchase

  while (Date.now() <= deadline) {
    current = await getPurchase(instanceId, purchase.purchaseId)
    assertNotTerminal(current)
    if (current.status === 'submitted' || current.status === 'completed') return current
    await sleep(pollMs)
  }

  throw new Error(
    `Timed out waiting for ERC-8183 provider submit for purchase ${purchase.purchaseId}; last status=${current.status}`,
  )
}

async function completeJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183CardOptions,
): Promise<AgentSelfIntroPurchase> {
  const intent = requireIntent(purchase)
  const jobId = requireOnChainJobId(purchase)
  const completeTxHash = options.completeTxHash ?? intent.txHashes.complete ?? null

  if (completeTxHash) {
    await waitForReceipt(intent.chainId, completeTxHash, options)
    return recordProgress(instanceId, purchase.purchaseId, {
      status: 'completed',
      completeTxHash,
    })
  }

  await assertAcceptableOnChainJob(intent, jobId, purchase.purchaseId)

  const completeStep: TxStep = {
    to: requireAddress(intent.routerAddress, 'erc8183.routerAddress'),
    data: encodeFunctionData({
      abi: ERC8183_ROUTER_ABI,
      functionName: 'settle',
      args: [BigInt(jobId), EMPTY_BYTES],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: 'ERC-8183 settle',
  }
  const executed = await executeSteps(instanceId, [completeStep])
  const executedCompleteTxHash = requiredStepHash(executed, 'ERC-8183 settle')
  await waitForReceipt(intent.chainId, executedCompleteTxHash, options)

  return recordProgress(instanceId, purchase.purchaseId, {
    status: 'completed',
    completeTxHash: executedCompleteTxHash,
  })
}

async function claimRefundIfEligible(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183CardOptions,
): Promise<string | null> {
  const intent = requireIntent(purchase)
  const jobId = purchase.erc8183?.onChainJobId
  if (!jobId) return null
  if (!isRefundCandidatePurchase(purchase)) return null

  const job = await readOnChainJob(intent, jobId)
  if (!job || !shouldClaimRefundForJob(job)) return null

  const refundStep: TxStep = {
    to: requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'claimRefund',
      args: [BigInt(jobId)],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: 'ERC-8183 claimRefund',
  }
  const executed = await executeSteps(instanceId, [refundStep])
  const refundTxHash = requiredStepHash(executed, 'ERC-8183 claimRefund')
  await waitForReceipt(intent.chainId, refundTxHash, options)
  return refundTxHash
}

function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'API request failed')
  }
  return envelope.data
}

function requireIntent(
  purchase: AgentSelfIntroPurchase,
): NonNullable<AgentSelfIntroPurchase['erc8183']> {
  if (!purchase.erc8183) {
    throw new Error(`Purchase ${purchase.purchaseId} did not include an ERC-8183 intent`)
  }
  return purchase.erc8183
}

function requireBudgetAmount(intent: NonNullable<AgentSelfIntroPurchase['erc8183']>): bigint {
  if (intent.budgetAmount === null || intent.budgetAmount === '') {
    throw new Error('ERC-8183 budgetAmount is missing')
  }
  const amount = BigInt(intent.budgetAmount)
  if (amount < 0n) throw new Error('ERC-8183 budgetAmount must be non-negative')
  return amount
}

function requireOnChainJobId(purchase: AgentSelfIntroPurchase): string {
  const jobId = purchase.erc8183?.onChainJobId
  if (!jobId) {
    throw new Error(`Purchase ${purchase.purchaseId} is missing erc8183.onChainJobId`)
  }
  return jobId
}

function requiredStepHash(result: WalletExecuteResult, label: string): string {
  const step = result.results.find((candidate) => candidate.label === label)
  if (!step || step.status !== 'success' || !step.hash) {
    throw new Error(`Wallet execute did not return a tx hash for ${label}`)
  }
  return step.hash
}

function optionalStepHash(result: WalletExecuteResult, label: string): string | null {
  const step = result.results.find((candidate) => candidate.label === label)
  if (!step || step.status === 'skipped' || !step.hash) return null
  return step.hash
}

function requireAddress(value: string, field: string): `0x${string}` {
  if (!isAddress(value)) throw new Error(`${field} must be an EVM address`)
  return getAddress(value) as `0x${string}`
}

async function readOnChainJob(
  intent: NonNullable<AgentSelfIntroPurchase['erc8183']>,
  jobId: string,
): Promise<OnChainJob> {
  const data = encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  })
  const raw = await evmRpc<Hex>(resolveRpcUrl(intent.chainId), 'eth_call', [
    {
      to: requireAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
      data,
    },
    'latest',
  ])
  const decoded = decodeFunctionResult({
    abi: ERC8183_ABI,
    functionName: 'getJob',
    data: raw,
  }) as unknown
  const job = normalizeOnChainJob(decoded)
  if (!job) {
    throw new Error(`ERC-8183 getJob returned an invalid job for jobId ${jobId}`)
  }
  return job
}

function normalizeOnChainJob(decoded: unknown): OnChainJob | null {
  const job = Array.isArray(decoded) ? decoded[0] : decoded
  if (!job || typeof job !== 'object') return null
  const record = job as Record<string, unknown>
  const tuple = job as ArrayLike<unknown>
  const id = (record.id ?? tuple[0]) as unknown
  const expiredAt = (record.expiredAt ?? tuple[6]) as unknown
  const status = (record.status ?? tuple[7]) as unknown
  if (typeof id !== 'bigint' || typeof expiredAt !== 'bigint') return null
  return { id, expiredAt, status: Number(status) }
}

function isRefundCandidatePurchase(purchase: AgentSelfIntroPurchase): boolean {
  if (purchase.status === 'rejected') return true
  if (purchase.status === 'funded' || purchase.status === 'submitted') return true
  return (
    purchase.status === 'failed' &&
    Boolean(purchase.erc8183?.onChainJobId && purchase.erc8183.txHashes.fund)
  )
}

function shouldClaimRefundForJob(job: OnChainJob): boolean {
  if (job.status === ERC8183_JOB_STATUS.REJECTED) return true
  if (job.status !== ERC8183_JOB_STATUS.FUNDED && job.status !== ERC8183_JOB_STATUS.SUBMITTED) {
    return false
  }
  return job.expiredAt <= BigInt(Math.floor(Date.now() / 1000))
}

async function assertAcceptableOnChainJob(
  intent: NonNullable<AgentSelfIntroPurchase['erc8183']>,
  jobId: string,
  purchaseId: string,
): Promise<void> {
  const job = await readOnChainJob(intent, jobId)
  if (job.status !== ERC8183_JOB_STATUS.SUBMITTED) {
    throw new Error(
      `ERC-8183 job is not submitted on-chain for purchase ${purchaseId}; status=${job.status}`,
    )
  }
  if (job.expiredAt <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error(`ERC-8183 job expired for purchase ${purchaseId}`)
  }
}

function parseCreatedJobId(receipt: RpcReceipt, purchase: AgentSelfIntroPurchase): string {
  if (receipt.status !== '0x1') {
    throw new Error(`createJob transaction failed: ${receipt.transactionHash}`)
  }
  const intent = requireIntent(purchase)
  if (receipt.to && getAddress(receipt.to) !== getAddress(intent.commerceAddress)) {
    throw new Error('createJob transaction target does not match the ERC-8183 contract')
  }

  const events = parseEventLogs({ abi: ERC8183_ABI, logs: receipt.logs })
  const created = events.find((event) => event.eventName === 'JobCreated')
  if (!created) throw new Error('JobCreated event not found in createJob receipt')

  const args = created.args as {
    jobId?: bigint
    client?: string
    provider?: string
    evaluator?: string
    hook?: string
  }
  if (typeof args.jobId !== 'bigint') throw new Error('JobCreated event is missing jobId')
  assertSameAddress(args.client, intent.clientWalletAddress, 'JobCreated.client')
  assertSameAddress(args.provider, intent.providerWalletAddress, 'JobCreated.provider')
  assertSameAddress(args.evaluator, intent.evaluatorWalletAddress, 'JobCreated.evaluator')
  assertSameAddress(args.hook, intent.hookAddress || ZERO_ADDRESS, 'JobCreated.hook')
  return args.jobId.toString()
}

function assertRegisteredJob(
  receipt: RpcReceipt,
  purchase: AgentSelfIntroPurchase,
  onChainJobId: string,
): void {
  if (receipt.status !== '0x1') {
    throw new Error(`registerJob transaction failed: ${receipt.transactionHash}`)
  }
  const intent = requireIntent(purchase)
  if (receipt.to && getAddress(receipt.to) !== getAddress(intent.routerAddress)) {
    throw new Error('registerJob transaction target does not match the ERC-8183 router')
  }

  const events = parseEventLogs({ abi: ERC8183_ROUTER_ABI, logs: receipt.logs })
  const registered = events.find((event) => event.eventName === 'JobRegistered')
  if (!registered) throw new Error('JobRegistered event not found in registerJob receipt')

  const args = registered.args as {
    jobId?: bigint
    policy?: string
    client?: string
  }
  if (args.jobId?.toString() !== onChainJobId) {
    throw new Error('JobRegistered.jobId does not match the created job')
  }
  assertSameAddress(args.policy, intent.policyAddress, 'JobRegistered.policy')
  assertSameAddress(args.client, intent.clientWalletAddress, 'JobRegistered.client')
}

function assertSameAddress(actual: string | undefined, expected: string, field: string): void {
  if (!actual || getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${field} does not match the purchase intent`)
  }
}

async function waitForReceipt(
  chainId: number,
  txHash: string,
  options: Erc8183CardOptions,
): Promise<RpcReceipt> {
  const rpcUrl = resolveRpcUrl(chainId)
  const pollMs = options.receiptPollMs ?? RECEIPT_POLL_MS
  const deadline = Date.now() + (options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS)
  let lastError: unknown

  while (Date.now() <= deadline) {
    let receipt: RpcReceipt | null
    try {
      receipt = await evmRpc<RpcReceipt | null>(rpcUrl, 'eth_getTransactionReceipt', [txHash])
    } catch (error) {
      lastError = error
      await sleep(pollMs)
      continue
    }

    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`transaction reverted: ${txHash}`)
      return receipt
    }

    await sleep(pollMs)
  }

  const reason = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for tx receipt ${txHash}${reason}`)
}

export function resolveRpcUrl(chainId: number): string {
  const envOverride =
    process.env[`EVM_RPC_${chainId}`] ||
    (chainId === BNB_CHAIN_ID ? process.env.BNB_RPC_URL : undefined) ||
    process.env.EVM_RPC_URL
  if (envOverride) return envOverride
  const def = DEFAULT_RPCS[chainId]
  if (!def && chainId === BNB_CHAIN_ID) return 'https://bsc-rpc.publicnode.com'
  if (!def) throw new Error(`No RPC URL configured for chainId ${chainId}`)
  return def
}

async function evmRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcReqId++, method, params }),
  })
  if (!res.ok) {
    throw new Error(`EVM RPC ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = (await res.json()) as RpcResponse<T>
  if (json.error) {
    throw new Error(`EVM RPC ${method} error ${json.error.code}: ${json.error.message}`)
  }
  if (json.result === undefined) {
    throw new Error(`EVM RPC ${method} returned no result`)
  }
  return json.result
}

function assertNotTerminal(purchase: AgentSelfIntroPurchase): void {
  if (purchase.status === 'failed' || purchase.status === 'rejected') {
    throw purchaseError(purchase)
  }
  if (purchase.erc8183?.status === 'expired') {
    throw purchaseError(purchase, 'expired')
  }
}

function purchaseError(purchase: AgentSelfIntroPurchase, statusOverride?: string): Error {
  const status = statusOverride ?? purchase.status
  const rejectHash = purchase.erc8183?.txHashes.reject
  const suffix = rejectHash ? ` rejectTxHash=${rejectHash}` : ''
  return new Error(`ERC-8183 card purchase ${status} for purchase ${purchase.purchaseId}${suffix}`)
}

function parseCardOptions(args: Record<string, string>): Erc8183CardOptions {
  return {
    purchaseId: args['purchase-id'],
    receiptTimeoutMs: parseOptionalPositiveInt(args['receipt-timeout-ms'], 'receipt-timeout-ms'),
    receiptPollMs: parseOptionalPositiveInt(args['receipt-poll-ms'], 'receipt-poll-ms'),
    submittedTimeoutMs: parseOptionalPositiveInt(
      args['submitted-timeout-ms'],
      'submitted-timeout-ms',
    ),
    submittedPollMs: parseOptionalPositiveInt(args['submitted-poll-ms'], 'submitted-poll-ms'),
    wait: parseOptionalBoolean(args.wait, 'wait'),
    createTxHash: parseOptionalTxHash(args['create-tx-hash'], 'create-tx-hash'),
    registerTxHash: parseOptionalTxHash(args['register-tx-hash'], 'register-tx-hash'),
    setBudgetTxHash: parseOptionalTxHash(args['set-budget-tx-hash'], 'set-budget-tx-hash'),
    approveTxHash:
      args['approve-tx-hash'] === undefined
        ? undefined
        : parseOptionalTxHash(args['approve-tx-hash'], 'approve-tx-hash'),
    fundTxHash: parseOptionalTxHash(args['fund-tx-hash'], 'fund-tx-hash'),
    completeTxHash: parseOptionalTxHash(args['complete-tx-hash'], 'complete-tx-hash'),
  }
}

function requirePurchaseId(options: Erc8183CardOptions): string {
  if (!options.purchaseId) throw new Error('Missing required argument: --purchase-id')
  return options.purchaseId
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${value}"`)
}

function parseOptionalTxHash(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
