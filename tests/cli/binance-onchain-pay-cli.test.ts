import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-instance-token'
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const EXTERNAL_ORDER_ID = 'pc0123456789abcdef0123456789abcdef'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
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

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return body
}

function writeJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
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
      'BINANCE_CONNECT_CLIENT_ID',
      'BINANCE_CONNECT_ACCESS_TOKEN',
      'BINANCE_CONNECT_PRIVATE_KEY',
      'BINANCE_CONNECT_BASE_URL',
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

describe('Binance Onchain Pay CLI broker cutover', () => {
  let port = 0
  let requestCount = 0
  const requests: Array<{
    url?: string
    authorization?: string
    idempotencyKey?: string
    body: Record<string, unknown>
  }> = []

  const server = createServer(async (req, res) => {
    requestCount++
    const bodyText = await readRequestBody(req)
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      idempotencyKey:
        typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key']
          : undefined,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    })
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

    if (req.url?.endsWith('/pre-orders')) {
      writeJson(res, 200, {
        ok: true,
        externalOrderId: EXTERNAL_ORDER_ID,
        idempotent: false,
        data: { orderId: 'provider-order' },
      })
      return
    }
    writeJson(res, 404, { ok: false, error: 'not found' })
  })

  beforeAll(async () => {
    port = await listen(server)
  })

  afterAll(async () => {
    await closeServer(server)
  })

  beforeEach(() => {
    requestCount = 0
    requests.length = 0
  })

  it('passes CLI pre-orders through the platform broker', async () => {
    const result = await runPurr(port, [
      'binance-onchain-pay',
      'pre-order',
      '--idempotency-key',
      'checkout-123',
      '--merchant-code',
      'merchant-code',
      '--merchant-name',
      'Merchant Name',
      '--fiat-amount',
      '50',
      '--fiat',
      'USD',
    ])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      orderId: 'provider-order',
      externalOrderId: EXTERNAL_ORDER_ID,
      idempotencyKey: 'checkout-123',
      idempotent: false,
    })
    expect(requests).toEqual([
      {
        url: `/v1/instances/${INSTANCE_ID}/binance-connect/pre-orders`,
        authorization: `Bearer ${API_TOKEN}`,
        idempotencyKey: 'checkout-123',
        body: {
          merchantCode: 'merchant-code',
          merchantName: 'Merchant Name',
          fiatCurrency: 'USD',
          fiatAmount: 50,
        },
      },
    ])
  })

  it('rejects legacy caller-controlled order IDs before any request', async () => {
    const result = await runPurr(port, [
      'binance-onchain-pay',
      'pre-order',
      '--external-order-id',
      'legacy-order',
      '--merchant-code',
      'merchant-code',
      '--merchant-name',
      'Merchant Name',
      '--fiat-amount',
      '50',
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'externalOrderId and timestamp are platform-managed; use --idempotency-key',
    )
    expect(requestCount).toBe(0)
  })
})
