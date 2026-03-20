import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepOutput } from '../types.js'

const okxFns = vi.hoisted(() => ({
  buildOkxApproveSteps: vi.fn(),
  buildOkxSwapSteps: vi.fn(),
  getOkxSwapChains: vi.fn(),
  getOkxSwapLiquidity: vi.fn(),
  quoteOkxSwap: vi.fn(),
}))

const executorFns = vi.hoisted(() => ({
  executeStepsFromFile: vi.fn(),
  executeStepsFromJson: vi.fn(),
}))

vi.mock('../vendors/okx.js', () => okxFns)
vi.mock('../executor.js', () => executorFns)

const SWAP_STEPS: StepOutput = {
  steps: [
    {
      to: '0x2222222222222222222222222222222222222222',
      data: '0xabcdef',
      value: '0x0',
      chainId: 8453,
      label: 'OKX swap',
      gasLimit: '210000',
    },
  ],
}

async function runMain(args: string[]) {
  vi.resetModules()

  const oldArgv = process.argv
  const logs: string[] = []
  const errors: string[] = []
  let exitCode = 0

  process.argv = ['node', 'src/main.ts', ...args]

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(String).join(' '))
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(String).join(' '))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCode = Number(code ?? 0)
    return undefined as never
  })

  try {
    await import('../main.ts')
  } finally {
    process.argv = oldArgv
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }

  return {
    exitCode,
    stdout: logs.join('\n'),
    stderr: errors.join('\n'),
  }
}

