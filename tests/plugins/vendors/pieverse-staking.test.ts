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

const PIEVERSE_TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
])

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount, uint256 duration) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId)',
  'function withdrawBatch(uint256[] stakeIds)',
])

const WALLET = '0x1111111111111111111111111111111111111111'

describe('Pieverse staking', () => {
  it('returns the Ethereum and BNB Chain deployments with staging execution networks', () => {
    expect(listPieverseStakingDeployments().map((deployment) => deployment.chainId)).toEqual([
      1, 56,
    ])
    expect(getPieverseStakingDeployment(1)).toMatchObject({
      executionChainId: 11155111,
      pieverse: '0xa7420420a6C0D1D2b70198358C32d32cCC2EC968',
      staking: '0x198658Ba2e01132fc16C05809704BA8873d0056a',
    })
    expect(getPieverseStakingDeployment(56)).toMatchObject({
      executionChainId: 97,
      pieverse: '0xd88F9A289a2b32B09B8C0C5C8F200d034a94bED7',
      staking: '0x366b3edF40456439aF125949Fa35dE337C506168',
    })
  })

  it('rejects unconfigured chains', () => {
    expect(() => getPieverseStakingDeployment(97)).toThrow('not configured for chain ID 97')
  })

  it('builds a conditional approval followed by stake', () => {
    const output = buildPieverseStakeSteps({
      chainId: 56,
      amountWei: '2500000000000000000',
      duration: '180d',
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
      decodeFunctionData({
        abi: PIEVERSE_TOKEN_ABI,
        data: output.steps[0].data as `0x${string}`,
      }).functionName,
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

  it('accepts at most two decimal places for staking amounts', () => {
    expect(() =>
      buildPieverseStakeSteps({
        chainId: 1,
        amountWei: '10000000000000000',
        duration: '90d',
      }),
    ).not.toThrow()
    expect(() =>
      buildPieverseStakeSteps({
        chainId: 1,
        amountWei: '1230000000000000000',
        duration: '90d',
      }),
    ).not.toThrow()
    expect(() =>
      buildPieverseStakeSteps({
        chainId: 1,
        amountWei: '1234000000000000000',
        duration: '90d',
      }),
    ).toThrow('supports at most 2 decimal places')
    expect(() => buildPieverseStakeSteps({ chainId: 1, amountWei: '1', duration: '90d' })).toThrow(
      'minimum increment: 0.01 PIEVERSE',
    )
  })

  it('maps public staking durations to the temporary contract durations', () => {
    expect(parsePieverseStakingDuration('90d', 1)).toBe(300)
    expect(parsePieverseStakingDuration('180d', 56)).toBe(600)
    expect(parsePieverseStakingDuration('365d', 1)).toBe(900)
    expect(parsePieverseStakingDuration('15552000', 56)).toBe(600)
    expect(() => parsePieverseStakingDuration('5m', 1)).toThrow('Supported durations')
  })

  it('builds single and batch withdrawals and rejects duplicate IDs', () => {
    const single = buildPieverseWithdrawSteps({ chainId: 1, stakeId: '0' })
    expect(
      decodeFunctionData({ abi: STAKING_ABI, data: single.steps[0].data as `0x${string}` }),
    ).toEqual({ functionName: 'withdraw', args: [0n] })

    const batch = buildPieverseWithdrawBatchSteps({ chainId: 56, stakeIds: '0, 2,5' })
    expect(
      decodeFunctionData({ abi: STAKING_ABI, data: batch.steps[0].data as `0x${string}` }),
    ).toEqual({ functionName: 'withdrawBatch', args: [[0n, 2n, 5n]] })
    expect(() => buildPieverseWithdrawBatchSteps({ chainId: 56, stakeIds: '1,1' })).toThrow(
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
        case 'paused':
          return false
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

    const result = await readPieverseStakingPositions({ chainId: 1, wallet: WALLET }, client)

    expect(result).toEqual({
      chainId: 1,
      wallet: WALLET,
      pieverseBalanceWei: '900',
      paused: false,
      stakes: [
        {
          stakeId: '0',
          amountWei: '500',
          unlockAt: '1970-01-01T00:21:40.000Z',
          status: 'matured',
        },
      ],
    })
  })
})
