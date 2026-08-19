import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  buildPieverseStakeSteps,
  buildPieverseWithdrawBatchSteps,
  buildPieverseWithdrawSteps,
  getPieverseStakingDeployment,
  listPieverseStakingDeployments,
  parsePieverseStakingDuration,
} from '@pieverseio/purr-plugin-vendors/pieverse-staking'

const PIEVERSE_TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
])

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount, uint256 duration) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId)',
  'function withdrawBatch(uint256[] stakeIds)',
])

describe('Pieverse staking', () => {
  it('returns the Ethereum and BNB Chain mainnet deployments', () => {
    expect(listPieverseStakingDeployments().map((deployment) => deployment.chainId)).toEqual([
      1, 56,
    ])
    expect(getPieverseStakingDeployment(1)).toMatchObject({
      executionChainId: 1,
      pieverse: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
      staking: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
    })
    expect(getPieverseStakingDeployment(56)).toMatchObject({
      executionChainId: 56,
      pieverse: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
      staking: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
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
      to: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
      chainId: 56,
      conditional: {
        type: 'allowance_lt',
        token: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
        spender: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
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
      to: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
      chainId: 56,
      value: '0x0',
    })
    expect(
      decodeFunctionData({ abi: STAKING_ABI, data: output.steps[1].data as `0x${string}` }),
    ).toEqual({
      functionName: 'stake',
      args: [2500000000000000000n, 15552000n],
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

  it('maps public staking durations to the mainnet contract durations', () => {
    expect(parsePieverseStakingDuration('90d', 1)).toBe(7_776_000)
    expect(parsePieverseStakingDuration('180d', 56)).toBe(15_552_000)
    expect(parsePieverseStakingDuration('365d', 1)).toBe(31_536_000)
    expect(parsePieverseStakingDuration('15552000', 56)).toBe(15_552_000)
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

})
