// Shared types + thin API helpers for the erc8183 plugin commands.
// State lives in api-server (campaign tables) and on-chain. The CLI never
// stores either — it just makes server calls and forwards the result.

import { apiGet, apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import type { TxStep } from '@pieverseio/purr-core/types'

export const SERVICE_SLUG = 'agent-self-intro'

export interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

export interface Intent {
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
}

export interface Purchase {
  purchaseId: string
  instanceId: string
  status: 'initiated' | 'created' | 'funded' | 'submitted' | 'completed' | 'failed' | 'rejected'
  cardId: string | null
  imageUrl: string | null
  shareUrl: string | null
  suggestedTweetText: string | null
  erc8183: Intent | null
}

export interface WalletExecuteResult {
  results: Array<{
    stepIndex: number
    label?: string
    hash: string
    status: 'success' | 'skipped'
  }>
}

export function instanceId(): string {
  return resolveCredentials().instanceId
}

const basePath = (id: string): string => `/v1/instances/${id}/erc8183/services/${SERVICE_SLUG}/card`

export async function createPurchase(): Promise<Purchase> {
  return unwrap(await apiPost<ApiEnvelope<Purchase>>(`${basePath(instanceId())}/purchase`, {}))
}

export async function getPurchase(purchaseId: string): Promise<Purchase> {
  return unwrap(
    await apiGet<ApiEnvelope<Purchase>>(`${basePath(instanceId())}/purchases/${purchaseId}`),
  )
}

export async function recordProgress(
  purchaseId: string,
  body: Record<string, unknown>,
): Promise<Purchase> {
  return unwrap(
    await apiPost<ApiEnvelope<Purchase>>(
      `${basePath(instanceId())}/purchases/${purchaseId}/progress`,
      body,
    ),
  )
}

export async function executeSteps(steps: TxStep[]): Promise<WalletExecuteResult> {
  return unwrap(
    await apiPost<ApiEnvelope<WalletExecuteResult>>(
      `/v1/instances/${instanceId()}/wallet/execute`,
      { steps },
    ),
  )
}

export function requireIntent(purchase: Purchase): Intent {
  if (!purchase.erc8183) {
    throw new Error(`Purchase ${purchase.purchaseId} did not include an ERC-8183 intent`)
  }
  return purchase.erc8183
}

export function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'API request failed')
  }
  return envelope.data
}

export function stepHash(
  result: WalletExecuteResult,
  label: string,
  required = true,
): string | null {
  const step = result.results.find((r) => r.label === label)
  if (!step) {
    if (required) throw new Error(`Wallet execute did not run step: ${label}`)
    return null
  }
  if (step.status === 'skipped') return null
  if (!step.hash) {
    if (required) throw new Error(`Wallet execute did not return a tx hash for ${label}`)
    return null
  }
  return step.hash
}
