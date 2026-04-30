import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-agentic-renewal'
const API_TOKEN = 'test-token'
const TOKEN_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'
const WALLET_ADDRESS = '0x82320000000000000000000000000000000066b2'

type JsonObject = Record<string, unknown>

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

const billingStatus = {
  status: 'Active',
  nextBillingDate: '2026-05-30',
  plan: { name: 'basic' },
  effectiveRenewalPriceUsd: '29',
  readyToRenew: true,
  agentWallets: [
    {
      chainId: 56,
      address: WALLET_ADDRESS,
      balances: [{ tokenAddress: TOKEN_ADDRESS, symbol: 'USDT', amount: '30.0' }],
    },
  ],
}

function readBody(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
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

async function runPurr(port: number, args: string[], input = ''): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const {
      HTTP_PROXY,
      http_proxy,
      HTTPS_PROXY,
      https_proxy,
      ALL_PROXY,
      all_proxy,
      ...cleanEnv
    } = process.env
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
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }))
    child.stdin.end(input)
  })
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<void>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
      await handler(req, res)
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  const port = await listen(server)
  try {
    await fn(port)
  } finally {
    await closeServer(server)
  }
}

describe('instance CLI', () => {
  it('prints billing status summary', async () => {
    await withServer(
      async (req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/billing-status`)
        writeJson(res, 200, { ok: true, data: billingStatus })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'status'])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('Status: Active')
        expect(result.stdout).toContain('Next billing date: 2026-05-30')
        expect(result.stdout).toContain('Plan: basic')
        expect(result.stdout).toContain('Renewal price: $29 USD')
        expect(result.stdout).toContain('Ready to renew: yes')
        expect(result.stdout).toContain(`Chain 56 (BSC): ${WALLET_ADDRESS}`)
        expect(result.stdout).toContain(`${TOKEN_ADDRESS}`)
      },
    )
  })

  it('prints raw billing status JSON when requested', async () => {
    await withServer(
      async (req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/billing-status`)
        writeJson(res, 200, { ok: true, data: billingStatus })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'status', '--json'])
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: 'Active',
          plan: { name: 'basic' },
          agentWallets: [{ chainId: 56, address: WALLET_ADDRESS }],
        })
      },
    )
  })

  it('supports short help for instance subcommands without calling the platform', async () => {
    await withServer(
      async () => {
        throw new Error('The platform should not be called for help output')
      },
      async (port) => {
        const statusHelp = await runPurr(port, ['instance', 'status', '-h'])
        expect(statusHelp.code).toBe(0)
        expect(statusHelp.stdout).toContain('Usage: purr instance status')

        const renewHelp = await runPurr(port, ['instance', 'renew', '-h'])
        expect(renewHelp.code).toBe(0)
        expect(renewHelp.stdout).toContain('Usage: purr instance renew')
      },
    )
  })

  it('dry-runs renew with parsed chain and token without posting payment', async () => {
    let renewCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'GET' && req.url === `/v1/instances/${INSTANCE_ID}/billing-status`) {
          writeJson(res, 200, { ok: true, data: billingStatus })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/renew`) {
          renewCalls++
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, [
          'instance',
          'renew',
          '--chain-id',
          '56',
          '--token-address',
          TOKEN_ADDRESS,
          '--dry-run',
        ])
        expect(result.code).toBe(0)
        expect(renewCalls).toBe(0)
        expect(result.stderr).toContain('Chain: 56 (BSC)')
        expect(result.stderr).toContain(`Token: ${TOKEN_ADDRESS}`)
        expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, chainId: 56 })
      },
    )
  })

  it('prompts before renewal and sends an idempotency key', async () => {
    let postedBody: JsonObject | undefined
    let idempotencyKey: string | undefined
    await withServer(
      async (req, res) => {
        if (req.method === 'GET' && req.url === `/v1/instances/${INSTANCE_ID}/billing-status`) {
          writeJson(res, 200, { ok: true, data: billingStatus })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/renew`) {
          idempotencyKey = String(req.headers['idempotency-key'])
          postedBody = await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: { txHash: `0x${'a'.repeat(64)}`, quoteId: 'quote-1', amount: '0.01' },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(
          port,
          ['instance', 'renew', '--chain-id', '56', '--token-address', TOKEN_ADDRESS],
          'y\n',
        )
        expect(result.code).toBe(0)
        expect(postedBody).toEqual({ chainId: 56, tokenAddress: TOKEN_ADDRESS })
        expect(idempotencyKey).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        expect(result.stderr).toContain('Proceed? [y/N]')
        expect(JSON.parse(result.stdout)).toMatchObject({ quoteId: 'quote-1' })
      },
    )
  })

  it('maps user abort to exit code 1 without posting renewal', async () => {
    let renewCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'GET' && req.url === `/v1/instances/${INSTANCE_ID}/billing-status`) {
          writeJson(res, 200, { ok: true, data: billingStatus })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/renew`) {
          renewCalls++
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(
          port,
          ['instance', 'renew', '--chain-id', '56', '--token-address', TOKEN_ADDRESS],
          'n\n',
        )
        expect(result.code).toBe(1)
        expect(renewCalls).toBe(0)
        expect(result.stderr).toContain('Aborted.')
      },
    )
  })

  it('retries stale quote errors once', async () => {
    let renewCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'GET' && req.url === `/v1/instances/${INSTANCE_ID}/billing-status`) {
          writeJson(res, 200, { ok: true, data: billingStatus })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/renew`) {
          renewCalls++
          await readBody(req)
          if (renewCalls === 1) {
            writeJson(res, 409, {
              ok: false,
              error: { code: 'STALE_QUOTE', message: 'Quote expired' },
            })
            return
          }
          writeJson(res, 200, { ok: true, data: { txHash: `0x${'b'.repeat(64)}` } })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, [
          'instance',
          'renew',
          '--chain-id',
          '56',
          '--token-address',
          TOKEN_ADDRESS,
          '--yes',
        ])
        expect(result.code).toBe(0)
        expect(renewCalls).toBe(2)
        expect(result.stderr).toContain('retrying once')
        expect(JSON.parse(result.stdout)).toMatchObject({ txHash: `0x${'b'.repeat(64)}` })
      },
    )
  })

  it('maps structured platform errors to renewal exit codes', async () => {
    const cases = [
      { code: 'INSUFFICIENT_BALANCE', status: 402, expectedExit: 2 },
      { code: 'INELIGIBLE_STATE', status: 409, expectedExit: 3 },
      { code: 'PLATFORM_ERROR', status: 500, expectedExit: 4 },
    ]

    for (const testCase of cases) {
      await withServer(
        async (req, res) => {
          if (req.method === 'GET' && req.url === `/v1/instances/${INSTANCE_ID}/billing-status`) {
            writeJson(res, 200, { ok: true, data: billingStatus })
            return
          }
          if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/renew`) {
            await readBody(req)
            writeJson(res, testCase.status, {
              ok: false,
              error: { code: testCase.code, message: testCase.code },
            })
            return
          }
          throw new Error(`Unexpected route: ${req.method} ${req.url}`)
        },
        async (port) => {
          const result = await runPurr(port, [
            'instance',
            'renew',
            '--chain-id',
            '56',
            '--token-address',
            TOKEN_ADDRESS,
            '--yes',
          ])
          expect(result.code).toBe(testCase.expectedExit)
          expect(result.stderr).toContain(testCase.code)
        },
      )
    }
  })

  it('validates chain id and token address before calling the platform', async () => {
    await withServer(
      async (_req, _res) => {
        throw new Error('The platform should not be called for invalid CLI args')
      },
      async (port) => {
        const invalidChain = await runPurr(port, [
          'instance',
          'renew',
          '--chain-id',
          'bsc',
          '--token-address',
          TOKEN_ADDRESS,
        ])
        expect(invalidChain.code).toBe(1)
        expect(invalidChain.stderr).toContain('Invalid --chain-id')

        const invalidToken = await runPurr(port, [
          'instance',
          'renew',
          '--chain-id',
          '56',
          '--token-address',
          'usdt',
        ])
        expect(invalidToken.code).toBe(1)
        expect(invalidToken.stderr).toContain('Invalid --token-address')
      },
    )
  })
})
