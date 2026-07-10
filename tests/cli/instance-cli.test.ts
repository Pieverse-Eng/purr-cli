import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-agentic-renewal'
const API_TOKEN = 'test-token'
const TOKEN_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'
const WALLET_ADDRESS = '0x82320000000000000000000000000000000066b2'

const paymentMethods = [
  {
    tokenId: 'bnb',
    symbol: 'BNB',
    aliases: ['BNB', 'bnb'],
    chainId: 56,
    chainName: 'BNB Chain',
    native: true,
    decimals: 18,
    paymentRail: 'invoice-registry',
  },
  {
    tokenId: 'usdc-base',
    symbol: 'USDC',
    aliases: ['USDC', 'usdc'],
    chainId: 8453,
    chainName: 'Base',
    native: false,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    paymentRail: 'invoice-registry',
  },
]

function billingQuote(
  method: (typeof paymentMethods)[number],
  overrides: Record<string, JsonValue> = {},
): JsonObject {
  return {
    quoteId: `quote-${method.tokenId}`,
    ...method,
    payTo: '0x9254C66F8fA0cC62A1176a9fEFc9b458E6AEF55A',
    amount: '10',
    baseUsdAmount: '10',
    finalUsdAmount: '8.8',
    discountUsdAmount: '1.2',
    expiresAt: '2026-07-10T01:00:00.000Z',
    affordability: {
      affordable: true,
      walletAddress: WALLET_ADDRESS,
      tokenRequiredBaseUnits: '10000000',
      tokenBalanceBaseUnits: '30000000',
      gasRequiredWei: '100000000000000',
      nativeBalanceWei: '100000000000000000',
    },
    ...overrides,
  }
}

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

interface JsonObject {
  [key: string]: JsonValue
}

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

