/**
 * abi-call primitive — encode an EVM contract call locally and emit a step.
 *
 * This is the builder counterpart to `purr wallet abi-call` (which POSTs to
 * the platform server, which encodes calldata server-side then signs +
 * broadcasts). Here we encode locally with viem and emit a single step the
 * caller can pipe to any executor (`purr execute` for the platform, or
 * `purr ows-execute` for OWS local custody).
 *
 * Used directly as `purr evm abi-call`. Sibling of `purr evm raw` /
 * `purr evm approve` — same group convention: build only, do not sign.
 */

import { type Abi, encodeFunctionData, parseAbi } from 'viem'

import { normalizeHexInt, requireAddress } from '../shared.js'
import type { StepOutput } from '../types.js'

export interface AbiCallArgs {
  to: string
  /**
   * Human-readable function signature, e.g. `"register(string)"` or
   * `"register(string,(string,bytes)[])"`. The leading `function ` keyword
   * is optional — viem `parseAbi` accepts both.
   */
  signature: string
  /** JSON array of args matching the signature, e.g. `'["uri"]'`. */
  argsJson: string
  chainId: number
  value?: string // optional hex wei (default '0x0')
  gasLimit?: string // optional hex
  label?: string
}

export function buildAbiCallStep(args: AbiCallArgs): StepOutput {
  requireAddress(args.to, 'to')

  const rawSig = args.signature.trim()
  if (rawSig.length === 0) {
    throw new Error('--signature must be a non-empty function signature')
  }
  // Function name (for viem's encodeFunctionData functionName arg) — strip
  // any leading "function " and pull up to the first "(".
  const sigBody = rawSig.startsWith('function ') ? rawSig.slice('function '.length) : rawSig
  const nameMatch = sigBody.match(/^(\w+)\s*\(/)
  if (!nameMatch) {
    throw new Error(
      `Invalid --signature: expected "functionName(types...)", got ${JSON.stringify(args.signature)}`,
    )
  }
  const functionName = nameMatch[1]
  // parseAbi requires the "function " prefix.
  const abiEntry = rawSig.startsWith('function ') ? rawSig : `function ${rawSig}`

  let parsedArgs: unknown[]
  try {
    const parsed = JSON.parse(args.argsJson)
    if (!Array.isArray(parsed)) {
      throw new Error('must be a JSON array')
    }
    parsedArgs = parsed
  } catch (err) {
    throw new Error(`Invalid --args: ${err instanceof Error ? err.message : String(err)}`)
  }

  let data: `0x${string}`
  try {
    // parseAbi here returns a runtime-typed array; cast to the generic `Abi`
    // so encodeFunctionData accepts it (viem's strict overloads otherwise
    // require a const-known signature literal).
    const abi = parseAbi([abiEntry]) as Abi
    data = encodeFunctionData({
      abi,
      functionName,
      args: parsedArgs,
    })
  } catch (err) {
    throw new Error(
      `Failed to encode calldata: ${err instanceof Error ? err.message : String(err)}. ` +
        `Verify that --args matches the types in --signature.`,
    )
  }

  return {
    steps: [
      {
        to: args.to,
        data,
        // Normalize decimal-or-hex CLI input to canonical hex (downstream
        // validators require hex).
        value: normalizeHexInt(args.value, 'value') ?? '0x0',
        chainId: args.chainId,
        gasLimit: normalizeHexInt(args.gasLimit, 'gas-limit'),
        label: args.label ?? `${functionName}(...)`,
      },
    ],
  }
}
