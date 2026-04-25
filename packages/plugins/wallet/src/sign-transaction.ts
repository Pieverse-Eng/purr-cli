/**
 * wallet sign-transaction — sign unsigned transactions via managed custody.
 *
 * Takes a JSON payload containing a txs[] array of unsigned transactions
 * and POSTs to /wallet/sign-transaction. Returns the same items with their
 * `sig` fields filled, ready to be submitted to the vendor API that produced
 * the unsigned txs (Bitget Order Mode, Bulbaswap bridge, etc).
 *
 * Supports all signing modes handled by the server:
 *   - Raw EVM transactions (legacy + EIP-1559)
 *   - EIP-712 typed data (via { function: 'signTypeData' } markers)
 *   - Solana transactions (base64-encoded)
 *   - gasPayMaster raw hash signing
 *
 * Input JSON shape is permissive — the following are all accepted:
 *   { data: { orderId, txs } }   — raw vendor makeOrder response
 *   { orderId, txs }             — unwrapped order
 *   { txs }                      — just the txs array
 */

import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'

interface SignTransactionResponse {
  ok: boolean
  data?: {
    txs: Array<Record<string, unknown>>
    address: string
  }
  error?: string
}

export async function walletSignTransaction(
  txsJson: string,
  chainId?: number,
): Promise<{
  orderId?: string
  txs: Array<Record<string, unknown>>
  address: string
}> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(txsJson)
  } catch {
    throw new Error('Invalid --txs-json: not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid --txs-json: expected a JSON object')
  }

  // Support all three shapes: { data: { orderId, txs } }, { orderId, txs }, { txs }
  const data = (parsed.data ?? parsed) as Record<string, unknown>
  const orderId = data.orderId
  const txs = data.txs

  if (orderId !== undefined && typeof orderId !== 'string') {
    throw new Error('--txs-json: orderId, if present, must be a string')
  }
  if (!txs || !Array.isArray(txs) || txs.length === 0) {
    throw new Error('--txs-json must contain a non-empty txs array')
  }

  const body: Record<string, unknown> = { txs }
  if (chainId !== undefined) {
    body.chainId = chainId
  }

  const { instanceId } = resolveCredentials()
  const res = await apiPost<SignTransactionResponse>(
    `/v1/instances/${instanceId}/wallet/sign-transaction`,
    body,
  )

  if (!res.data) {
    throw new Error(res.error ?? 'Failed to sign transactions')
  }

  const result: {
    orderId?: string
    txs: Array<Record<string, unknown>>
    address: string
  } = {
    txs: res.data.txs,
    address: res.data.address,
  }
  if (typeof orderId === 'string') {
    result.orderId = orderId
  }
  return result
}
