import { encodeFunctionData, parseAbi } from 'viem'
import { apiGet, resolveCredentials } from '../api-client.js'
import { buildApprovalStep, parseBigInt, requireAddress } from '../shared.js'
import type { StepOutput } from '../types.js'

const ERC4626_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
])

export interface ListaDepositArgs {
  vault: string
  amountWei: string
  token: string
  wallet: string
  chainId: number
}

export function buildListaDepositSteps(args: ListaDepositArgs): StepOutput {
  requireAddress(args.vault, 'vault')
  requireAddress(args.token, 'token')
  requireAddress(args.wallet, 'wallet')
  const amount = parseBigInt(args.amountWei, 'amount-wei')

  const depositData = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: 'deposit',
    args: [amount, args.wallet as `0x${string}`],
  })

  return {
    steps: [
      buildApprovalStep(
        args.token,
        args.vault,
        args.amountWei,
        args.chainId,
        'Approve token for Lista vault',
      ),
      {
        to: args.vault,
        data: depositData,
        value: '0x0',
        chainId: args.chainId,
        label: 'Lista vault deposit',
      },
    ],
  }
}

export interface ListaRedeemArgs {
  vault: string
  sharesWei: string
  wallet: string
  chainId: number
}

export function buildListaRedeemSteps(args: ListaRedeemArgs): StepOutput {
  requireAddress(args.vault, 'vault')
  requireAddress(args.wallet, 'wallet')
  const shares = parseBigInt(args.sharesWei, 'shares-wei')
  const wallet = args.wallet as `0x${string}`
  const redeemData = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: 'redeem',
    args: [shares, wallet, wallet],
  })

  return {
    steps: [
      {
        to: args.vault,
        data: redeemData,
        value: '0x0',
        chainId: args.chainId,
        label: 'Lista vault redeem',
      },
    ],
  }
}

export interface ListaWithdrawArgs {
  vault: string
  amountWei: string
  wallet: string
  chainId: number
}

export function buildListaWithdrawSteps(args: ListaWithdrawArgs): StepOutput {
  requireAddress(args.vault, 'vault')
  requireAddress(args.wallet, 'wallet')
  const amount = parseBigInt(args.amountWei, 'amount-wei')
  const wallet = args.wallet as `0x${string}`
  const withdrawData = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: 'withdraw',
    args: [amount, wallet, wallet],
  })

  return {
    steps: [
      {
        to: args.vault,
        data: withdrawData,
        value: '0x0',
        chainId: args.chainId,
        label: 'Lista vault withdraw',
      },
    ],
  }
}

export async function listVaults(zone?: string): Promise<unknown> {
  const { instanceId } = resolveCredentials()
  const query = zone ? `?zone=${encodeURIComponent(zone)}` : ''
  return apiGet(`/v1/instances/${instanceId}/lista/vaults${query}`)
}
