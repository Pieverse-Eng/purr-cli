import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, zeroAddress } from 'viem'
import { walletPancake } from '../../packages/plugins/wallet/src/pancake'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  chain: vi.fn(),
  wallet: vi.fn(),
  execute: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({ readContract: mocks.read, getChainId: mocks.chain }),
}))
vi.mock('../../packages/plugins/wallet/src/address.js', () => ({ getWalletAddress: mocks.wallet }))
vi.mock('@pieverseio/purr-core/executor', () => ({ executeStepsFromJson: mocks.execute }))
const A = '0x55d398326f99059fF775485246999027B3197955'
const B = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
const owner = '0x1111111111111111111111111111111111111111'
const router = '0x2f68417A18dA681589F4eA64B9Cc9839209acfF7'
// Captured from the official /v1/calldata API, 2026-09-12; no signed transaction.
const captured = JSON.parse(
  readFileSync(new URL('../fixtures/pancake-calldata.json', import.meta.url), 'utf8'),
)
const abi = parseAbi([
  'function swapExactIn(uint256,(address,address,uint256,uint256),uint256[],(uint256[],address[],uint256[],bytes[],address)[][],uint256,address) payable',
])
let best: {
  chainId: number
  expiresAt: number
  inputAmount: string
  outputAmount: string
  slippageTolerance: number
  gasUseEstimateUsd: string
  agg: { srcToken: string; dstToken: string; aggregatorAddress: string; routes: unknown[] }
}
let call: typeof captured
let output: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(1789211100000)
  output = vi.spyOn(console, 'log').mockImplementation(() => {})
  best = {
    chainId: 56,
    expiresAt: 1789211348,
    inputAmount: '100000000000000000000',
    outputAmount: '44303161890012517071',
    slippageTolerance: 0.005,
    gasUseEstimateUsd: '30983061639765391',
    agg: {
      srcToken: A,
      dstToken: B,
      aggregatorAddress: router,
      routes: [{ inputAmount: '100000000000000000000' }],
    },
  }
  call = structuredClone(captured)
  mocks.chain.mockResolvedValue(56)
  mocks.read.mockImplementation(async ({ functionName }) => (functionName === 'decimals' ? 18 : 0n))
  mocks.wallet.mockResolvedValue({ address: owner, chainId: 56 })
  mocks.execute.mockResolvedValue({ results: [{ hash: '0xtx' }] })
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(JSON.stringify(url.includes('/quote?') ? { best } : call), { status: 200 }),
  )
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const args = { from: 'USDT', to: 'CAKE', amount: '100' }

