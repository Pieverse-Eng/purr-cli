import { getAddress, isAddress } from 'viem'
import type {
  AgentSelfIntroPurchase,
  PieverseCardOptions,
  PurchaseIntent,
  WalletExecuteResult,
} from './types.js'

export function requireIntent(purchase: AgentSelfIntroPurchase): PurchaseIntent {
  if (!purchase.erc8183) {
    throw new Error(`Purchase ${purchase.purchaseId} did not include an ERC-8183 intent`)
  }
  return purchase.erc8183
}

export function requireBudgetAmount(intent: PurchaseIntent): bigint {
  if (intent.budgetAmount === null || intent.budgetAmount === '') {
    throw new Error('ERC-8183 budgetAmount is missing')
  }
  const amount = BigInt(intent.budgetAmount)
  if (amount < 0n) throw new Error('ERC-8183 budgetAmount must be non-negative')
  return amount
}

export function requireOnChainJobId(purchase: AgentSelfIntroPurchase): string {
  const jobId = purchase.erc8183?.onChainJobId
  if (!jobId) {
    throw new Error(`Purchase ${purchase.purchaseId} is missing erc8183.onChainJobId`)
  }
  return jobId
}

export function requiredStepHash(result: WalletExecuteResult, label: string): string {
  const step = result.results.find((candidate) => candidate.label === label)
  if (!step || step.status !== 'success' || !step.hash) {
    throw new Error(`Wallet execute did not return a tx hash for ${label}`)
  }
  return step.hash
}

export function optionalStepHash(result: WalletExecuteResult, label: string): string | null {
  const step = result.results.find((candidate) => candidate.label === label)
  if (!step || step.status === 'skipped' || !step.hash) return null
  return step.hash
}

export function requireEvmAddress(value: string, field: string): `0x${string}` {
  if (!isAddress(value)) throw new Error(`${field} must be an EVM address`)
  return getAddress(value) as `0x${string}`
}

export function assertNotTerminal(purchase: AgentSelfIntroPurchase): void {
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

export function requirePurchaseId(options: PieverseCardOptions): string {
  if (!options.purchaseId) throw new Error('Missing required argument: --purchase-id')
  return options.purchaseId
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
