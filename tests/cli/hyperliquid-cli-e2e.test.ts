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

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return body
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

describe('Hyperliquid CLI e2e', () => {
  let port = 0
  let tmpHome = ''
  let requestCount = 0
  const requests: Array<{
    method?: string
    url?: string
    authorization?: string
    body: string
  }> = []

  const server = createServer(async (req, res) => {
    try {
      requestCount++
      const body = await readRequestBody(req)
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      })

      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

      if (req.url === `/v1/instances/${INSTANCE_ID}/integrations/hyperliquid-trading`) {
        if (req.method === 'GET') {
          writeJson(res, 200, {
            ok: true,
            data: {
              integration: 'hyperliquid-trading',
              enabled: true,
              agentAccess: true,
              dashboardVisible: true,
              updatedAt: '2026-07-20T00:00:00.000Z',
            },
          })
          return
        }

        if (req.method === 'PUT') {
          const parsed = JSON.parse(body) as { enabled?: boolean }
          if (parsed.enabled === false) {
            writeJson(res, 409, {
              ok: false,
              code: 'HYPERLIQUID_TRADING_DISABLE_BLOCKED',
              error: 'Cannot disable Hyperliquid Trading while open positions or open orders exist',
              data: {
                integration: 'hyperliquid-trading',
                network: 'mainnet',
                walletAddress: WALLET_ADDRESS,
                blockers: [
                  {
                    dex: 'default',
                    openPositionsCount: 1,
                    openOrdersCount: 0,
                    frontendOpenOrdersCount: 0,
                    positions: [{ coin: 'SOL', size: '-0.71' }],
                  },
                ],
              },
            })
            return
          }

          assert.deepEqual(parsed, { enabled: true })
          writeJson(res, 200, {
            ok: true,
            data: {
              integration: 'hyperliquid-trading',
              enabled: true,
              agentAccess: true,
              dashboardVisible: true,
              updatedAt: '2026-07-20T00:00:10.000Z',
            },
          })
          return
        }
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/integrations/hyperliquid-trading/snapshot`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            enabled: true,
            network: 'mainnet',
            walletAddress: WALLET_ADDRESS,
            updatedAt: '2026-07-20T00:00:30.000Z',
            summary: {
              accountValueUsd: '10.91',
              todayPnlUsd: '-0.04',
              todayPnlPercent: '-0.23',
              allTimePnlUsd: '-0.04',
              allTimePnlPercent: '-0.23',
              marginUsedUsd: '10.85',
              marginUsedPercent: '99.45',
              openPositionsCount: 1,
              riskStatus: 'attention',
            },
            positions: [],
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/account`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            network: 'mainnet',
            address: WALLET_ADDRESS,
            walletId: 'wallet-row-id',
            walletProvider: 'tee',
            chainType: 'ethereum',
            apiUrl: 'https://api.hyperliquid.xyz',
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/symbol?coin=BTC`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 409, {
          ok: false,
          code: 'HYPERLIQUID_SYMBOL_AMBIGUOUS',
          error: 'Hyperliquid symbol is ambiguous: BTC',
          data: {
            coin: 'BTC',
            candidates: [
              { coin: 'BTC', dex: 'default', assetId: 0, szDecimals: 5 },
              { coin: 'hyna:BTC', dex: 'hyna', assetId: 120000, szDecimals: 5 },
            ],
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/builder-fee/approve`) {
        assert.equal(req.method, 'POST')
        assert.deepEqual(JSON.parse(body), {})
        writeJson(res, 200, {
          ok: true,
          data: {
            network: 'mainnet',
            walletAddress: WALLET_ADDRESS,
            status: 'approved',
            actionRequestId: 'approval-request-id',
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/builder-fee/status`) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            status: 'approval_required',
          },
        })
        return
      }

      if (
        req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/withdraw-status?nonce=1784552760585`
      ) {
        assert.equal(req.method, 'GET')
        writeJson(res, 200, {
          ok: true,
          data: {
            network: 'mainnet',
            walletAddress: WALLET_ADDRESS,
            nonce: 1784552760585,
            status: 'arrived',
            withdrawal: {
              time: 1784552800000,
              txHash: `0x${'a'.repeat(64)}`,
              amountUsdc: '5',
              feeUsdc: '1',
            },
          },
        })
        return
      }

      if (req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/order`) {
        assert.equal(req.method, 'POST')
        writeJson(res, 428, {
          ok: false,
          code: 'HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED',
          error: 'Builder fee approval is required',
        })
        return
      }

      if (
        req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/cancel` ||
        req.url === `/v1/instances/${INSTANCE_ID}/hyperliquid/cancel-by-cloid`
      ) {
        assert.equal(req.method, 'POST')
        writeJson(res, 200, {
          ok: true,
          data: {
            status: 'ok',
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
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-hyperliquid-e2e-'))
    port = await listen(server)
  })

  beforeEach(() => {
    requestCount = 0
    requests.length = 0
  })

  afterAll(async () => {
    await closeServer(server)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('prints the Hyperliquid account response from the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'account'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      network: 'mainnet',
      address: WALLET_ADDRESS,
      walletProvider: 'tee',
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/account`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('prints the Hyperliquid Trading integration status', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'status'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      integration: 'hyperliquid-trading',
      enabled: true,
      agentAccess: true,
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/integrations/hyperliquid-trading`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('enables the Hyperliquid Trading integration through the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'enable'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      integration: 'hyperliquid-trading',
      enabled: true,
      dashboardVisible: true,
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'PUT',
      url: `/v1/instances/${INSTANCE_ID}/integrations/hyperliquid-trading`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify({ enabled: true }),
    })
  })

  it('prints disable blockers from the Hyperliquid Trading integration route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'disable'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const [errorLine, ...detailLines] = result.stderr.split('\n')
    expect(errorLine).toBe(
      'error [HYPERLIQUID_TRADING_DISABLE_BLOCKED]: Cannot disable Hyperliquid Trading while open positions or open orders exist',
    )
    expect(JSON.parse(detailLines.join('\n'))).toMatchObject({
      integration: 'hyperliquid-trading',
      blockers: [
        {
          dex: 'default',
          openPositionsCount: 1,
          positions: [{ coin: 'SOL', size: '-0.71' }],
        },
      ],
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'PUT',
      url: `/v1/instances/${INSTANCE_ID}/integrations/hyperliquid-trading`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify({ enabled: false }),
    })
  })

  it('prints the Hyperliquid Trading snapshot response', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'snapshot'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: true,
      summary: {
        marginUsedPercent: '99.45',
        riskStatus: 'attention',
      },
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/integrations/hyperliquid-trading/snapshot`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('prints ambiguity candidates so the caller can select the intended dex', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'symbol', '--coin', 'BTC'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const [errorLine, ...detailLines] = result.stderr.split('\n')
    expect(errorLine).toBe(
      'error [HYPERLIQUID_SYMBOL_AMBIGUOUS]: Hyperliquid symbol is ambiguous: BTC',
    )
    expect(JSON.parse(detailLines.join('\n'))).toEqual({
      coin: 'BTC',
      candidates: [
        { coin: 'BTC', dex: 'default', assetId: 0, szDecimals: 5 },
        { coin: 'hyna:BTC', dex: 'hyna', assetId: 120000, szDecimals: 5 },
      ],
    })
    expect(requestCount).toBe(1)
  })

  it('approves the fixed Hyperliquid builder fee through the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'approve-builder-fee'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      network: 'mainnet',
      walletAddress: WALLET_ADDRESS,
      status: 'approved',
      actionRequestId: 'approval-request-id',
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/builder-fee/approve`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '{}',
    })
  })

  it('checks the Hyperliquid builder fee approval status through the platform route', async () => {
    const result = await runPurr(port, tmpHome, ['hyperliquid', 'builder-fee-status'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'approval_required',
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/builder-fee/status`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('checks Hyperliquid withdraw arrival status by nonce through the platform route', async () => {
    const result = await runPurr(port, tmpHome, [
      'hyperliquid',
      'withdraw-status',
      '--nonce',
      '1784552760585',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      network: 'mainnet',
      walletAddress: WALLET_ADDRESS,
      nonce: 1784552760585,
      status: 'arrived',
      withdrawal: {
        amountUsdc: '5',
        feeUsdc: '1',
      },
    })
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'GET',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/withdraw-status?nonce=1784552760585`,
      authorization: `Bearer ${API_TOKEN}`,
      body: '',
    })
  })

  it('exposes builder fee approval requirements without automatically retrying', async () => {
    const order = {
      orders: [
        {
          a: 0,
          b: true,
          p: '100',
          s: '0.01',
          r: false,
          t: { limit: { tif: 'Gtc' } },
        },
      ],
      grouping: 'na',
    }
    const result = await runPurr(port, tmpHome, [
      'hyperliquid',
      'limit-order',
      '--asset',
      '0',
      '--side',
      'buy',
      '--size',
      '0.01',
      '--price',
      '100',
      '--tif',
      'Gtc',
      '--reduce-only',
      'false',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'error [HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED]: Builder fee approval is required',
    )
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/order`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify(order),
    })
  })

  it.each([
    {
      command: 'order',
      replacement: 'Use limit-order, bracket-order, stop-loss, take-profit, or protect-position',
    },
    {
      command: 'modify',
      replacement: 'Use modify-limit-order, modify-stop-loss, or modify-take-profit',
    },
  ])(
    'rejects the removed raw $command command without making an HTTP request',
    async ({ command, replacement }) => {
      const result = await runPurr(port, tmpHome, ['hyperliquid', command, '--body-json', '{}'])

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`purr hyperliquid ${command} was removed. ${replacement}`)
      expect(requestCount).toBe(0)
    },
  )

  it('builds parameterized cancel requests without exposing raw bodies', async () => {
    const byOid = await runPurr(port, tmpHome, [
      'hyperliquid',
      'cancel',
      '--asset',
      '159',
      '--oid',
      '123456',
    ])
    const byCloid = await runPurr(port, tmpHome, [
      'hyperliquid',
      'cancel-by-cloid',
      '--asset',
      '159',
      '--cloid',
      '0xABCDEFABCDEFABCDEFABCDEFABCDEFAB',
    ])

    expect(byOid.code).toBe(0)
    expect(byOid.stderr).toBe('')
    expect(byCloid.code).toBe(0)
    expect(byCloid.stderr).toBe('')
    expect(requests).toEqual([
      {
        method: 'POST',
        url: `/v1/instances/${INSTANCE_ID}/hyperliquid/cancel`,
        authorization: `Bearer ${API_TOKEN}`,
        body: JSON.stringify({ cancels: [{ a: 159, o: 123456 }] }),
      },
      {
        method: 'POST',
        url: `/v1/instances/${INSTANCE_ID}/hyperliquid/cancel-by-cloid`,
        authorization: `Bearer ${API_TOKEN}`,
        body: JSON.stringify({
          cancels: [{ asset: 159, cloid: '0xabcdefabcdefabcdefabcdefabcdefab' }],
        }),
      },
    ])
  })

  it('rejects malformed or legacy cancel arguments without making an HTTP request', async () => {
    const missing = await runPurr(port, tmpHome, [
      'hyperliquid',
      'cancel',
      '--asset',
      '159',
    ])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toBe('Missing required argument: --oid')

    const duplicate = await runPurr(port, tmpHome, [
      'hyperliquid',
      'cancel',
      '--asset',
      '159',
      '--oid',
      '123',
      '--oid',
      '456',
    ])
    expect(duplicate.code).toBe(1)
    expect(duplicate.stderr).toBe('Duplicate option for purr hyperliquid cancel: --oid')

    const legacy = await runPurr(port, tmpHome, [
      'hyperliquid',
      'cancel-by-cloid',
      '--body-json',
      '{}',
    ])
    expect(legacy.code).toBe(1)
    expect(legacy.stderr).toContain(
      'Unknown option for purr hyperliquid cancel-by-cloid: --body-json',
    )
    expect(requestCount).toBe(0)
  })

  it('builds an entry order with attached TP/SL children from bracket parameters', async () => {
    const result = await runPurr(port, tmpHome, [
      'hyperliquid',
      'bracket-order',
      '--asset',
      '159',
      '--side',
      'buy',
      '--size',
      '0.45',
      '--entry-price',
      '72',
      '--entry-tif',
      'Gtc',
      '--take-profit-price',
      '100',
      '--take-profit-worst-price',
      '90',
      '--stop-loss-price',
      '69',
      '--stop-loss-worst-price',
      '62',
      '--execution',
      'market',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'error [HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED]: Builder fee approval is required',
    )
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/order`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify({
        orders: [
          {
            a: 159,
            b: true,
            p: '72',
            s: '0.45',
            r: false,
            t: { limit: { tif: 'Gtc' } },
          },
          {
            a: 159,
            b: false,
            p: '90',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '100', tpsl: 'tp' } },
          },
          {
            a: 159,
            b: false,
            p: '62',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '69', tpsl: 'sl' } },
          },
        ],
        grouping: 'normalTpsl',
      }),
    })
  })

  it('builds a stop-loss trigger from CLI parameters before posting to the existing route', async () => {
    const result = await runPurr(port, tmpHome, [
      'hyperliquid',
      'stop-loss',
      '--asset',
      '159',
      '--position-side',
      'long',
      '--size',
      '0.45',
      '--trigger-price',
      '69',
      '--worst-price',
      '62',
      '--execution',
      'market',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'error [HYPERLIQUID_BUILDER_FEE_APPROVAL_REQUIRED]: Builder fee approval is required',
    )
    expect(requestCount).toBe(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/hyperliquid/order`,
      authorization: `Bearer ${API_TOKEN}`,
      body: JSON.stringify({
        orders: [
          {
            a: 159,
            b: false,
            p: '62',
            s: '0.45',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '69', tpsl: 'sl' } },
          },
        ],
        grouping: 'positionTpsl',
      }),
    })
  })

  it('rejects malformed stop-loss parameters without making an HTTP request', async () => {
    const missing = await runPurr(port, tmpHome, [
      'hyperliquid',
      'stop-loss',
      '--asset',
      '159',
      '--position-side',
      'long',
      '--trigger-price',
      '69',
      '--execution',
      'market',
    ])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toBe('Missing required argument: --size')

    const missingWorstPrice = await runPurr(port, tmpHome, [
      'hyperliquid',
      'stop-loss',
      '--asset',
      '159',
      '--position-side',
      'long',
      '--size',
      '0.45',
      '--trigger-price',
      '69',
      '--execution',
      'market',
    ])
    expect(missingWorstPrice.code).toBe(1)
    expect(missingWorstPrice.stdout).toBe('')
    expect(missingWorstPrice.stderr).toBe(
      '--worst-price is required when --execution is market',
    )

    const unknown = await runPurr(port, tmpHome, [
      'hyperliquid',
      'stop-loss',
      '--asset',
      '159',
      '--position-side',
      'long',
      '--size',
      '0.45',
      '--trigger-price',
      '69',
      '--execution',
      'market',
      '--tpsl',
      'sl',
    ])
    expect(unknown.code).toBe(1)
    expect(unknown.stdout).toBe('')
    expect(unknown.stderr).toContain('Unknown option for purr hyperliquid stop-loss: --tpsl')

    const duplicate = await runPurr(port, tmpHome, [
      'hyperliquid',
      'stop-loss',
      '--asset',
      '159',
      '--position-side',
      'long',
      '--size',
      '0.45',
      '--size',
      '45',
      '--trigger-price',
      '69',
      '--execution',
      'market',
    ])
    expect(duplicate.code).toBe(1)
    expect(duplicate.stdout).toBe('')
    expect(duplicate.stderr).toBe('Duplicate option for purr hyperliquid stop-loss: --size')

    const positional = await runPurr(port, tmpHome, [
      'hyperliquid',
      'stop-loss',
      '--asset',
      '159',
      'unexpected',
    ])
    expect(positional.code).toBe(1)
    expect(positional.stdout).toBe('')
    expect(positional.stderr).toBe(
      'Unexpected positional argument for purr hyperliquid stop-loss: "unexpected". Use named --options only.',
    )
    expect(requestCount).toBe(0)
  })
})
