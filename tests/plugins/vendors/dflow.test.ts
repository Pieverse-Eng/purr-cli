import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DflowCliError,
  dflowExecuteOrder,
  dflowExecutionStatus,
  dflowMetadata,
  dflowOrder,
  dflowPositions,
  dflowPriorityFees,
  dflowQuote,
  dflowPredictionOrderStatus,
  dflowStream,
} from '@pieverseio/purr-plugin-vendors/dflow'

const originalFetch = globalThis.fetch
const SOLANA_ADDRESS = 'DZttmKxhq1H7v5fFVPbejCkqHiTDjq9J6Q1muQT2ouWD'
const OTHER_SOLANA_ADDRESS = '2QDSRUp5Xa8SSKceKLxeYpEDgjWCpxRDWBQQA43qX4vn'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body)
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => text,
  } as unknown as Response
}

function jsonErrorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = JSON.stringify(body)
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => text,
  } as unknown as Response
}

type Route = (body: unknown, init?: RequestInit) => Response | Promise<Response>

/** Routes fetch by URL suffix; any other request fails the test. */
function mockPlatform(routes: Record<string, Route>) {
  const calls: Array<{ url: string; method?: string; headers?: HeadersInit; body?: unknown }> = []
  Object.defineProperty(globalThis, 'fetch', {
    value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method: init?.method, headers: init?.headers, body })
      const path = new URL(url).pathname
      const route = routes[path]
      if (!route) throw new Error(`unexpected fetch ${url}`)
      return route(body, init)
    }),
    configurable: true,
    writable: true,
  })
  return calls
}

const EXECUTE_PATH = '/v1/instances/test-instance/dflow/execute'
const EXECUTION_PATH = '/v1/instances/test-instance/dflow/executions/request-1'
const REQUEST = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amount: '1000000',
  options: { slippageBps: 50 },
}
const ORDER_OUTPUT = {
  type: 'dflow-order',
  request: REQUEST,
  order: {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount: '1000000',
    outAmount: '24000000',
    minOutAmount: '23880000',
    executionMode: 'sync',
    transaction: 'base64-preview-transaction',
    lastValidBlockHeight: 999,
  },
}

function submitted(result: Record<string, unknown> = {}) {
  return jsonResponse({
    ok: true,
    data: {
      requestId: 'request-1',
      result: {
        state: 'submitted',
        signature: '5sig',
        executionMode: 'sync',
        lastValidBlockHeight: 999,
        ...result,
      },
    },
  })
}

function execution(state: string, error: unknown = null) {
  return jsonResponse({
    ok: true,
    data: { requestId: 'request-1', chain: { signature: '5sig', state, error } },
  })
}

