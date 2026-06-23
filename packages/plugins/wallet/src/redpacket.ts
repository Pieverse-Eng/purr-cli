import { ApiClientError, apiGet, apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { isAddress } from 'viem'

const REDPACKET_TOKEN_DECIMALS = 6
const REDPACKET_TOKEN_SYMBOL = 'USDT0'

interface ApiEnvelope<T> {
  ok: boolean
  data: T
  error?: string
  code?: string
}

interface ApiErrorEnvelope {
  ok?: false
  code?: string
  error?: string
  data?: unknown
}

interface Identity {
  handle: string | null
  renderedHandle: string | null
  walletAddress: string
  instanceId?: string | null
  ownerUserId?: string | null
}

interface TokenInfo {
  chainId: number
  address: string
  symbol: string
  decimals: number
}

interface RedpacketCreateResult {
  envelopeId: string
  expiresAt: string
  amountBaseUnits: string
  token: TokenInfo
  sender: Identity
  recipient: Identity
  ackText: string
  notification?: unknown
}

interface PendingEnvelope {
  envelopeId: string
  amountBaseUnits: string
  expiresAt: string
  token: TokenInfo
  sender: Identity
}

interface SentEnvelope {
  envelopeId: string
  amountBaseUnits: string
  status: string
  createdAt: string
  expiresAt: string
  claimedAt: string | null
  expiredAt: string | null
  claimTxHash: string | null
  token: TokenInfo
  recipient: Identity
}

interface ClaimResult {
  envelopeId: string
  txHash: string
  amountBaseUnits: string
  sender: Identity
  ackText: string
}

interface FailedClaim {
  envelopeId: string
  error: string
  code?: string
}

interface PendingResponse {
  pending: PendingEnvelope[]
}

interface SentResponse {
  sent: SentEnvelope[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

interface ClaimResponse {
  claimed: ClaimResult[]
  failed: FailedClaim[]
  ackText: string | null
}

interface WalletEnsureResponse {
  address: string
  chainId: number
  chainType: string
  createdNow: boolean
}

interface NormalizedAmount {
  amount: string
  symbol: string
  amountBaseUnits: string
}

class RedpacketInputError extends Error {
  readonly exitCode = 1
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50
  if (!/^\d+$/.test(value)) throw new RedpacketInputError('--limit must be a positive integer')
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new RedpacketInputError('--limit must be between 1 and 100')
  }
  return parsed
}

function parseNonNegativeInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new RedpacketInputError(`--${name} must be a non-negative integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new RedpacketInputError(`--${name} must be a non-negative integer`)
  }
  return parsed
}

function formatBaseUnits(value: string, decimals: number): string {
  const amount = BigInt(value)
  const scale = 10n ** BigInt(decimals)
  const whole = amount / scale
  const fraction = amount % scale
  if (fraction === 0n) return whole.toString()
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole.toString()}.${fractionText}`
}

function parseAmountToBaseUnits(raw: string): string {
  let text = raw.trim().replace(/,/g, '')
  if (text.startsWith('$')) text = text.slice(1).trim()
  text = text.replace(/\s*(usdt0|usdt|usd)\s*$/i, '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new RedpacketInputError('--amount must be a decimal USDT0 amount, e.g. 0.1')
  }
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > REDPACKET_TOKEN_DECIMALS) {
    throw new RedpacketInputError(`--amount supports at most ${REDPACKET_TOKEN_DECIMALS} decimals`)
  }
  const baseUnits =
    BigInt(whole) * 10n ** BigInt(REDPACKET_TOKEN_DECIMALS) +
    BigInt(fraction.padEnd(REDPACKET_TOKEN_DECIMALS, '0') || '0')
  if (baseUnits <= 0n) throw new RedpacketInputError('--amount must be greater than zero')
  return baseUnits.toString()
}

function resolveAmount(args: Record<string, string>): string {
  const amount = args.amount
  if (amount !== undefined) return parseAmountToBaseUnits(amount)
  throw new RedpacketInputError('Missing required argument: --amount')
}

function assertSendRecipient(recipient: string): string {
  const trimmed = recipient.trim()
  if (isAddress(trimmed)) return trimmed
  if (trimmed.endsWith('.pie')) {
    const handle = trimmed.slice(0, -'.pie'.length)
    const valid =
      /^[a-z0-9-]{5,30}$/.test(handle) &&
      !handle.startsWith('-') &&
      !handle.endsWith('-') &&
      !handle.includes('--')
    if (valid) return trimmed
  }
  throw new RedpacketInputError(
    '--recipient must be a valid lowercase .pie handle or raw EVM address; do not use bare names or @ handles',
  )
}

function parseChannel(raw: string | undefined): 'telegram' | 'line' | undefined {
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'telegram' || normalized === 'line') return normalized
  throw new RedpacketInputError('--channel must be telegram or line')
}

function parseEnvelopeIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0) throw new RedpacketInputError('--envelope-ids must include at least one id')
  return ids
}

function identityLabel(identity: Identity): string {
  return identity.renderedHandle ?? identity.handle ?? identity.walletAddress
}

function normalizeAmount(amountBaseUnits: string, token: TokenInfo): NormalizedAmount {
  return {
    amount: formatBaseUnits(amountBaseUnits, token.decimals),
    symbol: token.symbol,
    amountBaseUnits,
  }
}

function normalizeCreate(result: RedpacketCreateResult) {
  return {
    text: result.ackText,
    envelopeId: result.envelopeId,
    ...normalizeAmount(result.amountBaseUnits, result.token),
    sender: identityLabel(result.sender),
    senderWalletAddress: result.sender.walletAddress,
    recipient: identityLabel(result.recipient),
    recipientWalletAddress: result.recipient.walletAddress,
    expiresAt: result.expiresAt,
    notification: result.notification,
  }
}

function normalizePendingEnvelope(envelope: PendingEnvelope) {
  return {
    envelopeId: envelope.envelopeId,
    ...normalizeAmount(envelope.amountBaseUnits, envelope.token),
    sender: identityLabel(envelope.sender),
    senderWalletAddress: envelope.sender.walletAddress,
    expiresAt: envelope.expiresAt,
  }
}

function normalizeClaimResult(claim: ClaimResult) {
  return {
    envelopeId: claim.envelopeId,
    txHash: claim.txHash,
    amount: formatBaseUnits(claim.amountBaseUnits, REDPACKET_TOKEN_DECIMALS),
    symbol: REDPACKET_TOKEN_SYMBOL,
    amountBaseUnits: claim.amountBaseUnits,
    sender: identityLabel(claim.sender),
    senderWalletAddress: claim.sender.walletAddress,
  }
}

function normalizeClaimResponse(data: ClaimResponse) {
  return {
    text: data.ackText,
    claimedCount: data.claimed.length,
    failedCount: data.failed.length,
    claimed: data.claimed.map(normalizeClaimResult),
    failed: data.failed,
  }
}

function normalizeSentEnvelope(envelope: SentEnvelope) {
  return {
    envelopeId: envelope.envelopeId,
    ...normalizeAmount(envelope.amountBaseUnits, envelope.token),
    status: envelope.status,
    recipient: identityLabel(envelope.recipient),
    recipientWalletAddress: envelope.recipient.walletAddress,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    claimedAt: envelope.claimedAt,
    expiredAt: envelope.expiredAt,
    claimTxHash: envelope.claimTxHash,
  }
}

function shouldRaw(args: Record<string, string>): boolean {
  return args.raw === 'true'
}

function apiErrorEnvelope(err: ApiClientError): ApiErrorEnvelope {
  if (typeof err.body === 'object' && err.body !== null && !Array.isArray(err.body)) {
    return err.body as ApiErrorEnvelope
  }
  return { ok: false, error: err.bodyText || err.message }
}

async function depositHint() {
  const { instanceId } = resolveCredentials()
  const res = await apiPost<ApiEnvelope<WalletEnsureResponse>>(
    `/v1/instances/${instanceId}/wallet/ensure`,
    { chainType: 'ethereum', chainId: 196 },
  )
  if (!res.ok) return undefined
  return {
    chainId: 196,
    token: 'USDT0',
    address: res.data.address,
  }
}

async function printApiError(err: ApiClientError): Promise<void> {
  const body = apiErrorEnvelope(err)
  const out: Record<string, unknown> = { ok: false, ...body }
  if (body.code === 'REDPACKET_INSUFFICIENT_BALANCE') {
    out.hint = 'Deposit XLayer USDT0 to the instance wallet, then retry.'
    try {
      out.deposit = await depositHint()
    } catch (depositErr) {
      out.depositError = depositErr instanceof Error ? depositErr.message : String(depositErr)
    }
  }
  console.log(JSON.stringify(out, null, 2))
  process.exitCode = 1
}

async function getPending(senderHandle?: string): Promise<PendingEnvelope[]> {
  const { instanceId } = resolveCredentials()
  const query = senderHandle ? `?senderHandle=${encodeURIComponent(senderHandle)}` : ''
  const res = await apiGet<ApiEnvelope<PendingResponse>>(
    `/v2/instances/${instanceId}/redpackets/pending${query}`,
  )
  if (!res.ok) throw new Error(res.error ?? 'Failed to fetch pending redpackets')
  return res.data.pending
}

