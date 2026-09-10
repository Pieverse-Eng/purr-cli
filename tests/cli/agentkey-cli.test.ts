import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const instanceId = 'test-agentkey-instance'
const requestId = 'a'.repeat(64)
const version = `ak-v1-${'b'.repeat(64)}`
const quote = {
  name: 'FutureProvider/lookup',
  params: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
  execute_as: { name: 'FutureProvider/lookup', params: { q: '<required>' }, priceVersion: version },
  price: { credits: '0.051963', version, unit: 'call' },
}
const receipt = {
  requestId,
  state: 'completed',
  billing: { credits: '0.051963', status: 'charged' },
  result: { data: [{ title: 'result' }], nextCursor: 'next-page' },
}
type Call = { method: string; path: string; body: unknown; authorization?: string }
type Handler = (call: Call, req: IncomingMessage, res: ServerResponse) => void
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function harness(handler?: Handler) {
  const calls: Call[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const call = {
      method: req.method!,
      path: req.url!,
      body: raw ? JSON.parse(raw) : undefined,
      authorization: req.headers.authorization,
    }
    calls.push(call)
    if (handler) handler(call, req, res)
    else if (call.path.endsWith('/describe')) json(res, quote)
    else json(res, receipt)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing mock address')
  const url = `http://127.0.0.1:${address.port}`
  const run = (args: string[], entry = 'linux-macos') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('bun', ['run', `packages/cli/src/${entry}.ts`, 'agentkey', ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WALLET_API_URL: url,
          WALLET_API_TOKEN: 'test-instance-token',
          INSTANCE_ID: instanceId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const timer = setTimeout(() => child.kill(), 15_000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  return { calls, run, url }
}

describe('purr agentkey (real CLI and HTTP client)', () => {
  it('documents progressive discovery without making an API call', async () => {
    const h = await harness()
    const r = await h.run(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('discover -> describe')
    expect(r.stdout).toContain('No upstream API key')
    expect(h.calls).toHaveLength(0)
  })

  it.each([
    [[], {}],
    [['--prefix', 'social/twitter'], { prefix: 'social/twitter' }],
    [
      ['帮我找 Robinhood 最近的推文', '--prefix=social/twitter'],
      { query: '帮我找 Robinhood 最近的推文', prefix: 'social/twitter' },
    ],
  ])('forwards discovery inputs without hardcoded catalogs: %j', async (args, body) => {
    const catalog = {
      tools: [{ path: 'future/new-category', contains: ['new tool'], price: null }],
      count: 1,
    }
    const h = await harness((_call, _req, res) => json(res, catalog))
    const r = await h.run(['discover', ...(args as string[])])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(catalog)
    expect(h.calls).toEqual([
      {
        method: 'POST',
        path: `/v1/instances/${instanceId}/agentkey/discover`,
        body,
        authorization: 'Bearer test-instance-token',
      },
    ])
  })

  it('shows the full schema and execution template on both entrypoints', async () => {
    const h = await harness()
    for (const entry of ['linux-macos', 'windows']) {
      const r = await h.run(['describe', 'social/future/lookup', '--json'], entry)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual(quote)
    }
    expect(h.calls.map((c) => c.body)).toEqual([
      { name: 'social/future/lookup' },
      { name: 'social/future/lookup' },
    ])
  })

  it.each([[{ q: 'Robinhood', num: 1 }], [['wallet-123', { limit: 1 }]]])(
    'refreshes a quote and executes exactly once with params %j',
    async (params) => {
      const h = await harness()
      const r = await h.run(['execute', 'social/future/lookup', '--params', JSON.stringify(params)])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual(receipt)
      expect(h.calls.map((c) => c.path.split('/').at(-1))).toEqual(['describe', 'execute'])
      expect(h.calls[1].body).toEqual({
        name: 'FutureProvider/lookup',
        params,
        priceVersion: version,
        maxCredits: '0.051963',
      })
    },
  )

  it('supports a params file and forwards an explicit ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'purr-agentkey-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'params.json')
    await writeFile(file, '["id",{"limit":2}]')
    const h = await harness()
    const r = await h.run([
      'execute',
      'FutureProvider/lookup',
      '--params-file',
      file,
      '--max-credits',
      '0.06',
    ])
    expect(r.code).toBe(0)
    expect(h.calls[1].body).toMatchObject({ params: ['id', { limit: 2 }], maxCredits: '0.06' })
  })

  it('stops before execution when the refreshed quote exceeds the ceiling', async () => {
    const h = await harness()
    const r = await h.run([
      'execute',
      'FutureProvider/lookup',
      '--params',
      '{}',
      '--max-credits',
      '0.051962',
    ])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.code).toBe('MAX_CREDITS_EXCEEDED')
    expect(h.calls).toHaveLength(1)
  })

  it.each([
    ['execute', 'Tool/name', '--params', 'null'],
    ['execute', 'Tool/name', '--params', '"encoded string"'],
    ['execute', 'Tool/name', '--params', '{}', '--params-file', '/tmp/nope'],
    ['execute', 'Tool/name', '--params', '{}', '--max-credits', '-1'],
    ['execute', 'Tool/name', '--params', '{}', '--max-credit', '1'],
    ['execute', 'Tool/name', '--params', '{}', '--params', '{}'],
    ['discover', '--prefix'],
    ['request', '../execute'],
  ])('rejects invalid arguments before network access: %j', async (...args) => {
    const h = await harness()
    const r = await h.run(args)
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.code).toBe('INVALID_ARGUMENT')
    expect(h.calls).toHaveLength(0)
  })

  it('returns a held receipt and queries it using GET only', async () => {
    const held = {
      ...receipt,
      state: 'dispatched',
      billing: { ...receipt.billing, status: 'held' },
      result: null,
    }
    const h = await harness((c, _req, res) =>
      c.path.endsWith('/describe')
        ? json(res, quote)
        : json(res, held, c.method === 'POST' ? 202 : 200),
    )
    const r = await h.run(['execute', 'FutureProvider/lookup', '--params', '{}'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(held)
    expect(r.stderr).toContain(`purr agentkey request ${requestId}`)
    const read = await h.run(['request', requestId])
    expect(read.code).toBe(0)
    expect(h.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET'])
    expect(h.calls[2].path).toBe(`/v1/instances/${instanceId}/agentkey/requests/${requestId}`)
  })

  it.each([undefined, { message: 'unknown search type: news', code: 400, type: 'validation' }])(
    'stops polling indeterminate receipts and preserves error details: %j',
    async (error) => {
      const uncertain = {
        ...receipt,
        state: 'indeterminate',
        billing: { ...receipt.billing, status: 'held' },
        result: null,
        ...(error ? { error } : {}),
      }
      const h = await harness((c, _req, res) =>
        c.path.endsWith('/describe') ? json(res, quote) : json(res, uncertain, 202),
      )
      for (const args of [
        ['execute', 'FutureProvider/lookup', '--params', '{}'],
        ['request', requestId],
      ]) {
        const r = await h.run(args)
        expect(r.code).toBe(1)
        expect(JSON.parse(r.stdout)).toEqual(uncertain)
        expect(r.stderr).toContain('Do not keep polling')
        expect(r.stderr).not.toContain('purr agentkey request')
      }
      expect(h.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET'])
    },
  )
  it('preserves sanitized diagnostic fields on HTTP errors', async () => {
    const h = await harness((_c, _req, res) =>
      json(
        res,
        {
          code: 'AGENTKEY_UPSTREAM_UNAVAILABLE',
          error: { message: 'unknown tool', code: 400, type: 'validation', internal: 'private' },
        },
        502,
      ),
    )
    const r = await h.run(['describe', 'Unknown/tool'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.upstreamError).toEqual({
      message: 'unknown tool',
      code: 400,
      type: 'validation',
    })
    expect(r.stderr).not.toContain('private')
    expect(h.calls).toHaveLength(1)
  })
  it('does not retry an execute whose connection is lost', async () => {
    const h = await harness((c, req, res) =>
      c.path.endsWith('/describe') ? json(res, quote) : req.socket.destroy(),
    )
    const r = await h.run(['execute', 'FutureProvider/lookup', '--params', '{}'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error).toMatchObject({
      code: 'AGENTKEY_EXECUTION_UNCERTAIN',
      automaticRetry: false,
    })
    expect(h.calls.filter((c) => c.path.endsWith('/execute'))).toHaveLength(1)
  })

  it('does not follow an execute redirect or resend the paid request', async () => {
    const h = await harness((c, _req, res) => {
      if (c.path.endsWith('/describe')) json(res, quote)
      else {
        res.writeHead(307, { Location: '/redirect-target' })
        res.end()
      }
    })
    const r = await h.run(['execute', 'FutureProvider/lookup', '--params', '{}'])
    expect(r.code).toBe(1)
    expect(h.calls.map((c) => c.path.split('/').at(-1))).toEqual(['describe', 'execute'])
  })

  it('preserves the request ID on a platform error without exposing raw errors', async () => {
    const h = await harness((c, _req, res) => {
      if (c.path.endsWith('/describe')) json(res, quote)
      else {
        res.setHeader('X-AgentKey-Request-Id', requestId)
        json(res, { code: 'AGENTKEY_BILLING_UNAVAILABLE', internal: 'private detail' }, 503)
      }
    })
    const r = await h.run(['execute', 'FutureProvider/lookup', '--params', '{}'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error).toMatchObject({
      code: 'AGENTKEY_BILLING_UNAVAILABLE',
      status: 503,
      requestId,
    })
    expect(r.stderr).not.toContain('private detail')
    expect(h.calls).toHaveLength(2)
  })

  it('returns a refunded receipt as a failed execution without retrying', async () => {
    const refunded = {
      ...receipt,
      state: 'refunded',
      billing: { credits: '0.051963', status: 'refunded' },
      result: null,
    }
    const h = await harness((c, _req, res) =>
      c.path.endsWith('/describe') ? json(res, quote) : json(res, refunded),
    )
    const r = await h.run(['execute', 'FutureProvider/lookup', '--params', '{}'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toEqual(refunded)
    expect(h.calls).toHaveLength(2)
  })

  it.each(['failed', 'indeterminate'])(
    'handles an uncharged %s receipt without a polling hint',
    async (state) => {
      const failed = {
        ...receipt,
        state,
        billing: { credits: '0.000000', status: 'not_charged' },
        result: null,
        ...(state === 'failed' ? { error: { message: 'project not found', code: 404 } } : {}),
      }
      const h = await harness((c, _req, res) =>
        c.path.endsWith('/describe') ? json(res, quote) : json(res, failed),
      )
      for (const args of [
        ['execute', 'FutureProvider/lookup', '--params', '{}'],
        ['request', requestId],
      ]) {
        const r = await h.run(args)
        expect(r.code).toBe(1)
        expect(JSON.parse(r.stdout)).toEqual(failed)
        expect(r.stderr).not.toContain('purr agentkey request')
        expect(r.stderr).not.toContain('Billing remains unresolved')
        if (state === 'indeterminate') expect(r.stderr).toContain('No AI Credits have been charged')
      }
      expect(h.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET'])
    },
  )

  it('reports expired results using GET only and preserves the HTTP status', async () => {
    const h = await harness((_c, _req, res) => json(res, { ...receipt, result: null }, 410))
    const r = await h.run(['request', requestId])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.status).toBe(410)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].method).toBe('GET')
  })

  it('does not execute on a malformed quote', async () => {
    const h = await harness((_c, _req, res) =>
      json(res, { ...quote, price: { credits: '0.1', version: 'bad' } }),
    )
    const r = await h.run(['execute', 'FutureProvider/lookup', '--params', '{}'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.code).toBe('INVALID_QUOTE')
    expect(h.calls).toHaveLength(1)
  })
})