describe('dflow execution helpers', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://platform.example.com'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'test-instance'
    delete process.env.SOLANA_RPC_URL
  })

  it('routes quote, positions, priority fees, and Metadata API through the platform', async () => {
    const calls: Array<{ url: URL; init?: RequestInit; body?: unknown }> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString())
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, init, body })
        if (url.pathname.endsWith('/dflow/quote')) {
          return jsonResponse({ ok: true, data: { inAmount: '1', outAmount: '2' } })
        }
        if (url.pathname.endsWith('/dflow/positions')) {
          return jsonResponse({ ok: true, data: { wallet: SOLANA_ADDRESS, tokens: [] } })
        }
        if (url.pathname.endsWith('/dflow/priority-fees')) {
          return jsonResponse({ ok: true, data: { high: 1000 } })
        }
        if (url.pathname.endsWith('/dflow/metadata/markets')) {
          return jsonResponse({ ok: true, data: { markets: [] } })
        }
        if (url.pathname.endsWith('/dflow/metadata/filter_outcome_mints')) {
          return jsonResponse({ ok: true, data: { outcomeMints: [] } })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    await dflowQuote({ inputMint: 'input', outputMint: 'output', amount: '1' })
    await dflowPositions()
    await dflowPriorityFees()
    await dflowMetadata({ path: '/api/v1/markets', queryJson: '{"status":"active"}' })
    await dflowMetadata({
      path: 'filter_outcome_mints',
      bodyJson: `{"addresses":["${SOLANA_ADDRESS}"]}`,
    })

    expect(calls).toHaveLength(5)
    expect(calls[0].body).toEqual({ inputMint: 'input', outputMint: 'output', amount: '1' })
    expect(calls[3].url.searchParams.get('status')).toBe('active')
    expect(calls[4].body).toEqual({ addresses: [SOLANA_ADDRESS] })
    for (const call of calls) {
      expect(call.url.origin).toBe('https://platform.example.com')
      expect(call.init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
      expect(call.init?.headers).not.toHaveProperty('x-api-key')
    }
  })

  it('reads DFlow market events from the platform SSE proxy', async () => {
    const encoder = new TextEncoder()
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: connected\ndata: {"channel":"prices"}\n\n' +
              'event: message\ndata: {"ticker":"KXTEST","yes_bid":"0.4000"}\n\n',
          ),
        )
        controller.close()
      },
    })
    const fetchMock = vi.fn(
      async () =>
        new Response(responseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    )
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowStream({ channel: 'prices', tickers: 'KXTEST', maxEvents: 1 }),
    ).resolves.toMatchObject({
      type: 'dflow-stream',
      transport: 'platform',
      eventCount: 1,
      events: [{ ticker: 'KXTEST', yes_bid: '0.4000' }],
    })
    const [input, init] = fetchMock.mock.calls[0]
    expect(String(input)).toContain('/dflow/stream?channel=prices&tickers=KXTEST')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    expect(init?.headers).not.toHaveProperty('x-api-key')
  })

  afterEach(() => {
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
    delete process.env.SOLANA_RPC_URL
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    })
  })

  it('creates a DFlow order using the purr Solana address', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, body })

        if (url.endsWith('/wallet/ensure')) {
          expect(body).toEqual({ chainType: 'solana' })
          return jsonResponse({
            ok: true,
            data: { address: SOLANA_ADDRESS, chainId: 0, chainType: 'solana' },
          })
        }
        if (url.endsWith('/v1/instances/test-instance/dflow/order')) {
          expect(init?.method).toBe('POST')
          expect(init?.headers).toMatchObject({
            Authorization: 'Bearer test-token',
          })
          expect(init?.headers).not.toHaveProperty('x-api-key')
          expect(body).toEqual({
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            amount: '1000000',
            options: { slippageBps: 'auto' },
          })
          return jsonResponse({
            ok: true,
            data: {
              inAmount: '1000000',
              outAmount: '24000000',
              slippageBps: 'auto',
              transaction: 'base64-preview-transaction',
              lastValidBlockHeight: 12345,
            },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
      configurable: true,
      writable: true,
    })

    const result = await dflowOrder({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000',
      paramsJson: JSON.stringify({ slippageBps: 'auto' }),
    })

    expect(result).toMatchObject({
      type: 'dflow-order',
      userPublicKey: SOLANA_ADDRESS,
      transport: 'platform',
      platformApiBaseUrl: 'https://platform.example.com',
      summary: {
        inAmount: '1000000',
        outAmount: '24000000',
        slippageBps: 'auto',
        hasTransaction: true,
      },
    })
    expect(calls.map((c) => c.url)).toHaveLength(2)
  })

  it('rejects explicit dynamic compute flags before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ dynamicComputeUnitLimit: false }),
      }),
    ).rejects.toThrow(/dynamicComputeUnitLimit is not supported in --params-json/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects sponsor parameters before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ sponsor: SOLANA_ADDRESS }),
      }),
    ).rejects.toThrow(/one signer only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects reserved DFlow order parameters before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ userPublicKey: OTHER_SOLANA_ADDRESS }),
      }),
    ).rejects.toThrow(/userPublicKey is managed by purr/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects response-only DFlow order parameters before resolving the wallet', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    await expect(
      dflowOrder({
        inputMint: 'input',
        outputMint: 'output',
        amount: '1',
        paramsJson: JSON.stringify({ computeUnitLimit: 400000 }),
      }),
    ).rejects.toThrow(/response field/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('executes through the platform with the order request, its minimum and an idempotency key', async () => {
    const calls = mockPlatform({
      [EXECUTE_PATH]: () => submitted(),
      [EXECUTION_PATH]: () => execution('confirmed'),
    })

    const result = await dflowExecuteOrder({ orderJson: JSON.stringify(ORDER_OUTPUT) })

    const execute = calls.find((call) => call.url.endsWith(EXECUTE_PATH))
    expect(execute).toMatchObject({
      method: 'POST',
      body: { ...REQUEST, minimumToAmount: '23880000' },
      headers: { Authorization: 'Bearer test-token' },
    })
    const idempotencyKey = (execute?.headers as Record<string, string>)['Idempotency-Key']
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([EXECUTE_PATH, EXECUTION_PATH])
    expect(result).toEqual({
      type: 'dflow-execute-order',
      requestId: 'request-1',
      idempotencyKey,
      minimumToAmount: '23880000',
      state: 'submitted',
      executionMode: 'sync',
      signature: '5sig',
      lastValidBlockHeight: 999,
      orderAddress: undefined,
      confirmation: { state: 'confirmed', confirmed: true },
    })
  })

  it('waits for the submitted signature to confirm', async () => {
    const states = ['processed', 'unknown', 'finalized']
    const calls = mockPlatform({
      [EXECUTE_PATH]: () => submitted(),
      [EXECUTION_PATH]: () => execution(states.shift() ?? 'finalized'),
    })

    const result = await dflowExecuteOrder({
      orderJson: JSON.stringify(ORDER_OUTPUT),
      pollIntervalMs: 1,
    })

    expect(calls.filter((call) => call.url.endsWith(EXECUTION_PATH))).toHaveLength(3)
    expect(result.confirmation).toEqual({ state: 'finalized', confirmed: true })
  })

  it('reports a reverted transaction with its request and signature', async () => {
    mockPlatform({
      [EXECUTE_PATH]: () => submitted(),
      [EXECUTION_PATH]: () => execution('reverted', { InstructionError: [2, 'Custom'] }),
    })

    const error = await dflowExecuteOrder({
      orderJson: JSON.stringify(ORDER_OUTPUT),
      idempotencyKey: 'swap-1',
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DflowCliError)
    expect(error).toMatchObject({
      code: 'DFLOW_TRANSACTION_REVERTED',
      data: {
        requestId: 'request-1',
        idempotencyKey: 'swap-1',
        signature: '5sig',
        error: { InstructionError: [2, 'Custom'] },
      },
    })
  })

  it('polls an async order after confirmation and keeps the signature when that fails', async () => {
    mockPlatform({
      [EXECUTE_PATH]: () => submitted({ executionMode: 'async' }),
      [EXECUTION_PATH]: () => execution('confirmed'),
      '/v1/instances/test-instance/dflow/order-status': () =>
        jsonResponse({ ok: true, data: { status: 'closed', signature: '5sig' } }),
    })
    const polled = await dflowExecuteOrder({ orderJson: JSON.stringify(ORDER_OUTPUT), poll: true })
    expect(polled).toMatchObject({
      executionMode: 'async',
      signature: '5sig',
      status: { signature: '5sig', terminal: true, status: { status: 'closed' } },
    })

    mockPlatform({
      [EXECUTE_PATH]: () => submitted({ executionMode: 'async' }),
      [EXECUTION_PATH]: () => execution('confirmed'),
      '/v1/instances/test-instance/dflow/order-status': () =>
        jsonErrorResponse(500, { ok: false, error: 'status unavailable' }),
    })
    const failed = await dflowExecuteOrder({ orderJson: JSON.stringify(ORDER_OUTPUT), poll: true })
    expect(failed).toMatchObject({
      signature: '5sig',
      confirmation: { state: 'confirmed', confirmed: true },
      statusError: { message: 'status unavailable', status: 500 },
    })
  })

  it('does not query order status for a synchronous order', async () => {
    const calls = mockPlatform({
      [EXECUTE_PATH]: () => submitted(),
      [EXECUTION_PATH]: () => execution('confirmed'),
    })
    await dflowExecuteOrder({ orderJson: JSON.stringify(ORDER_OUTPUT), poll: true })
    expect(calls.some((call) => call.url.includes('/order-status'))).toBe(false)
  })

  it('returns an unsubmitted execution without waiting for a signature', async () => {
    const calls = mockPlatform({
      [EXECUTE_PATH]: () =>
        jsonResponse({
          ok: true,
          data: { requestId: 'request-1', result: { state: 'awaiting_approval' } },
        }),
    })
    const result = await dflowExecuteOrder({ orderJson: JSON.stringify(ORDER_OUTPUT) })
    expect(result).toMatchObject({ requestId: 'request-1', state: 'awaiting_approval' })
    expect(result).not.toHaveProperty('confirmation')
    expect(calls).toHaveLength(1)
  })

  it('keeps the idempotency key and request on a failed execute so it can be replayed', async () => {
    mockPlatform({
      [EXECUTE_PATH]: () =>
        jsonErrorResponse(502, {
          ok: false,
          code: 'EXECUTION_INTERRUPTED',
          error: 'The execution outcome is unknown',
          data: { requestId: 'request-1', causeCode: 'WALLET_SEND_OUTCOME_UNKNOWN' },
        }),
    })

    const error = await dflowExecuteOrder({
      orderJson: JSON.stringify(ORDER_OUTPUT),
      idempotencyKey: 'swap-1',
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DflowCliError)
    expect(error).toMatchObject({
      code: 'EXECUTION_INTERRUPTED',
      status: 502,
      data: {
        idempotencyKey: 'swap-1',
        requestId: 'request-1',
        causeCode: 'WALLET_SEND_OUTCOME_UNKNOWN',
      },
    })
  })

  it('uses an explicit minimum and idempotency key', async () => {
    const calls = mockPlatform({
      [EXECUTE_PATH]: () => submitted(),
      [EXECUTION_PATH]: () => execution('confirmed'),
    })
    await dflowExecuteOrder({
      orderJson: JSON.stringify(ORDER_OUTPUT),
      minimumToAmount: '23000000',
      idempotencyKey: 'swap-1',
    })
    expect(calls[0]).toMatchObject({
      body: { minimumToAmount: '23000000' },
      headers: { 'Idempotency-Key': 'swap-1' },
    })
  })

  it('rejects unusable execution input before calling the platform', async () => {
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })
    const cases: Array<[Parameters<typeof dflowExecuteOrder>[0], string]> = [
      [{ orderJson: JSON.stringify(ORDER_OUTPUT.order) }, 'execute-order needs the JSON printed'],
      [
        {
          orderJson: JSON.stringify({
            ...ORDER_OUTPUT,
            order: { ...ORDER_OUTPUT.order, inAmount: '5' },
          }),
        },
        'DFlow order inAmount does not match its request amount',
      ],
      [
        {
          orderJson: JSON.stringify({
            ...ORDER_OUTPUT,
            order: { ...ORDER_OUTPUT.order, minOutAmount: undefined },
          }),
        },
        'pass --minimum-to-amount',
      ],
      [
        { orderJson: JSON.stringify(ORDER_OUTPUT), minimumToAmount: '0' },
        '--minimum-to-amount must be a positive integer',
      ],
      [
        { orderJson: JSON.stringify(ORDER_OUTPUT), idempotencyKey: 'has space' },
        '--idempotency-key must be',
      ],
      [
        {
          orderJson: JSON.stringify({
            ...ORDER_OUTPUT,
            request: { ...REQUEST, options: { sponsor: 'x' } },
          }),
        },
        'DFlow sponsor is out of scope',
      ],
      [{ orderJson: JSON.stringify(ORDER_OUTPUT), pollTimeoutMs: 0 }, '--poll-timeout-ms'],
    ]
    for (const [args, message] of cases) {
      await expect(dflowExecuteOrder(args)).rejects.toThrow(message)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads a platform execution by request id', async () => {
    mockPlatform({ [EXECUTION_PATH]: () => execution('finalized') })
    await expect(dflowExecutionStatus({ requestId: 'request-1' })).resolves.toEqual({
      type: 'dflow-execution-status',
      requestId: 'request-1',
      execution: {
        requestId: 'request-1',
        chain: { signature: '5sig', state: 'finalized', error: null },
      },
    })
  })

  it('checks DFlow prediction order status by transaction signature', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const parsed = new URL(url)
        expect(parsed.origin).toBe('https://platform.example.com')
        expect(parsed.pathname).toBe('/v1/instances/test-instance/dflow/order-status')
        expect(parsed.searchParams.get('signature')).toBe('transaction-signature-1')
        expect(parsed.searchParams.get('lastValidBlockHeight')).toBe('12345')
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
        expect(init?.headers).not.toHaveProperty('x-api-key')
        return jsonResponse({
          ok: true,
          data: { status: 'closed', signature: 'transaction-signature-1' },
        })
      }),
      configurable: true,
      writable: true,
    })

    await expect(
      dflowPredictionOrderStatus({
        signature: 'transaction-signature-1',
        lastValidBlockHeight: '12345',
      }),
    ).resolves.toMatchObject({
      type: 'dflow-prediction-order-status',
      signature: 'transaction-signature-1',
      terminal: true,
      status: { status: 'closed' },
    })
  })

  it('honors the platform Retry-After header while polling order status', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonErrorResponse(
          429,
          {
            ok: false,
            code: 'dflow_rate_limited',
            error: 'DFlow rate limit exceeded.',
            retryable: true,
            retryAfterSeconds: 1,
          },
          { 'Retry-After': '1' },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: { status: 'closed', signature: 'transaction-signature-1' },
        }),
      )
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    })

    const statusPromise = dflowPredictionOrderStatus({
      signature: 'transaction-signature-1',
      poll: true,
      timeoutMs: 5_000,
      intervalMs: 50,
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(statusPromise).resolves.toMatchObject({
      type: 'dflow-prediction-order-status',
      terminal: true,
      status: { status: 'closed' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
