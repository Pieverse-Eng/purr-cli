import type { StepOutput } from '../types.js'

export interface RawArgs {
  to: string
  data: string
  value?: string
  chainId: number
  label?: string
  gasLimit?: string
}

export function buildRawStep(args: RawArgs): StepOutput {
  return {
    steps: [
      {
        to: args.to,
        data: args.data,
        value: args.value ?? '0x0',
        chainId: args.chainId,
        label: args.label ?? 'Raw transaction',
        gasLimit: args.gasLimit,
      },
    ],
  }
}
