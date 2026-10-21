import { createPublicClient, http, parseAbi, zeroAddress } from 'viem'
import { bsc } from 'viem/chains'
import { getMyPieHandle } from './resolve.js'

// SPACE ID Agent ID (.ai) registry on BSC. Registration requires a SPACE ID
// backend signature, so purr only reads it.
export const AGENT_ID_REGISTRY = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' as const

const AGENT_ID_ABI = parseAbi([
  'function isValidHandle(string handle) view returns (bool)',
  'function ownerOfHandle(string handle) view returns (address)',
])

const AI_SUFFIX = '.ai'
const PIE_SUFFIX = '.pie'

export interface AgentIdCheckResult {
  name: string
  handle: string
  valid: boolean
  registered: boolean
  owner: string | null
  reason?: string
}

export interface AgentIdReader {
  isValidHandle(handle: string): Promise<boolean>
  ownerOfHandle(handle: string): Promise<string>
}

function resolveBscRpcUrl(): string {
  return (
    process.env.EVM_RPC_56 ||
    process.env.BNB_RPC_URL ||
    process.env.EVM_RPC_URL ||
    'https://bsc-rpc.publicnode.com'
  )
}

function createAgentIdReader(): AgentIdReader {
  const client = createPublicClient({
    chain: bsc,
    transport: http(resolveBscRpcUrl(), { timeout: 15000, retryCount: 0 }),
  })
  return {
    isValidHandle: (handle) =>
      client.readContract({
        address: AGENT_ID_REGISTRY,
        abi: AGENT_ID_ABI,
        functionName: 'isValidHandle',
        args: [handle],
      }),
    ownerOfHandle: (handle) =>
      client.readContract({
        address: AGENT_ID_REGISTRY,
        abi: AGENT_ID_ABI,
        functionName: 'ownerOfHandle',
        args: [handle],
      }),
  }
}

export function normalizeAgentIdHandle(input: string): string {
  let handle = input.trim().toLowerCase()
  for (const suffix of [AI_SUFFIX, PIE_SUFFIX]) {
    if (handle.endsWith(suffix)) handle = handle.slice(0, -suffix.length)
  }
  if (!handle) throw new Error('Missing .ai handle')
  return handle
}

export async function checkAgentId(
  input: string,
  reader: AgentIdReader = createAgentIdReader(),
): Promise<AgentIdCheckResult> {
  const handle = normalizeAgentIdHandle(input)
  const name = `${handle}${AI_SUFFIX}`
  if (!(await reader.isValidHandle(handle))) {
    return {
      name,
      handle,
      valid: false,
      registered: false,
      owner: null,
      reason: '.ai handles use only lowercase letters and digits, 3-20 characters',
    }
  }

  const owner = await reader.ownerOfHandle(handle)
  const registered = owner.toLowerCase() !== zeroAddress
  return { name, handle, valid: true, registered, owner: registered ? owner : null }
}

export async function pnsAiCheck(name?: string): Promise<void> {
  const input = name ?? (await getMyPieHandle()).handle
  console.log(JSON.stringify(await checkAgentId(input), null, 2))
}
