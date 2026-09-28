import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { walletAddress } from '@pieverseio/purr-plugin-wallet/address'
import { walletBalance } from '@pieverseio/purr-plugin-wallet/balance'
import { walletSign } from '@pieverseio/purr-plugin-wallet/sign'
import { SUI_USDC_COIN_TYPE } from '@pieverseio/purr-plugin-wallet/sui'
import { walletSuiExecute } from '@pieverseio/purr-plugin-wallet/sui-execute'
import { walletSuiSwap } from '@pieverseio/purr-plugin-wallet/sui-swap'
import { executeWalletTransfer } from '@pieverseio/purr-plugin-wallet/transfer'
import { mockFetch } from '../../helpers.js'

const RECIPIENT = `0x${'22'.repeat(32)}`
const CETUS = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS'

function printed(): unknown {
  const log = console.log as unknown as { mock: { calls: string[][] } }
  return JSON.parse(log.mock.calls.at(-1)![0])
}

const EXECUTED_SWAP = {
  hash: 'digest',
  from: RECIPIENT,
  chainId: 0,
  chainType: 'sui',
  caip2: 'sui:mainnet',
  transactionId: 'digest',
  operationId: 'op-1',
  replayed: false,
  status: 'confirmed',
  explorerUrl: 'https://suiscan.xyz/mainnet/tx/digest',
  fromCoin: { coinType: '0x2::sui::SUI', symbol: 'SUI', decimals: 9 },
  toCoin: { coinType: SUI_USDC_COIN_TYPE, symbol: 'USDC', decimals: 6 },
  amountIn: '0.02',
  amountInBaseUnits: '20000000',
  amountOut: '0.024252',
  amountOutBaseUnits: '24252',
  gasUsedSui: '0.001617872',
  minAmountOutBaseUnits: '24130',
}

function request(mock: ReturnType<typeof mockFetch>) {
  const [url, init] = mock.mock.calls[0]
  return {
    url: String(url),
    body: init.body ? JSON.parse(init.body) : undefined,
    headers: init.headers as Record<string, string>,
  }
}

