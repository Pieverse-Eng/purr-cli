import { createPublicClient, encodeFunctionData, http, parseAbi } from 'viem'

import { buildApprovalStep, parseBigInt, requireAddress } from '@pieverseio/purr-core/shared'
import type { StepOutput } from '@pieverseio/purr-core/types'

const PIEVERSE_TOKEN_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)'])

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount, uint256 duration) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId)',
  'function withdrawBatch(uint256[] stakeIds)',
  'function paused() view returns (bool)',
  'function stakeCount(address account) view returns (uint256)',
  'function stakes(address account, uint256 stakeId) view returns (uint256 amount, uint64 startedAt, uint64 unlockAt)',
  'function stakeStatus(address account, uint256 stakeId) view returns (uint8)',
])

export interface PieverseStakingDeployment {
  /** Public network ID accepted and returned by the CLI. */
  chainId: number
  chain: string
  /** Temporary network used to execute the current staging deployment. */
  executionChainId: number
  pieverse: `0x${string}`
  staking: `0x${string}`
  rpcUrl: string
  explorerUrl: string
  durations: readonly string[]
}

const DEPLOYMENTS: Record<number, PieverseStakingDeployment> = {
  1: {
    chainId: 1,
    chain: 'ethereum',
    executionChainId: 11155111,
    pieverse: '0xa7420420a6C0D1D2b70198358C32d32cCC2EC968',
    staking: '0x198658Ba2e01132fc16C05809704BA8873d0056a',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    durations: ['90d', '180d', '365d'],
  },
  56: {
    chainId: 56,
    chain: 'bnb-chain',
    executionChainId: 97,
    pieverse: '0xd88F9A289a2b32B09B8C0C5C8F200d034a94bED7',
    staking: '0x366b3edF40456439aF125949Fa35dE337C506168',
    rpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
    explorerUrl: 'https://testnet.bscscan.com',
    durations: ['90d', '180d', '365d'],
  },
}

const SUPPORTED_CHAIN_IDS = [1, 56] as const

const DURATION_MAPPINGS = [
  { days: 90, publicSeconds: 7_776_000, executionSeconds: 300 },
  { days: 180, publicSeconds: 15_552_000, executionSeconds: 600 },
  { days: 365, publicSeconds: 31_536_000, executionSeconds: 900 },
] as const

const STATUS_NAMES = ['active', 'matured', 'closed'] as const
const PIEVERSE_STAKING_AMOUNT_INCREMENT_WEI = 10n ** 16n

export interface ContractReadClient {
  readContract(args: Record<string, unknown>): Promise<unknown>
}

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

export async function readPieverseStakingPositions(
  args: { chainId: number; wallet: string },
  client?: ContractReadClient,
): Promise<PieverseStakingPositions> {
  const deployment = getPieverseStakingDeployment(args.chainId)
  const wallet = requireAddress(args.wallet, 'wallet')
  const rpc = client ?? createStakingReadClient(deployment)
  const [pieverseBalance, paused, stakeCount] = await Promise.all([
    rpc.readContract({
      address: deployment.pieverse,
      abi: PIEVERSE_TOKEN_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    }),
    rpc.readContract({
      address: deployment.staking,
      abi: STAKING_ABI,
      functionName: 'paused',
    }),
    rpc.readContract({
      address: deployment.staking,
      abi: STAKING_ABI,
      functionName: 'stakeCount',
      args: [wallet],
    }),
  ])

  const count = requireBigIntResult(stakeCount, 'stakeCount')
  if (count > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('stakeCount is too large to enumerate')
  const positions = await Promise.all(
    Array.from({ length: Number(count) }, async (_, index) => {
      const stakeId = BigInt(index)
      const [stake, status] = await Promise.all([
        rpc.readContract({
          address: deployment.staking,
          abi: STAKING_ABI,
          functionName: 'stakes',
          args: [wallet, stakeId],
        }),
        rpc.readContract({
          address: deployment.staking,
          abi: STAKING_ABI,
          functionName: 'stakeStatus',
          args: [wallet, stakeId],
        }),
      ])
      if (!Array.isArray(stake) || stake.length !== 3) {
        throw new Error(`Invalid stakes result for stake ID ${stakeId}`)
      }
      const amount = requireBigIntResult(stake[0], 'stake amount')
      const unlockAt = requireBigIntResult(stake[2], 'stake unlockAt')
      const statusIndex = requireIntegerResult(status, 'stake status')
      const statusName = STATUS_NAMES[statusIndex]
      if (!statusName)
        throw new Error(`Unknown stake status ${statusIndex} for stake ID ${stakeId}`)
      if (statusName === 'closed') return undefined
      return {
        stakeId: stakeId.toString(),
        amountWei: amount.toString(),
        unlockAt: toIsoTimestamp(unlockAt),
        status: statusName,
      }
    }),
  )

  return {
    chainId: deployment.chainId,
    wallet,
    pieverseBalanceWei: requireBigIntResult(pieverseBalance, 'PIEVERSE balance').toString(),
    paused: requireBooleanResult(paused, 'paused'),
    stakes: positions.filter((position) => position !== undefined),
  }
}

function createStakingReadClient(deployment: PieverseStakingDeployment): ContractReadClient {
  const rpcUrl =
    process.env[`EVM_RPC_${deployment.executionChainId}`] ||
    (deployment.executionChainId === 11155111 ? process.env.SEPOLIA_RPC_URL : undefined) ||
    (deployment.executionChainId === 97 ? process.env.BSC_TESTNET_RPC_URL : undefined) ||
    deployment.rpcUrl
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  return {
    readContract(args) {
      return publicClient.readContract(args as never) as Promise<unknown>
    },
  }
}

function parseStakeId(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid stake ID: "${value}"`)
  return BigInt(value)
}

function requireBigIntResult(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint') throw new Error(`Invalid ${name} result from RPC`)
  return value
}

function requireBooleanResult(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${name} result from RPC`)
  return value
}

function requireIntegerResult(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  throw new Error(`Invalid ${name} result from RPC`)
}

function toIsoTimestamp(seconds: bigint): string {
  const milliseconds = Number(seconds) * 1000
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`Timestamp ${seconds} is out of range`)
  return new Date(milliseconds).toISOString()
}
