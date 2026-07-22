import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-token'
const INSTANCE_ID = 'inst-osero'
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

describe('Osero CLI e2e', () => {
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

      if (req.url === `/v1/instances/${INSTANCE_ID}/osero/chains`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: [
            {
              chainId: 8453,
              name: 'Base',
              shortName: 'base',
              platformSupported: true,
            },
          ],
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/osero/apy?chainId=8453`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            chainId: 8453,
            apy: 0.036,
            apyPercent: 3.6,
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/osero/balances?chainId=8453`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            chainId: 8453,
            account: WALLET_ADDRESS,
            tokens: {
              USDC: { balance: '5750699', balanceFormatted: '5.750699' },
              USDS: { balance: '0', balanceFormatted: '0' },
              sUSDS: { balance: '0', balanceFormatted: '0' },
            },
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/osero/preview/mint-susds`) {
        assert.equal(req.method, 'POST')
        assert.deepEqual(JSON.parse(body), {
          chainId: 8453,
          amount: '1000000',
        })
        writeJson(res, 200, {
          ok: true,
          data: {
            action: 'mint-susds',
            chainId: 8453,
            inputToken: 'USDC',
            outputToken: 'sUSDS',
            inputAmount: '1000000',
            outputAmount: '905937000000000000',
            outputAmountFormatted: '0.905937',
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/osero/execute/redeem-susds`) {
        assert.equal(req.method, 'POST')
        assert.deepEqual(JSON.parse(body), {
          chainId: 8453,
          amount: '905937000000000000',
          receiver: WALLET_ADDRESS,
          slippageBps: 300,
          referralCode: '42',
        })
        writeJson(res, 200, {
          ok: true,
          data: {
            plan: {
              action: 'redeem-susds',
              chainId: 8453,
              transactionCount: 2,
              operations: ['APPROVE_ERC20', 'REDEEM_SUSDS_FOR_USDC'],
            },
            execution: {
              from: WALLET_ADDRESS,
              chainId: 8453,
              results: [
                {
                  stepIndex: 0,
                  operation: 'APPROVE_ERC20',
                  hash: `0x${'a'.repeat(64)}`,
                },
                {
                  stepIndex: 1,
                  operation: 'REDEEM_SUSDS_FOR_USDC',
                  hash: `0x${'b'.repeat(64)}`,
                },
              ],
              finalHash: `0x${'b'.repeat(64)}`,
            },
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/osero/contracts?chainId=999999`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 400, {
          ok: false,
          code: 'OSERO_UNSUPPORTED_CHAIN',
          error: 'Unsupported Osero chain',
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
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-osero-e2e-'))
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

  it('prints Osero supported chains from the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['osero', 'chains'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual([
      {
        chainId: 8453,
        name: 'Base',
        shortName: 'base',
        platformSupported: true,
      },
    ])
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/osero/chains`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('supports chain aliases for read endpoints', async () => {
    const result = await runPurr(port, tmpHome, ['osero', 'apy', '--chain', 'base'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      chainId: 8453,
      apy: 0.036,
      apyPercent: 3.6,
    })
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/osero/apy?chainId=8453`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('previews mint-susds with raw integer amount only', async () => {
    const result = await runPurr(port, tmpHome, [
      'osero',
      'preview',
      '--action',
      'mint-susds',
      '--chain',
      'base',
      '--amount',
      '1000000',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: 'mint-susds',
      inputToken: 'USDC',
      outputToken: 'sUSDS',
      outputAmountFormatted: '0.905937',
    })
    expect(JSON.parse(requests[0].body)).not.toHaveProperty('idempotencyKey')
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/osero/preview/mint-susds`,
      authorization: `Bearer ${API_TOKEN}`,
    })
  })

  it('executes redeem-susds and prints tx hashes returned by platform', async () => {
    const result = await runPurr(port, tmpHome, [
      'osero',
      'execute',
      '--action',
      'redeem-susds',
      '--chain-id',
      '8453',
      '--amount',
      '905937000000000000',
      '--receiver',
      WALLET_ADDRESS,
      '--slippage-bps',
      '300',
      '--referral-code',
      '42',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout)
    expect(output.execution.finalHash).toBe(`0x${'b'.repeat(64)}`)
    expect(output.execution.results).toHaveLength(2)
    expect(JSON.parse(requests[0].body)).not.toHaveProperty('idempotencyKey')
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/osero/execute/redeem-susds`,
      authorization: `Bearer ${API_TOKEN}`,
    })
  })

  it('formats platform Osero errors with their code', async () => {
    const result = await runPurr(port, tmpHome, [
      'osero',
      'contracts',
      '--chain-id',
      '999999',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error [OSERO_UNSUPPORTED_CHAIN]: Unsupported Osero chain')
  })

  it('prints Osero help without exposing idempotency options', async () => {
    const result = await runPurr(port, tmpHome, ['osero', 'help'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: purr osero <command> [options]')
    expect(result.stdout).not.toMatch(/idempotency/i)
    expect(requestCount).toBe(0)
  })
})
