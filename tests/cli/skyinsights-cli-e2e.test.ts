import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-token'
const INSTANCE_ID = 'inst-123'
const WALLET_ADDRESS = '0x5e2c75267ac8cC7530C90Ab431c4F25452C024CE'
const TX_HASH = `0x${'a'.repeat(64)}`
const REQUEST_ID = '00000000-0000-0000-0000-000000000123'
const CREATED_AT = '2026-07-22T00:00:00.000Z'
const UPDATED_AT = '2026-07-22T00:00:01.000Z'
const COMPLETED_AT = '2026-07-22T00:00:02.000Z'

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

describe('SkyInsights CLI e2e', () => {
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

      const encodedAddress = encodeURIComponent(WALLET_ADDRESS)
      const basePath = `/v1/instances/${INSTANCE_ID}/security/skyinsights`

      if (req.url === `${basePath}/kya/labels?chain=bsc&address=${encodedAddress}`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            provider: 'skyinsights',
            operation: 'kya_labels',
            result: {
              chain: 'bsc',
              address: WALLET_ADDRESS,
              entities: [],
              labels: [],
            },
          },
        })
        return
      }

      if (req.url === `${basePath}/kya/risk?chain=bsc&address=${encodedAddress}`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            provider: 'skyinsights',
            operation: 'kya_risk',
            result: {
              chain: 'bsc',
              address: WALLET_ADDRESS,
              riskLevel: 'None',
              riskScore: 0,
              verdict: 'safe',
              riskReasons: [],
              riskFactors: {},
              entities: [],
              labels: [],
            },
          },
        })
        return
      }

      if (req.url === `${basePath}/kyt/risk?chain=bsc&txHash=${TX_HASH}`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            provider: 'skyinsights',
            operation: 'kyt_risk',
            result: {
              chain: 'bsc',
              txHash: TX_HASH,
              transactionStatus: 'success',
              tokens: ['BNB'],
              totalUsd: '12.34',
              timestamp: 1784552800000,
              riskLevel: 'Medium',
              riskScore: 12,
              verdict: 'warn',
              riskReasons: ['Mixer exposure'],
              riskFactors: { mixer: [{ level: 'Medium' }] },
              transfer: null,
            },
          },
        })
        return
      }

      if (req.url === `${basePath}/kya/screenings`) {
        if (req.method === 'POST') {
          assert.deepEqual(JSON.parse(body), {
            chain: 'bsc',
            address: WALLET_ADDRESS,
            ruleSetId: 'standard-mode-rule-set',
          })
          writeJson(res, 202, {
            ok: true,
            data: {
              provider: 'skyinsights',
              requestId: REQUEST_ID,
              operation: 'kya_screening_v2',
              status: 'submitted',
              chain: 'bsc',
              address: WALLET_ADDRESS,
              riskLevel: null,
              verdict: null,
              result: null,
              errorCode: null,
              createdAt: CREATED_AT,
              updatedAt: UPDATED_AT,
              completedAt: null,
            },
          })
          return
        }

        if (req.method === 'GET') {
          writeJson(res, 200, {
            ok: true,
            data: [
              {
                provider: 'skyinsights',
                requestId: REQUEST_ID,
                operation: 'kya_screening_v2',
                status: 'succeeded',
                chain: 'bsc',
                address: WALLET_ADDRESS,
                riskLevel: 'None',
                verdict: 'safe',
                result: {
                  chain: 'bsc',
                  address: WALLET_ADDRESS,
                  ruleSetId: 'standard-mode-rule-set',
                  status: 'SUCCESS',
                  riskLevel: 'None',
                  verdict: 'safe',
                  riskResults: {},
                  counterparties: {},
                  createdAt: null,
                  updatedAt: null,
                  startedAt: null,
                  finishedAt: COMPLETED_AT,
                },
                errorCode: null,
                createdAt: CREATED_AT,
                updatedAt: UPDATED_AT,
                completedAt: COMPLETED_AT,
              },
            ],
          })
          return
        }
      }

      if (req.url === `${basePath}/kya/screenings?limit=5`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: [
            {
              provider: 'skyinsights',
              requestId: REQUEST_ID,
              operation: 'kya_screening_v2',
              status: 'succeeded',
              chain: 'bsc',
              address: WALLET_ADDRESS,
              riskLevel: 'None',
              verdict: 'safe',
              result: {
                chain: 'bsc',
                address: WALLET_ADDRESS,
                ruleSetId: 'standard-mode-rule-set',
                status: 'SUCCESS',
                riskLevel: 'None',
                verdict: 'safe',
                riskResults: {},
                counterparties: {},
                createdAt: null,
                updatedAt: null,
                startedAt: null,
                finishedAt: COMPLETED_AT,
              },
              errorCode: null,
              createdAt: CREATED_AT,
              updatedAt: UPDATED_AT,
              completedAt: COMPLETED_AT,
            },
          ],
        })
        return
      }

      if (req.url === `${basePath}/kya/screenings/${REQUEST_ID}`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            provider: 'skyinsights',
            requestId: REQUEST_ID,
            operation: 'kya_screening_v2',
            status: 'succeeded',
            chain: 'bsc',
            address: WALLET_ADDRESS,
            riskLevel: 'None',
            verdict: 'safe',
            result: {
              chain: 'bsc',
              address: WALLET_ADDRESS,
              ruleSetId: 'standard-mode-rule-set',
              status: 'SUCCESS',
              riskLevel: 'None',
              verdict: 'safe',
              riskResults: {},
              counterparties: {},
              createdAt: null,
              updatedAt: null,
              startedAt: null,
              finishedAt: COMPLETED_AT,
            },
            errorCode: null,
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            completedAt: COMPLETED_AT,
          },
        })
        return
      }

      if (req.url === `${basePath}/kya/risk?chain=eth&address=${encodedAddress}`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 502, {
          ok: false,
          code: 'skyinsights_invalid_response',
          error: 'SkyInsights returned an unexpected response shape.',
          retryable: false,
          retryAfterSeconds: null,
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
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-skyinsights-e2e-'))
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

  it('prints KYA labels from the platform route', async () => {
    const result = await runPurr(port, tmpHome, [
      'skyinsights',
      'kya-labels',
      '--chain',
      'bsc',
      '--address',
      WALLET_ADDRESS,
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      provider: 'skyinsights',
      operation: 'kya_labels',
      result: {
        chain: 'bsc',
        address: WALLET_ADDRESS,
        entities: [],
        labels: [],
      },
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/security/skyinsights/kya/labels?chain=bsc&address=${encodeURIComponent(WALLET_ADDRESS)}`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('prints KYA risk from the platform route', async () => {
    const result = await runPurr(port, tmpHome, [
      'skyinsights',
      'kya-risk',
      '--chain',
      'bsc',
      '--address',
      WALLET_ADDRESS,
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      provider: 'skyinsights',
      operation: 'kya_risk',
      result: {
        address: WALLET_ADDRESS,
        chain: 'bsc',
        riskLevel: 'None',
        verdict: 'safe',
      },
    })
    expect(requestCount).toBe(1)
    expect(requests[0]?.url).toBe(
      `/v1/instances/${INSTANCE_ID}/security/skyinsights/kya/risk?chain=bsc&address=${encodeURIComponent(WALLET_ADDRESS)}`,
    )
  })

  it('prints KYT risk from the platform route', async () => {
    const result = await runPurr(port, tmpHome, [
      'skyinsights',
      'kyt-risk',
      '--chain',
      'bsc',
      '--tx-hash',
      TX_HASH,
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      provider: 'skyinsights',
      operation: 'kyt_risk',
      result: {
        txHash: TX_HASH,
        chain: 'bsc',
        riskLevel: 'Medium',
        verdict: 'warn',
      },
    })
    expect(requestCount).toBe(1)
    expect(requests[0]?.url).toBe(
      `/v1/instances/${INSTANCE_ID}/security/skyinsights/kyt/risk?chain=bsc&txHash=${TX_HASH}`,
    )
  })

  it('submits a KYA screening request through the platform route', async () => {
    const result = await runPurr(port, tmpHome, [
      'skyinsights',
      'screening-submit',
      '--chain',
      'bsc',
      '--address',
      WALLET_ADDRESS,
      '--rule-set-id',
      'standard-mode-rule-set',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      provider: 'skyinsights',
      requestId: REQUEST_ID,
      operation: 'kya_screening_v2',
      status: 'submitted',
      chain: 'bsc',
      address: WALLET_ADDRESS,
      riskLevel: null,
      verdict: null,
      result: null,
      errorCode: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      completedAt: null,
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/security/skyinsights/kya/screenings`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify({
        chain: 'bsc',
        address: WALLET_ADDRESS,
        ruleSetId: 'standard-mode-rule-set',
      }),
    })
  })

  it('lists KYA screening requests through the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['skyinsights', 'screening-list', '--limit', '5'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual([
      {
        provider: 'skyinsights',
        requestId: REQUEST_ID,
        operation: 'kya_screening_v2',
        status: 'succeeded',
        chain: 'bsc',
        address: WALLET_ADDRESS,
        riskLevel: 'None',
        verdict: 'safe',
        result: {
          chain: 'bsc',
          address: WALLET_ADDRESS,
          ruleSetId: 'standard-mode-rule-set',
          status: 'SUCCESS',
          riskLevel: 'None',
          verdict: 'safe',
          riskResults: {},
          counterparties: {},
          createdAt: null,
          updatedAt: null,
          startedAt: null,
          finishedAt: COMPLETED_AT,
        },
        errorCode: null,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        completedAt: COMPLETED_AT,
      },
    ])
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/security/skyinsights/kya/screenings?limit=5`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('gets a KYA screening request through the platform route', async () => {
    const result = await runPurr(port, tmpHome, [
      'skyinsights',
      'screening-get',
      '--request-id',
      REQUEST_ID,
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      provider: 'skyinsights',
      requestId: REQUEST_ID,
      operation: 'kya_screening_v2',
      status: 'succeeded',
      chain: 'bsc',
      address: WALLET_ADDRESS,
      riskLevel: 'None',
      verdict: 'safe',
      result: {
        chain: 'bsc',
        address: WALLET_ADDRESS,
        ruleSetId: 'standard-mode-rule-set',
        status: 'SUCCESS',
        riskLevel: 'None',
        verdict: 'safe',
        riskResults: {},
        counterparties: {},
        createdAt: null,
        updatedAt: null,
        startedAt: null,
        finishedAt: COMPLETED_AT,
      },
      errorCode: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      completedAt: COMPLETED_AT,
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/security/skyinsights/kya/screenings/${REQUEST_ID}`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('prints SkyInsights platform error details', async () => {
    const result = await runPurr(port, tmpHome, [
      'skyinsights',
      'kya-risk',
      '--chain',
      'eth',
      '--address',
      WALLET_ADDRESS,
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const [errorLine, ...detailLines] = result.stderr.split('\n')
    expect(errorLine).toBe(
      'error [skyinsights_invalid_response]: SkyInsights returned an unexpected response shape.',
    )
    expect(detailLines).toEqual([])
    expect(requestCount).toBe(1)
  })
})
