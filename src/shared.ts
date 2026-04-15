import { encodeFunctionData, isAddress, maxUint256, parseAbi } from 'viem'
import type { TxStep } from './types.js'

export const NATIVE_EVM = '0x0000000000000000000000000000000000000000'

export const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
])

export function isNative(token: string): boolean {
  if (token === '') return true
  const t = token.toLowerCase()
  if (t === NATIVE_EVM.toLowerCase()) return true
  // Accept any 0x-prefixed all-zeros string (agents sometimes add extra zeros)
  return /^0x0+$/.test(t)
}

export function parseBigInt(value: string, name: string): bigint {
  let n: bigint
  try {
    n = BigInt(value)
  } catch {
    throw new Error(`Invalid ${name}: "${value}" — must be a positive integer (wei)`)
  }
  if (n <= 0n) {
    throw new Error(`${name} must be greater than 0`)
  }
  return n
}

/**
 * Build a conditional ERC-20 approval step (maxUint256 approve, skipped if allowance >= requiredWei).
 */
export function buildApprovalStep(
  token: string,
  spender: string,
  requiredWei: string,
  chainId: number,
  label: string,
): TxStep {
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [spender as `0x${string}`, maxUint256],
  })
  return {
    to: token,
    data: approveData,
    value: '0x0',
    chainId,
    label,
    conditional: {
      type: 'allowance_lt',
      token,
      spender,
      amount: requiredWei,
    },
  }
}

export function requireAddress(value: string, name: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${name}: "${value}" — must be a valid EVM address (0x + 40 hex chars)`)
  }
  return value
}

export function parseChainId(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid --chain-id: "${value}" — must be a positive integer`)
  }
  return n
}

/**
 * Normalize a gas limit / value / amount string to canonical 0x-prefixed hex.
 * Accepts decimal ("500000") or hex ("0x7a120") input — agents pass either
 * form, but step JSON consumers (api-server step-executor + ows-execute) both
 * require hex. Returns undefined when input is undefined so callers can spread
 * with `...rest`.
 */
/**
 * Parse OWS EVM signature result into viem-compatible {r, s, v}.
 *
 * The OWS Node SDK contract (docs/sdk-node.md) is: `SignResult { signature: string, recoveryId?: number }`.
 * The installed v1.2.4 returns signature = 65 bytes (r||s||v, v ∈ {0,1}) AND
 * recoveryId = v + 27 alongside — redundant but present. To be robust against
 * future SDK versions that might drop v from `signature` and rely on
 * recoveryId, accept both shapes.
 */
export function parseEvmSig(
  sig: string,
  recoveryId: number | undefined | null,
): { r: `0x${string}`; s: `0x${string}`; v: bigint } {
  const raw = sig.replace(/^0x/, '')
  if (raw.length === 130) {
    const r = `0x${raw.slice(0, 64)}` as `0x${string}`
    const s = `0x${raw.slice(64, 128)}` as `0x${string}`
    const vRaw = Number.parseInt(raw.slice(128, 130), 16)
    const v = vRaw < 27 ? BigInt(vRaw + 27) : BigInt(vRaw)
    return { r, s, v }
  }
  if (raw.length === 128) {
    if (recoveryId == null) {
      throw new Error('OWS returned a 64-byte EVM signature without recoveryId; cannot determine v')
    }
    const r = `0x${raw.slice(0, 64)}` as `0x${string}`
    const s = `0x${raw.slice(64, 128)}` as `0x${string}`
    const v = recoveryId < 27 ? BigInt(recoveryId + 27) : BigInt(recoveryId)
    return { r, s, v }
  }
  throw new Error(
    `Unexpected EVM signature length from OWS: ${raw.length / 2} bytes (expected 64 or 65)`,
  )
}

export function normalizeHexInt(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  let n: bigint
  try {
    n = BigInt(value) // accepts both decimal and 0x-hex strings
  } catch {
    throw new Error(`Invalid ${name}: "${value}" — must be an integer (decimal or 0x-prefixed hex)`)
  }
  if (n < 0n) {
    throw new Error(`${name} must be non-negative, got ${value}`)
  }
  return `0x${n.toString(16)}`
}