export async function redpacketSend(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const recipient = assertSendRecipient(args.recipient ?? '')
  const amountBaseUnits = resolveAmount(args)
  const channel = parseChannel(args.channel)
  const body: Record<string, unknown> = { recipient, amountBaseUnits }
  if (channel) body.senderChatContext = { channel }

  try {
    const res = await apiPost<ApiEnvelope<RedpacketCreateResult>>(
      `/v2/instances/${instanceId}/redpackets`,
      body,
    )
    if (!res.ok) throw new Error(res.error ?? 'Failed to send redpacket')
    console.log(
      JSON.stringify(
        shouldRaw(args) ? res : { ok: true, data: normalizeCreate(res.data) },
        null,
        2,
      ),
    )
  } catch (err) {
    if (err instanceof ApiClientError) {
      await printApiError(err)
      return
    }
    throw err
  }
}

export async function redpacketPending(args: Record<string, string>): Promise<void> {
  try {
    const sender = args.sender
    const { instanceId } = resolveCredentials()
    const query = sender ? `?senderHandle=${encodeURIComponent(sender)}` : ''
    const res = await apiGet<ApiEnvelope<PendingResponse>>(
      `/v2/instances/${instanceId}/redpackets/pending${query}`,
    )
    if (!res.ok) throw new Error(res.error ?? 'Failed to fetch pending redpackets')
    console.log(
      JSON.stringify(
        shouldRaw(args)
          ? res
          : {
              ok: true,
              data: {
                count: res.data.pending.length,
                pending: res.data.pending.map(normalizePendingEnvelope),
              },
            },
        null,
        2,
      ),
    )
  } catch (err) {
    if (err instanceof ApiClientError) {
      await printApiError(err)
      return
    }
    throw err
  }
}

export async function redpacketClaim(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const sender = args.sender
  const envelopeIds = parseEnvelopeIds(args['envelope-ids'])
  if (sender && envelopeIds) {
    throw new RedpacketInputError('Use either --sender or --envelope-ids, not both')
  }

  try {
    let claimIds = envelopeIds
    if (sender) {
      const pending = await getPending(sender)
      claimIds = pending.map((envelope) => envelope.envelopeId)
      if (claimIds.length === 0) {
        const emptyRaw = { ok: true, data: { claimed: [], failed: [], ackText: null } }
        console.log(
          JSON.stringify(
            shouldRaw(args)
              ? emptyRaw
              : {
                  ok: true,
                  data: {
                    text: null,
                    claimedCount: 0,
                    failedCount: 0,
                    claimed: [],
                    failed: [],
                  },
                },
            null,
            2,
          ),
        )
        return
      }
    }

    const res = await apiPost<ApiEnvelope<ClaimResponse>>(
      `/v2/instances/${instanceId}/redpackets/claim`,
      claimIds ? { envelopeIds: claimIds } : {},
    )
    if (!res.ok) throw new Error(res.error ?? 'Failed to claim redpackets')
    console.log(
      JSON.stringify(
        shouldRaw(args) ? res : { ok: true, data: normalizeClaimResponse(res.data) },
        null,
        2,
      ),
    )
  } catch (err) {
    if (err instanceof ApiClientError) {
      await printApiError(err)
      return
    }
    throw err
  }
}

export async function redpacketSent(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()
  const limit = parseLimit(args.limit)
  const offset = parseNonNegativeInt(args.offset, 'offset', 0)

  try {
    const res = await apiGet<ApiEnvelope<SentResponse>>(
      `/v2/instances/${instanceId}/redpackets/sent?limit=${limit}&offset=${offset}`,
    )
    if (!res.ok) throw new Error(res.error ?? 'Failed to fetch sent redpackets')
    console.log(
      JSON.stringify(
        shouldRaw(args)
          ? res
          : {
              ok: true,
              data: {
                total: res.data.total,
                limit: res.data.limit,
                offset: res.data.offset,
                hasMore: res.data.hasMore,
                sent: res.data.sent.map(normalizeSentEnvelope),
              },
            },
        null,
        2,
      ),
    )
  } catch (err) {
    if (err instanceof ApiClientError) {
      await printApiError(err)
      return
    }
    throw err
  }
}

export const __testing = {
  assertSendRecipient,
  formatBaseUnits,
  parseAmountToBaseUnits,
  parseEnvelopeIds,
  parseLimit,
  resolveAmount,
}
