// `fund-card` — wraps the ERC-8183 setBudget + approve + fund sequence.
//
// One /wallet/execute call carries all three steps. The approve step is
// conditional on `allowance_lt` so executor skips it when the wallet already
// has sufficient allowance. The server records progress and returns the
// updated purchase state.

import {
  type Purchase,
  executeSteps,
  getPurchase,
  recordProgress,
  requireIntent,
  stepHash,
} from './api.js'
import { LABELS, fundJobSteps } from './calldata.js'

export interface FundCardResult {
  purchaseId: string
  status: Purchase['status']
  setBudgetTxHash: string
  approveTxHash: string | null
  fundTxHash: string
}

export async function fundCard(purchaseId: string): Promise<FundCardResult> {
  const purchase = await getPurchase(purchaseId)
  const intent = requireIntent(purchase)
  if (!intent.onChainJobId) {
    throw new Error(
      `Purchase ${purchaseId} has no onChainJobId yet — wait for the server to observe the createJob receipt, then retry`,
    )
  }

  const executed = await executeSteps(fundJobSteps(intent, intent.onChainJobId))
  const setBudgetTxHash = stepHash(executed, LABELS.setBudget) as string
  const approveTxHash = stepHash(executed, LABELS.approve, false)
  const fundTxHash = stepHash(executed, LABELS.fund) as string

  const updated = await recordProgress(purchaseId, {
    status: 'funded',
    setBudgetTxHash,
    approveTxHash,
    fundTxHash,
  })

  return {
    purchaseId: updated.purchaseId,
    status: updated.status,
    setBudgetTxHash,
    approveTxHash,
    fundTxHash,
  }
}
