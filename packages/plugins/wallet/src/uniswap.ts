import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { parseChainId } from '@pieverseio/purr-core/shared'
import { chainNameToId, resolveToken } from '@pieverseio/purr-core/token-registry'

const ROBINHOOD_CHAIN_ID = 4663

type UniswapSwapData = Record<string, unknown>

interface UniswapSwapResponse {
  ok: boolean
  data: UniswapSwapData
  error?: string
}

function requiredArg(args: Record<string, string>, name: string): string {
  const value = args[name]
  if (value === undefined) {
    throw new Error(`Missing required argument: --${name}`)
  }
  return value
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  const parsed = Number(trimmed)
  if (!trimmed || !Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function resolveChainId(args: Record<string, string>): number {
  const chainNameId = args.chain ? chainNameToId(args.chain) : undefined
  if (args.chain && chainNameId === undefined) {
    throw new Error(`Unknown --chain: ${args.chain}`)
  }

  const chainId = args['chain-id']
    ? parseChainId(args['chain-id'])
    : (chainNameId ?? ROBINHOOD_CHAIN_ID)
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error('purr wallet uniswap currently supports Robinhood Chain only')
  }
  return chainId
}

function parseProtocols(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const protocols = value
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)
  return protocols.length > 0 ? protocols : undefined
}

function buildSwapBody(args: Record<string, string>): Record<string, unknown> {
  const chainId = resolveChainId(args)
  const body: Record<string, unknown> = {
    fromToken: resolveToken(requiredArg(args, 'from'), chainId),
    toToken: resolveToken(requiredArg(args, 'to'), chainId),
    fromAmount: requiredArg(args, 'amount'),
    chainId,
  }

  const slippageTolerance = parseOptionalNumber(args.slippage, 'slippage')
  if (slippageTolerance !== undefined) body.slippageTolerance = slippageTolerance
  if (args.recipient) body.recipient = args.recipient
  if (args['min-amount-out']) body.minAmountOut = args['min-amount-out']
  if (args['dedup-key']) body.dedupKey = args['dedup-key']
  const protocols = parseProtocols(args.protocols)
  if (protocols) body.protocols = protocols

  return body
}

export async function walletUniswap(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const execute = args.execute === 'true'
  const body = buildSwapBody(args)
  const endpoint = execute ? 'execute' : 'quote'
  const res = await apiPost<UniswapSwapResponse>(
    `/v1/instances/${instanceId}/wallet/uniswap/${endpoint}`,
    body,
  )

  if (!res.ok) {
    throw new Error(res.error ?? `Uniswap ${endpoint} failed`)
  }

  console.log(JSON.stringify(res.data))
}