describe('Sui wallet commands', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'inst-123'
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
  })

  describe('transfer', () => {
    it.each([
      [undefined, { assetType: 'native' }],
      ['SUI', { assetType: 'native' }],
      ['0x2::sui::SUI', { assetType: 'native' }],
      ['usdc', { assetType: 'sui_coin', tokenAddress: SUI_USDC_COIN_TYPE }],
      [CETUS, { assetType: 'sui_coin', tokenAddress: CETUS }],
    ])('sends %s on the named network with an Idempotency-Key', async (token, asset) => {
      const mock = mockFetch({ ok: true, data: { hash: 'digest' } })
      vi.stubGlobal('fetch', mock)
      await executeWalletTransfer({
        'chain-type': 'sui',
        to: RECIPIENT,
        amount: '0.5',
        ...(token ? { token } : {}),
      })
      const { url, body, headers } = request(mock)
      expect(url).toBe('https://api.test/v1/instances/inst-123/wallet/transfer')
      expect(body).toEqual({
        chainType: 'sui',
        caip2: 'sui:mainnet',
        to: RECIPIENT,
        amount: '0.5',
        ...asset,
      })
      expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('reuses the caller key so an unresolved send can be retried safely', async () => {
      const mock = mockFetch({ ok: true, data: {} })
      vi.stubGlobal('fetch', mock)
      await executeWalletTransfer({
        chain: 'sui',
        to: RECIPIENT,
        amount: '1',
        'idempotency-key': 'b0f6b9a4-2f3e-4a52-9a0c-7c1f2d3e4f50',
      })
      expect(request(mock).headers['Idempotency-Key']).toBe('b0f6b9a4-2f3e-4a52-9a0c-7c1f2d3e4f50')
    })

    it('refuses EVM-only options and unknown coins before calling the platform', async () => {
      const mock = mockFetch({ ok: true, data: {} })
      vi.stubGlobal('fetch', mock)
      const base = { 'chain-type': 'sui', to: RECIPIENT, amount: '1' }
      await expect(executeWalletTransfer({ ...base, decimals: '6' })).rejects.toThrow('--decimals')
      await expect(executeWalletTransfer({ ...base, token: 'DOGE' })).rejects.toThrow(
        'Unknown Sui coin',
      )
      expect(mock).not.toHaveBeenCalled()
    })

    it('keeps the approval request id of a policy deferral', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch(
          {
            ok: false,
            code: 'POLICY_DEFERRED',
            reason: 'manual_approval_required',
            requestId: 'policy-child:wallet-transaction:7:key',
          },
          202,
        ),
      )
      await expect(
        executeWalletTransfer({
          'chain-type': 'sui',
          to: RECIPIENT,
          amount: '1',
          'idempotency-key': 'resume-me',
        }),
      ).rejects.toThrow(
        /POLICY_DEFERRED.*policy-child:wallet-transaction:7:key.*"idempotencyKey":"resume-me"/,
      )
    })
  })

  describe('balance', () => {
    it.each([
      [undefined, 'balance=true&chain_type=sui&caip2=sui%3Amainnet'],
      [
        'USDC',
        `balance=true&chain_type=sui&caip2=sui%3Amainnet&token=${encodeURIComponent(SUI_USDC_COIN_TYPE)}`,
      ],
    ])('queries %s by network', async (token, query) => {
      const mock = mockFetch({ ok: true, data: { balance: '1' } })
      vi.stubGlobal('fetch', mock)
      await walletBalance({ 'chain-type': 'sui', ...(token ? { token } : {}) })
      expect(request(mock).url).toBe(`https://api.test/v1/instances/inst-123/wallet?${query}`)
    })
  })

  it('names the network when signing a Sui personal message', async () => {
    const mock = mockFetch({ ok: true, data: { signature: 'sig' } })
    vi.stubGlobal('fetch', mock)
    await walletSign({ 'chain-type': 'sui', address: RECIPIENT, message: 'hello' })
    expect(request(mock).body).toEqual({ message: 'hello', chainType: 'sui', caip2: 'sui:mainnet' })
  })

  describe('sui-swap', () => {
    it('quotes without an Idempotency-Key', async () => {
      const mock = mockFetch({ ok: true, data: { estimatedAmountOut: '0.12' } })
      vi.stubGlobal('fetch', mock)
      await walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.1', slippage: '1' })
      const { url, body, headers } = request(mock)
      expect(url).toBe('https://api.test/v1/instances/inst-123/wallet/swap/quote')
      expect(body).toEqual({
        chainType: 'sui',
        caip2: 'sui:mainnet',
        fromCoin: 'SUI',
        toCoin: 'USDC',
        amount: '0.1',
        slippageBps: 100,
      })
      expect(headers['Idempotency-Key']).toBeUndefined()
    })

    it('executes with the accepted minimum and an Idempotency-Key', async () => {
      const mock = mockFetch({ ok: true, data: { hash: 'digest', amountOut: '0.12' } })
      vi.stubGlobal('fetch', mock)
      await walletSuiSwap({
        from: 'SUI',
        to: 'USDC',
        amount: '0.1',
        'min-amount-out': '120000',
        execute: 'true',
      })
      const { url, body, headers } = request(mock)
      expect(url).toBe('https://api.test/v1/instances/inst-123/wallet/swap/execute')
      expect(body).toMatchObject({ minAmountOutBaseUnits: '120000' })
      expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it.each([
      ['0.25', 25],
      ['0.5', 50],
      ['50', 5000],
    ])('converts --slippage %s%% to %i basis points', async (slippage, bps) => {
      const mock = mockFetch({ ok: true, data: {} })
      vi.stubGlobal('fetch', mock)
      await walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.1', slippage })
      expect(request(mock).body.slippageBps).toBe(bps)
    })

    it.each([['0'], ['51'], ['0.125'], ['abc']])('rejects --slippage %s', async (slippage) => {
      await expect(
        walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.1', slippage }),
      ).rejects.toThrow('--slippage')
    })

    it('points --slippage-bps callers to the percentage flag', async () => {
      await expect(
        walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.1', 'slippage-bps': '100' }),
      ).rejects.toThrow('--slippage as a percentage')
    })

    it('rejects a decimal minimum, which must be in base units', async () => {
      await expect(
        walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.1', 'min-amount-out': '0.12' }),
      ).rejects.toThrow('base units')
    })
  })

  it('executes caller-built TransactionData on the named network', async () => {
    const mock = mockFetch({ ok: true, data: { hash: 'digest' } })
    vi.stubGlobal('fetch', mock)
    await walletSuiExecute({ 'tx-bytes': 'AAAA' })
    const { url, body, headers } = request(mock)
    expect(url).toBe('https://api.test/v1/instances/inst-123/wallet/execute')
    expect(body).toEqual({ chainType: 'sui', caip2: 'sui:mainnet', transaction: 'AAAA' })
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  describe('output shapes', () => {
    it('prints a confirmed swap like wallet uniswap results', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: true, data: EXECUTED_SWAP }))
      await walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.02', execute: 'true' })
      expect(printed()).toEqual({
        hash: 'digest',
        explorerUrl: 'https://suiscan.xyz/mainnet/tx/digest',
        status: 'confirmed',
        operationId: 'op-1',
        replayed: false,
        input: { coinType: '0x2::sui::SUI', symbol: 'SUI', amount: '0.02' },
        output: { coinType: SUI_USDC_COIN_TYPE, symbol: 'USDC', amount: '0.024252' },
        gas: { amount: '0.001617872', symbol: 'SUI' },
      })
    })

    it('omits an actual output the fullnode has not reported yet', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: true, data: { ...EXECUTED_SWAP, amountOut: null } }))
      await walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.02', execute: 'true' })
      expect((printed() as { output: unknown }).output).toEqual({
        coinType: SUI_USDC_COIN_TYPE,
        symbol: 'USDC',
      })
    })

    it('keeps the quote whole, including the base-unit floor for --min-amount-out', async () => {
      const quote = { minAmountOut: '0.02413', minAmountOutBaseUnits: '24130' }
      vi.stubGlobal('fetch', mockFetch({ ok: true, data: quote }))
      await walletSuiSwap({ from: 'SUI', to: 'USDC', amount: '0.02' })
      expect(printed()).toEqual(quote)
    })

    it('drops chainId, transactionId and row ids from Sui results only', async () => {
      const row = { id: 'row', chainId: 0, chainType: 'sui', address: RECIPIENT }
      vi.stubGlobal(
        'fetch',
        mockFetch({ ok: true, data: { ...row, transactionId: 'd', hash: 'd' } }),
      )
      await expect(
        executeWalletTransfer({ 'chain-type': 'sui', to: RECIPIENT, amount: '1' }),
      ).resolves.toEqual({ chainType: 'sui', address: RECIPIENT, hash: 'd' })

      vi.stubGlobal('fetch', mockFetch({ ok: true, data: row }))
      await walletBalance({ 'chain-type': 'sui' })
      expect(printed()).toEqual({ chainType: 'sui', address: RECIPIENT })
      await walletAddress({ 'chain-type': 'sui' })
      expect(printed()).toEqual({ chainType: 'sui', address: RECIPIENT })

      const evm = { id: 'row', chainId: 8453, chainType: 'ethereum', address: '0xabc' }
      vi.stubGlobal('fetch', mockFetch({ ok: true, data: evm }))
      await walletBalance({ 'chain-type': 'ethereum', 'chain-id': '8453' })
      expect(printed()).toEqual(evm)
    })
  })
})
