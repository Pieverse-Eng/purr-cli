// Canonical TxStep/ConditionalCheck types.
// Also defined in: packages/api-server/src/services/step-executor.ts (consumer side).
// Keep both in sync — they represent the JSON wire format between purr CLI and the executor.

export interface ConditionalCheck {
  type: 'allowance_lt'
  token: string
  spender: string
  amount: string // wei
}

export interface TxStep {
  to: string
  data: string // hex calldata
  value: string // hex wei, default "0x0"
  chainId: number
  label?: string
  gasLimit?: string
  conditional?: ConditionalCheck
}

export interface StepOutput {
  steps: TxStep[]
}
