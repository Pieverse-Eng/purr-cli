import {
  lookupPieIdentityByAccount,
  resolvePieName,
  type PieIdentityChannel,
} from '@pieverseio/purr-plugin-pns/resolve'
import { executeWalletTransfer } from '@pieverseio/purr-plugin-wallet/transfer'

export const PIE_TRANSFER_USAGE =
  'Usage: purr .pie transfer (--pie <name.pie> | --channel <telegram|line|kakao> --account <account>) --amount <amount> --chain-id <id> [--token <token>] [--decimals <n>]'

function requirePieIdentityChannel(value: string | undefined): PieIdentityChannel {
  if (value === 'telegram' || value === 'line' || value === 'kakao') return value
  if (value === undefined) {
    throw new Error(PIE_TRANSFER_USAGE)
  }
  throw new Error(`Invalid --channel: ${value}. Use: telegram, line, kakao`)
}

function requireAccount(value: string | undefined): string {
  const account = value?.trim()
  if (!account) throw new Error(PIE_TRANSFER_USAGE)
  return account
}

export async function pieTransfer(args: Record<string, string>): Promise<void> {
  if (args.to) {
    throw new Error(
      'Do not pass --to; purr .pie transfer resolves the recipient from --pie or --channel/--account',
    )
  }
  if (args['chain-type'] && args['chain-type'] !== 'ethereum') {
    throw new Error('purr .pie transfer currently supports only ethereum recipients')
  }

  let pieName = args.pie?.trim()
  if (pieName && (args.channel || args.account)) {
    throw new Error('Use either --pie or --channel/--account, not both')
  }

  if (!pieName) {
    const channel = requirePieIdentityChannel(args.channel)
    const account = requireAccount(args.account)
    const identity = await lookupPieIdentityByAccount({ channel, account })

    if (!identity.pieName) {
      throw new Error(`No .pie identity found for ${channel}:${account}`)
    }
    pieName = identity.pieName
  }

  const resolved = await resolvePieName(pieName)
  const transfer = await executeWalletTransfer({
    ...args,
    to: resolved.walletAddress,
  })

  console.log(
    JSON.stringify({
      ...transfer,
      pieName,
    }),
  )
}
