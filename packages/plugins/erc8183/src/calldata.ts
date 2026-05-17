// Pure ERC-8183 calldata builders. No I/O, no plugin awareness.

import { type Hex, encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem'

export const ERC8183_ABI = parseAbi([
  'function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)',
  'function setBudget(uint256 jobId,uint256 amount,bytes optParams)',
  'function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)',
  'function complete(uint256 jobId,bytes32 reason,bytes optParams)',
  'function claimRefund(uint256 jobId)',
  'function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])

const ZERO: Hex = '0x0000000000000000000000000000000000000000'
const EMPTY: Hex = '0x'

export interface CreateJobArgs {
  provider: string
  evaluator: string
  expiredAt: number
  description: string
  hook?: string
}

export interface JobIdArg {
  jobId: string
}

export interface BudgetArgs extends JobIdArg {
  amountWei: string
  optParams?: Hex
}

export interface CompleteArgs extends JobIdArg {
  reason: Hex
  optParams?: Hex
}

export function encodeCreateJob(a: CreateJobArgs): Hex {
  return encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'createJob',
    args: [
      address(a.provider, 'provider'),
      address(a.evaluator, 'evaluator'),
      BigInt(a.expiredAt),
      a.description,
      address(a.hook ?? ZERO, 'hook'),
    ],
  })
}

export function encodeSetBudget(a: BudgetArgs): Hex {
  return encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'setBudget',
    args: [BigInt(a.jobId), BigInt(a.amountWei), a.optParams ?? EMPTY],
  })
}

export function encodeFund(a: BudgetArgs): Hex {
  return encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'fund',
    args: [BigInt(a.jobId), BigInt(a.amountWei), a.optParams ?? EMPTY],
  })
}

export function encodeComplete(a: CompleteArgs): Hex {
  return encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'complete',
    args: [BigInt(a.jobId), a.reason, a.optParams ?? EMPTY],
  })
}

export function encodeClaimRefund(a: JobIdArg): Hex {
  return encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'claimRefund',
    args: [BigInt(a.jobId)],
  })
}

function address(value: string, field: string): `0x${string}` {
  if (!isAddress(value)) throw new Error(`${field} must be an EVM address: ${value}`)
  return getAddress(value) as `0x${string}`
}
