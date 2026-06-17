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
const TOKEN_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

function writeJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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

describe('.pie CLI e2e', () => {
  let port = 0
  let tmpHome = ''
  const requests: Array<{
    method?: string
    url?: string
    authorization?: string
    body?: unknown
  }> = []

  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      })

      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

      if (
        req.method === 'GET' &&
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

      if (
        req.method === 'GET' &&
        req.url ===
          `/v2/instances/${INSTANCE_ID}/pie-identities/by-account?channel=line&account=missing-user`
      ) {
        writeJson(res, 200, {
          ok: true,
          data: {
            pieName: null,
          },
        })
        return
      }

      if (req.method === 'GET' && req.url === '/v2/handles/alice.pie') {
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

      if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/wallet/transfer`) {
        writeJson(res, 200, {
          ok: true,
          data: {
            from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            to: WALLET_ADDRESS,
            amount: '100',
            hash: '0xtransfer',
            chainId: 56,
            chainType: 'ethereum',
            assetType: 'erc20',
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
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-pie-e2e-'))
    port = await listen(server)
  })

  beforeEach(() => {
    requests.length = 0
  })

  afterAll(async () => {
    await closeServer(server)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('resolves a channel account to .pie, resolves the wallet, then transfers to that wallet', async () => {
    const result = await runPurr(port, tmpHome, [
      '.pie',
      'transfer',
      '--channel',
      'line',
      '--account',
      'line-user',
      '--amount',
      '100',
      '--chain-id',
      '56',
      '--token',
      'USDT',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: WALLET_ADDRESS,
      amount: '100',
      hash: '0xtransfer',
      chainId: 56,
      chainType: 'ethereum',
      assetType: 'erc20',
      pieName: 'alice.pie',
    })
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        'GET',
        `/v2/instances/${INSTANCE_ID}/pie-identities/by-account?channel=line&account=line-user`,
      ],
      ['GET', '/v2/handles/alice.pie'],
      ['POST', `/v1/instances/${INSTANCE_ID}/wallet/transfer`],
    ])
    expect(requests[2]?.body).toEqual({
      to: WALLET_ADDRESS,
      amount: '100',
      chainType: 'ethereum',
      chainId: 56,
      assetType: 'erc20',
      tokenAddress: TOKEN_ADDRESS,
    })
  })

  it('resolves a direct .pie input and transfers to that wallet', async () => {
    const result = await runPurr(port, tmpHome, [
      '.pie',
      'transfer',
      '--pie',
      'alice.pie',
      '--amount',
      '100',
      '--chain-id',
      '56',
      '--token',
      'USDT',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: WALLET_ADDRESS,
      amount: '100',
      hash: '0xtransfer',
      chainId: 56,
      chainType: 'ethereum',
      assetType: 'erc20',
      pieName: 'alice.pie',
    })
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', '/v2/handles/alice.pie'],
      ['POST', `/v1/instances/${INSTANCE_ID}/wallet/transfer`],
    ])
    expect(requests[1]?.body).toEqual({
      to: WALLET_ADDRESS,
      amount: '100',
      chainType: 'ethereum',
      chainId: 56,
      assetType: 'erc20',
      tokenAddress: TOKEN_ADDRESS,
    })
  })

  it('stops before handle resolution and transfer when no .pie identity is paired', async () => {
    const result = await runPurr(port, tmpHome, [
      '.pie',
      'transfer',
      '--channel',
      'line',
      '--account',
      'missing-user',
      '--amount',
      '100',
      '--chain-id',
      '56',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('No .pie identity found for line:missing-user')
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        'GET',
        `/v2/instances/${INSTANCE_ID}/pie-identities/by-account?channel=line&account=missing-user`,
      ],
    ])
  })

  it('rejects solana transfers before resolving the channel account', async () => {
    const result = await runPurr(port, tmpHome, [
      '.pie',
      'transfer',
      '--channel',
      'line',
      '--account',
      'line-user',
      '--amount',
      '1',
      '--chain-type',
      'solana',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('purr .pie transfer currently supports only ethereum recipients')
    expect(requests).toEqual([])
  })
})
