import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-balancer-cli'
const API_TOKEN = 'test-token'
const POOL = '0x1111111111111111111111111111111111111111'
interface RecordedRequest {
  method: string | undefined
  path: string
  query: Record<string, string>
  body: Record<string, unknown>
}

function writeJson(
  res: ServerResponse<IncomingMessage>,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks.length === 0
    ? {}
    : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
}

interface PurrResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

async function runPurrRaw(port: number, args: string[]): Promise<PurrResult> {
  return await new Promise((resolve, reject) => {
    const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy, ...cleanEnv } =
      process.env
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
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}

async function runPurr(port: number, args: string[]): Promise<Record<string, unknown>> {
  const result = await runPurrRaw(port, args)
  if (result.exitCode !== 0) {
    throw new Error(`purr exited ${result.exitCode}: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe('Balancer CLI routing', () => {
  it('routes all pool, swap, and liquidity commands', async () => {
    const requests: RecordedRequest[] = []
    const server = createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        requests.push({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body: await readBody(req),
        })
        writeJson(res, { ok: true, data: { operation: url.pathname.split('/').at(-1) } })
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') reject(new Error('Failed to bind server'))
        else resolve(address.port)
      })
    })

    try {
      const commands = [
        ['pools', '--chain', 'base', '--tokens', 'WETH,USDC'],
        ['quote', '--chain', 'base', '--from', 'ETH', '--to', 'USDC', '--amount', '0.001'],
        [
          'swap',
          '--chain',
          'base',
          '--from',
          'ETH',
          '--to',
          'USDC',
          '--amount',
          '0.001',
          '--min-amount-out',
          '1',
          '--execute',
        ],
        [
          'add-quote',
          '--chain',
          'base',
          '--pool-id',
          POOL,
          '--protocol-version',
          '3',
          '--amounts-in',
          'ETH:0.001',
        ],
        [
          'add',
          '--chain',
          'base',
          '--pool-id',
          POOL,
          '--protocol-version',
          '3',
          '--amounts-in',
          'ETH:0.001',
          '--min-bpt-out',
          '1',
          '--execute',
        ],
        [
          'remove-quote',
          '--chain',
          'base',
          '--pool-id',
          POOL,
          '--protocol-version',
          '3',
          '--bpt-amount-in',
          '0.001',
        ],
        [
          'remove',
          '--chain',
          'base',
          '--pool-id',
          POOL,
          '--protocol-version',
          '3',
          '--bpt-amount-in',
          '0.001',
          '--min-amounts-out',
          'WETH:1,USDC:1',
          '--execute',
        ],
      ]
      for (const command of commands) {
        await runPurr(port, ['balancer', ...command])
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }

    const prefix = `/v1/instances/${INSTANCE_ID}/wallet/balancer`
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${prefix}/pools`,
      `POST ${prefix}/quote`,
      `POST ${prefix}/swap`,
      `POST ${prefix}/liquidity/add/quote`,
      `POST ${prefix}/liquidity/add`,
      `POST ${prefix}/liquidity/remove/quote`,
      `POST ${prefix}/liquidity/remove`,
    ])
    expect(requests[0].query).toMatchObject({ chainId: '8453' })
    expect(requests[2].body).toMatchObject({ minAmountOut: '1' })
    expect(requests[4].body).toMatchObject({ minBptOut: '1' })
    expect(requests[6].body).toMatchObject({
      minAmountsOut: [
        { token: '0x4200000000000000000000000000000000000006', amountRaw: '1' },
        { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amountRaw: '1' },
      ],
    })
    expect(requests.slice(2).every(({ body }) => !('dedupKey' in body))).toBe(true)
  })

  it('preserves policy-deferred request metadata for approval workflows', async () => {
    const server = createServer((_req, res) => {
      writeJson(res, {
        code: 'POLICY_DEFERRED',
        reason: 'approval required',
        request_id: 'req_balancer_123',
        expires_at: '2026-07-11T14:00:00Z',
      }, 202)
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') reject(new Error('Failed to bind server'))
        else resolve(address.port)
      })
    })

    try {
      const result = await runPurr(port, [
        'balancer',
        'swap',
        '--chain',
        'base',
        '--from',
        'ETH',
        '--to',
        'USDC',
        '--amount',
        '0.001',
        '--min-amount-out',
        '1',
        '--execute',
      ])
      expect(result).toEqual({
        code: 'POLICY_DEFERRED',
        reason: 'approval required',
        request_id: 'req_balancer_123',
        expires_at: '2026-07-11T14:00:00Z',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('prints structured rate-limit metadata including Retry-After', async () => {
    const server = createServer((_req, res) => {
      writeJson(
        res,
        { ok: false, error: 'Balancer API rate limit exceeded', code: 'BALANCER_RATE_LIMITED' },
        429,
        { 'Retry-After': '7' },
      )
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') reject(new Error('Failed to bind server'))
        else resolve(address.port)
      })
    })

    try {
      const result = await runPurrRaw(port, [
        'balancer',
        'quote',
        '--chain',
        'base',
        '--from',
        'ETH',
        '--to',
        'USDC',
        '--amount',
        '0.001',
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: 'Balancer API rate limit exceeded',
        code: 'BALANCER_RATE_LIMITED',
        http_status: 429,
        retry_after: '7',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
