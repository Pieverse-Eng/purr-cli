import { ApiClientError, apiGet } from '@pieverseio/purr-core/api-client'

export interface PnsResolvedHandle {
  kind: 'handle'
  handle: string
  renderedHandle: string
  walletAddress: string
}

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

interface ApiErrorBody {
  error?: string
  code?: string
}

function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error ?? envelope.code ?? 'PNS lookup failed')
  }
  return envelope.data
}

function errorBody(error: ApiClientError): ApiErrorBody {
  return error.body && typeof error.body === 'object' ? (error.body as ApiErrorBody) : {}
}

function formatLookupError(input: string, error: unknown): Error {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const body = errorBody(error)
  const detail = body.error ?? body.code
  if (error.status === 404) return new Error(`PNS handle not found: ${input}`)
  if (error.status === 409) return new Error(`PNS handle is not claimable yet: ${input}`)
  if (error.status === 400) {
    return new Error(`Invalid PNS handle: ${input}${detail ? ` (${detail})` : ''}`)
  }
  return new Error(detail ?? error.message)
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
