// `complete-card` — wraps the ERC-8183 complete call.
//
// Called by the caller once the Pieverse provider has submitted the
// deliverable on-chain (server status becomes `submitted`). The CLI does
// not poll for that transition — the agent or operator decides when to
// run this command. If it's called too early, /wallet/execute will revert
// on-chain and the server surfaces that error.

import {
  type Purchase,
  executeSteps,
  getPurchase,
  recordProgress,
  requireIntent,
  stepHash,
} from './api.js'
import { LABELS, completeJobStep } from './calldata.js'

export interface CompleteCardResult {
  purchaseId: string
  status: Purchase['status']
  completeTxHash: string
  imageUrl: string | null
  shareUrl: string | null
  suggestedTweetText: string | null
  xIntentUrl: string | null
}

export async function completeCard(purchaseId: string): Promise<CompleteCardResult> {
  const purchase = await getPurchase(purchaseId)
  const intent = requireIntent(purchase)
  if (!intent.onChainJobId) {
    throw new Error(`Purchase ${purchaseId} has no onChainJobId`)
  }

  const reasonSeed = `accepted:${purchaseId}:${purchase.cardId ?? ''}`
  const executed = await executeSteps([completeJobStep(intent, intent.onChainJobId, reasonSeed)])
  const completeTxHash = stepHash(executed, LABELS.complete) as string

  const updated = await recordProgress(purchaseId, {
    status: 'completed',
    completeTxHash,
  })

  const tweet = updated.suggestedTweetText
  return {
    purchaseId: updated.purchaseId,
    status: updated.status,
    completeTxHash,
    imageUrl: updated.imageUrl,
    shareUrl: updated.shareUrl,
    suggestedTweetText: tweet,
    xIntentUrl: tweet ? `https://x.com/intent/tweet?text=${encodeURIComponent(tweet)}` : null,
  }
}
