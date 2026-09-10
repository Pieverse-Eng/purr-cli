import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const API_TOKEN = 'test-token'
const INSTANCE_ID = 'instance-123'
const EVM_ADDRESS = '0x1111111111111111111111111111111111111111'
const SOLANA_ADDRESS = 'So11111111111111111111111111111111112'
const ACCOUNT_ID = `0x${'22'.repeat(32)}`
const BROKER_ID = 'broker-1'
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SEED = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
)
const ED25519_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, ED25519_SEED]),
  format: 'der',
  type: 'pkcs8',
})
const ED25519_PUBLIC_KEY = createPublicKey(ED25519_PRIVATE_KEY)

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
  let receivedWalletSignature = false
  let verifiedOrderlyHeader = false

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'purr-orderly-e2e-'))
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

        if (url.pathname === `/v1/instances/${INSTANCE_ID}/wallet`) {
          assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
          const chainType = url.searchParams.get('chain_type')
          writeJson(res, {
            ok: true,
            data: { address: chainType === 'solana' ? SOLANA_ADDRESS : EVM_ADDRESS },
          })
          return
        }
        if (url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/sign`) {
          assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
          assert.equal(req.method, 'POST')
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>
          assert.equal(body.chainType, 'solana')
          assert.equal(body.scheme, 'raw')
          assert.equal(typeof body.message, 'string')
          receivedWalletSignature = true
          writeJson(res, {
            ok: true,
            data: {
              signature: bs58.encode(sign(null, Buffer.from(body.message), ED25519_PRIVATE_KEY)),
            },
          })
          return
        }
        if (url.pathname === '/v1/get_account') {
          assert.equal(url.searchParams.get('broker_id'), BROKER_ID)
          assert.equal(url.searchParams.get('address'), EVM_ADDRESS)
          assert.equal(url.searchParams.get('chain_type'), 'EVM')
          writeJson(res, { success: true, data: { account_id: ACCOUNT_ID } })
          return
        }
        if (url.pathname === '/v1/client/holding') {
          assert.equal(req.method, 'GET')
          assert.equal(req.headers['orderly-account-id'], ACCOUNT_ID)
          assert.equal(req.headers['orderly-key'], `ed25519:${SOLANA_ADDRESS}`)
          const timestamp = req.headers['orderly-timestamp']
          const signature = req.headers['orderly-signature']
          assert.equal(typeof timestamp, 'string')
          assert.equal(typeof signature, 'string')
          assert.equal(Buffer.from(signature, 'base64url').length, 64)
          assert.equal(
            verify(
              null,
              Buffer.from(`${timestamp}GET/v1/client/holding`),
              ED25519_PUBLIC_KEY,
              Buffer.from(signature, 'base64url'),
            ),
            true,
          )
          verifiedOrderlyHeader = true
          writeJson(res, { success: true, data: { holding: [] } })
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

  it('converts the platform raw Base58 signature into a verifiable Orderly header', async () => {
    const result = await runPurr(port, home)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ holding: [] })
    expect(receivedWalletSignature).toBe(true)
    expect(verifiedOrderlyHeader).toBe(true)
  })
})
