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
  const writes: Array<{ body: unknown; key?: string; generation?: string }> = []
  let status = 200
  let response: unknown
  const server = createServer((req, res) => {
    received.push({ path: req.url ?? '', method: req.method, auth: req.headers.authorization })
    let data = ''
    req.on('data', (chunk) => {
      data += String(chunk)
    })
    req.on('end', () => {
      if (req.method === 'POST')
        writes.push({
          body: JSON.parse(data),
          key: req.headers['idempotency-key'] as string | undefined,
          generation: req.headers['x-terminal-connection-version'] as string | undefined,
        })
      res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '9' })
      res.end(JSON.stringify(response))
    })
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
    writes.length = 0
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

  it.each(['status', 'account'])(
    'prints later backend capabilities unchanged for %s',
    async (command) => {
      const data = {
        identity: { walletGeneration: 'gen-2' },
        mode: 'execution',
        executionEnabled: true,
      }
      response = { ok: true, data }
      const result = await run(['injective', command])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual(data)
      expect(received).toEqual([
        {
          path: `/v1/instances/owned-instance/injective/${command}`,
          method: 'GET',
          auth: 'Bearer test-token',
        },
      ])
    },
  )

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
    expect(result.stdout).toMatch(/injective\s+Injective.*trading/i)
  })

  const orderArgs = [
    'injective',
    'order',
    '--market-id',
    '0x' + 'a'.repeat(64),
    '--kind',
    'limit',
    '--side',
    'buy',
    '--quantity',
    '0.001',
    '--price',
    '80000',
    '--margin',
    '20',
    '--max-fee-inj',
    '0.001',
  ]
  const identityArgs = ['--wallet-generation', 'b'.repeat(64), '--idempotency-key', 'original-key']
  it('keeps trading a local draft until explicit execution and sends one owner-scoped business request', async () => {
    const draft = await run(orderArgs)
    expect(draft.code).toBe(0)
    expect(JSON.parse(draft.stdout)).toMatchObject({
      executionEnabled: false,
      operation: 'order',
      body: { quantity: '0.001' },
    })
    expect(received).toHaveLength(0)
    response = {
      ok: true,
      data: { requestId: 'original', state: 'unknown', txHash: 'AB'.repeat(32) },
    }
    const result = await run([...orderArgs, ...identityArgs, '--execute', 'true'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual((response as { data: unknown }).data)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      path: '/v1/instances/owned-instance/injective/order',
      method: 'POST',
    })
    expect(writes[0]).toEqual({
      key: 'original-key',
      generation: 'b'.repeat(64),
      body: {
        marketId: '0x' + 'a'.repeat(64),
        maxFeeInj: '0.001',
        kind: 'limit',
        side: 'buy',
        quantity: '0.001',
        price: '80000',
        margin: '20',
      },
    })
  })
  it('preserves policy holds and queries an original unknown request without replaying a write', async () => {
    status = 202
    response = {
      code: 'POLICY_DEFERRED',
      reason: 'manual_approval_required',
      request_id: 'approval-a',
    }
    const held = await run([...orderArgs, ...identityArgs, '--execute', 'true'])
    expect(held.code).toBe(0)
    expect(JSON.parse(held.stdout)).toEqual(response)
    const recoveredHold = await run([
      'injective',
      'request',
      '--request-id',
      'original-key',
      '--by',
      'idempotency-key',
    ])
    expect(recoveredHold.code).toBe(0)
    expect(JSON.parse(recoveredHold.stdout)).toEqual(response)
    response = { ok: true, data: { requestId: 'original', state: 'unknown' } }
    status = 200
    const recovered = await run([
      'injective',
      'request',
      '--request-id',
      'original-key',
      '--by',
      'idempotency-key',
    ])
    expect(recovered.code).toBe(0)
    expect(received.at(-1)).toMatchObject({
      method: 'GET',
      path: '/v1/instances/owned-instance/injective/requests/original-key?by=idempotency-key',
    })
    expect(writes).toHaveLength(1)
  })

  it('routes the Spot group through draft, explicit execution and original-request observation', async () => {
    const args = [
      'injective',
      'spot',
      'order',
      '--market-id',
      '0x' + 'a'.repeat(64),
      '--kind',
      'market',
      '--side',
      'sell',
      '--quantity',
      '0.123456789012345678',
      '--price',
      '2.01',
      '--max-fee-inj',
      '0.001',
    ]
    const draft = await run(args)
    expect(draft.code).toBe(0)
    expect(JSON.parse(draft.stdout)).toEqual({
      executionEnabled: false,
      operation: 'spot-order',
      body: {
        marketId: '0x' + 'a'.repeat(64),
        kind: 'market',
        side: 'sell',
        quantity: '0.123456789012345678',
        price: '2.01',
        maxFeeInj: '0.001',
      },
    })
    expect(received).toHaveLength(0)
    status = 202
    response = {
      code: 'POLICY_DEFERRED',
      reason: 'manual_approval_required',
      request_id: 'spot-approval',
    }
    const held = await run([...args, ...identityArgs, '--execute', 'true'])
    expect(held.code).toBe(0)
    expect(JSON.parse(held.stdout)).toEqual(response)
    expect(received).toEqual([
      {
        path: '/v1/instances/owned-instance/injective/spot-order',
        method: 'POST',
        auth: 'Bearer test-token',
      },
    ])
    expect(writes).toEqual([
      { body: JSON.parse(draft.stdout).body, key: 'original-key', generation: 'b'.repeat(64) },
    ])
    status = 200
    response = { ok: true, data: { requestId: 'spot-original', state: 'unknown' } }
    const recovered = await run([
      'injective',
      'request',
      '--request-id',
      'original-key',
      '--by',
      'idempotency-key',
    ])
    expect(recovered.code).toBe(0)
    expect(JSON.parse(recovered.stdout)).toEqual({ requestId: 'spot-original', state: 'unknown' })
    expect(received.at(-1)).toMatchObject({
      method: 'GET',
      path: '/v1/instances/owned-instance/injective/requests/original-key?by=idempotency-key',
    })
    expect(writes).toHaveLength(1)
  })

  it('reads Spot readiness from the actual CLI group', async () => {
    const result = await run([
      'injective',
      'spot',
      'readiness',
      '--market-id',
      '0x' + 'a'.repeat(64),
    ])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual((response as { data: unknown }).data)
    expect(received).toEqual([
      {
        path: '/v1/instances/owned-instance/injective/spot-readiness?marketId=0x' + 'a'.repeat(64),
        method: 'GET',
        auth: 'Bearer test-token',
      },
    ])
  })

  it.each([
    ['order'],
    ['cancel'],
    ['rfq', 'unsupported'],
    ['spot', 'unsupported'],
    ['spot', 'order', '--margin', '1'],
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
      ok: false,
      error: { code: 'INJECTIVE_RATE_LIMITED', reason: 'rate_limited', retryAfterMs: 1250 },
    }
    const result = await run(['injective', 'status'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error [INJECTIVE_RATE_LIMITED]')
    expect(result.stderr).toContain('"reason": "rate_limited"')
    expect(result.stderr).toContain('"retryAfterMs": 1250')
    expect(result.stderr).toContain('"retryAfter": "9"')
    expect(received).toHaveLength(1)
  })

  it('preserves an instance-domain 404 without suggesting a backend upgrade', async () => {
    status = 404
    response = {
      ok: false,
      error: { code: 'INSTANCE_NOT_FOUND', message: 'Current Agent instance is unavailable.' },
    }
    const result = await run(['injective', 'status'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error [INSTANCE_NOT_FOUND]')
    expect(result.stderr).not.toMatch(/upgrade/i)
    expect(received).toHaveLength(1)
  })
})
