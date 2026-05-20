import { apiGet, apiPost } from '@pieverseio/purr-core/api-client'
import type { TxStep } from '@pieverseio/purr-core/types'
import { SERVICE_SLUG } from './constants.js'
import type {
  AgentSelfIntroPurchase,
  ApiEnvelope,
  PieverseCardPurchaseRequest,
  WalletExecuteResult,
} from './types.js'

function basePath(instanceId: string): string {
  return `/v1/instances/${instanceId}/erc8183/services/${SERVICE_SLUG}/card`
}

export async function purchaseCard(
  instanceId: string,
  body: PieverseCardPurchaseRequest = {},
): Promise<AgentSelfIntroPurchase> {
  const res = await apiPost<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${basePath(instanceId)}/purchase`,
    body,
  )
  return unwrap(res)
}

export async function getPurchase(
  instanceId: string,
  purchaseId: string,
): Promise<AgentSelfIntroPurchase> {
  const res = await apiGet<ApiEnvelope<AgentSelfIntroPurchase>>(
    `${basePath(instanceId)}/purchases/${purchaseId}`,
  )
  return unwrap(res)
}

export async function recordProgress(
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

function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'API request failed')
  }
  return envelope.data
}
