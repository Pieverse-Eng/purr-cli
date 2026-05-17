// `buy-card` — wraps the ERC-8183 createJob call.
//
// 1. Server creates (or returns) the campaign purchase + ERC-8183 intent.
// 2. CLI encodes createJob from the intent and submits via /wallet/execute.
// 3. CLI tells the server the job is created; server observes the receipt,
//    decodes JobCreated, and persists the on-chain jobId. The CLI never
//    parses receipts — that's the server's job.
//
// Caller orchestrates: follow the returned CTA to run `fund-card` next.

import {
  type Purchase,
  createPurchase,
  executeSteps,
  recordProgress,
  requireIntent,
  stepHash,
} from './api.js'
import { LABELS, createJobStep } from './calldata.js'

export interface BuyCardResult {
  purchaseId: string
  status: Purchase['status']
  createTxHash: string
  onChainJobId: string | null
}

export async function buyCard(): Promise<BuyCardResult> {
  const purchase = await createPurchase()
  const intent = requireIntent(purchase)

  const executed = await executeSteps([createJobStep(intent)])
  const createTxHash = stepHash(executed, LABELS.createJob) as string

  const updated = await recordProgress(purchase.purchaseId, {
    status: 'created',
    createTxHash,
  })

  return {
    purchaseId: updated.purchaseId,
    status: updated.status,
    createTxHash,
    onChainJobId: updated.erc8183?.onChainJobId ?? null,
  }
}
