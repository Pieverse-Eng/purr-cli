import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileAsyncMock = vi.fn()

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util')
  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock),
  }
})

describe('OKX API CLI wrapper', () => {
  beforeEach(() => {
    vi.resetModules()
    execFileAsyncMock.mockReset()
    delete process.env.ONCHAINOS_BIN
  })

  it('unwraps supported chain data from onchainos swap chains', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        data: [{ chainId: 8453, chainIndex: 8453, chainName: 'Base', dexTokenApproveAddress: '0x1' }],
      }),
    })

    const { swapChains } = await import('../vendors/okx-api.js')
    await expect(swapChains()).resolves.toEqual([
      { chainId: 8453, chainIndex: 8453, chainName: 'Base', dexTokenApproveAddress: '0x1' },
    ])
    expect(execFileAsyncMock).toHaveBeenCalledWith('onchainos', ['swap', 'chains'], {
      maxBuffer: 10 * 1024 * 1024,
    })
  })

  it('builds swap quote CLI args including swap-mode', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        data: [{ toTokenAmount: '123', fromTokenAmount: '456' }],
      }),
    })

    const { swapQuote } = await import('../vendors/okx-api.js')
    await expect(
      swapQuote({
        fromToken: '0xfrom',
        toToken: '0xto',
        amount: '1000',
        chain: 'base',
        swapMode: 'exactOut',
      }),
    ).resolves.toEqual({ toTokenAmount: '123', fromTokenAmount: '456' })

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'onchainos',
      ['swap', 'quote', '--from', '0xfrom', '--to', '0xto', '--amount', '1000', '--chain', 'base', '--swap-mode', 'exactOut'],
      { maxBuffer: 10 * 1024 * 1024 },
    )
  })

  it('builds swap swap CLI args including slippage, gas level, and max auto slippage', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        data: [{ tx: { to: '0x1', data: '0xabc' } }],
      }),
    })

    const { swapSwap } = await import('../vendors/okx-api.js')
    await expect(
      swapSwap({
        fromToken: '0xfrom',
        toToken: '0xto',
        amount: '1000',
        chain: 'base',
        wallet: '0xwallet',
        slippagePercent: 3,
        swapMode: 'exactIn',
        gasLevel: 'fast',
        maxAutoSlippagePercent: 0.5,
      }),
    ).resolves.toEqual({ tx: { to: '0x1', data: '0xabc' } })

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'onchainos',
      [
        'swap',
        'swap',
        '--from',
        '0xfrom',
        '--to',
        '0xto',
        '--amount',
        '1000',
        '--chain',
        'base',
        '--wallet',
        '0xwallet',
        '--slippage',
        '3',
        '--swap-mode',
        'exactIn',
        '--gas-level',
        'fast',
        '--max-auto-slippage',
        '0.5',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    )
  })

  it('throws a helpful error when the onchainos binary is missing', async () => {
    const error = Object.assign(new Error('spawn onchainos ENOENT'), { code: 'ENOENT' })
    execFileAsyncMock.mockRejectedValue(error)

    const { swapLiquidity } = await import('../vendors/okx-api.js')
    await expect(swapLiquidity({ chain: 'base' })).rejects.toThrow(
      'onchainos binary not found. Install onchainos or set ONCHAINOS_BIN to the binary path.',
    )
  })

  it('throws when onchainos returns non-JSON output', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: 'not-json',
    })

    const { swapApprove } = await import('../vendors/okx-api.js')
    await expect(swapApprove({ token: '0xtoken', amount: '1000', chain: 'base' })).rejects.toThrow(
      'onchainos returned non-JSON output for: swap approve --token 0xtoken --amount 1000 --chain base',
    )
  })

  it('throws when the OKX CLI envelope reports failure', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        ok: false,
        error: 'rate limited',
      }),
    })

    const { swapLiquidity } = await import('../vendors/okx-api.js')
    await expect(swapLiquidity({ chain: 'base' })).rejects.toThrow('rate limited')
  })
})
