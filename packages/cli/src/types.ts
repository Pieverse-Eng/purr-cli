interface OwsStepExecutionLike extends Error {
  partialResults: unknown
  failedStepIndex: number
}

export interface OwsRuntime {
  signTransaction: (
    txsJson: string,
    chainId: number | undefined,
    opts: { owsWallet: string; owsToken?: string },
  ) => Promise<{ orderId?: string; txs: Array<Record<string, unknown>>; address: string }>
  buildTransfer: (input: {
    owsWallet?: string
    from?: string
    to: string
    amount: string
    chainType: 'ethereum' | 'solana'
    chainId?: number
    token?: string
    decimals?: number
    rpcUrl?: string
    gasLimit?: string
  }) => Promise<unknown>
  executeSteps: (input: {
    stepsJson: string
    owsWallet: string
    owsToken?: string
    rpcUrl?: string
  }) => Promise<unknown>
  isGasPayMasterUnsupportedError: (err: unknown) => boolean
  gasPayMasterUnsupportedExitCode: number
  isStepExecutionError: (err: unknown) => err is OwsStepExecutionLike
}

export interface PurrCliOptions {
  disabledPlugins?: Record<string, string>
}

export interface PluginRuntimeMap {
  ows: OwsRuntime
}

export type PluginId = keyof PluginRuntimeMap
