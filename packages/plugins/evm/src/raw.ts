import { normalizeHexInt } from '@pieverseio/purr-core/shared'
import type { StepOutput } from '@pieverseio/purr-core/types'

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
        // Both `value` and `gasLimit` may arrive as decimal or 0x-hex from the
        // CLI; normalize to canonical hex so downstream validators (api-server
        // step-executor + purr ows-execute) accept it.
        value: normalizeHexInt(args.value, 'value') ?? '0x0',
        chainId: args.chainId,
        label: args.label ?? 'Raw transaction',
        gasLimit: normalizeHexInt(args.gasLimit, 'gas-limit'),
      },
    ],
  }
}
