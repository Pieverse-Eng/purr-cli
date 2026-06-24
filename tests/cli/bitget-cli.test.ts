import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-bitget'
const API_TOKEN = 'test-token'

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

async function runPurr(port: number, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy, ...cleanEnv } =
      process.env
    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...cleanEnv,
        NO_PROXY: '*',
        no_proxy: '*',
        BITGET_WALLET_API_BASE_URL: `http://127.0.0.1:${port}`,
        WALLET_API_URL: 'http://127.0.0.1:1',
        WALLET_API_TOKEN: API_TOKEN,
        INSTANCE_ID,
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

async function withBitgetServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<void>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res)
    } catch {
      writeJson(res, 500, { status: -1, error_code: -1, msg: 'Mock server error' })
    }
  })
  const port = await listen(server)
  try {
    await fn(port)
  } finally {
    await closeServer(server)
  }
}

describe('Bitget CLI argument parsing', () => {
  it('preserves empty native-token contracts for order execution', async () => {
    const requests: Array<Record<string, unknown>> = []

    await withBitgetServer(
      async (req, res) => {
        assert.equal(req.method, 'POST')
        assert.equal(req.url, '/swap-go/swapx/makeOrder')
        requests.push(await readJsonBody(req))
        writeJson(res, 200, { status: 400, error_code: 400, msg: 'stop before signing' })
      },
      async (port) => {
        const result = await runPurr(port, [
          'bitget',
          'order-execute',
          '--order-id',
          'order-1',
          '--from-chain',
          'bnb',
          '--from-contract',
          '',
          '--from-symbol',
          'BNB',
          '--from-address',
          '0x1111111111111111111111111111111111111111',
          '--to-chain',
          'bnb',
          '--to-contract',
          '',
          '--to-symbol',
          'USDT',
          '--to-address',
          '0x1111111111111111111111111111111111111111',
          '--from-amount',
          '0.0052',
          '--slippage',
          '0.02',
          '--market',
          'bitget',
          '--protocol',
          'aggregator',
        ])

        expect(result.code).not.toBe(0)
      },
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      fromContract: '',
      toContract: '',
    })
  })

  it('preserves empty native-token contracts for transfer execution', async () => {
    const requests: Array<Record<string, unknown>> = []

    await withBitgetServer(
      async (req, res) => {
        assert.equal(req.method, 'POST')
        assert.equal(req.url, '/userv2/order/makeTransferOrder')
        requests.push(await readJsonBody(req))
        writeJson(res, 200, { status: 400, error_code: 400, msg: 'stop before signing' })
      },
      async (port) => {
        const result = await runPurr(port, [
          'bitget',
          'transfer-execute',
          '--chain',
          'bnb',
          '--contract',
          '',
          '--from-address',
          '0x1111111111111111111111111111111111111111',
          '--to-address',
          '0x2222222222222222222222222222222222222222',
          '--amount',
          '0.01',
        ])

        expect(result.code).not.toBe(0)
      },
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      contract: '',
    })
  })

  it('requires from-address for OWS prepared order execution before signing or submit', async () => {
    let requestCount = 0

    await withBitgetServer(
      async (_req, res) => {
        requestCount += 1
        writeJson(res, 500, { status: -1, error_code: -1, msg: 'should not be called' })
      },
      async (port) => {
        const result = await runPurr(port, [
          'ows-wallet',
          'bitget-order-execute',
          '--ows-wallet',
          'treasury',
          '--make-order-json',
          JSON.stringify({
            data: {
              orderId: 'prepared-order-1',
              txs: [
                {
                  chainId: 56,
                  deriveTransaction: {
                    to: '0x2222222222222222222222222222222222222222',
                    calldata: '0x',
                    gasLimit: '21000',
                    gasPrice: '1000000000',
                    nonce: 1,
                    chainId: 56,
                    value: '0',
                  },
                },
              ],
            },
          }),
        ])

        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain('Missing required argument: --from-address')
      },
    )

    expect(requestCount).toBe(0)
  })

  it('requires from-address for OWS prepared transfer execution before signing or submit', async () => {
    let requestCount = 0

    await withBitgetServer(
      async (_req, res) => {
        requestCount += 1
        writeJson(res, 500, { status: -1, error_code: -1, msg: 'should not be called' })
      },
      async (port) => {
        const result = await runPurr(port, [
          'ows-wallet',
          'bitget-transfer-execute',
          '--ows-wallet',
          'treasury',
          '--transfer-order-json',
          JSON.stringify({
            data: {
              orderId: 'prepared-transfer-1',
              source: {
                type: 'evm_1559',
                evm: {
                  to: '0x2222222222222222222222222222222222222222',
                  data: '0x',
                  gasLimit: '21000',
                  maxFeePerGas: '1000000000',
                  maxPriorityFeePerGas: '100000000',
                  nonce: 1,
                  chainId: 8453,
                  value: '0',
                },
              },
            },
          }),
        ])

        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain('Missing required argument: --from-address')
      },
    )

    expect(requestCount).toBe(0)
  })
})
