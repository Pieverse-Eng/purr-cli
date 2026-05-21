/**
 * `purr wallet sign-okx-x402` — sign an OKX-x402 helper-pattern payment envelope.
 *
 * Pieverse helper-pattern endpoints (treasure-code, paid red-packet, etc.)
 * return an "expected" JSON envelope from /payment-required and then accept
 * an OKX-x402 `X-PAYMENT` header (base64) on the follow-up POST. Constructing
 * that header by hand involves multiple footguns (forgetting `payload.accepted`,
 * base64 vs base64url, BigInt JSON-serialization, EIP-712 domain reconstruction)
 * so this subcommand wraps the whole flow into a single CLI invocation.
 *
 * v1 is Privy-only: the underlying signTypedData call delegates to the
 * platform's `POST /v1/instances/:id/wallet/sign-typed-data` endpoint, mirroring
 * the existing `wallet sign-typed-data` subcommand. When that dispatch becomes
 * auth-mode-aware (OWS local custody), this subcommand should reuse the same
 * helper rather than re-branching.
 *
 * See issue #24 for the full spec.
 */

import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { getX402TokenDomain } from '@pieverseio/purr-core/x402-tokens'
import { isAddress } from 'viem'

// ---------------------------------------------------------------------------
// Exit codes — issue #24 contract
// ---------------------------------------------------------------------------

const EXIT_USER_INPUT = 1
const EXIT_SIGNER = 2
const EXIT_SDK = 3

// EIP-3009-style helper-pattern requirements always use the OKX-blessed
// 5-minute timeout. If we ever need to override this per call site, add a
// `--max-timeout-seconds` flag — but the platform-side endpoint hardcodes 300
// today (see purrfectclaw-platform/services/merchant-okx-x402.ts), so matching
// keeps the two sides in sync.
const DEFAULT_MAX_TIMEOUT_SECONDS = 300

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface Expected {
  amountBaseUnits: string
  chainId: number
  tokenAddress: string
  payTo: string
  // The following fields are accepted but unused for signing — they're
  // here so consumers don't have to strip the envelope.
  orderCode?: string
  description?: string
  resourceUrl?: string
}

class UserInputError extends Error {
  readonly exitCode = EXIT_USER_INPUT
}

class SignerError extends Error {
  readonly exitCode = EXIT_SIGNER
}

class SdkError extends Error {
  readonly exitCode = EXIT_SDK
}

