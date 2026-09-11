import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { decodeFunctionData, encodeAbiParameters, parseAbi } from 'viem'
import { expect, it } from 'vitest'
import { buildPancakeSwapSteps, quotePancakeSwap } from '../../packages/plugins/vendors/src/pancake'

const A = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const B = '0x5b1910eaad6450e50f816082aa078c41f10c292f'
const router = '0x1b81D678ffb9C0263b24A97847620C99d213eB14'
const base = {
  path: [A, WBNB, B],
  fees: [500, 2500],
  chainId: 56,
  amountInWei: '100000000000000000000',
  amountOutMinWei: '900',
  wallet: A,
}
const abi = parseAbi([
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
])

function runCommand(command: string, apiUrl: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        'bash',
        ['-c', command.replace(/^purr /, 'bun run packages/cli/src/linux-macos.ts ')],
        {
          env: {
            ...process.env,
            WALLET_API_URL: apiUrl,
            WALLET_API_TOKEN: 'fixture-token',
            INSTANCE_ID: 'fixture-instance',
          },
        },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (data) => {
        stdout += data
      })
      child.stderr.on('data', (data) => {
        stderr += data
      })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    },
  )
}

it('quotes V3 at a pinned block and builds the same route with deadline and slippage protection', async () => {
  let quotedPath: string | undefined
  let walletCalls = 0
  let failWallet = false
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const call = JSON.parse(body)
    if (req.url === '/v1/instances/fixture-instance/wallet/ensure') {
      walletCalls++
      expect(call).toEqual({ chainId: 56 })
      expect(req.headers.authorization).toBe('Bearer fixture-token')
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify(
          failWallet
            ? { ok: false, error: 'wallet unavailable' }
            : {
                ok: true,
                data: { address: A, chainId: 56, chainType: 'ethereum', createdNow: false },
              },
        ),
      )
      return
    }
    expect(req.url).toBe('/')
    let result = '0x38'
    if (call.method === 'eth_blockNumber') result = '0x123'
    if (call.method === 'eth_call') {
      expect(call.params[1]).toBe('0x123')
      expect(call.params[0].to.toLowerCase()).toBe('0xb048bbc1ee6b733fffcfb9e9cef7375518e25997')
      const decoded = decodeFunctionData({
        abi: parseAbi([
          'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160[], uint32[], uint256)',
        ]),
        data: call.params[0].data,
      })
      quotedPath = decoded.args[0]
      expect(decoded.args[1]).toBe(BigInt(base.amountInWei))
      result = encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint160[]' }, { type: 'uint32[]' }, { type: 'uint256' }],
        [1000n, [1n, 1n], [0, 0], 150000n],
      )
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const quote = await quotePancakeSwap({
      ...base,
      rpcUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      slippageBps: 100,
    })
    expect(quote.version).toBe('v3')
    expect(quote.amountOutMinWei).toBe('990')
    expect(quote.swapCommandTemplate).not.toMatch(/--execute|--wallet|--deadline|<wallet-address>/)
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const before = BigInt(Math.floor(Date.now() / 1000))
    const built = await runCommand(quote.swapCommandTemplate, apiUrl)
    expect(built.status, built.stderr).toBe(0)
    const { steps } = JSON.parse(built.stdout)
    expect(steps).toHaveLength(2)
    expect(steps[1].to.toLowerCase()).toBe(router.toLowerCase())
    expect(steps[1].value).toBe('0x0')
    const approval = decodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount)']),
      data: steps[0].data as `0x${string}`,
    })
    expect(approval.args[0].toLowerCase()).toBe(router.toLowerCase())
    expect(approval.args[1]).toBe((1n << 256n) - 1n)
    expect(steps[0].conditional).toMatchObject({ type: 'allowance_lt', amount: base.amountInWei })
    const decoded = decodeFunctionData({ abi, data: steps[1].data as `0x${string}` }).args[0]
    expect(decoded.path).toBe(quotedPath)
    expect(decoded.amountOutMinimum).toBe(990n)
    expect(decoded.amountIn).toBe(BigInt(base.amountInWei))
    expect(decoded.recipient.toLowerCase()).toBe(A.toLowerCase())
    expect(decoded.deadline).toBeGreaterThanOrEqual(before + 1200n)
    expect(decoded.deadline).toBeLessThanOrEqual(BigInt(Math.floor(Date.now() / 1000)) + 1200n)
    expect(walletCalls).toBe(1)

    // The same automatic wallet/deadline behavior applies to legacy V2 swaps.
    const v2 = await runCommand(
      `purr pancake swap --chain-id 56 --path ${A},${B} --amount-in-wei 1000 --amount-out-min-wei 900`,
      apiUrl,
    )
    expect(v2.status, v2.stderr).toBe(0)
    const v2Swap = JSON.parse(v2.stdout).steps[1]
    const v2Args = decodeFunctionData({
      abi: parseAbi([
        'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
      ]),
      data: v2Swap.data,
    }).args
    expect(v2Args[3].toLowerCase()).toBe(A.toLowerCase())
    expect(v2Args[4]).toBeGreaterThanOrEqual(before + 1200n)
    expect(walletCalls).toBe(2)

    failWallet = true
    const failed = await runCommand(quote.swapCommandTemplate, apiUrl)
    expect(failed.status).not.toBe(0)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('wallet unavailable')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('treats WBNB as ERC-20 and rejects native BNB or incompatible routers', () => {
  const { steps } = buildPancakeSwapSteps({ ...base, path: [WBNB, B], fees: [2500] })
  expect(steps[0].to.toLowerCase()).toBe(WBNB.toLowerCase())
  expect(steps[1].value).toBe('0x0')
  for (const change of [
    { path: ['0x0000000000000000000000000000000000000000', B], fees: [500] },
    { fees: [500] },
    { fees: [500, 3000] },
    { fees: [] },
    { router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' },
    { amountOutMinWei: '0' },
  ])
    expect(() => buildPancakeSwapSteps({ ...base, ...change })).toThrow()
})

it.each(['--wallet 0x1111111111111111111111111111111111111111', '--deadline 1200'])(
  'rejects removed swap argument %s before contacting the platform',
  async (flag) => {
    const result = await runCommand(`purr pancake swap --chain-id 56 ${flag}`, 'http://127.0.0.1:1')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no longer accepts --wallet or --deadline')
  },
)