function writeJson(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: JsonValue,
): void {
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
    } catch {
      writeJson(res, 500, {
        ok: false,
        error: 'Mock server error',
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
        expect(result.stdout).not.toContain('Ready to renew')
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
        expect(renewHelp.stdout).toContain('--token')
        expect(renewHelp.stdout).toContain('deprecated')

        const topupHelp = await runPurr(port, ['instance', 'topup', '-h'])
        expect(topupHelp.code).toBe(0)
        expect(topupHelp.stdout).toContain('Usage: purr instance topup')
        expect(topupHelp.stdout).toContain('--credits')

        const creditsHelp = await runPurr(port, ['instance', 'credits', '-h'])
        expect(creditsHelp.code).toBe(0)
        expect(creditsHelp.stdout).toContain('Usage: purr instance credits')

        const methodsHelp = await runPurr(port, ['instance', 'payment-methods', '-h'])
        expect(methodsHelp.code).toBe(0)
        expect(methodsHelp.stdout).toContain('Usage: purr instance payment-methods')

        const billingStatusHelp = await runPurr(port, ['instance', 'billing-status', '-h'])
        expect(billingStatusHelp.code).toBe(0)
        expect(billingStatusHelp.stdout).toContain('Usage: purr instance billing-status --invoice')

        const groupHelp = await runPurr(port, ['instance', '--help'])
        expect(groupHelp.code).toBe(0)
        expect(groupHelp.stdout).toContain('credits')
        expect(groupHelp.stdout).toContain('payment-methods')
        expect(groupHelp.stdout).toContain('topup')
      },
    )
  })

  it('documents the long-term instance billing commands in root help', async () => {
    await withServer(
      async () => {
        throw new Error('Root help must not call the platform')
      },
      async (port) => {
        const result = await runPurr(port, ['--help'])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('purr instance credits')
        expect(result.stdout).toContain('purr instance payment-methods')
        expect(result.stdout).toContain('purr instance renew --token')
        expect(result.stdout).toContain('purr instance topup --credits 100')
      },
    )
  })

  it('prints Purrfect Claw credits from the existing instance credits route', async () => {
    await withServer(
      async (req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/credits`)
        writeJson(res, 200, { ok: true, data: { balance: 525, used: 100, limit: 625 } })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'credits'])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('Purrfect Claw credits')
        expect(result.stdout).toContain('Balance: 525')
        expect(result.stdout).toContain('Used: 100')
        expect(result.stdout).toContain('Limit: 625')
      },
    )
  })

  it('lists canonical payment methods without asking for token addresses', async () => {
    await withServer(
      async (req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/billing/payment-methods`)
        writeJson(res, 200, { ok: true, data: { methods: paymentMethods } })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'payment-methods'])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('bnb')
        expect(result.stdout).toContain('BNB Chain')
        expect(result.stdout).toContain('usdc-base')
        expect(result.stdout).not.toContain('Enter token address')
      },
    )
  })

  it('checks one existing billing invoice without re-running payment', async () => {
    const invoiceId = '22222222-2222-4222-8222-222222222222'
    await withServer(
      async (req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/billing/${invoiceId}`)
        writeJson(res, 200, {
          ok: true,
          data: { invoiceId, kind: 'credit_topup', state: 'confirming' },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'billing-status', '--invoice', invoiceId])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain(invoiceId)
        expect(result.stdout).toContain('"state": "confirming"')
      },
    )
  })

  it.each([
    '99',
    '99.5',
  ])('rejects invalid top-up credits %s before any network call', async (credits) => {
    await withServer(
      async () => {
        throw new Error('The platform should not be called for invalid top-up credits')
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'topup', '--credits', credits, '--yes'])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('--credits')
        expect(result.stderr).toContain('integer')
        expect(result.stderr).toContain('100')
      },
    )
  })

  it('rejects mixing canonical token selection with deprecated address options', async () => {
    await withServer(
      async () => {
        throw new Error('The platform should not be called for mutually exclusive options')
      },
      async (port) => {
        const result = await runPurr(port, [
          'instance',
          'renew',
          '--token',
          'usdc-base',
          '--chain-id',
          '8453',
        ])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('mutually exclusive')
      },
    )
  })

  it('creates a 100-credit token-specific dry-run quote without address fields or payment', async () => {
    let quoteBody: JsonObject | undefined
    let quoteKey: string | undefined
    let payCalls = 0
    await withServer(
      async (req, res) => {
        if (
          req.method === 'GET' &&
          req.url === `/v1/instances/${INSTANCE_ID}/billing/payment-methods`
        ) {
          writeJson(res, 200, { ok: true, data: { methods: paymentMethods } })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/billing/quote`) {
          quoteKey = String(req.headers['idempotency-key'])
          quoteBody = await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-topup-100',
              kind: 'credit_topup',
              quotes: [billingQuote(paymentMethods[1])],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/billing/pay`) {
          payCalls++
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, [
          'instance',
          'topup',
          '--credits',
          '100',
          '--token',
          'usdc-base',
          '--dry-run',
        ])

        expect(result.code).toBe(0)
        expect(quoteBody).toEqual({
          kind: 'credit_topup',
          credits: 100,
          tokenId: 'usdc-base',
        })
        expect(quoteBody).not.toHaveProperty('chainId')
        expect(quoteBody).not.toHaveProperty('tokenAddress')
        expect(quoteBody).not.toHaveProperty('payerAddress')
        expect(quoteKey).toMatch(/^[0-9a-f-]{36}$/i)
        expect(payCalls).toBe(0)
        expect(result.stderr).toContain('Token: USDC (usdc-base)')
        expect(result.stderr).toContain('Chain: 8453 (Base)')
        expect(result.stderr).toContain('Final price: $8.8 USD')
        expect(result.stderr).toContain('Discount: $1.2 USD')
        expect(result.stderr).toContain(`Wallet: ${WALLET_ADDRESS}`)
        expect(result.stderr).toContain('Affordable: yes')
        expect(JSON.parse(result.stdout)).toMatchObject({
          dryRun: true,
          invoiceId: 'invoice-topup-100',
          quote: { quoteId: 'quote-usdc-base', tokenId: 'usdc-base' },
        })
      },
    )
  })

  it('matches token aliases case-insensitively for renewal quotes', async () => {
    let quoteBody: JsonObject | undefined
    await withServer(
      async (req, res) => {
        if (
          req.method === 'GET' &&
          req.url === `/v1/instances/${INSTANCE_ID}/billing/payment-methods`
        ) {
          writeJson(res, 200, { ok: true, data: { methods: paymentMethods } })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/billing/quote`) {
          quoteBody = await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-renew-usdc',
              kind: 'renewal',
              quotes: [billingQuote(paymentMethods[1])],
            },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--token', 'uSdC', '--dry-run'])
        expect(result.code).toBe(0)
        expect(quoteBody).toEqual({ kind: 'renewal', tokenId: 'usdc-base' })
      },
    )
  })

  it('prefers an exact canonical token id over colliding aliases', async () => {
    const exactMethod = {
      ...paymentMethods[0],
      tokenId: 'dollar',
      symbol: 'DOLLAR',
      aliases: ['DOLLAR'],
    }
    const collidingMethod = {
      ...paymentMethods[1],
      aliases: ['dollar'],
    }
    let quoteBody: JsonObject | undefined
    await withServer(
      async (req, res) => {
        if (req.method === 'GET') {
          writeJson(res, 200, {
            ok: true,
            data: { methods: [exactMethod, collidingMethod] },
          })
          return
        }
        quoteBody = await readBody(req)
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-exact-id',
            kind: 'renewal',
            quotes: [billingQuote(exactMethod)],
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--token', 'dollar', '--dry-run'])
        expect(result.code).toBe(0)
        expect(quoteBody).toEqual({ kind: 'renewal', tokenId: 'dollar' })
      },
    )
  })

  it('rejects ambiguous aliases and lists canonical token ids before quoting', async () => {
    let quoteCalls = 0
    const ambiguousMethods = [
      { ...paymentMethods[0], aliases: ['coin'] },
      { ...paymentMethods[1], aliases: ['COIN'] },
    ]
    await withServer(
      async (req, res) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, data: { methods: ambiguousMethods } })
          return
        }
        quoteCalls++
        throw new Error('Ambiguous token selection must not create a quote')
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--token', 'coin', '--dry-run'])
        expect(result.code).toBe(1)
        expect(quoteCalls).toBe(0)
        expect(result.stderr).toContain('Ambiguous token')
        expect(result.stderr).toContain('bnb')
        expect(result.stderr).toContain('usdc-base')
      },
    )
  })

  it('rejects unknown token aliases with the supported canonical ids before quoting', async () => {
    let quoteCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, data: { methods: paymentMethods } })
          return
        }
        quoteCalls++
        throw new Error('Unknown token selection must not create a quote')
      },
      async (port) => {
        const result = await runPurr(port, [
          'instance',
          'renew',
          '--token',
          'not-a-token',
          '--dry-run',
        ])
        expect(result.code).toBe(1)
        expect(quoteCalls).toBe(0)
        expect(result.stderr).toContain('Unknown token')
        expect(result.stderr).toContain('bnb')
        expect(result.stderr).toContain('usdc-base')
      },
    )
  })

  it('auto-selects the lowest-cost affordable quote and ignores cheaper unaffordable quotes', async () => {
    const uMethod = {
      ...paymentMethods[1],
      tokenId: 'u-bsc',
      symbol: 'U',
      aliases: ['$U', 'U', 'u'],
      chainId: 56,
      chainName: 'BNB Chain',
    }
    let quoteBody: JsonObject | undefined
    await withServer(
      async (req, res) => {
        assert.equal(req.method, 'POST')
        assert.equal(req.url, `/v1/instances/${INSTANCE_ID}/billing/quote`)
        quoteBody = await readBody(req)
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-auto-lowest',
            kind: 'renewal',
            quotes: [
              billingQuote(paymentMethods[0], {
                finalUsdAmount: '7',
                affordability: {
                  affordable: false,
                  reason: 'INSUFFICIENT_GAS',
                  walletAddress: WALLET_ADDRESS,
                  tokenRequiredBaseUnits: '1',
                  tokenBalanceBaseUnits: '1',
                  gasRequiredWei: '10',
                  nativeBalanceWei: '1',
                },
              }),
              billingQuote(paymentMethods[1], { finalUsdAmount: '10' }),
              billingQuote(uMethod, { finalUsdAmount: '8.8' }),
            ],
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--dry-run'])
        expect(result.code).toBe(0)
        expect(quoteBody).toEqual({ kind: 'renewal' })
        expect(JSON.parse(result.stdout)).toMatchObject({ quote: { tokenId: 'u-bsc' } })
      },
    )
  })

  it('breaks equal-price auto-selection ties by stablecoin then canonical token id', async () => {
    const usdtMethod = {
      ...paymentMethods[1],
      tokenId: 'usdt-bsc',
      symbol: 'USDT',
      aliases: ['USDT', 'usdt'],
      chainId: 56,
      chainName: 'BNB Chain',
    }
    await withServer(
      async (_req, res) => {
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-stable-tie',
            kind: 'renewal',
            quotes: [
              billingQuote(paymentMethods[0], { finalUsdAmount: '8.8' }),
              billingQuote(usdtMethod, { finalUsdAmount: '8.8' }),
              billingQuote(paymentMethods[1], { finalUsdAmount: '8.8' }),
            ],
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--dry-run'])
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ quote: { tokenId: 'usdc-base' } })
      },
    )
  })

  it('rejects a non-numeric final USD amount even when it is the only affordable quote', async () => {
    await withServer(
      async (_req, res) => {
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-invalid-price',
            kind: 'renewal',
            quotes: [billingQuote(paymentMethods[1], { finalUsdAmount: 'not-a-number' })],
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--dry-run'])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('invalid final USD amount')
      },
    )
  })

  it('fails clearly when no automatically selected quote is affordable', async () => {
    await withServer(
      async (_req, res) => {
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-unaffordable',
            kind: 'renewal',
            quotes: paymentMethods.map((method, index) =>
              billingQuote(method, {
                affordability: {
                  affordable: false,
                  reason: index === 0 ? 'INSUFFICIENT_GAS' : 'INSUFFICIENT_TOKEN_BALANCE',
                  walletAddress: WALLET_ADDRESS,
                  tokenRequiredBaseUnits: '100',
                  tokenBalanceBaseUnits: '1',
                  gasRequiredWei: '10',
                  nativeBalanceWei: '1',
                },
              }),
            ),
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--dry-run'])
        expect(result.code).toBe(2)
        expect(result.stderr).toContain('No affordable payment quote')
        expect(result.stderr).toContain('insufficient token balance or gas')
      },
    )
  })

  it('reports a pinned quote as temporarily unavailable instead of insufficient balance', async () => {
    let payCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'GET' && req.url?.endsWith('/billing/payment-methods')) {
          writeJson(res, 200, { ok: true, data: { methods: paymentMethods } })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-rpc-unavailable-pinned',
              kind: 'renewal',
              quotes: [
                billingQuote(paymentMethods[1], {
                  affordability: {
                    affordable: false,
                    reason: 'UNAVAILABLE',
                    walletAddress: WALLET_ADDRESS,
                    tokenRequiredBaseUnits: '10000000',
                  },
                }),
              ],
            },
          })
          return
        }
        payCalls += 1
        writeJson(res, 500, { error: 'payment must not run' })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--token', 'USDC', '--yes'])
        expect(result.code).toBe(4)
        expect(result.stderr).toContain('temporarily unavailable')
        expect(result.stderr).not.toContain('Insufficient token balance')
        expect(payCalls).toBe(0)
      },
    )
  })

  it('distinguishes unavailable balance checks during automatic selection', async () => {
    await withServer(
      async (_req, res) => {
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-rpc-unavailable-auto',
            kind: 'renewal',
            quotes: paymentMethods.map((method, index) =>
              billingQuote(method, {
                affordability: {
                  affordable: false,
                  reason: index === 0 ? 'UNAVAILABLE' : 'INSUFFICIENT_TOKEN_BALANCE',
                  walletAddress: WALLET_ADDRESS,
                  tokenRequiredBaseUnits: '100',
                },
              }),
            ),
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--yes'])
        expect(result.code).toBe(4)
        expect(result.stderr).toContain('Some payment methods are temporarily unavailable')
        expect(result.stderr).not.toContain('insufficient token balance or gas across')
      },
    )
  })

  it('does not auto-pay quotes when authoritative affordability is absent', async () => {
    await withServer(
      async (_req, res) => {
        const quote = billingQuote(paymentMethods[1])
        delete quote.affordability
        writeJson(res, 200, {
          ok: true,
          data: {
            invoiceId: 'invoice-no-affordability',
            kind: 'renewal',
            quotes: [quote],
          },
        })
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--yes'])
        expect(result.code).toBe(2)
        expect(result.stderr).toContain('No affordable payment quote')
      },
    )
  })

  it('returns a fully credit-covered renewal as fulfilled without confirmation or payment', async () => {
    let payCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-credit-covered',
              kind: 'renewal',
              state: 'fulfilled',
              requiresPayment: false,
              quotes: [],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) {
          payCalls++
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew'])
        expect(result.code).toBe(0)
        expect(payCalls).toBe(0)
        expect(result.stderr).not.toContain('Proceed? [y/N]')
        expect(result.stderr).toContain('fulfilled')
        expect(JSON.parse(result.stdout)).toMatchObject({
          invoiceId: 'invoice-credit-covered',
          state: 'fulfilled',
          requiresPayment: false,
          quotes: [],
        })
      },
    )
  })

  it('reports a recovered paid invoice as confirming without trying to pay again', async () => {
    let payCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-already-paid',
              kind: 'credit_topup',
              state: 'confirming',
              requiresPayment: false,
              quotes: [],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) payCalls++
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'topup', '--credits', '100', '--yes'])
        expect(result.code).toBe(0)
        expect(payCalls).toBe(0)
        expect(result.stderr).toContain('confirming')
        expect(JSON.parse(result.stdout)).toMatchObject({
          invoiceId: 'invoice-already-paid',
          state: 'confirming',
          requiresPayment: false,
        })
      },
    )
  })

  it('pays with only invoiceId and quoteId, then reports confirming without fulfillment claims', async () => {
    let payBody: JsonObject | undefined
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/billing/quote`) {
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-pay-confirming',
              kind: 'credit_topup',
              quotes: [billingQuote(paymentMethods[1])],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url === `/v1/instances/${INSTANCE_ID}/billing/pay`) {
          payBody = await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              state: 'confirming',
              txHash: '0xpay-confirming',
              invoiceId: 'invoice-pay-confirming',
              quoteId: 'quote-usdc-base',
            },
          })
          return
        }
        if (
          req.method === 'GET' &&
          req.url === `/v1/instances/${INSTANCE_ID}/billing/invoice-pay-confirming`
        ) {
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-pay-confirming',
              kind: 'credit_topup',
              state: 'confirming',
              invoiceStatus: 'paid',
              fulfillment: { status: 'paid', creditAmount: 100, completedAt: null },
            },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'topup', '--credits', '100', '--yes'])
        expect(result.code).toBe(0)
        expect(payBody).toEqual({
          invoiceId: 'invoice-pay-confirming',
          quoteId: 'quote-usdc-base',
        })
        expect(Object.keys(payBody ?? {}).sort()).toEqual(['invoiceId', 'quoteId'])
        expect(JSON.parse(result.stdout)).toMatchObject({
          state: 'confirming',
          txHash: '0xpay-confirming',
          invoiceId: 'invoice-pay-confirming',
          quoteId: 'quote-usdc-base',
        })
        expect(result.stderr).toContain('confirming')
        expect(result.stderr.toLowerCase()).not.toContain('fulfilled')
        expect(result.stderr.toLowerCase()).not.toContain('success')
        expect(result.stderr).not.toContain('Proceed? [y/N]')
      },
    )
  })

  it('resumes an already-started payment quote instead of selecting a new transaction', async () => {
    let payBody: JsonObject | undefined
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-recovery',
              kind: 'credit_topup',
              quotes: [
                billingQuote(paymentMethods[1], {
                  paymentStartedAt: '2026-07-10T06:14:00.000Z',
                  affordability: {
                    affordable: true,
                    recoveringPayment: true,
                    walletAddress: WALLET_ADDRESS,
                    tokenRequiredBaseUnits: '10000000',
                  },
                }),
              ],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) {
          payBody = await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              state: 'confirming',
              txHash: '0xrecovered',
              invoiceId: 'invoice-recovery',
              quoteId: 'quote-usdc-base',
            },
          })
          return
        }
        if (req.method === 'GET' && req.url?.endsWith('/billing/invoice-recovery')) {
          writeJson(res, 200, {
            ok: true,
            data: { invoiceId: 'invoice-recovery', state: 'confirming' },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'topup', '--credits', '100', '--yes'])
        expect(result.code).toBe(0)
        expect(payBody).toEqual({
          invoiceId: 'invoice-recovery',
          quoteId: 'quote-usdc-base',
        })
        expect(result.stderr).toContain('Recovery: resuming an already-started payment')
        expect(JSON.parse(result.stdout)).toMatchObject({
          state: 'confirming',
          txHash: '0xrecovered',
        })
      },
    )
  })

  it('prompts for direct canonical payment and reports fulfilled only after status confirms it', async () => {
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-renew-fulfilled',
              kind: 'renewal',
              quotes: [billingQuote(paymentMethods[1])],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) {
          await readBody(req)
          writeJson(res, 200, { ok: true, data: { accepted: true } })
          return
        }
        if (req.method === 'GET' && req.url?.endsWith('/billing/invoice-renew-fulfilled')) {
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-renew-fulfilled',
              kind: 'renewal',
              state: 'fulfilled',
              invoiceStatus: 'paid',
              fulfillment: {
                instanceActivated: true,
                creditGranted: true,
                creditGrantOwner: 'pieverse-app',
              },
            },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew'], 'y\n')
        expect(result.code).toBe(0)
        expect(result.stderr).toContain('Proceed? [y/N]')
        expect(result.stderr).toContain('fulfilled')
        expect(JSON.parse(result.stdout)).toMatchObject({ state: 'fulfilled' })
      },
    )
  })

  it('re-quotes the same invoice and retries payment once after quote expiry', async () => {
    const quoteKeys: string[] = []
    const quoteBodies: JsonObject[] = []
    const payBodies: JsonObject[] = []
    let quoteCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          quoteCalls++
          quoteKeys.push(String(req.headers['idempotency-key']))
          quoteBodies.push(await readBody(req))
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-retry',
              kind: 'renewal',
              quotes: [
                {
                  ...billingQuote(paymentMethods[1]),
                  quoteId: `quote-retry-${quoteCalls}`,
                },
              ],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) {
          payBodies.push(await readBody(req))
          if (payBodies.length === 1) {
            writeJson(res, 409, {
              ok: false,
              error: { code: 'QUOTE_EXPIRED', message: 'Quote expired' },
            })
          } else {
            writeJson(res, 200, {
              ok: true,
              data: {
                state: 'confirming',
                txHash: '0xyes-retry',
                invoiceId: 'invoice-retry',
                quoteId: 'quote-retry-2',
              },
            })
          }
          return
        }
        if (req.method === 'GET' && req.url?.endsWith('/billing/invoice-retry')) {
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-retry',
              kind: 'renewal',
              state: 'confirming',
              invoiceStatus: 'paid',
              fulfillment: { instanceActivated: true, creditGranted: false },
            },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--yes'])
        expect(result.code).toBe(0)
        expect(quoteCalls).toBe(2)
        expect(new Set(quoteKeys).size).toBe(1)
        expect(quoteBodies).toEqual([
          { kind: 'renewal' },
          { kind: 'renewal', tokenId: 'usdc-base' },
        ])
        expect(payBodies).toEqual([
          { invoiceId: 'invoice-retry', quoteId: 'quote-retry-1' },
          { invoiceId: 'invoice-retry', quoteId: 'quote-retry-2' },
        ])
        expect(result.stderr).toContain('retrying once')
        expect(result.stderr).not.toContain('Proceed? [y/N]')
        expect(JSON.parse(result.stdout)).toMatchObject({
          invoiceId: 'invoice-retry',
          state: 'confirming',
          txHash: '0xyes-retry',
        })
      },
    )
  })

  it.each([
    { decision: 'n', expectedCode: 1, expectedPayCount: 1, label: 'aborts' },
    { decision: 'y', expectedCode: 0, expectedPayCount: 2, label: 'accepts' },
  ])('$label an interactive stale re-quote after pinning the original token and confirming again', async ({
    decision,
    expectedCode,
    expectedPayCount,
  }) => {
    const quoteBodies: JsonObject[] = []
    const payBodies: JsonObject[] = []
    let quoteCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          quoteCalls++
          quoteBodies.push(await readBody(req))
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: `invoice-interactive-${quoteCalls}`,
              kind: 'renewal',
              quotes:
                quoteCalls === 1
                  ? [
                      {
                        ...billingQuote(paymentMethods[1]),
                        quoteId: 'quote-usdc-initial',
                      },
                    ]
                  : [
                      {
                        ...billingQuote(paymentMethods[0], { finalUsdAmount: '1' }),
                        quoteId: 'quote-bnb-retry',
                      },
                      {
                        ...billingQuote(paymentMethods[1], { finalUsdAmount: '9' }),
                        quoteId: 'quote-usdc-retry',
                      },
                    ],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) {
          payBodies.push(await readBody(req))
          if (payBodies.length === 1) {
            writeJson(res, 409, {
              ok: false,
              error: { code: 'QUOTE_EXPIRED', message: 'Quote expired' },
            })
          } else {
            writeJson(res, 200, {
              ok: true,
              data: {
                state: 'confirming',
                txHash: '0xinteractive-retry',
                invoiceId: 'invoice-interactive-2',
                quoteId: 'quote-usdc-retry',
              },
            })
          }
          return
        }
        if (req.method === 'GET' && req.url?.endsWith('/billing/invoice-interactive-2')) {
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-interactive-2',
              kind: 'renewal',
              state: 'confirming',
            },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew'], `y\n${decision}\n`)
        expect(result.code).toBe(expectedCode)
        expect(quoteBodies).toEqual([
          { kind: 'renewal' },
          { kind: 'renewal', tokenId: 'usdc-base' },
        ])
        expect(payBodies).toHaveLength(expectedPayCount)
        expect(payBodies[0]).toEqual({
          invoiceId: 'invoice-interactive-1',
          quoteId: 'quote-usdc-initial',
        })
        expect(result.stderr.match(/Proceed\? \[y\/N\]/g)).toHaveLength(2)
        expect(result.stderr).toContain('Token: USDC (usdc-base)')
        expect(payBodies).not.toContainEqual({
          invoiceId: 'invoice-interactive-2',
          quoteId: 'quote-bnb-retry',
        })

        if (decision === 'n') {
          expect(result.stderr).toContain('Aborted.')
        } else {
          expect(payBodies[1]).toEqual({
            invoiceId: 'invoice-interactive-2',
            quoteId: 'quote-usdc-retry',
          })
          expect(JSON.parse(result.stdout)).toMatchObject({
            state: 'confirming',
            txHash: '0xinteractive-retry',
          })
        }
      },
    )
  })

  it('does not retry payment after payment succeeds when the status lookup fails', async () => {
    let quoteCalls = 0
    let payCalls = 0
    let statusCalls = 0
    await withServer(
      async (req, res) => {
        if (req.method === 'POST' && req.url?.endsWith('/billing/quote')) {
          quoteCalls++
          await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              invoiceId: 'invoice-status-error',
              kind: 'renewal',
              quotes: [billingQuote(paymentMethods[1])],
            },
          })
          return
        }
        if (req.method === 'POST' && req.url?.endsWith('/billing/pay')) {
          payCalls++
          const body = await readBody(req)
          writeJson(res, 200, {
            ok: true,
            data: {
              state: 'confirming',
              txHash: '0xstatus-error-payment',
              invoiceId: body.invoiceId,
              quoteId: body.quoteId,
            },
          })
          return
        }
        if (req.method === 'GET' && req.url?.endsWith('/billing/invoice-status-error')) {
          statusCalls++
          writeJson(res, 409, {
            ok: false,
            error: { code: 'QUOTE_EXPIRED', message: 'Status lookup expired' },
          })
          return
        }
        throw new Error(`Unexpected route: ${req.method} ${req.url}`)
      },
      async (port) => {
        const result = await runPurr(port, ['instance', 'renew', '--yes'])
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({
          state: 'confirming',
          txHash: '0xstatus-error-payment',
          invoiceId: 'invoice-status-error',
          quoteId: 'quote-usdc-base',
        })
        expect(result.stderr).toContain('confirming')
        expect(result.stderr.toLowerCase()).not.toContain('fulfilled')
        expect(result.stderr).toContain('Status lookup expired')
        expect(quoteCalls).toBe(1)
        expect(payCalls).toBe(1)
        expect(statusCalls).toBe(1)
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
        expect(result.stderr).toContain('deprecated')
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
