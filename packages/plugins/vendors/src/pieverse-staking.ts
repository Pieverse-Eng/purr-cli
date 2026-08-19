import { encodeFunctionData, parseAbi } from 'viem'

import { apiGet, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { buildApprovalStep, parseBigInt } from '@pieverseio/purr-core/shared'
import type { StepOutput } from '@pieverseio/purr-core/types'

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount, uint256 duration) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId)',
  'function withdrawBatch(uint256[] stakeIds)',
])

export interface PieverseStakingDeployment {
  /** Public network ID accepted and returned by the CLI. */
  chainId: number
  chain: string
  /** Network used to execute the deployed staking contract. */
  executionChainId: number
  pieverse: `0x${string}`
  staking: `0x${string}`
  explorerUrl: string
  durations: readonly string[]
}

const DEPLOYMENTS: Record<number, PieverseStakingDeployment> = {
  1: {
    chainId: 1,
    chain: 'ethereum',
    executionChainId: 1,
    pieverse: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
    staking: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
    explorerUrl: 'https://etherscan.io',
    durations: ['90d', '180d', '365d'],
  },
  56: {
    chainId: 56,
    chain: 'bnb-chain',
    executionChainId: 56,
    pieverse: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
    staking: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
    explorerUrl: 'https://bscscan.com',
    durations: ['90d', '180d', '365d'],
  },
}

const SUPPORTED_CHAIN_IDS = [1, 56] as const

const DURATION_MAPPINGS = [
  { days: 90, publicSeconds: 7_776_000, executionSeconds: 7_776_000 },
  { days: 180, publicSeconds: 15_552_000, executionSeconds: 15_552_000 },
  { days: 365, publicSeconds: 31_536_000, executionSeconds: 31_536_000 },
] as const

const STATUS_NAMES = ['active', 'matured', 'closed'] as const
const PIEVERSE_STAKING_AMOUNT_INCREMENT_WEI = 10n ** 16n

export interface PieverseStakePosition {
  stakeId: string
  amountWei: string
  unlockAt: string
  status: Exclude<(typeof STATUS_NAMES)[number], 'closed'>
}

export interface PieverseStakingPositions {
  chainId: number
  wallet: string
  pieverseBalanceWei: string
  paused: boolean
  stakes: PieverseStakePosition[]
}

interface PieverseStakingPositionsResponse {
  ok: boolean
  data?: PieverseStakingPositions
  error?: string
}

export function getPieverseStakingDeployment(chainId: number): PieverseStakingDeployment {
  const deployment = DEPLOYMENTS[chainId]
  if (!deployment) {
    throw new Error(
      `Pieverse staking is not configured for chain ID ${chainId}. Supported chain IDs: 1 (Ethereum), 56 (BNB Chain)`,
    )
  }
  return deployment
}

export function listPieverseStakingDeployments(): PieverseStakingDeployment[] {
  return SUPPORTED_CHAIN_IDS.map((chainId) => DEPLOYMENTS[chainId])
}

export function parsePieverseStakingDuration(value: string, chainId: number): number {
  const deployment = getPieverseStakingDeployment(chainId)
  const normalized = value.toLowerCase()
  const mapping = DURATION_MAPPINGS.find(
    ({ days, publicSeconds }) => normalized === `${days}d` || normalized === String(publicSeconds),
  )
  if (!mapping || !deployment.durations.includes(`${mapping.days}d`)) {
    throw new Error(`Invalid staking duration: "${value}". Supported durations: 90d, 180d, 365d`)
  }
  return mapping.executionSeconds
}

export function buildPieverseStakeSteps(args: {
  chainId: number
  amountWei: string
  duration: string
}): StepOutput {
  const deployment = getPieverseStakingDeployment(args.chainId)
  const amount = parseBigInt(args.amountWei, 'amount-wei')
  if (amount % PIEVERSE_STAKING_AMOUNT_INCREMENT_WEI !== 0n) {
    throw new Error(
      'PIEVERSE staking amount supports at most 2 decimal places (minimum increment: 0.01 PIEVERSE)',
    )
  }
  const duration = parsePieverseStakingDuration(args.duration, args.chainId)
  const durationDays = DURATION_MAPPINGS.find(
    ({ executionSeconds }) => executionSeconds === duration,
  )?.days
  if (!durationDays) throw new Error(`No public duration configured for ${duration} seconds`)
  return {
    steps: [
      buildApprovalStep(
        deployment.pieverse,
        deployment.staking,
        amount.toString(),
        deployment.executionChainId,
        'Approve PIEVERSE for Pieverse staking',
      ),
      {
        to: deployment.staking,
        data: encodeFunctionData({
          abi: STAKING_ABI,
          functionName: 'stake',
          args: [amount, BigInt(duration)],
        }),
        value: '0x0',
        chainId: deployment.executionChainId,
        label: `Stake PIEVERSE for ${durationDays} days`,
      },
    ],
  }
}

export function buildPieverseWithdrawSteps(args: { chainId: number; stakeId: string }): StepOutput {
  const deployment = getPieverseStakingDeployment(args.chainId)
  const stakeId = parseStakeId(args.stakeId)
  return {
    steps: [
      {
        to: deployment.staking,
        data: encodeFunctionData({
          abi: STAKING_ABI,
          functionName: 'withdraw',
          args: [stakeId],
        }),
        value: '0x0',
        chainId: deployment.executionChainId,
        label: `Withdraw Pieverse stake ${stakeId}`,
      },
    ],
  }
}

export function buildPieverseWithdrawBatchSteps(args: {
  chainId: number
  stakeIds: string
}): StepOutput {
  const deployment = getPieverseStakingDeployment(args.chainId)
  const rawIds = args.stakeIds
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (rawIds.length === 0) throw new Error('--stake-ids must contain at least one stake ID')
  const stakeIds = rawIds.map(parseStakeId)
  if (new Set(stakeIds.map(String)).size !== stakeIds.length) {
    throw new Error('--stake-ids must not contain duplicate stake IDs')
  }
  return {
    steps: [
      {
        to: deployment.staking,
        data: encodeFunctionData({
          abi: STAKING_ABI,
          functionName: 'withdrawBatch',
          args: [stakeIds],
        }),
        value: '0x0',
        chainId: deployment.executionChainId,
        label: `Withdraw Pieverse stakes ${stakeIds.join(', ')}`,
      },
    ],
  }
}

export async function readPieverseStakingPositions(args: {
  chainId: number
}): Promise<PieverseStakingPositions> {
  const deployment = getPieverseStakingDeployment(args.chainId)
  const { instanceId } = resolveCredentials()
  const response = await apiGet<PieverseStakingPositionsResponse>(
    `/v1/instances/${instanceId}/wallet/staking/positions?chain_id=${deployment.chainId}`,
  )

  if (!response.ok || !response.data) {
    throw new Error(response.error ?? 'Failed to read Pieverse staking positions')
  }

  return response.data
}

function parseStakeId(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid stake ID: "${value}"`)
  return BigInt(value)
}
