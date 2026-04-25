/**
 * wallet abi-call — execute an EVM contract call via managed custody.
 *
 * Takes a human-readable function signature and a JSON args array, POSTs
 * to /wallet/execute with { abi, functionName, args, ... }. The server
 * encodes calldata via viem's encodeFunctionData, signs, and broadcasts.
 *
 * Example:
 *   purr wallet abi-call \
 *     --to 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 \
 *     --signature 'register(string)' \
 *     --args '["https://example.com/agent.json"]' \
 *     --chain-id 2818
 */

import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { parseChainId } from '@pieverseio/purr-core/shared'

interface WalletAbiCallResponse {
  ok: boolean
  data?: {
    hash: string
    from: string
    chainId: number
    chainType: string
    transactionId?: string
  }
  error?: string
}

export async function walletAbiCall(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()

  const to = args.to
  if (!to) {
    throw new Error('Missing required argument: --to')
  }
  const signature = args.signature
  if (!signature) {
    throw new Error('Missing required argument: --signature')
  }
  const argsJson = args.args
  if (!argsJson) {
    throw new Error('Missing required argument: --args')
  }
  if (!args['chain-id']) {
    throw new Error('Missing required argument: --chain-id')
  }

  // Parse function name from signature, e.g. "register(string,(string,bytes)[])" → "register"
  const rawSig = signature.trim()
  const nameMatch = rawSig.match(/^(?:function\s+)?(\w+)\s*\(/)
  if (!nameMatch) {
    throw new Error(`Invalid --signature: expected "functionName(types...)", got "${signature}"`)
  }
  const functionName = nameMatch[1]

  // parseAbi on the server expects entries prefixed with "function "
  const abiEntry = rawSig.startsWith('function ') ? rawSig : `function ${rawSig}`

  let parsedArgs: unknown[]
  try {
    const parsed = JSON.parse(argsJson)
    if (!Array.isArray(parsed)) {
      throw new Error('must be a JSON array')
    }
    parsedArgs = parsed
  } catch (err) {
    throw new Error(`Invalid --args: ${(err as Error).message}`)
  }

  const body: Record<string, unknown> = {
    to,
    abi: [abiEntry],
    functionName,
    args: parsedArgs,
    chainId: parseChainId(args['chain-id']),
  }
  if (args.value) {
    body.value = args.value
  }
  if (args['gas-limit']) {
    body.gasLimit = args['gas-limit']
  }

  const res = await apiPost<WalletAbiCallResponse>(
    `/v1/instances/${instanceId}/wallet/execute`,
    body,
  )

  if (!res.data) {
    throw new Error(res.error ?? 'ABI call failed')
  }

  console.log(JSON.stringify(res.data))
}
