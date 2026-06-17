import { ApiClientError, apiGet, resolveCredentials } from '@pieverseio/purr-core/api-client'

export interface PnsResolvedHandle {
  kind: 'handle'
  handle: string
  renderedHandle: string
  walletAddress: string
}

export type PieIdentityChannel = 'telegram' | 'line' | 'kakao'

export interface PieIdentityByAccountResult {
  pieName: string | null
}

export interface PieIdentityAccount {
  channel: PieIdentityChannel
  accountId: string
  username?: string
}

export interface PieIdentityAccountsResult {
  accounts: PieIdentityAccount[]
}

export type MerchantAgentCardStatus = 'not_enabled' | 'not_running' | 'available' | 'unavailable'

export interface PieIdentityMerchantProfile {
  enabled: boolean
  useUpstreamSkill: boolean
  agentCard: unknown | null
  agentCardStatus: MerchantAgentCardStatus
  shopName?: string
  walletAddress?: string
  chainId?: number
  tokenSymbol?: string
  tokenDecimals?: number
  shopId?: string
  publicUrl?: string
}

interface PieIdentityBaseProfile {
  pieName: string
  agentType: 'hosted' | 'remote'
  walletAddress: string
  merchant: PieIdentityMerchantProfile
}

export type PieIdentityProfile =
  | (PieIdentityBaseProfile & {
      agentType: 'hosted'
      runtimeType: string
      active: boolean
      gatewayStatus: string
    })
  | (PieIdentityBaseProfile & {
      agentType: 'remote'
    })

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

interface ApiErrorBody {
  error?: string
  code?: string
  message?: string
}

function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'PNS lookup failed')
  }
  return envelope.data
}

function scopedPieIdentityPath(suffix: string): string {
  const { instanceId } = resolveCredentials()
  return `/v2/instances/${encodeURIComponent(instanceId)}/pie-identities/${suffix}`
}

function errorBody(error: ApiClientError): ApiErrorBody {
  return error.body && typeof error.body === 'object' ? (error.body as ApiErrorBody) : {}
}

function formatLookupError(input: string, error: unknown): Error {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const body = errorBody(error)
  const detail = body.message ?? body.error ?? body.code
  if (error.status === 404) return new Error(`PNS handle not found: ${input}`)
  if (error.status === 409) return new Error(`PNS handle is not claimable yet: ${input}`)
  if (error.status === 400) {
    return new Error(`Invalid PNS handle: ${input}${detail ? ` (${detail})` : ''}`)
  }
  return new Error(detail ?? error.message)
}

function requirePieIdentityChannel(value: string | undefined): PieIdentityChannel {
  if (value === 'telegram' || value === 'line' || value === 'kakao') return value
  if (value === undefined) {
    throw new Error(
      'Usage: purr pns by-account --channel <telegram|line|kakao> --account <account>',
    )
  }
  throw new Error(`Invalid --channel: ${value}. Use: telegram, line, kakao`)
}

export async function resolvePieName(input: string): Promise<PnsResolvedHandle> {
  const name = input.trim()
  if (!name) {
    throw new Error('Missing PNS handle')
  }

  const response = await apiGet<ApiEnvelope<PnsResolvedHandle>>(
    `/v2/handles/${encodeURIComponent(name)}`,
  )
  return unwrap(response)
}

export async function lookupPieIdentityByAccount(input: {
  channel: PieIdentityChannel
  account: string
}): Promise<PieIdentityByAccountResult> {
  const account = input.account.trim()
  if (!account) {
    throw new Error('Missing PNS account')
  }

  const query = new URLSearchParams({
    channel: input.channel,
    account,
  })
  const response = await apiGet<ApiEnvelope<PieIdentityByAccountResult>>(
    `${scopedPieIdentityPath('by-account')}?${query.toString()}`,
  )
  return unwrap(response)
}

export async function listPieIdentityAccounts(input: string): Promise<PieIdentityAccountsResult> {
  const name = input.trim()
  if (!name) {
    throw new Error('Missing PNS handle')
  }

  const response = await apiGet<ApiEnvelope<PieIdentityAccountsResult>>(
    scopedPieIdentityPath(`${encodeURIComponent(name)}/accounts`),
  )
  return unwrap(response)
}

export async function getPieIdentityProfile(input: string): Promise<PieIdentityProfile> {
  const name = input.trim()
  if (!name) {
    throw new Error('Missing PNS handle')
  }

  const response = await apiGet<ApiEnvelope<PieIdentityProfile>>(
    scopedPieIdentityPath(`${encodeURIComponent(name)}/profile`),
  )
  return unwrap(response)
}

export async function pnsResolve(handle?: string): Promise<void> {
  if (!handle) {
    throw new Error('Usage: purr pns resolve <handle>')
  }

  try {
    const resolved = await resolvePieName(handle)
    console.log(resolved.walletAddress)
  } catch (error) {
    throw formatLookupError(handle, error)
  }
}

export async function pnsByAccount(args: Record<string, string>): Promise<void> {
  const channel = requirePieIdentityChannel(args.channel)
  const account = args.account?.trim()
  if (!account) {
    throw new Error(
      'Usage: purr pns by-account --channel <telegram|line|kakao> --account <account>',
    )
  }

  try {
    const result = await lookupPieIdentityByAccount({ channel, account })
    if (result.pieName) console.log(result.pieName)
  } catch (error) {
    throw formatLookupError(account, error)
  }
}

export async function pnsAccounts(handle?: string): Promise<void> {
  if (!handle) {
    throw new Error('Usage: purr pns accounts <handle>')
  }

  try {
    const result = await listPieIdentityAccounts(handle)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    throw formatLookupError(handle, error)
  }
}

export async function pnsProfile(handle?: string): Promise<void> {
  if (!handle) {
    throw new Error('Usage: purr pns profile <handle>')
  }

  try {
    const result = await getPieIdentityProfile(handle)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    throw formatLookupError(handle, error)
  }
}
