import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-token'
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
    delete cleanEnv.INSTANCE_ID

    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...cleanEnv,
        HOME: tmpHome,
        NO_PROXY: '*',
        no_proxy: '*',
        WALLET_API_URL: `http://127.0.0.1:${port}`,
        WALLET_API_TOKEN: API_TOKEN,
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
      assert.equal(req.url, '/v2/handles/alice')
      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

      writeJson(res, 200, {
        ok: true,
        data: {
          kind: 'handle',
          handle: 'alice',
          renderedHandle: 'alice.pie',
          walletAddress: WALLET_ADDRESS,
        },
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
})
