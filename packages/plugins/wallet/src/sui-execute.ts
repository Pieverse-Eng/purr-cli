import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { requireArgOrFile } from '@pieverseio/purr-core/file-input'
import { SUI_NETWORK, suiFailure } from './sui.js'

interface SuiExecuteResponse {
  ok: boolean
  data: Record<string, unknown>
  error?: string
}

/**
 * Execute caller-built Sui TransactionData (base64 BCS, sender = the agent's
 * Sui wallet). The platform simulates it for wallet policy, then the TEE signs
 * and broadcasts it. The bytes identify the transaction, so resubmitting the
 * same bytes replays the earlier result instead of sending again.
 *
 * Build each transaction against current chain state: bytes that reuse coin
 * versions consumed by the wallet's previous send are rejected. When sending
 * several in a row, wait until the previous one is visible on the fullnode
 * before building the next.
 */
export async function walletSuiExecute(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const transaction = requireArgOrFile(args, 'tx-bytes', 'tx-file')
  const key = args['idempotency-key']?.trim()
  const res = await apiPost<SuiExecuteResponse>(
    `/v1/instances/${instanceId}/wallet/execute`,
    { chainType: 'sui', caip2: SUI_NETWORK, transaction },
    key ? { headers: { 'Idempotency-Key': key } } : {},
  )
  if (!res.ok) throw suiFailure(res, 'Sui execute failed')
  console.log(JSON.stringify(res.data))
}
