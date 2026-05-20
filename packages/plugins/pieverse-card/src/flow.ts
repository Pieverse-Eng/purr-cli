import { encodeFunctionData } from 'viem'
import { resolveCredentials } from '@pieverseio/purr-core/api-client'
import { isNative } from '@pieverseio/purr-core/shared'
import type { TxStep } from '@pieverseio/purr-core/types'
import { ERC20_ABI, ERC8183_ABI, ERC8183_ROUTER_ABI } from './abi.js'
import { executeSteps, getPurchase, purchaseCard, recordProgress } from './api.js'
import {
  EMPTY_BYTES,
  ERC8183_JOB_STATUS,
  SUBMITTED_POLL_MS,
  SUBMITTED_TIMEOUT_MS,
  ZERO_ADDRESS,
} from './constants.js'
import {
  assertNotTerminal,
  optionalStepHash,
  requireBudgetAmount,
  requireEvmAddress,
  requireIntent,
  requireOnChainJobId,
  requirePurchaseId,
  requiredStepHash,
  sleep,
} from './guards.js'
import { assertRegisteredJob, parseCreatedJobId } from './receipts.js'
import { readCommercePaymentToken, readOnChainJob, waitForReceipt } from './rpc.js'
import type {
  AgentSelfIntroPurchase,
  OnChainJob,
  PieverseCardOptions,
  PieverseCardPurchaseRequest,
  PieverseCardResult,
  PurchaseIntent,
} from './types.js'

const MIN_JOB_EXPIRATION_SECONDS = 8 * 24 * 60 * 60

export async function purchasePieverseCard(
  options: PieverseCardOptions = {},
): Promise<PieverseCardResult> {
  const { instanceId } = resolveCredentials()
  return purchaseCard(instanceId, purchaseRequestFromOptions(options))
}

export async function getPieverseCardStatus(
  options: PieverseCardOptions,
): Promise<PieverseCardResult> {
  const { instanceId } = resolveCredentials()
  return getPurchase(instanceId, requirePurchaseId(options))
}

export async function createPieverseCardJob(
  options: PieverseCardOptions,
): Promise<PieverseCardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  assertNotTerminal(purchase)

  if (purchase.status !== 'initiated') {
    return purchase
  }

  return createJob(instanceId, purchase, options)
}

export async function fundPieverseCard(options: PieverseCardOptions): Promise<PieverseCardResult> {
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

export async function getPieverseCardDeliverable(
  options: PieverseCardOptions,
): Promise<PieverseCardResult> {
  const { instanceId } = resolveCredentials()
  const purchase = await getPurchase(instanceId, requirePurchaseId(options))
  assertNotTerminal(purchase)

  if (purchase.status === 'submitted' || purchase.status === 'completed' || !options.wait) {
    return purchase
  }

  return waitForSubmitted(instanceId, purchase, options)
}

export async function refundPieverseCard(
  options: PieverseCardOptions,
): Promise<PieverseCardResult> {
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

async function createJob(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: PieverseCardOptions,
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
    const jobExpirationSeconds = Math.max(intent.jobExpirationSeconds, MIN_JOB_EXPIRATION_SECONDS)
    const expiredAt = Math.floor(Date.now() / 1000) + jobExpirationSeconds
    const step: TxStep = {
      to: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
      data: encodeFunctionData({
        abi: ERC8183_ABI,
        functionName: 'createJob',
        args: [
          requireEvmAddress(intent.providerWalletAddress, 'erc8183.providerWalletAddress'),
          requireEvmAddress(intent.evaluatorWalletAddress, 'erc8183.evaluatorWalletAddress'),
          BigInt(expiredAt),
          intent.jobUri,
          requireEvmAddress(intent.hookAddress || ZERO_ADDRESS, 'erc8183.hookAddress'),
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
      to: requireEvmAddress(intent.routerAddress, 'erc8183.routerAddress'),
      data: encodeFunctionData({
        abi: ERC8183_ROUTER_ABI,
        functionName: 'registerJob',
        args: [
          BigInt(createdJobId),
          requireEvmAddress(intent.policyAddress, 'erc8183.policyAddress'),
        ],
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
  options: PieverseCardOptions,
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
      to: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
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

  const paymentTokenAddress = await resolvePaymentTokenAddress(intent)
  if (paymentTokenAddress && !isNative(paymentTokenAddress) && budgetAmount > 0n) {
    const token = requireEvmAddress(paymentTokenAddress, 'erc8183.paymentTokenAddress')
    steps.push({
      to: token,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'), budgetAmount],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: 'ERC-8183 approve payment token',
      conditional: {
        type: 'allowance_lt',
        token,
        spender: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
        amount: budgetAmount.toString(),
      },
    })
  }

  steps.push({
    to: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
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

async function resolvePaymentTokenAddress(intent: PurchaseIntent): Promise<string | null> {
  try {
    return await readCommercePaymentToken(intent)
  } catch {
    return intent.paymentTokenAddress
  }
}

async function waitForSubmitted(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: PieverseCardOptions,
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

async function claimRefundIfEligible(
  instanceId: string,
  purchase: AgentSelfIntroPurchase,
  options: PieverseCardOptions,
): Promise<string | null> {
  const intent = requireIntent(purchase)
  const jobId = purchase.erc8183?.onChainJobId
  if (!jobId) return null
  if (!isRefundCandidatePurchase(purchase)) return null

  const job = await readOnChainJob(intent, jobId)
  if (!job || !shouldClaimRefundForJob(job)) return null

  const refundStep: TxStep = {
    to: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
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

function purchaseRequestFromOptions(options: PieverseCardOptions): PieverseCardPurchaseRequest {
  return {
    partner: options.partner,
    channel: options.channel,
  }
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
