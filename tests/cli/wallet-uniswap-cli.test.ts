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
        WALLET_API_URL: `http://127.0.0.1:${port}`,
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

async function withApiServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<void>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
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
          mode: 'transaction',
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
