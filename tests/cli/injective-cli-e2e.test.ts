import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

describe('Injective actual CLI routing and output', () => {
  let home: string
  let apiUrl: string
  const received: Array<{ path: string; method?: string; auth?: string }> = []
  let status = 200
  let response: unknown
  const server = createServer((req, res) => {
    received.push({ path: req.url ?? '', method: req.method, auth: req.headers.authorization })
    res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '9' })
    res.end(JSON.stringify(response))
  })
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'purr-injective-e2e-'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected listening server')
    apiUrl = `http://127.0.0.1:${address.port}`
  })
  beforeEach(() => {
    received.length = 0
    status = 200
    response = {
      ok: true,
      data: {
        mode: 'read_only',
        executionEnabled: false,
        identity: null,
        readStatus: 'wallet_unavailable',
      },
    }
  })
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    rmSync(home, { recursive: true, force: true })
  })

  async function run(args: string[], overrides: Record<string, string | undefined> = {}) {
    const env = { ...process.env }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'FX_PLATFORM_QUOTE_TOKEN',
      'FX_PLATFORM_UNISWAP_QUOTE_URL',
      'FX_PLATFORM_DFLOW_QUOTE_URL',
    ])
      delete env[key]
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const binary = process.env.PURR_TEST_BINARY
        const child = spawn(
          binary ?? process.env.PURR_TEST_BUN ?? 'bun',
          binary ? args : ['packages/cli/src/linux-macos.ts', ...args],
          {
            cwd: process.cwd(),
            env: {
              ...env,
              HOME: home,
              NO_PROXY: '*',
              no_proxy: '*',
              WALLET_API_URL: apiUrl,
              WALLET_API_TOKEN: 'test-token',
              INSTANCE_ID: 'owned-instance',
              ...overrides,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
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
      },
    )
  }

  it('dispatches status through authenticated GET and emits unchanged JSON', async () => {
    const result = await run(['injective', 'status'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual((response as { data: unknown }).data)
    expect(received).toEqual([
      {
        path: '/v1/instances/owned-instance/injective/status',
        method: 'GET',
        auth: 'Bearer test-token',
      },
    ])
  })

  it('prints text help without credentials or HTTP', async () => {
    const result = await run(['injective', '--help'], { WALLET_API_TOKEN: '', INSTANCE_ID: '' })
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^Usage: purr injective/)
    expect(result.stdout).toContain('Read-only')
    expect(received).toHaveLength(0)
  })

  it('includes Injective discovery in root help', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/injective\s+Injective.*read-only/i)
  })

  it.each([
    ['order'],
    ['cancel'],
    ['rfq'],
    ['status', '--execute'],
    ['status', 'ignored'],
    ['markets', '--market-type=spot', '--market-type=perp'],
  ])('rejects %j with nonzero exit and no HTTP', async (...args) => {
    const result = await run(['injective', ...args])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error \[INJECTIVE_(READ_ONLY|INVALID_ARGUMENT)\]/)
    expect(received).toHaveLength(0)
  })

  it('accepts public reads without instance and preserves unavailable as null', async () => {
    const data = {
      identity: { venue: 'injective', environment: 'mainnet' },
      data: null,
      meta: { status: 'unavailable', reason: 'upstream_unavailable' },
      missing: [],
    }
    response = { ok: true, data }
    const result = await run(['injective', 'markets', '--market-type=spot'], { INSTANCE_ID: '' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(data)
    expect(received[0].path).toBe(
      '/v1/market-data/reference/terminal/instruments?venue=injective&environment=mainnet&product=spot',
    )
  })

  it.each([{ WALLET_API_TOKEN: '' }, { INSTANCE_ID: '' }])(
    'fails missing credentials before HTTP %j',
    async (overrides) => {
      const result = await run(['injective', 'status'], overrides)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Missing required credentials')
      expect(received).toHaveLength(0)
    },
  )

  it('renders old backend capability failures with an actionable code', async () => {
    status = 404
    response = { error: 'Not Found' }
    const result = await run(['injective', 'status'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error [INJECTIVE_CAPABILITY_UNAVAILABLE]')
    expect(result.stderr).toMatch(/upgrade.*backend/i)
  })

  it('renders upstream code and Retry-After without a retry storm', async () => {
    status = 429
    response = {
      error: { code: 'INJECTIVE_RATE_LIMITED', message: 'Budget exhausted' },
      data: { retryAfterMs: 9000 },
    }
    const result = await run(['injective', 'status'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error [INJECTIVE_RATE_LIMITED]: Budget exhausted')
    expect(result.stderr).toContain('"retryAfter": "9"')
    expect(received).toHaveLength(1)
  })
})
