import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import {
  buildPieverseStakeSteps,
  buildPieverseWithdrawBatchSteps,
  buildPieverseWithdrawSteps,
  getPieverseStakingDeployment,
  listPieverseStakingDeployments,
  parsePieverseStakingDuration,
  readPieverseStakingPositions,
  type ContractReadClient,
} from '@pieverseio/purr-plugin-vendors/pieverse-staking'

const BURR_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount, uint256 duration) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId)',
  'function withdrawBatch(uint256[] stakeIds)',
])

const WALLET = '0x1111111111111111111111111111111111111111'

describe('Pieverse testnet staking', () => {
  it('returns the configured Sepolia and BSC Testnet deployments', () => {
    expect(listPieverseStakingDeployments().map((deployment) => deployment.chainId)).toEqual([
      11155111, 97,
    ])
    expect(getPieverseStakingDeployment(11155111)).toMatchObject({
      burr: '0xa7420420a6C0D1D2b70198358C32d32cCC2EC968',
      staking: '0x198658Ba2e01132fc16C05809704BA8873d0056a',
    })
    expect(getPieverseStakingDeployment(97)).toMatchObject({
      burr: '0xd88F9A289a2b32B09B8C0C5C8F200d034a94bED7',
      staking: '0x366b3edF40456439aF125949Fa35dE337C506168',
    })
  })

  it('rejects unconfigured chains', () => {
    expect(() => getPieverseStakingDeployment(1)).toThrow('not configured for chain ID 1')
  })

  it('builds a conditional approval followed by stake', () => {
    const output = buildPieverseStakeSteps({
      chainId: 97,
      amountWei: '2500000000000000000',
      duration: '10m',
    })
    expect(output.steps).toHaveLength(2)
    expect(output.steps[0]).toMatchObject({
      to: '0xd88F9A289a2b32B09B8C0C5C8F200d034a94bED7',
      chainId: 97,
      conditional: {
        type: 'allowance_lt',
        token: '0xd88F9A289a2b32B09B8C0C5C8F200d034a94bED7',
        spender: '0x366b3edF40456439aF125949Fa35dE337C506168',
        amount: '2500000000000000000',
      },
    })
    expect(
      decodeFunctionData({ abi: BURR_ABI, data: output.steps[0].data as `0x${string}` })
        .functionName,
    ).toBe('approve')
    expect(output.steps[1]).toMatchObject({
      to: '0x366b3edF40456439aF125949Fa35dE337C506168',
      chainId: 97,
      value: '0x0',
    })
    expect(
      decodeFunctionData({ abi: STAKING_ABI, data: output.steps[1].data as `0x${string}` }),
    ).toEqual({
      functionName: 'stake',
      args: [2500000000000000000n, 600n],
    })
  })

  it('accepts only the shortened testnet durations', () => {
    expect(parsePieverseStakingDuration('5m', 11155111)).toBe(300)
    expect(parsePieverseStakingDuration('600', 97)).toBe(600)
    expect(() => parsePieverseStakingDuration('90d', 11155111)).toThrow(
      'Supported testnet durations',
    )
  })

  it('builds single and batch withdrawals and rejects duplicate IDs', () => {
    const single = buildPieverseWithdrawSteps({ chainId: 11155111, stakeId: '0' })
    expect(
      decodeFunctionData({ abi: STAKING_ABI, data: single.steps[0].data as `0x${string}` }),
    ).toEqual({ functionName: 'withdraw', args: [0n] })

    const batch = buildPieverseWithdrawBatchSteps({ chainId: 97, stakeIds: '0, 2,5' })
    expect(
      decodeFunctionData({ abi: STAKING_ABI, data: batch.steps[0].data as `0x${string}` }),
    ).toEqual({ functionName: 'withdrawBatch', args: [[0n, 2n, 5n]] })
    expect(() => buildPieverseWithdrawBatchSteps({ chainId: 97, stakeIds: '1,1' })).toThrow(
      'must not contain duplicate',
    )
  })

  it('reads and normalizes wallet positions from the chain', async () => {
    const readContract = vi.fn(async (request: Record<string, unknown>) => {
      const functionName = request.functionName
      const args = request.args as readonly unknown[] | undefined
      switch (functionName) {
        case 'balanceOf':
          return 900n
        case 'allowance':
          return 500n
        case 'paused':
          return false
        case 'openPrincipal':
          return 1200n
        case 'stakeCount':
          return 2n
        case 'stakes':
          return args?.[1] === 0n ? [500n, 1000n, 1300n] : [0n, 2000n, 2600n]
        case 'stakeStatus':
          return args?.[1] === 0n ? 1 : 2n
        default:
          throw new Error(`Unexpected function ${String(functionName)}`)
      }
    })
    const client: ContractReadClient = { readContract }

    const result = await readPieverseStakingPositions({ chainId: 11155111, wallet: WALLET }, client)

    expect(result).toMatchObject({
      chainId: 11155111,
      wallet: WALLET,
      burrBalanceWei: '900',
      allowanceWei: '500',
      paused: false,
      openPrincipalWei: '1200',
      stakeCount: '2',
    })
    expect(result.stakes).toEqual([
      {
        stakeId: '0',
        amountWei: '500',
        startedAt: '1000',
        startedAtIso: '1970-01-01T00:16:40.000Z',
        unlockAt: '1300',
        unlockAtIso: '1970-01-01T00:21:40.000Z',
        status: 'matured',
      },
      {
        stakeId: '1',
        amountWei: '0',
        startedAt: '2000',
        startedAtIso: '1970-01-01T00:33:20.000Z',
        unlockAt: '2600',
        unlockAtIso: '1970-01-01T00:43:20.000Z',
        status: 'closed',
      },
    ])
  })
})
