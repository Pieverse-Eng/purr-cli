import { readFileSync } from 'node:fs'
import { apiPost, resolveCredentials } from '../api-client.js'
import { requireAddress } from '../shared.js'

interface WalletSignTypedDataResponse {
  ok: boolean
  data: {
    address: string
    signature: string
  }
  error?: string
}

function parseJsonInput(value: string): unknown {
  // Heuristic: if it looks like a file path, try reading it first.
  // Safe because we fall through to JSON.parse if the file doesn't exist.
  try {
    if (value.startsWith('/') || value.startsWith('./') || value.startsWith('~')) {
      const content = readFileSync(value, 'utf-8')
      return JSON.parse(content)
    }
  } catch {
    // Not a file or unreadable — try parsing as raw JSON
  }

  try {
    return JSON.parse(value)
  } catch {
    throw new Error(
      '--data must be valid JSON or a path to a JSON file. Example: --data \'{"domain":...,"types":...,"primaryType":"...","message":...}\'',
    )
  }
}

export async function walletSignTypedData(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()

  const address = args.address
  if (!address) {
    throw new Error('Missing required argument: --address')
  }
  const expectedAddress = requireAddress(address, 'address')
  const dataArg = args.data
  if (!dataArg) {
    throw new Error('Missing required argument: --data (JSON string or file path)')
  }

  const parsed = parseJsonInput(dataArg) as {
    domain?: unknown
    types?: unknown
    primaryType?: string
    message?: unknown
  }

  if (!parsed.domain || !parsed.types || !parsed.primaryType || !parsed.message) {
    throw new Error('--data must contain: domain, types, primaryType, message (EIP-712 typed data)')
  }

  const res = await apiPost<WalletSignTypedDataResponse>(
    `/v1/instances/${instanceId}/wallet/sign-typed-data`,
    {
      domain: parsed.domain,
      types: parsed.types,
      primaryType: parsed.primaryType,
      message: parsed.message,
    },
  )

  if (!res.ok) {
    throw new Error(res.error ?? 'Failed to sign typed data')
  }
  if (res.data.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Typed data signature returned unexpected address ${res.data.address}; expected ${expectedAddress}`,
    )
  }

  console.log(JSON.stringify(res.data))
}
