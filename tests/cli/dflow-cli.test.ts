import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-dflow'
const API_TOKEN = 'test-token'
const SOLANA_ADDRESS = 'DZttmKxhq1H7v5fFVPbejCkqHiTDjq9J6Q1muQT2ouWD'
const SERIALIZED_TRANSACTION = 'base64-serialized-solana-transaction-payload'

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
    const cleanEnv = { ...process.env }
    for (const name of [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'DFLOW_API_KEY',
      'DFLOW_TRADE_API_BASE_URL',
    ]) {
      delete cleanEnv[name]
    }

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

async function withDflowServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<void>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res)
    } catch {
      writeJson(res, 500, { ok: false, error: 'Internal server error' })
    }
  })
  const port = await listen(server)
  try {
    await fn(port)
  } finally {
    await closeServer(server)
  }
}

describe('DFlow CLI output', () => {
  it('omits the full order by default and includes it with --raw', async () => {
    await withDflowServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/wallet/ensure`) {
          assert.deepEqual(await readJsonBody(req), { chainType: 'solana' })
          writeJson(res, 200, {
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
          return
        }

        if (
          req.method === 'POST' &&
          req.url === `/v1/instances/${INSTANCE_ID}/dflow/order`
        ) {
          assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
          assert.equal(req.headers['x-api-key'], undefined)
          assert.deepEqual(await readJsonBody(req), {
            inputMint: 'input-mint',
            outputMint: 'output-mint',
            amount: '1000000',
          })
          writeJson(res, 200, {
            ok: true,
            data: {
              inAmount: '1000000',
              outAmount: '24000000',
              transaction: SERIALIZED_TRANSACTION,
              lastValidBlockHeight: 12345,
              orderAddress: 'order-address-1',
            },
          })
          return
        }

        writeJson(res, 404, { ok: false, error: 'not found' })
      },
      async (port) => {
        const baseArgs = [
          'dflow',
          'order',
          '--input-mint',
          'input-mint',
          '--output-mint',
          'output-mint',
          '--amount',
          '1000000',
        ]

        const normal = await runPurr(port, baseArgs)
        expect(normal.code).toBe(0)
        expect(normal.stderr).toBe('')
        expect(normal.stdout).not.toContain(SERIALIZED_TRANSACTION)
        const normalOutput = JSON.parse(normal.stdout) as Record<string, unknown>
        expect(normalOutput.order).toBeUndefined()
        expect(normalOutput).toMatchObject({
          type: 'dflow-order',
          userPublicKey: SOLANA_ADDRESS,
          transport: 'platform',
          platformApiBaseUrl: `http://127.0.0.1:${port}`,
          summary: {
            inAmount: '1000000',
            outAmount: '24000000',
            orderAddress: 'order-address-1',
            hasTransaction: true,
          },
        })

        const raw = await runPurr(port, [...baseArgs, '--raw', 'true'])
        expect(raw.code).toBe(0)
        expect(raw.stderr).toBe('')
        expect(raw.stdout).toContain(SERIALIZED_TRANSACTION)
        const rawOutput = JSON.parse(raw.stdout) as { order?: Record<string, unknown> }
        expect(rawOutput.order?.transaction).toBe(SERIALIZED_TRANSACTION)
      },
    )
  })

  it('queries DFlow order status by transaction signature', async () => {
    await withDflowServer(
      async (req, res) => {
        if (
          req.method === 'GET' &&
          req.url?.startsWith(`/v1/instances/${INSTANCE_ID}/dflow/order-status?`)
        ) {
          const parsed = new URL(req.url, 'http://127.0.0.1')
          assert.equal(parsed.searchParams.get('signature'), 'transaction-signature-1')
          assert.equal(parsed.searchParams.get('lastValidBlockHeight'), '12345')
          assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
          assert.equal(req.headers['x-api-key'], undefined)
          writeJson(res, 200, {
            ok: true,
            data: { status: 'closed', signature: 'transaction-signature-1' },
          })
          return
        }

        writeJson(res, 404, { ok: false, error: 'not found' })
      },
      async (port) => {
        const result = await runPurr(port, [
          'dflow',
          'status',
          '--signature',
          'transaction-signature-1',
          '--last-valid-block-height',
          '12345',
        ])

        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toMatchObject({
          type: 'dflow-status',
          signature: 'transaction-signature-1',
          terminal: true,
          status: { status: 'closed' },
        })
      },
    )
  })

  it('rejects legacy DFlow authentication flags', async () => {
    const apiKeyResult = await runPurr(1, [
      'dflow',
      'status',
      '--signature',
      'transaction-signature-1',
      '--api-key',
      'legacy-key',
    ])
    expect(apiKeyResult.code).toBe(1)
    expect(apiKeyResult.stderr).toContain(
      '--api-key is no longer supported; DFlow authentication is managed by the platform',
    )

    const baseUrlResult = await runPurr(1, [
      'dflow',
      'status',
      '--signature',
      'transaction-signature-1',
      '--base-url',
      'https://quote-api.dflow.net',
    ])
    expect(baseUrlResult.code).toBe(1)
    expect(baseUrlResult.stderr).toContain(
      '--base-url is no longer supported; DFlow requests are routed through the platform',
    )
  })
})
