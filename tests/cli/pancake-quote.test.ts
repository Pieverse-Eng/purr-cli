import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { decodeFunctionData, encodeAbiParameters, parseAbi } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quotePancakeSwap } from '../../packages/plugins/vendors/src/pancake'

const A = '0x55d398326f99059fF775485246999027B3197955'
const B = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
const base = { path: [A, B], amountInWei: '500000000000000000000', chainId: 56 }
const abi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])

interface RpcCall {
  id: number
  method: string
  params: [{ data: `0x${string}` }, string]
}

async function withRpc(run: (url: string, calls: RpcCall[]) => Promise<void>, fail = false) {
  const calls: RpcCall[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const call = JSON.parse(body)
    calls.push(call)
    const result =
      call.method === 'eth_chainId'
        ? '0x38'
        : call.method === 'eth_blockNumber'
          ? '0x123'
          : encodeAbiParameters(
              [{ type: 'uint256[]' }],
              [[BigInt(base.amountInWei), 123456789012345678901n]],
            )
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        fail && call.method === 'eth_call'
          ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'execution reverted' } }
          : { jsonrpc: '2.0', id: call.id, result },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('Pancake V2 quote', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('uses configured BSC RPC and gives explicit overrides precedence', async () => {
    await withRpc(async (rpcUrl) => {
      vi.stubEnv('EVM_RPC_56', rpcUrl)
      vi.stubEnv('BNB_RPC_URL', 'http://127.0.0.1:1')
      vi.stubEnv('EVM_RPC_URL', 'http://127.0.0.1:1')
      expect((await quotePancakeSwap(base)).amountOutWei).toBe('123456789012345678901')
      vi.stubEnv('EVM_RPC_56', 'http://127.0.0.1:1')
      expect((await quotePancakeSwap({ ...base, rpcUrl })).amountOutWei).toBe(
        '123456789012345678901',
      )
    })
  })
  it('quotes at one block and floors minimum with bigint precision', async () => {
    await withRpc(async (rpcUrl, calls) => {
      const q = await quotePancakeSwap({ ...base, rpcUrl })
      expect(q.amountOutMinWei).toBe('122222221122222222111')
      expect(q.amountOutWei).toBe('123456789012345678901')
      expect(q.swapCommandTemplate).toContain('--amount-out-min-wei 122222221122222222111')
      expect(q.swapCommandTemplate).toContain(`--path ${A},${B}`)
      expect(q.swapCommandTemplate).toContain("--wallet '<wallet-address>' --deadline '<deadline>'")
      expect(q.swapCommandTemplate).not.toMatch(/--fees|--execute/)
      const read = calls.find((c) => c.method === 'eth_call')
      expect(read!.params[1]).toBe('0x123')
      const decoded = decodeFunctionData({ abi, data: read!.params[0].data })
      expect(decoded.args[0]).toBe(BigInt(base.amountInWei))
      expect(decoded.args[1].map((s) => s.toLowerCase())).toEqual(
        base.path.map((s) => s.toLowerCase()),
      )
      expect(
        calls.every((c) => ['eth_chainId', 'eth_blockNumber', 'eth_call'].includes(c.method)),
      ).toBe(true)
    })
  })
  it('normalizes native BNB to WBNB', async () => {
    await withRpc(async (rpcUrl) => {
      const q = await quotePancakeSwap({
        ...base,
        path: ['0x0000000000000000000000000000000000000000', B],
        rpcUrl,
        slippageBps: 0,
      })
      expect(q.path[0].toLowerCase()).toBe('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')
      expect(q.amountOutMinWei).toBe(q.amountOutWei)
    })
  })
  it.each([
    { chainId: 1 },
    { amountInWei: '0' },
    { amountInWei: '-1' },
    { slippageBps: 10000 },
    { slippageBps: 0.5 },
    { path: [A] },
    { path: [A, ''] },
  ])('rejects invalid input %j', async (override) => {
    await expect(quotePancakeSwap({ ...base, ...override })).rejects.toThrow()
  })
  it('propagates route failures instead of producing a quote', async () => {
    await withRpc(async (rpcUrl) => {
      await expect(quotePancakeSwap({ ...base, rpcUrl })).rejects.toThrow()
    }, true)
  })
  it('CLI prints quote JSON without wallet credentials', async () => {
    await withRpc(async (rpcUrl) => {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn('bun', [
            'packages/cli/src/linux-macos.ts',
            'pancake',
            'quote',
            '--path',
            `${A},${B}`,
            '--amount-in-wei',
            base.amountInWei,
            '--chain-id',
            '56',
            '--rpc-url',
            rpcUrl,
          ])
          let stdout = '',
            stderr = ''
          child.stdout.on('data', (s) => (stdout += s))
          child.stderr.on('data', (s) => (stderr += s))
          child.on('close', (code) => resolve({ code, stdout, stderr }))
        },
      )
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).amountOutMinWei).toBe('122222221122222222111')
    })
  })
})
