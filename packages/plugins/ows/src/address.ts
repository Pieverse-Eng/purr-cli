import { getWallet as owsGetWallet } from '@open-wallet-standard/core'

export type OwsAddressChainType = 'ethereum' | 'solana'

export interface OwsWalletAddressInput {
  owsWallet: string
  chainType?: OwsAddressChainType
  vaultPath?: string
}

export function owsWalletAddress(input: OwsWalletAddressInput): {
  address: string
  chainType: OwsAddressChainType
  chainId: string
} {
  const chainType = input.chainType ?? 'ethereum'
  const wallet = owsGetWallet(input.owsWallet, input.vaultPath)
  const account = wallet.accounts.find((a) =>
    chainType === 'ethereum' ? a.chainId === 'eip155:1' : a.chainId.startsWith('solana:'),
  )
  if (!account) {
    throw new Error(`OWS wallet "${input.owsWallet}" has no ${chainType} account`)
  }
  return {
    address: account.address,
    chainType,
    chainId: account.chainId,
  }
}
