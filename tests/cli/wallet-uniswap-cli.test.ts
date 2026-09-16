import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-wallet-uniswap'
const API_TOKEN = 'test-token'
const NATIVE = '0x0000000000000000000000000000000000000000'
const SPCX = '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

function writeJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local mock server'))
        return
      }
      resolve(address.port)
    })
  })
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function runPurr(
  port: number,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy, ...cleanEnv } =
      process.env
    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...cleanEnv,
        NO_PROXY: '*',
        no_proxy: '*',
        WALLET_API_URL: `http://127.0.0.1:${port}`,
        WALLET_API_TOKEN: API_TOKEN,
        INSTANCE_ID,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

async function withApiServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<void>,
  fn: (port: number) => Promise<void>,
  research = false,
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/rpc') {
        assert.equal(req.headers.authorization, undefined)
      } else if (research) {
        assert.equal(req.headers.authorization, undefined)
        assert.equal(req.headers['x-pieverse-market-quote-capability'], 'read-only')
      } else {
        assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
      }
      await handler(req, res)
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Mock server error',
      })
    }
  })
  const port = await listen(server)
  try {
    await fn(port)
  } finally {
    await closeServer(server)
  }
}

describe('wallet uniswap CLI', () => {
  it('automatically confirms execute through RPC and prints one JSON result without a wait flag', async () => {
    const hash = `0x${'12'.repeat(32)}`
    const owner = `0x${'34'.repeat(20)}`
    let submissions = 0
    await withApiServer(
      async (req, res) => {
        const body = await readJsonBody(req)
        if (req.url?.endsWith('/uniswap/execute')) {
          submissions++
          writeJson(res, 200, {
            ok: true,
            data: {
              mode: 'transaction',
              hash,
              chainId: 4663,
              from: owner,
              fromToken: NATIVE,
              toToken: SPCX,
              estimatedToAmountFormatted: '0.031',
            },
          })
          return
        }
        assert.equal(req.url, '/rpc')
        let result: unknown
        if (body.method === 'eth_chainId') result = '0x1237'
        else if (body.method === 'eth_getTransactionReceipt')
          result = {
            transactionHash: hash,
            from: owner,
            to: SPCX,
            status: '0x1',
            blockNumber: '0x1',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x1',
            logs: [
              {
                address: SPCX,
                topics: [
                  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                  `0x${'0'.repeat(24)}${SPCX.slice(2)}`,
                  `0x${'0'.repeat(24)}${owner.slice(2)}`,
                ],
                data: `0x${1234567890123456789n.toString(16).padStart(64, '0')}`,
              },
            ],
          }
        else if (body.method === 'eth_call') result = `0x${'12'.padStart(64, '0')}`
        else throw new Error(`Unexpected RPC: ${body.method}`)
        writeJson(res, 200, { jsonrpc: '2.0', id: body.id, result })
      },
      async (port) => {
        const result = await runPurr(
          port,
          [
            'wallet',
            'uniswap',
            '--from',
            'ETH',
            '--to',
            'SPCX',
            '--amount',
            '0.003',
            '--chain',
            'robinhood',
            '--execute',
          ],
          {
            EVM_RPC_4663: `http://127.0.0.1:${port}/rpc`,
          },
        )
        expect(result.code).toBe(0)
        expect(result.stderr).toContain(hash)
        expect(JSON.parse(result.stdout)).toMatchObject({
          hash,
          status: 'success',
          output: { amount: '1.234567890123456789' },
          explorerUrl: `https://robinhoodchain.blockscout.com/tx/${hash}`,
        })
        expect(JSON.parse(result.stdout)).not.toHaveProperty('input')
        expect(JSON.parse(result.stdout)).not.toHaveProperty('warnings')
        expect(submissions).toBe(1)
      },
    )
  })

  it('quotes with a research capability and blocks execute despite inherited wallet credentials', async () => {
    let calls = 0
    await withApiServer(
      async (req, res) => {
        calls++
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/wallet/uniswap/quote`)
        assert.equal((await readJsonBody(req)).fromAmount, '100')
        writeJson(res, 200, { ok: true, data: { provider: 'uniswap', gasEstimateUsd: '0.02' } })
      },
      async (port) => {
        const env = {
          FX_PLATFORM_QUOTE_TOKEN: 'read-only',
          FX_PLATFORM_UNISWAP_QUOTE_URL: `http://127.0.0.1:${port}/v1/instances/${INSTANCE_ID}/wallet/uniswap/quote`,
        }
        const args = ['wallet', 'uniswap', '--from', 'USDG', '--to', 'SPCX', '--amount', '100']
        const quote = await runPurr(port, args, env)
        expect(quote.code).toBe(0)
        expect(JSON.parse(quote.stdout)).toMatchObject({
          provider: 'uniswap',
          gasEstimateUsd: '0.02',
        })
        const execute = await runPurr(port, [...args, '--execute'], env)
        expect(execute.code).not.toBe(0)
        expect(execute.stderr).toContain('Execution is unavailable')
        expect(calls).toBe(1)
      },
      true,
    )
  })
  it('dispatches quote and execute through the wallet uniswap command', async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> =
      []

    await withApiServer(
      async (req, res) => {
        const body = await readJsonBody(req)
        requests.push({ method: req.method, url: req.url, body })

        if (
          req.method === 'POST' &&
          req.url === `/v1/instances/${INSTANCE_ID}/wallet/uniswap/quote`
        ) {
          writeJson(res, 200, {
            ok: true,
            data: {
              provider: 'uniswap',
              quoteSource: 'amm',
              chainId: 4663,
              fromToken: NATIVE,
              toToken: SPCX,
              estimatedToAmountFormatted: '0.031',
              minimumToAmount: '30845000000000000',
            },
          })
          return
        }

        if (
          req.method === 'POST' &&
          req.url === `/v1/instances/${INSTANCE_ID}/wallet/uniswap/execute`
        ) {
          writeJson(res, 200, {
            ok: true,
            data: {
              mode: 'transaction',
              hash: '0xabc',
              chainId: 4663,
              fromToken: NATIVE,
              toToken: SPCX,
            },
          })
          return
        }

        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const quote = await runPurr(port, [
          'wallet',
          'uniswap',
          '--from',
          'ETH',
          '--to',
          'SPCX',
          '--amount',
          '0.003',
          '--chain',
          'robinhood',
        ])
        expect(quote.code).toBe(0)
        expect(JSON.parse(quote.stdout)).toMatchObject({
          provider: 'uniswap',
          quoteSource: 'amm',
        })

        const execute = await runPurr(port, [
          'wallet',
          'uniswap',
          '--from',
          'ETH',
          '--to',
          'SPCX',
          '--amount',
          '0.003',
          '--chain',
          'robinhood',
          '--execute',
        ])
        expect(execute.code).toBe(0)
        expect(JSON.parse(execute.stdout)).toMatchObject({
          status: 'unknown',
          hash: '0xabc',
        })
      },
    )

    expect(requests).toEqual([
      {
        method: 'POST',
        url: `/v1/instances/${INSTANCE_ID}/wallet/uniswap/quote`,
        body: {
          fromToken: NATIVE,
          toToken: SPCX,
          fromAmount: '0.003',
          chainId: 4663,
        },
      },
      {
        method: 'POST',
        url: `/v1/instances/${INSTANCE_ID}/wallet/uniswap/execute`,
        body: {
          fromToken: NATIVE,
          toToken: SPCX,
          fromAmount: '0.003',
          chainId: 4663,
        },
      },
    ])
  })
})
