// ERC-8183 buy-card — thin client.
//
// Purchase state lives in api-server (campaign_card_service_purchases table)
// and the source of truth for on-chain progress is the chain itself. The CLI
// must not replicate either. It calls the campaign purchase endpoint and
// returns whatever the server hands back. If the server needs another round
// trip (e.g. a deliverable hasn't been submitted yet), the operator re-runs
// — server endpoints are idempotent on (instance, purchase).
//
// If a future server contract requires the CLI to broadcast calldata between
// status transitions, that flow should be expressed by the server returning a
// "next steps" envelope that the CLI executes via the generic /wallet/execute
// surface. The CLI still doesn't carry a state machine — it just follows
// instructions the server provides on each round trip.

import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'

const SERVICE_SLUG = 'agent-self-intro'

export interface BuyCardResult {
  purchaseId: string
  status: string
  imageUrl: string | null
  shareUrl: string | null
  suggestedTweetText: string | null
  xIntentUrl: string | null
  // Server-provided campaign payload — passed through so the agent can show
  // template / handle / completion data without the CLI knowing the shape.
  // biome-ignore lint/suspicious/noExplicitAny: server-owned envelope
  raw: any
}

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

// biome-ignore lint/suspicious/noExplicitAny: server-owned shape; kept untyped on purpose
type PurchasePayload = any

export async function buyErc8183Card(): Promise<BuyCardResult> {
  const { instanceId } = resolveCredentials()
  const envelope = await apiPost<ApiEnvelope<PurchasePayload>>(
    `/v1/instances/${instanceId}/erc8183/services/${SERVICE_SLUG}/card/purchase`,
    {},
  )
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'API request failed')
  }
  const purchase = envelope.data
  const tweet = purchase.suggestedTweetText ?? null
  return {
    purchaseId: purchase.purchaseId,
    status: purchase.status,
    imageUrl: purchase.imageUrl ?? null,
    shareUrl: purchase.shareUrl ?? null,
    suggestedTweetText: tweet,
    xIntentUrl: tweet ? `https://x.com/intent/tweet?text=${encodeURIComponent(tweet)}` : null,
    raw: purchase,
  }
}
