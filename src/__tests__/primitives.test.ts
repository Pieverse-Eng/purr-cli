import { describe, expect, it } from 'vitest'
import { maxUint256 } from 'viem'
import { buildApproveSteps } from '../primitives/approve.js'
import { buildRawStep } from '../primitives/raw.js'
import { buildTransferSteps } from '../primitives/transfer.js'

describe('buildApproveSteps', () => {
  it('produces a single conditional approve step for normal tokens', () => {
    const result = buildApproveSteps({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      spender: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      amount: '1000000',
      chainId: 56,
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].conditional?.type).toBe('allowance_lt')
    expect(result.steps[0].conditional?.amount).toBe('1000000')
    expect(result.steps[0].chainId).toBe(56)
    expect(result.steps[0].value).toBe('0x0')
    expect(result.steps[0].data).toMatch(/^0x/)
  })

  it('produces maxUint256 approve when amount is "max"', () => {
    const result = buildApproveSteps({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      spender: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      amount: 'max',
      chainId: 56,
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].conditional?.amount).toBe(maxUint256.toString())
  })

  it('prepends reset-to-zero for USDT-style tokens', () => {
    const result = buildApproveSteps({
      token: '0x55d398326f99059fF775485246999027B3197955', // USDT BSC
      spender: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      amount: '1000000',
      chainId: 56,
    })
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].label).toContain('Reset')
    expect(result.steps[1].conditional?.type).toBe('allowance_lt')
  })

  it('throws on non-numeric amount', () => {
    expect(() =>
      buildApproveSteps({
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        spender: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        amount: 'abc',
        chainId: 56,
      }),
    ).toThrow('Invalid amount')
  })

  it('throws on zero amount', () => {
    expect(() =>
      buildApproveSteps({
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        spender: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        amount: '0',
        chainId: 56,
      }),
    ).toThrow('greater than 0')
  })
})

describe('buildTransferSteps', () => {
  it('encodes native transfer with value', () => {
    const result = buildTransferSteps({
      token: '0x0000000000000000000000000000000000000000',
      to: '0x1234567890123456789012345678901234567890',
      amountWei: '1000000000000000000',
      chainId: 56,
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].data).toBe('0x')
    expect(result.steps[0].value).toBe(`0x${(10n ** 18n).toString(16)}`)
  })

  it('encodes ERC-20 transfer', () => {
    const result = buildTransferSteps({
      token: '0x55d398326f99059fF775485246999027B3197955',
      to: '0x1234567890123456789012345678901234567890',
      amountWei: '1000000',
      chainId: 56,
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].value).toBe('0x0')
    expect(result.steps[0].data).toMatch(/^0x/)
    expect(result.steps[0].to).toBe('0x55d398326f99059fF775485246999027B3197955')
  })

  it('throws on invalid amountWei', () => {
    expect(() =>
      buildTransferSteps({
        token: '0x0000000000000000000000000000000000000000',
        to: '0x1234567890123456789012345678901234567890',
        amountWei: '12.5',
        chainId: 56,
      }),
    ).toThrow('Invalid amount-wei')
  })
})

describe('buildRawStep', () => {
  it('passes through fields directly', () => {
    const result = buildRawStep({
      to: '0xDEAD',
      data: '0xCAFE',
      value: '0x1',
      chainId: 1,
      label: 'test',
      gasLimit: '100000',
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toEqual({
      to: '0xDEAD',
      data: '0xCAFE',
      value: '0x1',
      chainId: 1,
      label: 'test',
      gasLimit: '100000',
    })
  })

  it('defaults value to 0x0', () => {
    const result = buildRawStep({ to: '0xA', data: '0xB', chainId: 56 })
    expect(result.steps[0].value).toBe('0x0')
  })
})
