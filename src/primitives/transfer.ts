import { encodeFunctionData, parseAbi } from 'viem'
import { isNative, parseBigInt, requireAddress } from '../shared.js'
import type { StepOutput } from '../types.js'

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

export interface TransferArgs {
  token: string // ERC-20 address or NATIVE_EVM for native
  to: string
  amountWei: string
  chainId: number
}

export function buildTransferSteps(args: TransferArgs): StepOutput {
  requireAddress(args.to, 'to')
  if (!isNative(args.token)) {
    requireAddress(args.token, 'token')
  }
  const amount = parseBigInt(args.amountWei, 'amount-wei')

  if (isNative(args.token)) {
    return {
      steps: [
        {
          to: args.to,
          data: '0x',
          value: `0x${amount.toString(16)}`,
          chainId: args.chainId,
          label: 'Transfer native token',
        },
      ],
    }
  }

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [args.to as `0x${string}`, amount],
  })

  return {
    steps: [
      {
        to: args.token,
        data,
        value: '0x0',
        chainId: args.chainId,
        label: `Transfer ERC-20 ${args.token}`,
      },
    ],
  }
}
