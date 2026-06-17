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

describe('PNS CLI e2e', () => {
  let port = 0
  let tmpHome = ''
  let requestCount = 0
  const requests: Array<{ method?: string; url?: string; authorization?: string }> = []

  const server = createServer((req, res) => {
    try {
      requestCount++
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      })

      assert.equal(req.method, 'GET')
      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

      if (req.url === '/v2/handles/alice') {
        writeJson(res, 200, {
          ok: true,
          data: {
            kind: 'handle',
            handle: 'alice',
            renderedHandle: 'alice.pie',
            walletAddress: WALLET_ADDRESS,
          },
        })
        return
      }

      if (
        req.url ===
        `/v2/instances/${INSTANCE_ID}/pie-identities/by-account?channel=line&account=line-user`
      ) {
        writeJson(res, 200, {
          ok: true,
          data: {
            pieName: 'alice.pie',
          },
        })
        return
      }

      if (req.url === `/v2/instances/${INSTANCE_ID}/pie-identities/alice/accounts`) {
        writeJson(res, 200, {
          ok: true,
          data: {
            accounts: [{ channel: 'line', accountId: 'line-user', username: 'Line Alice' }],
          },
        })
        return
      }

      if (req.url === `/v2/instances/${INSTANCE_ID}/pie-identities/alice.pie/profile`) {
        writeJson(res, 200, {
          ok: true,
          data: {
            pieName: 'alice.pie',
            agentType: 'hosted',
            runtimeType: 'hermes',
            walletAddress: WALLET_ADDRESS,
            active: true,
            gatewayStatus: 'running',
            merchant: {
              enabled: false,
              useUpstreamSkill: false,
              agentCard: null,
              agentCardStatus: 'not_enabled',
            },
          },
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
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-pns-e2e-'))
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

  it('resolves a handle through the platform route and prints only the wallet address', async () => {
    const result = await runPurr(port, tmpHome, ['pns', 'resolve', 'alice'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(WALLET_ADDRESS)
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: '/v2/handles/alice',
      authorization: `Bearer ${API_TOKEN}`,
    })
  })

  it('resolves a paired account and prints only the pie name', async () => {
    const result = await runPurr(port, tmpHome, [
      'pns',
      'by-account',
      '--channel',
      'line',
      '--account',
      'line-user',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('alice.pie')
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v2/instances/${INSTANCE_ID}/pie-identities/by-account?channel=line&account=line-user`,
      authorization: `Bearer ${API_TOKEN}`,
    })
  })

  it('prints paired accounts as JSON', async () => {
    const result = await runPurr(port, tmpHome, ['pns', 'accounts', 'alice'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      accounts: [{ channel: 'line', accountId: 'line-user', username: 'Line Alice' }],
    })
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v2/instances/${INSTANCE_ID}/pie-identities/alice/accounts`,
      authorization: `Bearer ${API_TOKEN}`,
    })
  })

  it('prints a pie identity profile as JSON', async () => {
    const result = await runPurr(port, tmpHome, ['pns', 'profile', 'alice.pie'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      pieName: 'alice.pie',
      agentType: 'hosted',
      runtimeType: 'hermes',
      walletAddress: WALLET_ADDRESS,
      active: true,
      gatewayStatus: 'running',
    })
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v2/instances/${INSTANCE_ID}/pie-identities/alice.pie/profile`,
      authorization: `Bearer ${API_TOKEN}`,
    })
  })
})
