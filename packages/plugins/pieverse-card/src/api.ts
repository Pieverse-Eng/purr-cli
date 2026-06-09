import { apiGet, apiPost } from '@pieverseio/purr-core/api-client'
import type { TxStep } from '@pieverseio/purr-core/types'
import { SERVICE_SLUG } from './constants.js'
import type {
  AgentSelfIntroPurchase,
  ApiEnvelope,
  Erc8183ServicePurchase,
  PieverseCardPurchaseRequest,
  SocialMemeBoosterJudgeInput,
  SocialMemeBoosterJudgePurchase,
  WalletExecuteResult,
} from './types.js'

export const SOCIAL_MEME_BOOSTER_JUDGE_SERVICE_SLUG = 'social-meme-booster-judge'

function cardBasePath(instanceId: string): string {
  return `/v1/instances/${instanceId}/erc8183/services/${SERVICE_SLUG}/card`
}

function memeJudgeBasePath(instanceId: string): string {
  return `/v1/instances/${instanceId}/erc8183/services/${SOCIAL_MEME_BOOSTER_JUDGE_SERVICE_SLUG}`
}

export async function purchaseCard(
  instanceId: string,
  body: PieverseCardPurchaseRequest = {},
): Promise<AgentSelfIntroPurchase> {
  const res = await apiPost<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${cardBasePath(instanceId)}/purchase`,
    body,
  )
  return unwrap(res)
}

export async function getPurchase(
  instanceId: string,
  purchaseId: string,
): Promise<AgentSelfIntroPurchase> {
  const res = await apiGet<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${cardBasePath(instanceId)}/purchases/${purchaseId}`,
  )
  return unwrap(res)
}

export async function recordProgress(
  instanceId: string,
  purchaseId: string,
  body: Record<string, unknown>,
): Promise<AgentSelfIntroPurchase> {
  const res = await apiPost<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${cardBasePath(instanceId)}/purchases/${purchaseId}/progress`,
    body,
  )
  return unwrap(res)
}

export async function purchaseMemeJudge(
  instanceId: string,
): Promise<SocialMemeBoosterJudgePurchase> {
  const res = await apiPost<ApiEnvelope<SocialMemeBoosterJudgePurchase>>(
    `${memeJudgeBasePath(instanceId)}/purchase`,
    {},
  )
  return unwrap(res)
}

export async function getMemeJudgePurchase(
  instanceId: string,
  purchaseId: string,
): Promise<SocialMemeBoosterJudgePurchase> {
  const res = await apiGet<ApiEnvelope<SocialMemeBoosterJudgePurchase>>(
    `${memeJudgeBasePath(instanceId)}/purchases/${purchaseId}`,
  )
  return unwrap(res)
}

export async function recordMemeJudgeProgress(
  instanceId: string,
  purchaseId: string,
  body: Record<string, unknown>,
): Promise<SocialMemeBoosterJudgePurchase> {
  const res = await apiPost<ApiEnvelope<SocialMemeBoosterJudgePurchase>>(
    `${memeJudgeBasePath(instanceId)}/purchases/${purchaseId}/progress`,
    body,
  )
  return unwrap(res)
}

export async function getMemeJudgeInput(purchaseId: string): Promise<SocialMemeBoosterJudgeInput> {
  const res = await apiGet<ApiEnvelope<SocialMemeBoosterJudgeInput>>(
    `/v1/erc8183/services/${SOCIAL_MEME_BOOSTER_JUDGE_SERVICE_SLUG}/purchases/${purchaseId}/input`,
  )
  return unwrap(res)
}

export async function executeSteps(
  instanceId: string,
  steps: TxStep[],
): Promise<WalletExecuteResult> {
  const res = await apiPost<ApiEnvelope<WalletExecuteResult>>(
    `/v1/instances/${instanceId}/wallet/execute`,
    { steps },
  )
  return unwrap(res)
}

export interface Erc8183ServiceClient<TPurchase extends Erc8183ServicePurchase> {
  getPurchase: (instanceId: string, purchaseId: string) => Promise<TPurchase>
  recordProgress: (
    instanceId: string,
    purchaseId: string,
    body: Record<string, unknown>,
  ) => Promise<TPurchase>
}

function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'API request failed')
  }
  return envelope.data
}
