import { createPublicClient, encodeFunctionData, http, parseAbi } from 'viem'

import { buildApprovalStep, parseBigInt, requireAddress } from '@pieverseio/purr-core/shared'
import type { StepOutput } from '@pieverseio/purr-core/types'

const BURR_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount, uint256 duration) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId)',
  'function withdrawBatch(uint256[] stakeIds)',
  'function paused() view returns (bool)',
  'function openPrincipal() view returns (uint256)',
  'function stakeCount(address account) view returns (uint256)',
  'function stakes(address account, uint256 stakeId) view returns (uint256 amount, uint64 startedAt, uint64 unlockAt)',
  'function stakeStatus(address account, uint256 stakeId) view returns (uint8)',
])

export interface PieverseStakingDeployment {
  chainId: number
  chain: string
  burr: `0x${string}`
  staking: `0x${string}`
  rpcUrl: string
  explorerUrl: string
  durations: readonly number[]
}

const DEPLOYMENTS: Record<number, PieverseStakingDeployment> = {
  11155111: {
    chainId: 11155111,
    chain: 'sepolia',
    burr: '0xa7420420a6C0D1D2b70198358C32d32cCC2EC968',
    staking: '0x198658Ba2e01132fc16C05809704BA8873d0056a',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    durations: [300, 600, 900],
  },
  97: {
    chainId: 97,
    chain: 'bsc-testnet',
    burr: '0xd88F9A289a2b32B09B8C0C5C8F200d034a94bED7',
    staking: '0x366b3edF40456439aF125949Fa35dE337C506168',
    rpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
    explorerUrl: 'https://testnet.bscscan.com',
    durations: [300, 600, 900],
  },
}

const SUPPORTED_CHAIN_IDS = [11155111, 97] as const

const STATUS_NAMES = ['active', 'matured', 'closed'] as const

export interface ContractReadClient {
  readContract(args: Record<string, unknown>): Promise<unknown>
}

export interface PieverseStakePosition {
  stakeId: string
  amountWei: string
  startedAt: string
  startedAtIso: string
  unlockAt: string
  unlockAtIso: string
  status: (typeof STATUS_NAMES)[number]
}

export interface PieverseStakingPositions {
  chainId: number
  chain: string
  wallet: string
  burr: string
  staking: string
  burrBalanceWei: string
  allowanceWei: string
  paused: boolean
  openPrincipalWei: string
  stakeCount: string
  stakes: PieverseStakePosition[]
}

export function getPieverseStakingDeployment(chainId: number): PieverseStakingDeployment {
  const deployment = DEPLOYMENTS[chainId]
  if (!deployment) {
    throw new Error(
      `Pieverse staking is not configured for chain ID ${chainId}. Supported chain IDs: 11155111 (Sepolia), 97 (BSC Testnet)`,
    )
  }
  return deployment
}

export function listPieverseStakingDeployments(): PieverseStakingDeployment[] {
  return SUPPORTED_CHAIN_IDS.map((chainId) => DEPLOYMENTS[chainId])
}

export function parsePieverseStakingDuration(value: string, chainId: number): number {
  const deployment = getPieverseStakingDeployment(chainId)
  const aliases: Record<string, number> = {
    '5m': 300,
    '10m': 600,
    '15m': 900,
  }
  const duration = aliases[value.toLowerCase()] ?? Number(value)
  if (!Number.isSafeInteger(duration) || !deployment.durations.includes(duration)) {
    throw new Error(
      `Invalid staking duration: "${value}". Supported testnet durations: 5m, 10m, 15m (300, 600, 900 seconds)`,
    )
  }
  return duration
}

export function buildPieverseStakeSteps(args: {
  chainId: number
  amountWei: string
  duration: string
}): StepOutput {
  const deployment = getPieverseStakingDeployment(args.chainId)
  const amount = parseBigInt(args.amountWei, 'amount-wei')
  const duration = parsePieverseStakingDuration(args.duration, args.chainId)
  return {
    steps: [
      buildApprovalStep(
        deployment.burr,
        deployment.staking,
        amount.toString(),
        args.chainId,
        'Approve BURR for Pieverse staking',
      ),
      {
        to: deployment.staking,
        data: encodeFunctionData({
          abi: STAKING_ABI,
          functionName: 'stake',
          args: [amount, BigInt(duration)],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: `Stake BURR for ${duration} seconds`,
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
        chainId: args.chainId,
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
        chainId: args.chainId,
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
  const [burrBalance, allowance, paused, openPrincipal, stakeCount] = await Promise.all([
    rpc.readContract({
      address: deployment.burr,
      abi: BURR_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    }),
    rpc.readContract({
      address: deployment.burr,
      abi: BURR_ABI,
      functionName: 'allowance',
      args: [wallet, deployment.staking],
    }),
    rpc.readContract({
      address: deployment.staking,
      abi: STAKING_ABI,
      functionName: 'paused',
    }),
    rpc.readContract({
      address: deployment.staking,
      abi: STAKING_ABI,
      functionName: 'openPrincipal',
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
      const startedAt = requireBigIntResult(stake[1], 'stake startedAt')
      const unlockAt = requireBigIntResult(stake[2], 'stake unlockAt')
      const statusIndex = requireIntegerResult(status, 'stake status')
      const statusName = STATUS_NAMES[statusIndex]
      if (!statusName)
        throw new Error(`Unknown stake status ${statusIndex} for stake ID ${stakeId}`)
      return {
        stakeId: stakeId.toString(),
        amountWei: amount.toString(),
        startedAt: startedAt.toString(),
        startedAtIso: toIsoTimestamp(startedAt),
        unlockAt: unlockAt.toString(),
        unlockAtIso: toIsoTimestamp(unlockAt),
        status: statusName,
      }
    }),
  )

  return {
    chainId: deployment.chainId,
    chain: deployment.chain,
    wallet,
    burr: deployment.burr,
    staking: deployment.staking,
    burrBalanceWei: requireBigIntResult(burrBalance, 'BURR balance').toString(),
    allowanceWei: requireBigIntResult(allowance, 'BURR allowance').toString(),
    paused: requireBooleanResult(paused, 'paused'),
    openPrincipalWei: requireBigIntResult(openPrincipal, 'openPrincipal').toString(),
    stakeCount: count.toString(),
    stakes: positions,
  }
}

function createStakingReadClient(deployment: PieverseStakingDeployment): ContractReadClient {
  const rpcUrl =
    process.env[`EVM_RPC_${deployment.chainId}`] ||
    (deployment.chainId === 11155111 ? process.env.SEPOLIA_RPC_URL : undefined) ||
    (deployment.chainId === 97 ? process.env.BSC_TESTNET_RPC_URL : undefined) ||
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
