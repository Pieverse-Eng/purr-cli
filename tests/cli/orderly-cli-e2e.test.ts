import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-token'
const INSTANCE_ID = 'instance-123'
const BROKER_ID = 'broker-1'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

function writeJson(res: ServerResponse<IncomingMessage>, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return body
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

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function runPurr(port: number, home: string): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.HTTP_PROXY
    delete env.http_proxy
    delete env.HTTPS_PROXY
    delete env.https_proxy
    delete env.ALL_PROXY
    delete env.all_proxy

    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', 'orderly', 'balance'], {
      cwd: process.cwd(),
      env: {
        ...env,
        HOME: home,
        NO_PROXY: '*',
        no_proxy: '*',
        WALLET_API_URL: `http://127.0.0.1:${port}`,
        WALLET_API_TOKEN: API_TOKEN,
        INSTANCE_ID,
        ORDERLY_API_URL: `http://127.0.0.1:${port}`,
        ORDERLY_BROKER_ID: BROKER_ID,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

describe('Orderly CLI e2e', () => {
  let server: ReturnType<typeof createServer>
  let port = 0
  let home = ''

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'purr-orderly-e2e-'))
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

        if (url.pathname === `/v1/instances/${INSTANCE_ID}/integrations/orderly-trading`) {
          assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
          writeJson(res, { ok: true, data: { enabled: true } })
          return
        }

        if (url.pathname === `/v1/instances/${INSTANCE_ID}/orderly/private-request`) {
          assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
          assert.equal(req.method, 'POST')
          assert.deepEqual(JSON.parse(await readBody(req)), {
            method: 'GET',
            path: '/v1/client/holding',
          })
          writeJson(res, { ok: true, data: { holding: [] } })
          return
        }

        throw new Error(`Unexpected request: ${req.method} ${url.pathname}${url.search}`)
      } catch (error) {
        console.error('Orderly CLI e2e test server error:', error)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    })
    port = await listen(server)
  })

  afterAll(async () => {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  })

  it('routes private reads through the platform-enforced Orderly proxy', async () => {
    const result = await runPurr(port, home)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ holding: [] })
  })
})
