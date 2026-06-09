import type { RpcLog } from 'viem'

export type PurchaseStatus =
  | 'initiated'
  | 'created'
  | 'funded'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'rejected'

export type AgentSelfIntroCardLevel = 'lv1'
export type AgentSelfIntroPartner = 'okx' | 'bnb'
export type AgentSelfIntroCardChannel = 'telegram' | 'line'

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

export interface Erc8183PurchaseIntent {
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
}

export interface Erc8183ServicePurchase {
  serviceSlug: string
  serviceId: string
  purchaseId: string
  instanceId: string
  pieName: string
  status: PurchaseStatus
  completedAt?: string | null
  idempotent?: boolean
  erc8183: Erc8183PurchaseIntent | null
}

export interface AgentSelfIntroPurchase extends Erc8183ServicePurchase {
  cardId: string | null
  templateId: string | null
  lv: AgentSelfIntroCardLevel
  partner: AgentSelfIntroPartner
  channel: AgentSelfIntroCardChannel
  imageUrl: string | null
  shareUrl: string | null
  suggestedTweetText: string | null
}

export interface SocialMemeBoosterJudgePurchase extends Erc8183ServicePurchase {
  campaignSlug: string
  campaignDay: string
  judgeResult: SocialMemeBoosterJudgeResult | null
}

export type SocialMemeBoosterJudgeResult =
  | {
      outcome: 'scored'
      totalScore: number
    }
  | {
      outcome: 'no_score'
      totalScore: null
    }

export interface SocialMemeBoosterJudgeInputPost {
  postId: string
  tweetId: string
  tweetUrl: string | null
  textPreview: string | null
  tweetCreatedAt: string | null
}

export interface SocialMemeBoosterJudgeInput {
  serviceSlug: string
  serviceId: string
  purchaseId: string
  jobId: string | null
  campaignSlug: string
  campaignDay: string
  instanceId: string
  pieName: string
  posts: SocialMemeBoosterJudgeInputPost[]
  requirements: {
    engagementSnapshot: {
      source: 'x_live_fetch'
      timing: 'after_payment_before_completion'
      staleDiscoveryMetricsAllowed: false
      requiredMetrics: readonly ['likes', 'reposts', 'replies', 'quotes', 'impressions']
      endpoint: {
        method: 'POST'
        href: string
        authorization: 'bearer_token_required'
      } | null
    }
  }
}

export type PurchaseIntent = NonNullable<Erc8183ServicePurchase['erc8183']>

export interface PieverseCardPurchaseRequest {
  partner?: AgentSelfIntroPartner
  channel?: AgentSelfIntroCardChannel
}

export interface PieverseServiceOptions {
  purchaseId?: string
  receiptTimeoutMs?: number
  receiptPollMs?: number
  submittedTimeoutMs?: number
  submittedPollMs?: number
  resultTimeoutMs?: number
  resultPollMs?: number
  wait?: boolean
  createTxHash?: string
  registerTxHash?: string
  setBudgetTxHash?: string
  approveTxHash?: string | null
  fundTxHash?: string
}

export interface PieverseCardOptions extends PieverseServiceOptions {
  partner?: AgentSelfIntroPartner
  channel?: AgentSelfIntroCardChannel
}

export type PieverseMemeJudgeOptions = PieverseServiceOptions

export type PieverseCardResult = AgentSelfIntroPurchase & {
  refundTxHash?: string
}

export type PieverseMemeJudgeResult = SocialMemeBoosterJudgePurchase & {
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
