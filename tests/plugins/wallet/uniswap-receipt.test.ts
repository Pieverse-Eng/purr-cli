import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex, pad } from 'viem'
import { walletUniswap } from '@pieverseio/purr-plugin-wallet/uniswap'

const HASH = `0x${'12'.repeat(32)}`
const OWNER = '0x6a3b6649a4c572e98e18bc8fabec0ac10d3d28e3'
const ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1'
const OUTPUT = '0x8e98a62a995a50eca9979bfa016f91bf36a8f9d9'
const USDC = '0x3600000000000000000000000000000000000000'
const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'
const INPUT = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const NATIVE = '0x0000000000000000000000000000000000000000'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function transfer(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: [TRANSFER, pad(from as `0x${string}`), pad(to as `0x${string}`)],
    data: toHex(amount, { size: 32 }),
  }
}
function receipt(logs = [transfer(OUTPUT, ROUTER, OWNER, 2556514112279151428756n)]) {
  return {
    transactionHash: HASH,
    from: OWNER,
    to: ROUTER,
    status: '0x1',
    blockNumber: '0x142fba0',
    gasUsed: '0x361f3',
    effectiveGasPrice: '0xdcd78840a',
    logs,
  }
}

describe('Uniswap automatic receipt confirmation', () => {
  beforeEach(() => {
    vi.stubEnv('WALLET_API_URL', 'https://api.test')
    vi.stubEnv('WALLET_API_TOKEN', 'private-wallet-token')
    vi.stubEnv('INSTANCE_ID', 'inst-123')
    vi.stubEnv('ARC_RPC_URL', 'https://arc.rpc.test')
    vi.stubEnv('ROBINHOOD_RPC_URL', 'https://robinhood.rpc.test')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function mockRpc(
    chainId: number,
    getReceipt: () => unknown = () => receipt(),
    options: {
      fromToken?: string
      toToken?: string
      metadataError?: boolean
      rpcChain?: number
      stallReceipt?: boolean
    } = {},
  ) {
    const mock = vi.fn(async (input: string | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = request.url
      const body = await request.json()
      if (url === 'https://api.test/v1/instances/inst-123/wallet/uniswap/execute') {
        return Response.json({
          ok: true,
          data: {
            mode: 'transaction',
            hash: HASH,
            chainId,
            from: OWNER,
            fromToken: options.fromToken ?? (chainId === 5042 ? USDC : INPUT),
            toToken: options.toToken ?? OUTPUT,
            estimatedToAmountFormatted: '1700',
          },
        })
      }
      expect(url).toBe(chainId === 5042 ? 'https://arc.rpc.test/' : 'https://robinhood.rpc.test/')
      expect(request.headers.has('authorization')).toBe(false)
      let result: unknown
      if (body.method === 'eth_chainId') result = toHex(options.rpcChain ?? chainId)
      else if (body.method === 'eth_getTransactionReceipt') {
        if (options.stallReceipt)
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          })
        result = getReceipt()
      } else if (body.method === 'eth_call') {
        if (options.metadataError)
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32000, message: 'archive unavailable' },
          })
        expect(body.params[1]).toBe('0x142fba0')
        result = toHex(body.params[0].to === INPUT ? 6 : 18, { size: 32 })
      } else throw new Error(`Unexpected RPC method: ${body.method}`)
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }
  const execute = (chainId = 5042, extra = {}) =>
    walletUniswap({
      from: chainId === 5042 ? 'USDC' : INPUT,
      to: OUTPUT,
      amount: '10',
      'chain-id': String(chainId),
      execute: 'true',
      ...extra,
    })
  const output = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]))
  const submissions = (mock: ReturnType<typeof mockRpc>) =>
    mock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/uniswap/execute'))

  it('returns exact Arc fills, de-duplicates matching USDC views, and keeps gas separate', async () => {
    const mock = mockRpc(5042, () =>
      receipt([
        transfer(SYSTEM, OWNER, ROUTER, 10n ** 19n),
        transfer(USDC, OWNER, ROUTER, 10000000n),
        transfer(OUTPUT, ROUTER, OWNER, 2556514112279151428756n),
        transfer(SYSTEM, ROUTER, OWNER, 10n ** 17n), // refund
        transfer(USDC, OWNER, ROUTER, 100000n), // unmatched transfer must survive
      ]),
    )
    await execute()
    expect(output()).toEqual({
      status: 'success',
      hash: HASH,
      chainId: 5042,
      explorerUrl: `https://arc.etherscan.io/tx/${HASH}`,
      input: { tokenAddress: 'native', symbol: 'USDC', amount: '10' },
      output: { tokenAddress: OUTPUT, amount: '2556.514112279151428756' },
      gas: { amount: '0.01314176776818675', symbol: 'USDC' },
    })
    expect(submissions(mock)).toHaveLength(1)
  })

  it('aggregates Robinhood ERC-20 refunds, ignores NFT logs, and uses the actual recipient', async () => {
    const nft = transfer(OUTPUT, ROUTER, OWNER, 999n)
    nft.topics.push(pad('0x01'))
    mockRpc(4663, () =>
      receipt([
        transfer(INPUT, OWNER, ROUTER, 10000000n),
        transfer(INPUT, ROUTER, OWNER, 1000000n),
        transfer(OUTPUT, ROUTER, USDC, 2222222222222222222n),
        nft,
        transfer(OUTPUT, USDC, USDC, 123n),
      ]),
    )
    await execute(4663, { recipient: USDC })
    expect(output()).toMatchObject({
      status: 'success',
      recipient: USDC,
      input: { amount: '9' },
      output: { amount: '2.222222222222222222' },
    })
  })

  it('silently omits unavailable native ETH input while keeping the confirmed token output', async () => {
    mockRpc(4663, () => receipt(), { fromToken: NATIVE })
    await execute(4663)
    expect(output()).toMatchObject({
      status: 'success',
      hash: HASH,
      output: { tokenAddress: OUTPUT, amount: '2556.514112279151428756' },
      gas: { symbol: 'ETH' },
    })
    expect(output()).not.toHaveProperty('input')
    expect(output()).not.toHaveProperty('warnings')
    expect(output()).not.toHaveProperty('estimatedToAmountFormatted')
  })

  it('silently omits unavailable native ETH output while keeping the confirmed token input', async () => {
    mockRpc(4663, () => receipt([transfer(INPUT, OWNER, ROUTER, 10000000n)]), {
      toToken: NATIVE,
    })
    await execute(4663, { to: 'ETH' })
    expect(output()).toMatchObject({
      status: 'success',
      input: { tokenAddress: INPUT, amount: '10' },
    })
    expect(output()).not.toHaveProperty('output')
    expect(output()).not.toHaveProperty('warnings')
  })

  it('omits only the unavailable amount when token metadata cannot be read', async () => {
    mockRpc(
      5042,
      () =>
        receipt([
          transfer(SYSTEM, OWNER, ROUTER, 10n ** 19n),
          transfer(OUTPUT, ROUTER, OWNER, 2556514112279151428756n),
        ]),
      { metadataError: true },
    )
    await execute()
    expect(output()).toMatchObject({
      status: 'success',
      input: { tokenAddress: 'native', symbol: 'USDC', amount: '10' },
    })
    expect(output()).not.toHaveProperty('output')
    expect(output()).not.toHaveProperty('warnings')
  })

  it('keeps the successful receipt even when neither amount has transfer evidence', async () => {
    mockRpc(4663, () => receipt([]))
    await execute(4663)
    expect(output()).toMatchObject({ status: 'success', hash: HASH, gas: { symbol: 'ETH' } })
    expect(output()).not.toHaveProperty('input')
    expect(output()).not.toHaveProperty('output')
    expect(output()).not.toHaveProperty('warnings')
  })

  it('retains warnings for transfers in the unexpected direction', async () => {
    mockRpc(4663, () => receipt([transfer(INPUT, ROUTER, OWNER, 10000000n)]))
    await execute(4663)
    expect(output()).toMatchObject({ status: 'success', hash: HASH })
    expect(output()).not.toHaveProperty('input')
    expect(output().warnings.join()).toContain('Unexpected transfer direction')
  })

  it('reports a reverted transaction with gas and no fills, without retrying execute', async () => {
    const mock = mockRpc(5042, () => ({ ...receipt(), status: '0x0' }))
    await execute()
    expect(output()).toMatchObject({
      status: 'reverted',
      gas: { symbol: 'USDC' },
    })
    expect(output()).not.toHaveProperty('input')
    expect(output()).not.toHaveProperty('output')
    expect(submissions(mock)).toHaveLength(1)
  })

  it('polls only receipts after a null response', async () => {
    vi.useFakeTimers()
    const next = vi.fn().mockReturnValueOnce(null).mockReturnValue(receipt())
    const mock = mockRpc(5042, next)
    const task = execute()
    await vi.advanceTimersByTimeAsync(2_001)
    await task
    expect(output().status).toBe('success')
    expect(next).toHaveBeenCalledTimes(2)
    expect(submissions(mock)).toHaveLength(1)
  })

  it('returns pending and the accepted hash at the deadline without another submission', async () => {
    vi.useFakeTimers()
    const mock = mockRpc(5042, () => null)
    const task = execute()
    await vi.advanceTimersByTimeAsync(60_001)
    await task
    expect(output()).toMatchObject({ hash: HASH, status: 'pending' })
    expect(submissions(mock)).toHaveLength(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(HASH))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the hash and redacts an RPC outage instead of reporting a failed swap', async () => {
    const mock = mockRpc(5042, () => {
      throw new Error('https://secret-rpc?key=private')
    })
    await execute()
    expect(output()).toMatchObject({ hash: HASH, status: 'unknown' })
    expect(JSON.stringify(output())).not.toContain('secret-rpc')
    expect(submissions(mock)).toHaveLength(1)
  })

  it('rejects a misconfigured RPC chain without reporting success', async () => {
    mockRpc(5042, () => receipt(), { rpcChain: 4663 })
    await execute()
    expect(output()).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('chain ID mismatch'),
    })
  })

  it('returns Arc USDC sale proceeds once in 18-decimal native units', async () => {
    mockRpc(
      5042,
      () =>
        receipt([
          transfer(OUTPUT, OWNER, ROUTER, 3n * 10n ** 18n),
          transfer(USDC, ROUTER, OWNER, 1500000n),
          transfer(SYSTEM, ROUTER, OWNER, 15n * 10n ** 17n),
        ]),
      { fromToken: OUTPUT, toToken: USDC },
    )
    await execute()
    expect(output()).toMatchObject({
      input: { tokenAddress: OUTPUT, amount: '3' },
      output: {
        tokenAddress: 'native',
        amount: '1.5',
        symbol: 'USDC',
      },
    })
  })

  it('rejects a receipt belonging to another transaction', async () => {
    mockRpc(5042, () => ({ ...receipt(), transactionHash: `0x${'34'.repeat(32)}` }))
    await execute()
    expect(output()).toMatchObject({ status: 'unknown', hash: HASH })
    expect(output().output).toBeUndefined()
  })

  it('aborts a stalled RPC read and keeps the accepted hash', async () => {
    vi.useFakeTimers()
    const mock = mockRpc(5042, () => receipt(), { stallReceipt: true })
    const task = execute()
    await vi.advanceTimersByTimeAsync(10_001)
    await task
    expect(output()).toMatchObject({ status: 'unknown', hash: HASH })
    expect(submissions(mock)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
