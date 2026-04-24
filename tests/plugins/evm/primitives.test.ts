import { describe, expect, it } from 'vitest'
import { encodeFunctionData, maxUint256, parseAbi } from 'viem'
import { buildAbiCallStep } from '@pieverseio/purr-plugin-evm/abi-call'
import { buildApproveSteps } from '@pieverseio/purr-plugin-evm/approve'
import { buildRawStep } from '@pieverseio/purr-plugin-evm/raw'
import { buildTransferSteps } from '@pieverseio/purr-plugin-evm/transfer'

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
  it('passes addresses + label through; normalizes value/gasLimit to canonical hex', () => {
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
      gasLimit: '0x186a0', // 100000 decimal → canonical hex
    })
  })

  it('normalizes hex gasLimit through unchanged (canonical form)', () => {
    const result = buildRawStep({
      to: '0xDEAD',
      data: '0xCAFE',
      chainId: 1,
      gasLimit: '0x186a0',
    })
    expect(result.steps[0].gasLimit).toBe('0x186a0')
  })

  it('normalizes decimal value to hex', () => {
    const result = buildRawStep({
      to: '0xDEAD',
      data: '0x',
      value: '1000000',
      chainId: 1,
    })
    expect(result.steps[0].value).toBe('0xf4240')
  })

  it('rejects unparseable gasLimit', () => {
    expect(() =>
      buildRawStep({ to: '0xDEAD', data: '0x', chainId: 1, gasLimit: 'not-a-number' }),
    ).toThrow(/gas-limit/)
  })

  it('defaults value to 0x0', () => {
    const result = buildRawStep({ to: '0xA', data: '0xB', chainId: 56 })
    expect(result.steps[0].value).toBe('0x0')
  })
})

describe('buildAbiCallStep', () => {
  const TO = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'

  it('encodes calldata locally and emits a single step', () => {
    const result = buildAbiCallStep({
      to: TO,
      signature: 'register(string)',
      argsJson: '["https://example.com/agent.json"]',
      chainId: 2818,
    })
    const expected = encodeFunctionData({
      abi: parseAbi(['function register(string)']),
      functionName: 'register',
      args: ['https://example.com/agent.json'],
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].to).toBe(TO)
    expect(result.steps[0].data).toBe(expected)
    expect(result.steps[0].chainId).toBe(2818)
    expect(result.steps[0].value).toBe('0x0')
    expect(result.steps[0].label).toBe('register(...)')
  })

  it('accepts the optional "function" prefix in --signature', () => {
    const a = buildAbiCallStep({
      to: TO,
      signature: 'function register(string)',
      argsJson: '["uri"]',
      chainId: 2818,
    })
    const b = buildAbiCallStep({
      to: TO,
      signature: 'register(string)',
      argsJson: '["uri"]',
      chainId: 2818,
    })
    expect(a.steps[0].data).toBe(b.steps[0].data)
  })

  it('handles tuple / array arg types', () => {
    const result = buildAbiCallStep({
      to: TO,
      signature: 'register(string,(string,bytes)[])',
      argsJson: '["uri",[["meta","0xdeadbeef"]]]',
      chainId: 2818,
    })
    expect(result.steps[0].data).toMatch(/^0x[0-9a-fA-F]+$/)
  })

  it('forwards optional value, gasLimit, label', () => {
    const result = buildAbiCallStep({
      to: TO,
      signature: 'foo(uint256)',
      argsJson: '["1"]',
      chainId: 2818,
      value: '0x10',
      gasLimit: '0x186a0',
      label: 'custom label',
    })
    expect(result.steps[0].value).toBe('0x10')
    expect(result.steps[0].gasLimit).toBe('0x186a0')
    expect(result.steps[0].label).toBe('custom label')
  })

  it('throws on malformed --signature', () => {
    expect(() =>
      buildAbiCallStep({
        to: TO,
        signature: 'not a function',
        argsJson: '[]',
        chainId: 2818,
      }),
    ).toThrow(/Invalid --signature/)
  })

  it('throws when --args is not a JSON array', () => {
    expect(() =>
      buildAbiCallStep({
        to: TO,
        signature: 'register(string)',
        argsJson: '{"not":"array"}',
        chainId: 2818,
      }),
    ).toThrow(/Invalid --args/)
  })

  it('throws when args do not match the signature types', () => {
    expect(() =>
      buildAbiCallStep({
        to: TO,
        signature: 'register(uint256)',
        argsJson: '["not-a-number"]',
        chainId: 2818,
      }),
    ).toThrow(/Failed to encode calldata/)
  })

  it('rejects an invalid --to address', () => {
    expect(() =>
      buildAbiCallStep({
        to: 'not-an-address',
        signature: 'register(string)',
        argsJson: '["x"]',
        chainId: 2818,
      }),
    ).toThrow()
  })
})
