import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-token'
const INSTANCE_ID = 'inst-123'
const WALLET_ADDRESS = '0x1234567890123456789012345678901234567890'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

function writeJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
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

async function runPurr(port: number, tmpHome: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env }
    delete cleanEnv.HTTP_PROXY
    delete cleanEnv.http_proxy
    delete cleanEnv.HTTPS_PROXY
    delete cleanEnv.https_proxy
    delete cleanEnv.ALL_PROXY
    delete cleanEnv.all_proxy

    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...cleanEnv,
        HOME: tmpHome,
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

describe('Hyperliquid CLI e2e', () => {
  let port = 0
  let tmpHome = ''
  let requestCount = 0
  const requests: Array<{
    method?: string
    url?: string
    authorization?: string
    body: string
  }> = []

  const server = createServer(async (req, res) => {
    try {
      requestCount++
      const body = await readRequestBody(req)
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      })

      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/account`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            network: 'mainnet',
            address: WALLET_ADDRESS,
            walletId: 'wallet-row-id',
            walletProvider: 'tee',
            chainType: 'ethereum',
            apiUrl: 'https://api.hyperliquid.xyz',
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/builder-fee/approve`) {
        assert.equal(req.method, 'POST')
        assert.deepEqual(JSON.parse(body), {})
        writeJson(res, 200, {
          ok: true,
          data: {
            network: 'mainnet',
            walletAddress: WALLET_ADDRESS,
            status: 'approved',
            actionRequestId: 'approval-request-id',
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/order`) {
        assert.equal(req.method, 'POST')
        writeJson(res, 428, {
          ok: false,
          code: 'HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED',
          error: 'Builder fee approval is required',
        })
        return
      }

      writeJson(res, 404, {
        ok: false,
        error: 'Not found',
      })
    } catch {
      writeJson(res, 500, {
        ok: false,
        error: 'Internal server error',
      })
    }
  })

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-hyperliquid-e2e-'))
    port = await listen(server)
  })

  beforeEach(() => {
    requestCount = 0
    requests.length = 0
  })

  afterAll(async () => {
    await closeServer(server)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('prints the Hyperliquid account response from the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'account'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      network: 'mainnet',
      address: WALLET_ADDRESS,
      walletProvider: 'tee',
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/account`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('approves the fixed Hyperliquid builder fee through the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'approve-builder-fee'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      network: 'mainnet',
      walletAddress: WALLET_ADDRESS,
      status: 'approved',
      actionRequestId: 'approval-request-id',
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/builder-fee/approve`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '{}',
    })
  })

  it('exposes builder fee approval requirements without automatically retrying', async () => {
    const order = {
      orders: [
        {
          a: 0,
          b: true,
          p: '100',
          s: '0.01',
          r: false,
          t: { limit: { tif: 'Gtc' } },
        },
      ],
      grouping: 'na',
    }
    const result = await runPurr(port, tmpHome, [
      'hyperliquid',
      'order',
      '--body-json',
      JSON.stringify(order),
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'error [HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED]: Builder fee approval is required',
    )
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/order`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify(order),
    })
  })
})
