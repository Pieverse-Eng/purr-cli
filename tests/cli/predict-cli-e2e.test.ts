import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PredictCliError, predictCommand } from '@pieverseio/purr-plugin-vendors/predict'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const API_TOKEN = 'predict-test-token'
const INSTANCE_ID = 'inst-predict'
const BASE_PATH = `/v1/instances/${INSTANCE_ID}/predict`
const PREVIEW_ID = '11111111-1111-4111-8111-111111111111'
const ORDER_HASH = `0x${'a'.repeat(64)}`
const ADDRESS = `0x${'b'.repeat(40)}`

interface RequestRecord {
  method?: string
  url?: string
  authorization?: string
  idempotencyKey?: string
  body?: unknown
}

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

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return body.length > 0 ? JSON.parse(body) : undefined
}

async function captureCommand(command: string, args: Record<string, string>): Promise<unknown[]> {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    lines.push(String(value))
  })
  try {
    await predictCommand(command, args)
  } finally {
    log.mockRestore()
  }
  return lines.map((line) => JSON.parse(line))
}

async function runPurr(port: number, tmpHome: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env }
    for (const name of [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]) {
      delete cleanEnv[name]
    }

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

describe('Predict CLI e2e', () => {
  let port = 0
  let tmpHome = ''
  const requests: RequestRecord[] = []
  const originalApiUrl = process.env.WALLET_API_URL
  const originalApiToken = process.env.WALLET_API_TOKEN
  const originalInstanceId = process.env.INSTANCE_ID

  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)
      const body = await readRequestBody(req)
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        idempotencyKey:
          typeof req.headers['idempotency-key'] === 'string'
            ? req.headers['idempotency-key']
            : undefined,
        body,
      })

      if (req.url?.startsWith(`${BASE_PATH}/stream?`)) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        })
        res.write('event: connected\ndata: {"topics":["wallet"]}\n\n')
        res.write('event: message\ndata: {"topic":"wallet","data":{"kind":"order"}}\n\n')
        res.end('event: message\ndata: {"topic":"orderbook:7","data":{"bestBid":0.4}}\n\n')
        return
      }

      if (req.url === `${BASE_PATH}/markets/999999`) {
        writeJson(res, 422, {
          ok: false,
          code: 'PREDICT_MARKET_UNAVAILABLE',
          error: 'Market is unavailable',
          retryable: false,
          data: { marketId: 999999 },
        })
        return
      }
      if (req.url === `${BASE_PATH}/markets/888888`) {
        writeJson(res, 400, {
          error: {
            issues: [
              { path: ['acknowledgeRisk'], message: 'Invalid literal value, expected true' },
            ],
          },
        })
        return
      }

      const paged =
        req.method === 'GET' &&
        (req.url?.startsWith(`${BASE_PATH}/categories`) ||
          req.url?.startsWith(`${BASE_PATH}/tags`) ||
          req.url?.startsWith(`${BASE_PATH}/search`) ||
          req.url?.startsWith(`${BASE_PATH}/markets?`) ||
          req.url?.startsWith(`${BASE_PATH}/orders?`) ||
          req.url?.startsWith(`${BASE_PATH}/positions?`) ||
          req.url?.startsWith(`${BASE_PATH}/activity`) ||
          req.url?.startsWith(`${BASE_PATH}/matches`) ||
          req.url?.startsWith(`${BASE_PATH}/addresses/`))

      writeJson(res, 200, {
        ok: true,
        data: { method: req.method, url: req.url, body },
        ...(paged ? { cursor: 'next-page' } : {}),
      })
    } catch (error) {
      void error
      writeJson(res, 500, { ok: false, error: 'Internal server error' })
    }
  })

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'purr-predict-e2e-'))
    port = await listen(server)
    process.env.WALLET_API_URL = `http://127.0.0.1:${port}`
    process.env.WALLET_API_TOKEN = API_TOKEN
    process.env.INSTANCE_ID = INSTANCE_ID
  })

  beforeEach(() => {
    requests.length = 0
  })

  afterAll(async () => {
    await closeServer(server)
    rmSync(tmpHome, { recursive: true, force: true })
    if (originalApiUrl === undefined) delete process.env.WALLET_API_URL
    else process.env.WALLET_API_URL = originalApiUrl
    if (originalApiToken === undefined) delete process.env.WALLET_API_TOKEN
    else process.env.WALLET_API_TOKEN = originalApiToken
    if (originalInstanceId === undefined) delete process.env.INSTANCE_ID
    else process.env.INSTANCE_ID = originalInstanceId
  })

  it('wraps every Predict read route and preserves pagination cursors', async () => {
    const cases: Array<{
      command: string
      args: Record<string, string>
      url: string
      paged?: boolean
    }> = [
      { command: 'account', args: {}, url: `${BASE_PATH}/account` },
      {
        command: 'balances',
        args: { 'market-id': '7' },
        url: `${BASE_PATH}/balances?marketId=7`,
      },
      { command: 'readiness', args: {}, url: `${BASE_PATH}/readiness` },
      {
        command: 'categories',
        args: {
          first: '2',
          after: 'cursor',
          status: 'OPEN',
          sort: 'VOLUME',
          'tag-ids': '1,2',
          'market-variant': 'BINARY',
        },
        url: `${BASE_PATH}/categories?first=2&after=cursor&status=OPEN&sort=VOLUME&tagIds=1%2C2&marketVariant=BINARY`,
        paged: true,
      },
      {
        command: 'category',
        args: { slug: 'world-cup' },
        url: `${BASE_PATH}/categories/world-cup`,
      },
      { command: 'tags', args: {}, url: `${BASE_PATH}/tags`, paged: true },
      {
        command: 'search',
        args: { query: 'rain chance', 'include-resolved': 'false', limit: '5' },
        url: `${BASE_PATH}/search?query=rain+chance&includeResolved=false&limit=5`,
        paged: true,
      },
      {
        command: 'markets',
        args: { first: '1', 'is-boosted': 'true', 'has-active-rewards': 'false' },
        url: `${BASE_PATH}/markets?first=1&isBoosted=true&hasActiveRewards=false`,
        paged: true,
      },
      { command: 'market', args: { 'market-id': '7' }, url: `${BASE_PATH}/markets/7` },
      {
        command: 'market-stats',
        args: { 'market-id': '7' },
        url: `${BASE_PATH}/markets/7/stats`,
      },
      {
        command: 'market-last-sale',
        args: { 'market-id': '7' },
        url: `${BASE_PATH}/markets/7/last-sale`,
      },
      {
        command: 'market-quote',
        args: { 'market-id': '7' },
        url: `${BASE_PATH}/markets/7/quote`,
      },
      {
        command: 'market-quotes',
        args: { 'market-ids': '7,8' },
        url: `${BASE_PATH}/markets/quotes?ids=7%2C8`,
      },
      {
        command: 'orderbook',
        args: { 'market-id': '7', outcome: 'no' },
        url: `${BASE_PATH}/markets/7/orderbook?outcome=NO`,
      },
      {
        command: 'timeseries-latest',
        args: { 'market-id': '7' },
        url: `${BASE_PATH}/markets/7/timeseries/latest?metric=chance`,
      },
      {
        command: 'timeseries',
        args: {
          'market-id': '7',
          from: '1000',
          to: '2000',
          resolution: '1h',
          limit: '10',
          after: 'next',
        },
        url: `${BASE_PATH}/markets/7/timeseries?metric=chance&resolution=1h&from=1000&to=2000&limit=10&after=next`,
      },
      {
        command: 'orders',
        args: { first: '10', status: 'OPEN' },
        url: `${BASE_PATH}/orders?first=10&status=OPEN`,
        paged: true,
      },
      {
        command: 'order',
        args: { 'order-hash': ORDER_HASH },
        url: `${BASE_PATH}/orders/${ORDER_HASH}`,
      },
      {
        command: 'positions',
        args: { 'market-id': '7', sort: 'VALUE' },
        url: `${BASE_PATH}/positions?marketId=7&sort=VALUE`,
        paged: true,
      },
      {
        command: 'address-positions',
        args: { address: ADDRESS, first: '5' },
        url: `${BASE_PATH}/addresses/${ADDRESS}/positions?first=5`,
        paged: true,
      },
      {
        command: 'activity',
        args: { first: '3' },
        url: `${BASE_PATH}/activity?first=3`,
        paged: true,
      },
      {
        command: 'matches',
        args: { 'market-id': '7', 'minimum-value': '0.9' },
        url: `${BASE_PATH}/matches?marketId=7&minimumValue=0.9`,
        paged: true,
      },
      { command: 'referral', args: {}, url: `${BASE_PATH}/account/referral` },
      {
        command: 'approvals',
        args: { 'market-id': '7', operation: 'trade', side: 'buy' },
        url: `${BASE_PATH}/approvals?marketId=7&operation=TRADE&side=BUY`,
      },
    ]

    for (const testCase of cases) {
      const [output] = await captureCommand(testCase.command, testCase.args)
      expect(requests.at(-1)?.url).toBe(testCase.url)
      if (testCase.paged) {
        expect(output).toMatchObject({ cursor: 'next-page', data: { url: testCase.url } })
      } else {
        expect(output).toMatchObject({ url: testCase.url })
      }
    }
    expect(requests).toHaveLength(cases.length)
  })

  it('wraps every Predict mutation route with the documented body shape', async () => {
    const cases: Array<{
      command: string
      args: Record<string, string>
      url: string
      body: unknown
    }> = [
      {
        command: 'set-referral',
        args: { code: 'ABCDE' },
        url: `${BASE_PATH}/account/referral`,
        body: { code: 'ABCDE' },
      },
      {
        command: 'order-preview',
        args: {
          'market-id': '7',
          outcome: 'yes',
          side: 'buy',
          strategy: 'limit',
          quantity: '2',
          price: '0.45',
          'expires-at': '2027-01-01T00:00:00.000Z',
          'post-only': 'true',
          'self-trade-prevention': 'cancel-maker',
        },
        url: `${BASE_PATH}/orders/preview`,
        body: {
          marketId: 7,
          outcome: 'YES',
          side: 'BUY',
          strategy: 'LIMIT',
          quantity: '2',
          price: '0.45',
          expiresAt: '2027-01-01T00:00:00.000Z',
          options: {
            postOnly: true,
            selfTradePrevention: 'CANCEL_MAKER',
          },
        },
      },
      {
        command: 'order-preview',
        args: {
          'market-id': '7',
          outcome: 'yes',
          side: 'buy',
          strategy: 'market',
          spend: '1.5',
          'slippage-bps': '50',
          'is-min-amount-out': 'false',
          'fill-or-kill': 'false',
          'reserved-balance-policy': 'STRICT',
        },
        url: `${BASE_PATH}/orders/preview`,
        body: {
          marketId: 7,
          outcome: 'YES',
          side: 'BUY',
          strategy: 'MARKET',
          spend: '1.5',
          slippageBps: 50,
          isMinAmountOut: false,
          options: {
            fillOrKill: false,
            reservedBalancePolicy: 'STRICT',
          },
        },
      },
      {
        command: 'order-execute',
        args: { 'preview-id': PREVIEW_ID },
        url: `${BASE_PATH}/orders`,
        body: { previewId: PREVIEW_ID },
      },
      {
        command: 'cancel-preview',
        args: { 'order-hashes': ORDER_HASH },
        url: `${BASE_PATH}/orders/cancel/preview`,
        body: { orderHashes: [ORDER_HASH] },
      },
      {
        command: 'cancel-all-preview',
        args: {},
        url: `${BASE_PATH}/orders/cancel-all/preview`,
        body: {},
      },
      {
        command: 'remove-from-book-preview',
        args: { 'order-hashes': ORDER_HASH },
        url: `${BASE_PATH}/orders/remove-from-book/preview`,
        body: { orderHashes: [ORDER_HASH] },
      },
      {
        command: 'cancel-execute',
        args: { 'preview-id': PREVIEW_ID },
        url: `${BASE_PATH}/orders/cancel`,
        body: { previewId: PREVIEW_ID },
      },
      {
        command: 'cancel-all-execute',
        args: { 'preview-id': PREVIEW_ID },
        url: `${BASE_PATH}/orders/cancel-all`,
        body: { previewId: PREVIEW_ID },
      },
      {
        command: 'remove-from-book-execute',
        args: { 'preview-id': PREVIEW_ID, 'acknowledge-risk': 'true' },
        url: `${BASE_PATH}/orders/remove-from-book`,
        body: { previewId: PREVIEW_ID, acknowledgeRisk: true },
      },
      {
        command: 'approval-preview',
        args: {
          operation: 'trade',
          'market-id': '7',
          side: 'sell',
          amount: '2',
          unlimited: 'false',
          'step-ids': 'erc20,exchange',
        },
        url: `${BASE_PATH}/approvals/preview`,
        body: {
          operation: 'TRADE',
          marketId: 7,
          side: 'SELL',
          amount: '2',
          unlimited: false,
          stepIds: ['erc20', 'exchange'],
        },
      },
      {
        command: 'approval-revoke-preview',
        args: { operation: 'all' },
        url: `${BASE_PATH}/approvals/revoke/preview`,
        body: { operation: 'ALL' },
      },
      {
        command: 'approval-execute',
        args: { 'preview-id': PREVIEW_ID },
        url: `${BASE_PATH}/approvals`,
        body: { previewId: PREVIEW_ID },
      },
      {
        command: 'approval-revoke-execute',
        args: { 'preview-id': PREVIEW_ID },
        url: `${BASE_PATH}/approvals/revoke`,
        body: { previewId: PREVIEW_ID },
      },
      {
        command: 'position-preview',
        args: { action: 'split', 'market-id': '7', amount: '1' },
        url: `${BASE_PATH}/positions/actions/preview`,
        body: { action: 'SPLIT', marketId: 7, amount: '1' },
      },
      {
        command: 'position-preview',
        args: { action: 'redeem', 'market-id': '7', outcome: 'no' },
        url: `${BASE_PATH}/positions/actions/preview`,
        body: { action: 'REDEEM', marketId: 7, outcome: 'NO' },
      },
      {
        command: 'position-preview',
        args: { action: 'convert', 'category-slug': 'elections', 'market-ids': '7,8', amount: '1' },
        url: `${BASE_PATH}/positions/actions/preview`,
        body: { action: 'CONVERT', categorySlug: 'elections', marketIds: [7, 8], amount: '1' },
      },
      {
        command: 'position-execute',
        args: { 'preview-id': PREVIEW_ID },
        url: `${BASE_PATH}/positions/actions`,
        body: { previewId: PREVIEW_ID },
      },
    ]

    for (const testCase of cases) {
      const [output] = await captureCommand(testCase.command, testCase.args)
      const request = requests.at(-1)
      expect(request).toMatchObject({
        method: 'POST',
        url: testCase.url,
        body: testCase.body,
      })
      expect(request?.idempotencyKey).toBeUndefined()
      expect(output).toMatchObject({ method: 'POST', url: testCase.url, body: testCase.body })
    }
    expect(requests).toHaveLength(cases.length)
  })

  it('streams Predict events incrementally and prints a terminal summary', async () => {
    const output = await captureCommand('stream', {
      topics: 'wallet,orderbook:7',
      'max-events': '2',
      'timeout-ms': '5000',
    })

    expect(requests[0]?.url).toBe(`${BASE_PATH}/stream?topics=wallet%2Corderbook%3A7`)
    expect(output).toEqual([
      {
        type: 'predict-stream-event',
        event: 'message',
        data: { topic: 'wallet', data: { kind: 'order' } },
      },
      {
        type: 'predict-stream-event',
        event: 'message',
        data: { topic: 'orderbook:7', data: { bestBid: 0.4 } },
      },
      {
        type: 'predict-stream',
        topics: ['wallet', 'orderbook:7'],
        eventCount: 2,
        timedOut: false,
      },
    ])
  })

  it('rejects unsupported networks and missing removal acknowledgement before HTTP', async () => {
    await expect(predictCommand('account', { network: 'testnet' })).rejects.toThrow(
      'BNB Chain mainnet-only',
    )
    await expect(
      predictCommand('remove-from-book-execute', { 'preview-id': PREVIEW_ID }),
    ).rejects.toThrow('--acknowledge-risk true is required')
    expect(requests).toHaveLength(0)
  })

  it('rejects unknown, irrelevant, positional, and duplicate arguments before HTTP', async () => {
    await expect(predictCommand('account', { 'market-id': '7' })).rejects.toThrow(
      'Unsupported argument for predict-fun account: --market-id',
    )
    await expect(
      predictCommand('order-preview', {
        'market-id': '7',
        outcome: 'YES',
        side: 'BUY',
        strategy: 'MARKET',
        spend: '1',
        'slipage-bps': '50',
      }),
    ).rejects.toThrow('Unsupported argument for predict-fun order-preview: --slipage-bps')
    await expect(
      predictCommand('position-preview', {
        action: 'SPLIT',
        'market-id': '7',
        amount: '1',
        outcome: 'YES',
      }),
    ).rejects.toThrow('Unsupported argument for predict-fun position-preview: --outcome')
    await expect(
      predictCommand('set-referral', {
        code: 'ABCDE',
        'idempotency-key': 'legacy-referral-key',
      }),
    ).rejects.toThrow('Unsupported argument for predict-fun set-referral: --idempotency-key')

    const positional = await runPurr(port, tmpHome, ['predict-fun', 'account', 'unexpected'])
    expect(positional.code).toBe(1)
    expect(positional.stderr).toContain(
      'Unexpected positional argument for predict-fun account: unexpected',
    )

    const duplicate = await runPurr(port, tmpHome, [
      'predict-fun',
      'market',
      '--market-id',
      '7',
      '--market-id',
      '8',
    ])
    expect(duplicate.code).toBe(1)
    expect(duplicate.stderr).toContain('Duplicate argument for predict-fun market: --market-id')
    expect(requests).toHaveLength(0)
  })

  it('preserves structured platform errors and raw Zod validation details', async () => {
    await expect(predictCommand('market', { 'market-id': '999999' })).rejects.toMatchObject({
      name: 'PredictCliError',
      code: 'PREDICT_MARKET_UNAVAILABLE',
      status: 422,
      message: 'Market is unavailable',
      retryable: false,
      data: { marketId: 999999 },
    } satisfies Partial<PredictCliError>)

    await expect(predictCommand('market', { 'market-id': '888888' })).rejects.toMatchObject({
      name: 'PredictCliError',
      status: 400,
      message: 'Invalid literal value, expected true',
    } satisfies Partial<PredictCliError>)
  })

  it('is wired into the root CLI dispatcher and error formatter', async () => {
    const success = await runPurr(port, tmpHome, [
      'predict-fun',
      'market-quote',
      '--market-id',
      '7',
    ])
    expect(success.code).toBe(0)
    expect(success.stderr).toBe('')
    expect(JSON.parse(success.stdout)).toMatchObject({ url: `${BASE_PATH}/markets/7/quote` })

    const failure = await runPurr(port, tmpHome, ['predict-fun', 'market', '--market-id', '999999'])
    expect(failure.code).toBe(1)
    expect(failure.stdout).toBe('')
    expect(failure.stderr).toContain('error [PREDICT_MARKET_UNAVAILABLE]: Market is unavailable')
    expect(failure.stderr).toContain('"marketId": 999999')

    const legacyGroup = await runPurr(port, tmpHome, ['predict', 'help'])
    expect(legacyGroup.code).toBe(1)
    expect(legacyGroup.stdout).toBe('')
    expect(legacyGroup.stderr).toContain('Unknown group: predict')
  })
})
