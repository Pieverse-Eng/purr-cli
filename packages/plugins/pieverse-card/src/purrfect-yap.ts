import {
  createPieverseMemeJudgeJob,
  fundPieverseMemeJudge,
  getPieverseMemeJudgeInput,
  getPieverseMemeJudgeResult,
  getPieverseMemeJudgeStatus,
  purchasePieverseMemeJudge,
  refundPieverseMemeJudge,
} from './flow.js'
import { parseMemeJudgeOptions } from './options.js'
import type { PieverseMemeJudgeResult, SocialMemeBoosterJudgeInput } from './types.js'

const CARD_ONLY_ARGS = ['partner', 'channel', 'lv', 'pie-name', 'pieName'] as const

export {
  createPieverseMemeJudgeJob,
  fundPieverseMemeJudge,
  getPieverseMemeJudgeInput,
  getPieverseMemeJudgeResult,
  getPieverseMemeJudgeStatus,
  purchasePieverseMemeJudge,
  refundPieverseMemeJudge,
} from './flow.js'
export type {
  PieverseMemeJudgeOptions,
  PieverseMemeJudgeResult,
  SocialMemeBoosterJudgeInput,
  SocialMemeBoosterJudgePurchase,
} from './types.js'

export async function pieversePurrfectYap(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (args['rpc-url']) {
    throw new Error(
      'purr pieverse purrfect-yap commands do not accept --rpc-url. Set EVM_RPC_56 or EVM_RPC_URL if an RPC override is needed.',
    )
  }
  for (const name of CARD_ONLY_ARGS) {
    if (args[name] !== undefined) {
      throw new Error(
        `purr pieverse purrfect-yap commands do not accept --${name}; campaign channel and partner are selected by the platform.`,
      )
    }
  }
  const options = parseMemeJudgeOptions(args)
  let result: PieverseMemeJudgeResult | SocialMemeBoosterJudgeInput

  switch (command) {
    case 'purchase':
      result = await purchasePieverseMemeJudge()
      break
    case 'create-job':
      result = await createPieverseMemeJudgeJob(options)
      break
    case 'fund':
      result = await fundPieverseMemeJudge(options)
      break
    case 'result':
      result = await getPieverseMemeJudgeResult(options)
      break
    case 'status':
      result = await getPieverseMemeJudgeStatus(options)
      break
    case 'input':
      result = await getPieverseMemeJudgeInput(options)
      break
    case 'refund':
      result = await refundPieverseMemeJudge(options)
      break
    default:
      throw new Error(
        'Unknown pieverse purrfect-yap command. Use: purchase, create-job, fund, result, status, input, refund',
      )
  }

  console.log(JSON.stringify(result, null, 2))
}