function parseExpected(raw: string): Expected {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UserInputError('--expected must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UserInputError('--expected must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>

  const amountBaseUnits = obj.amountBaseUnits
  if (typeof amountBaseUnits !== 'string' || amountBaseUnits.length === 0) {
    throw new UserInputError('--expected.amountBaseUnits required (string)')
  }
  const chainId = obj.chainId
  if (typeof chainId !== 'number' || !Number.isFinite(chainId) || chainId <= 0) {
    throw new UserInputError('--expected.chainId required (positive number)')
  }
  const tokenAddress = obj.tokenAddress
  if (typeof tokenAddress !== 'string' || !isAddress(tokenAddress)) {
    throw new UserInputError('--expected.tokenAddress required (0x EVM address)')
  }
  const payTo = obj.payTo
  if (typeof payTo !== 'string' || !isAddress(payTo)) {
    throw new UserInputError('--expected.payTo required (0x EVM address)')
  }

  return {
    amountBaseUnits,
    chainId,
    tokenAddress,
    payTo,
    orderCode: typeof obj.orderCode === 'string' ? obj.orderCode : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    resourceUrl: typeof obj.resourceUrl === 'string' ? obj.resourceUrl : undefined,
  }
}

// ---------------------------------------------------------------------------
// Build PaymentRequirements — either from --payment-required-header (decoded)
// or reconstructed locally from --expected.
// ---------------------------------------------------------------------------

interface PaymentRequirements {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

async function buildPaymentRequirements(
  expected: Expected,
  headerOverride: string | undefined,
): Promise<PaymentRequirements> {
  if (headerOverride) {
    // Caller already has the canonical PaymentRequirements[] from a 402
    // response — trust that over local reconstruction.
    const { decodePaymentRequiredHeader } = await import('@okxweb3/x402-core/http')
    let decoded: { accepts?: PaymentRequirements[] }
    try {
      decoded = decodePaymentRequiredHeader(headerOverride) as {
        accepts?: PaymentRequirements[]
      }
    } catch (err) {
      throw new SdkError(
        `Failed to decode --payment-required-header: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const accepts = decoded?.accepts
    if (!Array.isArray(accepts) || accepts.length === 0) {
      throw new SdkError('--payment-required-header decoded to empty accepts array')
    }
    return accepts[0]
  }

  const domain = getX402TokenDomain(expected.chainId, expected.tokenAddress)
  if (!domain) {
    throw new UserInputError(
      `Token ${expected.tokenAddress} on chain ${expected.chainId} is not in the x402 registry. ` +
        `Either pass --payment-required-header with the canonical requirements, ` +
        `or extend packages/core/src/x402-tokens.ts.`,
    )
  }

  return {
    scheme: 'exact',
    network: `eip155:${expected.chainId}`,
    amount: expected.amountBaseUnits,
    asset: expected.tokenAddress,
    payTo: expected.payTo,
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: { name: domain.name, version: domain.version },
  }
}

// ---------------------------------------------------------------------------
// ClientEvmSigner that delegates to the platform's sign-typed-data endpoint.
//
// Mirrors the wire contract of `wallet sign-typed-data` exactly (same path,
// same body shape, same response shape). If that endpoint ever gains an OWS
// local-custody branch, both subcommands should pivot together.
// ---------------------------------------------------------------------------

interface SignTypedDataResponse {
  ok: boolean
  data: { address: string; signature: string }
  error?: string
}

interface WalletEnsureResponse {
  ok: boolean
  data: { address: string; chainId: number; chainType: string }
  error?: string
}

async function resolveAgentEvmAddress(instanceId: string, chainId: number): Promise<string> {
  const res = await apiPost<WalletEnsureResponse>(`/v1/instances/${instanceId}/wallet/ensure`, {
    chainType: 'ethereum',
    chainId,
  })
  if (!res.ok) {
    throw new SignerError(res.error ?? 'Failed to resolve agent EVM wallet address')
  }
  return res.data.address
}

interface ClientEvmSigner {
  readonly address: `0x${string}`
  signTypedData(message: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }): Promise<`0x${string}`>
}

function makePlatformSigner(instanceId: string, address: `0x${string}`): ClientEvmSigner {
  return {
    address,
    async signTypedData(typedData) {
      // OKX scheme passes EIP712Domain into `types` to describe the domain
      // struct; the platform sign-typed-data endpoint accepts but does not
      // require it. Forward as-is.
      const res = await apiPost<SignTypedDataResponse>(
        `/v1/instances/${instanceId}/wallet/sign-typed-data`,
        {
          domain: typedData.domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          // BigInt values from the scheme (e.g. amount as bigint) need to be
          // string-encoded for JSON transport. The OKX scheme produces strings
          // already, but defend against future drift.
          message: stringifyBigInts(typedData.message) as Record<string, unknown>,
        },
      )
      if (!res.ok) {
        throw new SignerError(res.error ?? 'sign-typed-data failed')
      }
      if (res.data.address.toLowerCase() !== address.toLowerCase()) {
        throw new SignerError(
          `signer address mismatch: requested ${address}, got ${res.data.address}`,
        )
      }
      const sig = res.data.signature
      return (sig.startsWith('0x') ? sig : `0x${sig}`) as `0x${string}`
    },
  }
}

function stringifyBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(stringifyBigInts)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = stringifyBigInts(v)
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SignOkxX402Output {
  paymentSignature: string
  payerAddress: string
  authorizationNonce: string
}

export async function walletSignOkxX402(args: Record<string, string>): Promise<void> {
  let result: SignOkxX402Output
  try {
    result = await runSignOkxX402(args)
  } catch (err) {
    const exitCode = getExitCode(err)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(exitCode)
  }
  console.log(JSON.stringify(result))
}

function getExitCode(err: unknown): number {
  if (err instanceof UserInputError) return EXIT_USER_INPUT
  if (err instanceof SignerError) return EXIT_SIGNER
  if (err instanceof SdkError) return EXIT_SDK
  return 1
}

async function runSignOkxX402(args: Record<string, string>): Promise<SignOkxX402Output> {
  const expectedRaw = args.expected
  if (!expectedRaw) {
    throw new UserInputError(
      'Missing --expected (JSON envelope from /payment-required). Example: --expected \'{"amountBaseUnits":"1","chainId":196,"tokenAddress":"0x...","payTo":"0x..."}\'',
    )
  }
  const expected = parseExpected(expectedRaw)

  // --chain-id is optional — if present, it must match expected.chainId.
  if (args['chain-id']) {
    const argChainId = Number.parseInt(args['chain-id'], 10)
    if (!Number.isFinite(argChainId) || argChainId !== expected.chainId) {
      throw new UserInputError(
        `--chain-id ${args['chain-id']} does not match --expected.chainId ${expected.chainId}`,
      )
    }
  }

  const paymentRequirements = await buildPaymentRequirements(
    expected,
    args['payment-required-header'],
  )

  const { instanceId } = resolveCredentials()
  const payerAddress = (await resolveAgentEvmAddress(instanceId, expected.chainId)) as `0x${string}`
  const signer = makePlatformSigner(instanceId, payerAddress)

  // Dynamic-import the SDK so users who don't invoke this command don't pay
  // the bundle cost. Both packages are pure ESM with no native deps.
  let ExactEvmScheme: typeof import('@okxweb3/x402-evm').ExactEvmScheme
  let encodePaymentSignatureHeader: typeof import('@okxweb3/x402-core/http').encodePaymentSignatureHeader
  try {
    ;({ ExactEvmScheme } = await import('@okxweb3/x402-evm'))
    ;({ encodePaymentSignatureHeader } = await import('@okxweb3/x402-core/http'))
  } catch (err) {
    throw new SdkError(
      `Failed to load OKX x402 SDK: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ExactEvmScheme.createPaymentPayload returns a bare `{x402Version, payload}`
  // — it intentionally does NOT include `accepted`, because the HTTP wrapper
  // would normally add that downstream. Helper-pattern OKX endpoints index
  // `payload.accepted.{scheme,network}` during verification, so we must
  // enrich the result before encoding.
  let bareSigned: { x402Version: number; payload: Record<string, unknown> }
  try {
    bareSigned = (await new ExactEvmScheme(signer).createPaymentPayload(
      2,
      paymentRequirements as unknown as Parameters<
        InstanceType<typeof ExactEvmScheme>['createPaymentPayload']
      >[1],
      {},
    )) as { x402Version: number; payload: Record<string, unknown> }
  } catch (err) {
    if (err instanceof SignerError) throw err
    throw new SdkError(
      `ExactEvmScheme.createPaymentPayload failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const fullPayload = {
    x402Version: bareSigned.x402Version,
    payload: bareSigned.payload,
    accepted: paymentRequirements,
  }

  let paymentSignature: string
  try {
    paymentSignature = encodePaymentSignatureHeader(
      fullPayload as unknown as Parameters<typeof encodePaymentSignatureHeader>[0],
    )
  } catch (err) {
    throw new SdkError(
      `encodePaymentSignatureHeader failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // EIP-3009 nonce — pulled from the payload for idempotency-key purposes.
  // Permit2 payloads would have a different structure; for v1 we only support
  // EIP-3009, so the field is guaranteed to be present.
  const authorizationNonce = extractAuthorizationNonce(bareSigned.payload)

  return { paymentSignature, payerAddress, authorizationNonce }
}

function extractAuthorizationNonce(payload: Record<string, unknown>): string {
  const auth = payload.authorization
  if (auth && typeof auth === 'object' && 'nonce' in auth) {
    const nonce = (auth as { nonce?: unknown }).nonce
    if (typeof nonce === 'string') return nonce
  }
  // Permit2 path or future scheme — leave empty rather than guessing.
  return ''
}

// Internal exports for tests
export const __testing = {
  parseExpected,
  buildPaymentRequirements,
  stringifyBigInts,
  extractAuthorizationNonce,
  UserInputError,
  SignerError,
  SdkError,
  EXIT_USER_INPUT,
  EXIT_SIGNER,
  EXIT_SDK,
  DEFAULT_MAX_TIMEOUT_SECONDS,
}
