// ERC-8183 calldata builders. Pure functions — no I/O.
// Server returns the intent; these encode the next on-chain action.

import { createHash } from 'node:crypto'
import { type Hex, encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem'
import type { TxStep } from '@pieverseio/purr-core/types'
import { isNative } from '@pieverseio/purr-core/shared'
import type { Intent } from './api.js'

export const LABELS = {
  createJob: 'ERC-8183 createJob',
  setBudget: 'ERC-8183 setBudget',
  approve: 'ERC-8183 approve payment token',
  fund: 'ERC-8183 fund',
  complete: 'ERC-8183 complete',
  claimRefund: 'ERC-8183 claimRefund',
} as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const EMPTY_BYTES: Hex = '0x'

export const ERC8183_ABI = parseAbi([
  'function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)',
  'function setBudget(uint256 jobId,uint256 amount,bytes optParams)',
  'function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)',
  'function complete(uint256 jobId,bytes32 reason,bytes optParams)',
  'function claimRefund(uint256 jobId)',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])

const ERC20_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])

export function createJobStep(intent: Intent): TxStep {
  const expiredAt = Math.floor(Date.now() / 1000) + intent.jobExpirationSeconds
  return {
    to: addr(intent.contractAddress, 'contractAddress'),
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'createJob',
      args: [
        addr(intent.providerWalletAddress, 'providerWalletAddress'),
        addr(intent.evaluatorWalletAddress, 'evaluatorWalletAddress'),
        BigInt(expiredAt),
        intent.jobUri,
        addr(intent.hookAddress || ZERO_ADDRESS, 'hookAddress'),
      ],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: LABELS.createJob,
  }
}

export function fundJobSteps(intent: Intent, jobId: string): TxStep[] {
  const budget = requireBudget(intent)
  const contract = addr(intent.contractAddress, 'contractAddress')
  const steps: TxStep[] = [
    {
      to: contract,
      data: encodeFunctionData({
        abi: ERC8183_ABI,
        functionName: 'setBudget',
        args: [BigInt(jobId), budget, EMPTY_BYTES],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: LABELS.setBudget,
    },
  ]

  if (intent.paymentTokenAddress && !isNative(intent.paymentTokenAddress) && budget > 0n) {
    const token = addr(intent.paymentTokenAddress, 'paymentTokenAddress')
    steps.push({
      to: token,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [contract, budget],
      }),
      value: '0x0',
      chainId: intent.chainId,
      label: LABELS.approve,
      conditional: {
        type: 'allowance_lt',
        token,
        spender: contract,
        amount: budget.toString(),
      },
    })
  }

  steps.push({
    to: contract,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'fund',
      args: [BigInt(jobId), budget, EMPTY_BYTES],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: LABELS.fund,
  })
  return steps
}

export function completeJobStep(intent: Intent, jobId: string, reasonSeed: string): TxStep {
  return {
    to: addr(intent.contractAddress, 'contractAddress'),
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'complete',
      args: [BigInt(jobId), bytes32(reasonSeed), EMPTY_BYTES],
    }),
    value: '0x0',
    chainId: intent.chainId,
    label: LABELS.complete,
  }
}

function requireBudget(intent: Intent): bigint {
  if (intent.budgetAmount === null || intent.budgetAmount === '') {
    throw new Error('ERC-8183 budgetAmount is missing')
  }
  const amount = BigInt(intent.budgetAmount)
  if (amount < 0n) throw new Error('ERC-8183 budgetAmount must be non-negative')
  return amount
}

function addr(value: string, field: string): `0x${string}` {
  if (!isAddress(value)) throw new Error(`erc8183.${field} must be an EVM address`)
  return getAddress(value) as `0x${string}`
}

function bytes32(seed: string): Hex {
  return `0x${createHash('sha256').update(seed).digest('hex')}` as Hex
}