describe('OKX CLI entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('routes `okx chains` to the chain lister and prints JSON', async () => {
    okxFns.getOkxSwapChains.mockResolvedValueOnce([
      { chainId: 8453, chainIndex: 8453, chainName: 'Base', dexTokenApproveAddress: '0x1' },
      { chainId: 196, chainIndex: 196, chainName: 'X Layer', dexTokenApproveAddress: '0x2' },
    ])

    const result = await runMain(['okx', 'chains'])

    expect(result.exitCode).toBe(0)
    expect(okxFns.getOkxSwapChains).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.stdout)).toEqual([
      { chainId: 8453, chainIndex: 8453, chainName: 'Base', dexTokenApproveAddress: '0x1' },
      { chainId: 196, chainIndex: 196, chainName: 'X Layer', dexTokenApproveAddress: '0x2' },
    ])
  })

  it('routes `okx liquidity` to the liquidity helper with the raw CLI chain arg', async () => {
    okxFns.getOkxSwapLiquidity.mockResolvedValueOnce([
      { id: 'liq-1', name: 'PancakeSwap', logo: 'https://example.com/pancake.png' },
    ])

    const result = await runMain(['okx', 'liquidity', '--chain', 'bnb'])

    expect(result.exitCode).toBe(0)
    expect(okxFns.getOkxSwapLiquidity).toHaveBeenCalledWith({ chain: 'bnb' })
    expect(JSON.parse(result.stdout)).toEqual([
      { id: 'liq-1', name: 'PancakeSwap', logo: 'https://example.com/pancake.png' },
    ])
  })

  it('supports quote aliases and forwards exactOut params correctly', async () => {
    okxFns.quoteOkxSwap.mockResolvedValueOnce({
      fromTokenAmount: '2135167',
      toTokenAmount: '1000000000000000',
      swapMode: 'exactOut',
    })

    const result = await runMain([
      'okx',
      'quote',
      '--from',
      'USDC',
      '--to',
      'ETH',
      '--amount',
      '0.001',
      '--chain',
      'base',
      '--swap-mode',
      'exactOut',
    ])

    expect(result.exitCode).toBe(0)
    expect(okxFns.quoteOkxSwap).toHaveBeenCalledWith({
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '0.001',
      chain: 'base',
      swapMode: 'exactOut',
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      swapMode: 'exactOut',
      toTokenAmount: '1000000000000000',
    })
  })

  it('builds swap planning JSON without executing by default', async () => {
    okxFns.buildOkxSwapSteps.mockResolvedValueOnce(SWAP_STEPS)

    const result = await runMain([
      'okx',
      'swap',
      '--from-token',
      'ETH',
      '--to-token',
      'USDC',
      '--amount',
      '0.5',
      '--chain',
      'base',
      '--wallet',
      '0x1234567890123456789012345678901234567890',
      '--slippage',
      '0.03',
      '--gas-level',
      'fast',
    ])

    expect(result.exitCode).toBe(0)
    expect(okxFns.buildOkxSwapSteps).toHaveBeenCalledWith({
      fromToken: 'ETH',
      toToken: 'USDC',
      amount: '0.5',
      chain: 'base',
      wallet: '0x1234567890123456789012345678901234567890',
      slippage: 0.03,
      swapMode: undefined,
      gasLevel: 'fast',
      maxAutoSlippage: undefined,
    })
    expect(executorFns.executeStepsFromJson).not.toHaveBeenCalled()
    expect(JSON.parse(result.stdout)).toEqual(SWAP_STEPS)
  })

  it('supports swap aliases plus exactOut and max-auto-slippage at the CLI layer', async () => {
    okxFns.buildOkxSwapSteps.mockResolvedValueOnce({
      steps: [
        {
          to: '0x1111111111111111111111111111111111111111',
          data: '0xdeadbeef',
          value: '0x0',
          chainId: 8453,
          label: 'Approve token for OKX router',
        },
        ...SWAP_STEPS.steps,
      ],
    })

    const result = await runMain([
      'okx',
      'swap',
      '--from',
      'USDC',
      '--to',
      'ETH',
      '--from-amount',
      '0.001',
      '--chain',
      'base',
      '--wallet',
      '0x1234567890123456789012345678901234567890',
      '--swap-mode',
      'exactOut',
      '--max-auto-slippage',
      '0.5',
    ])

    expect(result.exitCode).toBe(0)
    expect(okxFns.buildOkxSwapSteps).toHaveBeenCalledWith({
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '0.001',
      chain: 'base',
      wallet: '0x1234567890123456789012345678901234567890',
      slippage: undefined,
      swapMode: 'exactOut',
      gasLevel: undefined,
      maxAutoSlippage: 0.5,
    })
    expect(JSON.parse(result.stdout).steps).toHaveLength(2)
  })

  it('executes swap steps when `--execute` is provided and forwards dedup-key', async () => {
    okxFns.buildOkxSwapSteps.mockResolvedValueOnce(SWAP_STEPS)
    executorFns.executeStepsFromJson.mockResolvedValueOnce({
      results: [{ stepIndex: 0, label: 'OKX swap', hash: '0xhash', status: 'success' }],
      from: '0x1234567890123456789012345678901234567890',
      chainId: 8453,
      chainType: 'ethereum',
    })

    const result = await runMain([
      'okx',
      'swap',
      '--from-token',
      'ETH',
      '--to-token',
      'USDC',
      '--amount',
      '0.5',
      '--chain',
      'base',
      '--wallet',
      '0x1234567890123456789012345678901234567890',
      '--execute',
      '--dedup-key',
      'okx-swap-1',
    ])

    expect(result.exitCode).toBe(0)
    expect(executorFns.executeStepsFromJson).toHaveBeenCalledWith(
      JSON.stringify(SWAP_STEPS),
      'okx-swap-1',
    )
    expect(JSON.parse(result.stdout)).toMatchObject({
      results: [{ hash: '0xhash', status: 'success' }],
      chainId: 8453,
    })
  })

  it('routes `okx approve` and prints the resulting approval step', async () => {
    okxFns.buildOkxApproveSteps.mockResolvedValueOnce({
      steps: [
        {
          to: '0x74b7f16337b8972027f6196a17a631ac6de26d22',
          data: '0xdeadbeef',
          value: '0x0',
          chainId: 196,
          label: 'Approve token for OKX router',
          gasLimit: '70000',
        },
      ],
    })

    const result = await runMain([
      'okx',
      'approve',
      '--token',
      'USDC',
      '--amount',
      '2',
      '--chain',
      'xlayer',
    ])

    expect(result.exitCode).toBe(0)
    expect(okxFns.buildOkxApproveSteps).toHaveBeenCalledWith({
      token: 'USDC',
      amount: '2',
      chain: 'xlayer',
    })
    expect(JSON.parse(result.stdout).steps[0]).toMatchObject({
      label: 'Approve token for OKX router',
      chainId: 196,
      gasLimit: '70000',
    })
  })

  it('prints a CLI-facing error when approve fails', async () => {
    okxFns.buildOkxApproveSteps.mockRejectedValueOnce(
      new Error('Native tokens do not require OKX approval'),
    )

    const result = await runMain([
      'okx',
      'approve',
      '--token',
      'ETH',
      '--amount',
      '1',
      '--chain',
      'base',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Native tokens do not require OKX approval')
  })

  it('prints a CLI-facing error when swap construction fails', async () => {
    okxFns.buildOkxSwapSteps.mockRejectedValueOnce(new Error('fixture swap failure'))

    const result = await runMain([
      'okx',
      'swap',
      '--from-token',
      'ETH',
      '--to-token',
      'USDC',
      '--amount',
      '0.5',
      '--chain',
      'base',
      '--wallet',
      '0x1234567890123456789012345678901234567890',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('fixture swap failure')
  })

  it('rejects unknown OKX commands at the CLI layer', async () => {
    const result = await runMain(['okx', 'bridge'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'Unknown okx command: bridge. Use: chains, liquidity, quote, approve, swap',
    )
  })
})
