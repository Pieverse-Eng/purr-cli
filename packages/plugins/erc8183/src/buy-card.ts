import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
const RECOVERY_STATE_FILE_ENV = 'PURR_ERC8183_STATE_FILE'
const DEFAULT_RECOVERY_STATE_FILE = join(
  homedir(),
  '.purrfectclaw',
  'erc8183-buy-card-state.json',
)

const DEFAULT_RPCS: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  97: 'https://bsc-testnet-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  1001: 'https://public-en-kairos.node.kaia.io',
  2818: 'https://rpc.morph.network',
  8217: 'https://public-en.node.kaia.io',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  46630: 'https://rpc.testnet.chain.robinhood.com',
}

const ERC8183_ABI = parseAbi([
  'function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)',
  'function setBudget(uint256 jobId,uint256 amount,bytes optParams)',
  'function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)',
  'function complete(uint256 jobId,bytes32 reason,bytes optParams)',
  'function claimRefund(uint256 jobId)',
  'function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])

const ERC20_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])

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

interface AgentSelfIntroPurchase {
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
    contractAddress: string
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

export interface Erc8183BuyCardOptions {
  receiptTimeoutMs?: number
  receiptPollMs?: number
  submittedTimeoutMs?: number
  submittedPollMs?: number
}

export interface Erc8183BuyCardResult {
  purchaseId: string
  status: PurchaseStatus
  imageUrl: string | null
  shareUrl: string | null
  suggestedTweetText: string | null
  xIntentUrl: string | null
  erc8183: AgentSelfIntroPurchase['erc8183']
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

interface RecoveryTxHashes {
  create?: string | null
  setBudget?: string | null
  approve?: string | null
  fund?: string | null
  complete?: string | null
  refund?: string | null
}

interface RecoveryEntry {
  purchaseId: string
  updatedAt: string
  onChainJobId?: string | null
  txHashes: RecoveryTxHashes
}

type RecoveryState = Record<string, RecoveryEntry>

let rpcReqId = 1

export async function erc8183BuyCard(args: Record<string, string>): Promise<void> {
  if (args['rpc-url']) {
    throw new Error(
      'purr erc8183 buy-card does not accept --rpc-url. Set EVM_RPC_56 or EVM_RPC_URL if an RPC override is needed.',
    )
  }
  const result = await buyErc8183Card({
    receiptTimeoutMs: parseOptionalPositiveInt(args['receipt-timeout-ms'], 'receipt-timeout-ms'),
    receiptPollMs: parseOptionalPositiveInt(args['receipt-poll-ms'], 'receipt-poll-ms'),
    submittedTimeoutMs: parseOptionalPositiveInt(
      args['submitted-timeout-ms'],
      'submitted-timeout-ms',
    ),
    submittedPollMs: parseOptionalPositiveInt(args['submitted-poll-ms'], 'submitted-poll-ms'),
  })
  console.log(JSON.stringify(result, null, 2))
}

export async function buyErc8183Card(
  options: Erc8183BuyCardOptions = {},
): Promise<Erc8183BuyCardResult> {
  const { instanceId } = resolveCredentials()
  let purchase = await purchaseCard(instanceId)

  await throwIfTerminal(instanceId, purchase, options)

  if (purchase.status === 'initiated') {
    purchase = await createJob(instanceId, purchase, options)
  }

  await throwIfTerminal(instanceId, purchase, options)

  if (purchase.status === 'created') {
    purchase = await fundJob(instanceId, purchase, options)
  }

  await throwIfTerminal(instanceId, purchase, options)

  if (purchase.status === 'funded') {
    purchase = await waitForSubmitted(instanceId, purchase, options)
  }

  await throwIfTerminal(instanceId, purchase, options)

  if (purchase.status === 'submitted') {
    const refundTxHash = await claimRefundIfNeeded(instanceId, purchase, 'expired', options)
    if (refundTxHash) throw purchaseError(purchase, 'expired', refundTxHash)
    purchase = await completeJob(instanceId, purchase, options)
  }

  await throwIfTerminal(instanceId, purchase, options)

  if (purchase.status !== 'completed') {
    throw new Error(`ERC-8183 buy-card stopped at unsupported status: ${purchase.status}`)
  }

  clearRecoveryEntry(instanceId, purchase.purchaseId)
  return toBuyCardResult(purchase)
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

async function getPurchase(instanceId: string, purchaseId: string): Promise<AgentSelfIntroPurchase> {
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

async function executeSteps(
  instanceId: string,
  steps: TxStep[],
): Promise<WalletExecuteResult> {
  const res = await apiPost<ApiEnvelope<WalletExecuteResult>>(
    `/v1/instances/${instanceId}/wallet/execute`,
    { steps },
  )
  return unwrap(res)
}

async function createJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183BuyCardOptions,
): Promise<AgentSelfIntroPurchase> {
  const intent = requireIntent(purchase)
  const recovery = readRecoveryEntry(instanceId, purchase.purchaseId)
  const existingCreateTxHash = intent.txHashes.create ?? recovery?.txHashes.create
  if (existingCreateTxHash) {
    const receipt = await waitForReceipt(intent.chainId, existingCreateTxHash, options)
    const onChainJobId = parseCreatedJobId(receipt, purchase)
    updateRecoveryEntry(instanceId, purchase.purchaseId, {
      onChainJobId,
      txHashes: { create: existingCreateTxHash },
    })
    return recordProgress(instanceId, purchase.purchaseId, {
      status: 'created',
      onChainJobId,
      createTxHash: existingCreateTxHash,
    })
  }

  const expiredAt = Math.floor(Date.now() / 1000) + intent.jobExpirationSeconds
  const step: TxStep = {
    to: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
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
  const createTxHash = requiredStepHash(executed, 'ERC-8183 createJob')
  updateRecoveryEntry(instanceId, purchase.purchaseId, {
    txHashes: { create: createTxHash },
  })
  const receipt = await waitForReceipt(intent.chainId, createTxHash, options)
  const onChainJobId = parseCreatedJobId(receipt, purchase)
  updateRecoveryEntry(instanceId, purchase.purchaseId, {
    onChainJobId,
    txHashes: { create: createTxHash },
  })

  return recordProgress(instanceId, purchase.purchaseId, {
    status: 'created',
    onChainJobId,
    createTxHash,
  })
}

async function fundJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183BuyCardOptions,
): Promise<AgentSelfIntroPurchase> {
  const intent = requireIntent(purchase)
  const jobId = requireOnChainJobId(purchase)
  const budgetAmount = requireBudgetAmount(intent)
  const recovery = readRecoveryEntry(instanceId, purchase.purchaseId)
  const existingFundTxHash = intent.txHashes.fund ?? recovery?.txHashes.fund
  if (existingFundTxHash) {
    const setBudgetTxHash = intent.txHashes.setBudget ?? recovery?.txHashes.setBudget
    if (!setBudgetTxHash) {
      throw new Error(
        `Recovered fund tx ${existingFundTxHash} is missing setBudget tx hash for purchase ${purchase.purchaseId}`,
      )
    }
    await waitForReceipt(intent.chainId, existingFundTxHash, options)
    return recordProgress(instanceId, purchase.purchaseId, {
      status: 'funded',
      setBudgetTxHash,
      approveTxHash: intent.txHashes.approve ?? recovery?.txHashes.approve ?? null,
      fundTxHash: existingFundTxHash,
    })
  }

  const steps: TxStep[] = [
    {
      to: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
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
        args: [requireAddress(intent.contractAddress, 'erc8183.contractAddress'), budgetAmount],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: 'ERC-8183 approve payment token',
      conditional: {
        type: 'allowance_lt',
        token,
        spender: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
        amount: budgetAmount.toString(),
      },
    })
  }

  steps.push({
    to: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
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
  updateRecoveryEntry(instanceId, purchase.purchaseId, {
    txHashes: { setBudget: setBudgetTxHash, approve: approveTxHash, fund: fundTxHash },
  })
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
  options: Erc8183BuyCardOptions,
): Promise<AgentSelfIntroPurchase> {
  const timeoutMs = options.submittedTimeoutMs ?? SUBMITTED_TIMEOUT_MS
  const pollMs = options.submittedPollMs ?? SUBMITTED_POLL_MS
  const deadline = Date.now() + timeoutMs
  let current = purchase

  while (Date.now() <= deadline) {
    current = await getPurchase(instanceId, purchase.purchaseId)
    if (current.status === 'submitted' || current.status === 'completed') return current
    await throwIfTerminal(instanceId, current, options)
    await sleep(pollMs)
  }

  const refundTxHash = await claimRefundIfNeeded(instanceId, current, 'expired', options)
  if (refundTxHash) throw purchaseError(current, 'expired', refundTxHash)

  throw new Error(
    `Timed out waiting for ERC-8183 provider submit for purchase ${purchase.purchaseId}; last status=${current.status}`,
  )
}

async function completeJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183BuyCardOptions,
): Promise<AgentSelfIntroPurchase> {
  const intent = requireIntent(purchase)
  const jobId = requireOnChainJobId(purchase)
  const recovery = readRecoveryEntry(instanceId, purchase.purchaseId)
  const existingCompleteTxHash = intent.txHashes.complete ?? recovery?.txHashes.complete
  if (existingCompleteTxHash) {
    await waitForReceipt(intent.chainId, existingCompleteTxHash, options)
    return recordProgress(instanceId, purchase.purchaseId, {
      status: 'completed',
      completeTxHash: existingCompleteTxHash,
    })
  }

  const completeStep: TxStep = {
    to: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'complete',
      args: [
        BigInt(jobId),
        hashToBytes32(`accepted:${purchase.purchaseId}:${purchase.cardId ?? ''}`),
        EMPTY_BYTES,
      ],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: 'ERC-8183 complete',
  }
  const executed = await executeSteps(
    instanceId,
    [completeStep],
  )
  const completeTxHash = requiredStepHash(executed, 'ERC-8183 complete')
  updateRecoveryEntry(instanceId, purchase.purchaseId, {
    txHashes: { complete: completeTxHash },
  })
  await waitForReceipt(intent.chainId, completeTxHash, options)

  return recordProgress(instanceId, purchase.purchaseId, {
    status: 'completed',
    completeTxHash,
  })
}

async function claimRefundIfNeeded(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  reason: 'expired' | 'rejected',
  options: Erc8183BuyCardOptions,
): Promise<string | null> {
  if (!isRefundCandidatePurchase(purchase, reason)) return null
  const intent = requireIntent(purchase)
  const jobId = purchase.erc8183?.onChainJobId
  if (!jobId) return null

  const recovery = readRecoveryEntry(instanceId, purchase.purchaseId)
  const existingRefundTxHash = recovery?.txHashes.refund
  if (existingRefundTxHash) {
    await waitForReceipt(intent.chainId, existingRefundTxHash, options)
    return existingRefundTxHash
  }

  const job = await readOnChainJob(intent, jobId)
  if (!job || !shouldClaimRefundForJob(job, reason)) return null

  const refundStep: TxStep = {
    to: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
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
  updateRecoveryEntry(instanceId, purchase.purchaseId, {
    txHashes: { refund: refundTxHash },
  })
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
): Promise<OnChainJob | null> {
  const data = encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  })
  try {
    const raw = await evmRpc<Hex>(resolveRpcUrl(intent.chainId), 'eth_call', [
      {
        to: requireAddress(intent.contractAddress, 'erc8183.contractAddress'),
        data,
      },
      'latest',
    ])
    const decoded = decodeFunctionResult({
      abi: ERC8183_ABI,
      functionName: 'getJob',
      data: raw,
    }) as unknown
    return normalizeOnChainJob(decoded)
  } catch {
    return null
  }
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

function isRefundCandidatePurchase(
  purchase: AgentSelfIntroPurchase,
  reason: 'expired' | 'rejected',
): boolean {
  if (reason === 'rejected') return purchase.status === 'rejected'
  return purchase.status === 'funded' || purchase.status === 'submitted'
}

function shouldClaimRefundForJob(job: OnChainJob, reason: 'expired' | 'rejected'): boolean {
  if (reason === 'rejected') return isRejectedJobStatus(job.status)
  if (!isFundedOrSubmittedJobStatus(job.status)) return false
  return job.expiredAt <= BigInt(Math.floor(Date.now() / 1000))
}

function isFundedOrSubmittedJobStatus(status: number): boolean {
  return status === 1 || status === 2
}

function isRejectedJobStatus(status: number): boolean {
  return status === 4
}

function parseCreatedJobId(receipt: RpcReceipt, purchase: AgentSelfIntroPurchase): string {
  if (receipt.status !== '0x1') {
    throw new Error(`createJob transaction failed: ${receipt.transactionHash}`)
  }
  const intent = requireIntent(purchase)
  if (receipt.to && getAddress(receipt.to) !== getAddress(intent.contractAddress)) {
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

function assertSameAddress(actual: string | undefined, expected: string, field: string): void {
  if (!actual || getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${field} does not match the purchase intent`)
  }
}

async function waitForReceipt(
  chainId: number,
  txHash: string,
  options: Erc8183BuyCardOptions,
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

function hashToBytes32(value: string | Uint8Array): Hex {
  return `0x${createHash('sha256').update(value).digest('hex')}`
}

function toBuyCardResult(purchase: AgentSelfIntroPurchase): Erc8183BuyCardResult {
  const text = purchase.suggestedTweetText
  return {
    purchaseId: purchase.purchaseId,
    status: purchase.status,
    imageUrl: purchase.imageUrl,
    shareUrl: purchase.shareUrl,
    suggestedTweetText: text,
    xIntentUrl: text ? `https://x.com/intent/tweet?text=${encodeURIComponent(text)}` : null,
    erc8183: purchase.erc8183,
  }
}

async function throwIfTerminal(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: Erc8183BuyCardOptions,
): Promise<void> {
  if (purchase.erc8183?.status === 'expired') {
    const refundTxHash = await claimRefundIfNeeded(instanceId, purchase, 'expired', options)
    throw purchaseError(purchase, 'expired', refundTxHash ?? undefined)
  }
  if (purchase.status === 'rejected') {
    const refundTxHash = await claimRefundIfNeeded(instanceId, purchase, 'rejected', options)
    throw purchaseError(purchase, 'rejected', refundTxHash ?? undefined)
  }
  if (purchase.status === 'failed') {
    throw purchaseError(purchase)
  }
}

function purchaseError(
  purchase: AgentSelfIntroPurchase,
  statusOverride?: string,
  refundTxHash?: string,
): Error {
  const status = statusOverride ?? purchase.status
  const rejectHash = purchase.erc8183?.txHashes.reject
  const suffixParts = [
    rejectHash ? `rejectTxHash=${rejectHash}` : '',
    refundTxHash ? `refundTxHash=${refundTxHash}` : '',
  ].filter(Boolean)
  const suffix = suffixParts.length > 0 ? ` ${suffixParts.join(' ')}` : ''
  return new Error(`ERC-8183 buy-card ${status} for purchase ${purchase.purchaseId}${suffix}`)
}

function recoveryStateFile(): string {
  return process.env[RECOVERY_STATE_FILE_ENV] ?? DEFAULT_RECOVERY_STATE_FILE
}

function recoveryKey(instanceId: string, purchaseId: string): string {
  return `${instanceId}:${purchaseId}`
}

function readRecoveryState(): RecoveryState {
  const file = recoveryStateFile()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as RecoveryState
  } catch {
    return {}
  }
}

function writeRecoveryState(state: RecoveryState): void {
  const file = recoveryStateFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
}

function readRecoveryEntry(instanceId: string, purchaseId: string): RecoveryEntry | null {
  return readRecoveryState()[recoveryKey(instanceId, purchaseId)] ?? null
}

function updateRecoveryEntry(
  instanceId: string,
  purchaseId: string,
  patch: {
    onChainJobId?: string | null
    txHashes?: RecoveryTxHashes
  },
): void {
  try {
    const state = readRecoveryState()
    const key = recoveryKey(instanceId, purchaseId)
    const current = state[key]
    state[key] = {
      purchaseId,
      updatedAt: new Date().toISOString(),
      onChainJobId: patch.onChainJobId ?? current?.onChainJobId ?? null,
      txHashes: {
        ...(current?.txHashes ?? {}),
        ...(patch.txHashes ?? {}),
      },
    }
    writeRecoveryState(state)
  } catch {
    // Recovery is best effort; failing to write local state must not block the purchase flow.
  }
}

function clearRecoveryEntry(instanceId: string, purchaseId: string): void {
  try {
    const state = readRecoveryState()
    const key = recoveryKey(instanceId, purchaseId)
    if (!(key in state)) return
    delete state[key]
    writeRecoveryState(state)
  } catch {
    // Best effort cleanup only.
  }
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