it('quotes publicly using raw amounts and fractional slippage, without accessing the wallet', async () => {
  await walletPancake(args)
  const query = new URL(mocks.fetch.mock.calls[0][0]).searchParams
  expect(query.get('amount')).toBe('100000000000000000000')
  expect(query.get('slippageTolerance')).toBe('0.005')
  expect(query.get('sources')).toBe('agg')
  expect(query.has('recipient')).toBe(false)
  expect(mocks.wallet).not.toHaveBeenCalled()
  expect(mocks.execute).not.toHaveBeenCalled()
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
    estimatedToAmountFormatted: '44.303161890012517071',
    gasEstimateUsd: '0.030983061639765391',
  })
})
it('requotes and submits exact approval plus captured API calldata through the generic executor', async () => {
  await walletPancake({ ...args, execute: 'true' })
  expect(mocks.wallet).toHaveBeenCalledWith({ 'chain-type': 'ethereum', 'chain-id': '56' })
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).recipient).toBe(owner)
  const { steps } = JSON.parse(mocks.execute.mock.calls[0][0])
  expect(steps).toHaveLength(2)
  expect(decodeFunctionData({ abi: erc20Abi, data: steps[0].data }).args).toEqual([
    router,
    100n * 10n ** 18n,
  ])
  expect(steps[1]).toMatchObject({ to: router, data: captured.calldata, value: '0', chainId: 56 })
  expect(mocks.execute.mock.calls[0][1]).toBeUndefined()
})
it('forwards an optional dedup key without retrying a failed execution', async () => {
  mocks.execute.mockRejectedValue(new Error('Execution response timed out'))
  await expect(
    walletPancake({ ...args, execute: 'true', 'dedup-key': 'confirmed-swap-1' }),
  ).rejects.toThrow('Execution response timed out')
  expect(mocks.execute).toHaveBeenCalledTimes(1)
  expect(mocks.execute.mock.calls[0][1]).toBe('confirmed-swap-1')
})
it('resets a nonzero insufficient allowance and skips an already sufficient one', async () => {
  mocks.read.mockImplementation(async ({ functionName }) => (functionName === 'decimals' ? 18 : 1n))
  await walletPancake({ ...args, execute: 'true' })
  expect(JSON.parse(mocks.execute.mock.calls[0][0]).steps).toHaveLength(3)
  mocks.read.mockImplementation(async ({ functionName }) =>
    functionName === 'decimals' ? 18 : 100n * 10n ** 18n,
  )
  await walletPancake({ ...args, execute: 'true' })
  expect(JSON.parse(mocks.execute.mock.calls[1][0]).steps).toHaveLength(1)
})
it('sends native BNB as value without an ERC20 approval', async () => {
  best.agg.srcToken = zeroAddress
  call.calldata = encodeFunctionData({
    abi,
    functionName: 'swapExactIn',
    args: [
      0n,
      [zeroAddress, B, 44081646080562454485n, 1789211348n],
      [100n * 10n ** 18n],
      [],
      0n,
      owner,
    ],
  })
  call.value = '0x56bc75e2d63100000'
  await walletPancake({ ...args, from: 'BNB', execute: 'true' })
  const { steps } = JSON.parse(mocks.execute.mock.calls[0][0])
  expect(steps).toHaveLength(1)
  expect(steps[0].value).toBe('100000000000000000000')
})
it.each(['min-amount-out', 'fees', 'fee', 'wallet', 'deadline', 'path', 'recipient', 'router'])(
  'rejects --%s before any request',
  async (flag) => {
    await expect(walletPancake({ ...args, [flag]: '1' })).rejects.toThrow('does not accept')
    expect(mocks.fetch).not.toHaveBeenCalled()
  },
)
it.each(['0', '50', 'NaN', '-1'])('rejects unsupported slippage %s', async (slippage) => {
  await expect(walletPancake({ ...args, slippage })).rejects.toThrow('slippage')
})
it.each(['chain', 'amount', 'token', 'expired', 'output'])(
  'rejects a mismatched %s quote before execution',
  async (field) => {
    if (field === 'chain') best.chainId = 1
    if (field === 'amount') best.inputAmount = '1'
    if (field === 'token') best.agg.dstToken = A
    if (field === 'expired') best.expiresAt = 1
    if (field === 'output') best.outputAmount = '0'
    await expect(walletPancake({ ...args, execute: 'true' })).rejects.toThrow(
      'invalid or expired quote',
    )
    expect(mocks.execute).not.toHaveBeenCalled()
  },
)
it.each(['router', 'recipient', 'minimum', 'input', 'value', 'deadline'])(
  'rejects altered calldata %s before approval or execution',
  async (field) => {
    if (field === 'router') call.to = owner
    else if (field === 'value') call.value = '0x1'
    else
      call.calldata = encodeFunctionData({
        abi,
        functionName: 'swapExactIn',
        args: [
          0n,
          [
            A,
            B,
            field === 'minimum' ? 1n : 44081646080562454485n,
            field === 'deadline' ? 1n : 1789211348n,
          ],
          [field === 'input' ? 1n : 100n * 10n ** 18n],
          [],
          0n,
          field === 'recipient' ? A : owner,
        ],
      })
    await expect(walletPancake({ ...args, execute: 'true' })).rejects.toThrow()
    expect(mocks.execute).not.toHaveBeenCalled()
  },
)
it('propagates API errors and does not submit partial steps', async () => {
  mocks.fetch.mockResolvedValue(new Response('{}', { status: 429 }))
  await expect(walletPancake({ ...args, execute: 'true' })).rejects.toThrow('HTTP 429')
  expect(mocks.execute).not.toHaveBeenCalled()
})
