// Thin wrapper around POST /v1/instances/:id/wallet/execute.
// Plugin commands compose this with a calldata builder to wrap one
// ERC-8183 call per /wallet/execute invocation.

import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import type { TxStep } from '@pieverseio/purr-core/types'

interface ApiEnvelope<T> {
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
}

export async function executeOne(step: TxStep): Promise<WalletExecuteResult> {
  const { instanceId } = resolveCredentials()
  const envelope = await apiPost<ApiEnvelope<WalletExecuteResult>>(
    `/v1/instances/${instanceId}/wallet/execute`,
    { steps: [step] },
  )
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? '/wallet/execute failed')
  }
  return envelope.data
}

export function firstHash(result: WalletExecuteResult): string {
  const step = result.results[0]
  if (!step || step.status !== 'success' || !step.hash) {
    throw new Error('Wallet execute did not return a tx hash')
  }
  return step.hash
}
