import {
  createPieverseCardJob,
  fundPieverseCard,
  getPieverseCardDeliverable,
  getPieverseCardStatus,
  purchasePieverseCard,
  refundPieverseCard,
} from './flow.js'
import { parseCardOptions } from './options.js'
import type { PieverseCardResult } from './types.js'

export {
  createPieverseCardJob,
  fundPieverseCard,
  getPieverseCardDeliverable,
  getPieverseCardStatus,
  purchasePieverseCard,
  refundPieverseCard,
} from './flow.js'
export { resolveRpcUrl } from './rpc.js'
export type {
  AgentSelfIntroPurchase,
  PieverseCardOptions,
  PieverseCardResult,
} from './types.js'

export async function pieverseCard(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (args['rpc-url']) {
    throw new Error(
      'purr pieverse card commands do not accept --rpc-url. Set EVM_RPC_56 or EVM_RPC_URL if an RPC override is needed.',
    )
  }
  const options = parseCardOptions(args)
  let result: PieverseCardResult

  switch (command) {
    case 'purchase':
      result = await purchasePieverseCard(options)
      break
    case 'create-job':
      result = await createPieverseCardJob(options)
      break
    case 'fund':
      result = await fundPieverseCard(options)
      break
    case 'deliverable':
      result = await getPieverseCardDeliverable(options)
      break
    case 'refund':
      result = await refundPieverseCard(options)
      break
    case 'status':
      result = await getPieverseCardStatus(options)
      break
    default:
      throw new Error(
        'Unknown pieverse card command. Use: purchase, create-job, fund, deliverable, refund, status',
      )
  }

  console.log(JSON.stringify(result, null, 2))
}
