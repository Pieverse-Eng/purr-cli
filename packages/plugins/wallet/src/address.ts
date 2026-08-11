import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'

export interface WalletAddressData {
  address: string
  chainId: number
  chainType: string
  createdNow: boolean
}

interface WalletAddressResponse {
  ok: boolean
  data: WalletAddressData
  error?: string
}

export async function getWalletAddress(
  args: Record<string, string>,
): Promise<WalletAddressData> {
  const { instanceId } = resolveCredentials()
  const body: Record<string, unknown> = {}

  if (args['chain-type']) {
    body.chainType = args['chain-type']
  }
  if (args['chain-id']) {
    body.chainId = Number.parseInt(args['chain-id'], 10)
  }

  const res = await apiPost<WalletAddressResponse>(
    `/v1/instances/${instanceId}/wallet/ensure`,
    body,
  )

  if (!res.ok) {
    throw new Error(res.error ?? 'Failed to get wallet address')
  }

  return res.data
}

export async function walletAddress(args: Record<string, string>): Promise<void> {
  console.log(JSON.stringify(await getWalletAddress(args)))
}
