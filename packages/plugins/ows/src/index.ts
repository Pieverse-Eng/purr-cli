import {
  EXIT_CODE_GASPAYMASTER_UNSUPPORTED,
  GasPayMasterUnsupportedError,
  owsWalletSignTransaction,
} from './sign-transaction.js'
import { OwsStepExecutionError, owsExecuteSteps } from './execute-steps.js'
import { owsBuildTransfer } from './build-transfer.js'

export {
  EXIT_CODE_GASPAYMASTER_UNSUPPORTED,
  GasPayMasterUnsupportedError,
  OwsStepExecutionError,
  owsBuildTransfer,
  owsExecuteSteps,
  owsWalletSignTransaction,
}

export const owsRuntime = {
  signTransaction: owsWalletSignTransaction,
  buildTransfer: owsBuildTransfer,
  executeSteps: owsExecuteSteps,
  isGasPayMasterUnsupportedError: (err: unknown) => err instanceof GasPayMasterUnsupportedError,
  gasPayMasterUnsupportedExitCode: EXIT_CODE_GASPAYMASTER_UNSUPPORTED,
  isStepExecutionError: (err: unknown): err is OwsStepExecutionError =>
    err instanceof OwsStepExecutionError,
}
