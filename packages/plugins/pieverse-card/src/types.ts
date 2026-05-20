import type { RpcLog } from 'viem'

export type PurchaseStatus =
  | 'initiated'
  | 'created'
  | 'funded'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'rejected'

export interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

export interface WalletExecuteResult {
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

export type PurchaseIntent = NonNullable<AgentSelfIntroPurchase['erc8183']>

export interface PieverseCardOptions {
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
}

export type PieverseCardResult = AgentSelfIntroPurchase & {
  refundTxHash?: string
}

export interface RpcReceipt {
  status: '0x0' | '0x1'
  to?: string
  transactionHash: string
  blockNumber: string
  logs: RpcLog[]
}

export interface RpcResponse<T> {
  jsonrpc: string
  id: number
  result?: T
  error?: { code: number; message: string }
}

export interface OnChainJob {
  id: bigint
  expiredAt: bigint
  status: number
}
