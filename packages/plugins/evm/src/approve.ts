import { encodeFunctionData, maxUint256 } from 'viem'
import { ERC20_APPROVE_ABI, parseBigInt, requireAddress } from '@pieverseio/purr-core/shared'
import type { StepOutput, TxStep } from '@pieverseio/purr-core/types'

// USDT-style tokens require resetting allowance to 0 before setting a new value.
const USDT_STYLE_TOKENS = new Set([
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT mainnet
  '0x55d398326f99059ff775485246999027b3197955', // USDT BSC
])

export interface ApproveArgs {
  token: string
  spender: string
  amount: string // wei, or "max" for maxUint256
  chainId: number
}

export function buildApproveSteps(args: ApproveArgs): StepOutput {
  requireAddress(args.token, 'token')
  requireAddress(args.spender, 'spender')
  const approveAmount = args.amount === 'max' ? maxUint256 : parseBigInt(args.amount, 'amount')
  const steps: TxStep[] = []

  const isUsdtStyle = USDT_STYLE_TOKENS.has(args.token.toLowerCase())

  // For USDT-style tokens, prepend a reset-to-zero step (conditional on existing allowance > 0)
  if (isUsdtStyle) {
    const resetData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [args.spender as `0x${string}`, 0n],
    })
    steps.push({
      to: args.token,
      data: resetData,
      value: '0x0',
      chainId: args.chainId,
      label: 'Reset USDT-style allowance to 0',
    })
  }

  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [args.spender as `0x${string}`, approveAmount],
  })

  steps.push({
    to: args.token,
    data: approveData,
    value: '0x0',
    chainId: args.chainId,
    label: `Approve ${args.amount === 'max' ? 'unlimited' : args.amount} tokens`,
    conditional: {
      type: 'allowance_lt',
      token: args.token,
      spender: args.spender,
      amount: args.amount === 'max' ? maxUint256.toString() : args.amount,
    },
  })

  return { steps }
}
