/**
 * Bitget Order Mode — sign unsigned transactions via managed custody.
 *
 * Takes the JSON output from `bitget-wallet-agent-api.py make-order`,
 * POSTs txs[] to the API server's /wallet/sign-transaction endpoint,
 * and returns the result with sig fields filled (ready for send).
 */

import { apiPost, resolveCredentials } from '../api-client.js'

interface SignTransactionResponse {
  ok: boolean
  data?: {
    txs: Array<Record<string, unknown>>
    address: string
  }
  error?: string
}

export async function bitgetSignTransaction(
  orderJson: string,
  chainId?: number,
): Promise<{ orderId: string; txs: Array<Record<string, unknown>>; address: string }> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(orderJson)
  } catch {
    throw new Error('Invalid --order-json: not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid --order-json: expected a JSON object')
  }

  // Support both raw makeOrder response shape: { data: { orderId, txs } }
  // and unwrapped shape: { orderId, txs }
  const data = (parsed.data ?? parsed) as Record<string, unknown>
  const orderId = data.orderId
  const txs = data.txs

  if (!orderId || typeof orderId !== 'string') {
    throw new Error('--order-json must contain orderId (string)')
  }
  if (!txs || !Array.isArray(txs) || txs.length === 0) {
    throw new Error('--order-json must contain non-empty txs array')
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

  return {
    orderId,
    txs: res.data.txs,
    address: res.data.address,
  }
}
