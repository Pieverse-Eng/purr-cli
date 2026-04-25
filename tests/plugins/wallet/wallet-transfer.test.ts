import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { walletTransfer } from '@pieverseio/purr-plugin-wallet/transfer'
import { mockFetch } from '../../helpers.js'

describe('walletTransfer', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'inst-123'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
  })

  // ── Validation ──

  it('throws when --to is missing', async () => {
    await expect(walletTransfer({ amount: '1', 'chain-id': '56' })).rejects.toThrow('--to')
  })

  it('throws when --amount is missing', async () => {
    await expect(walletTransfer({ to: '0xABC', 'chain-id': '56' })).rejects.toThrow('--amount')
  })

  it('throws when --chain-id is missing for EVM (default chain-type)', async () => {
    await expect(walletTransfer({ to: '0xABC', amount: '1' })).rejects.toThrow('--chain-id')
  })

  it('does not throw when --chain-id is missing for Solana', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: 'A',
        to: 'B',
        amount: '1',
        hash: 'tx',
        chainType: 'solana',
        assetType: 'native',
      },
    })
    vi.stubGlobal('fetch', mock)
    await expect(
      walletTransfer({
        to: 'FuQPd1qZaexnx88CCL3mrr4d6o8LUCWA8WCkSvv86nYc',
        amount: '0.5',
        'chain-type': 'solana',
      }),
    ).resolves.toBeUndefined()
  })

  // ── EVM native transfer ──

  it('sends EVM native transfer with correct body', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: '0x1',
        to: '0x2',
        amount: '0.01',
        hash: '0xabc',
        chainId: 56,
        chainType: 'ethereum',
        assetType: 'native',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({ to: '0x2', amount: '0.01', 'chain-id': '56' })

    expect(mock).toHaveBeenCalledOnce()
    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body).toEqual({
      to: '0x2',
      amount: '0.01',
      chainType: 'ethereum',
      chainId: 56,
      assetType: 'native',
    })
  })

  // ── EVM ERC-20 transfer ──

  it('sends EVM ERC-20 transfer with assetType erc20', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: '0x1',
        to: '0x2',
        amount: '100',
        hash: '0xdef',
        chainId: 56,
        chainType: 'ethereum',
        assetType: 'erc20',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({
      to: '0x2',
      amount: '100',
      'chain-id': '56',
      token: '0x55d398326f99059fF775485246999027B3197955',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.assetType).toBe('erc20')
    expect(body.tokenAddress).toBe('0x55d398326f99059fF775485246999027B3197955')
    expect(body.chainType).toBe('ethereum')
  })

  // ── EVM with token ticker resolution ──

  it('resolves EVM token ticker to address', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: '0x1',
        to: '0x2',
        amount: '100',
        hash: '0xdef',
        chainId: 56,
        chainType: 'ethereum',
        assetType: 'erc20',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({ to: '0x2', amount: '100', 'chain-id': '56', token: 'USDT' })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.tokenAddress).toBe('0x55d398326f99059fF775485246999027B3197955')
  })

  // ── Solana native transfer ──

  it('sends Solana native transfer without chain-id', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: 'A1',
        to: 'B2',
        amount: '0.5',
        hash: 'txhash',
        chainType: 'solana',
        assetType: 'native',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({
      to: 'FuQPd1qZaexnx88CCL3mrr4d6o8LUCWA8WCkSvv86nYc',
      amount: '0.5',
      'chain-type': 'solana',
    })

    expect(mock).toHaveBeenCalledOnce()
    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body).toEqual({
      to: 'FuQPd1qZaexnx88CCL3mrr4d6o8LUCWA8WCkSvv86nYc',
      amount: '0.5',
      chainType: 'solana',
      assetType: 'native',
    })
    expect(body.chainId).toBeUndefined()
  })

  // ── Solana SPL transfer ──

  it('sends Solana SPL transfer with assetType spl', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: 'A1',
        to: 'B2',
        amount: '100',
        hash: 'txhash',
        chainType: 'solana',
        assetType: 'spl',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({
      to: 'FuQPd1qZaexnx88CCL3mrr4d6o8LUCWA8WCkSvv86nYc',
      amount: '100',
      'chain-type': 'solana',
      token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.assetType).toBe('spl')
    expect(body.tokenAddress).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(body.chainType).toBe('solana')
  })

  // ── Solana SPL with ticker resolution ──

  it('resolves Solana token ticker to mint address', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: 'A1',
        to: 'B2',
        amount: '100',
        hash: 'txhash',
        chainType: 'solana',
        assetType: 'spl',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({
      to: 'FuQPd1qZaexnx88CCL3mrr4d6o8LUCWA8WCkSvv86nYc',
      amount: '100',
      'chain-type': 'solana',
      token: 'USDC',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.tokenAddress).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  })

  // ── Optional decimals ──

  it('includes decimals when provided', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: 'A1',
        to: 'B2',
        amount: '100',
        hash: 'txhash',
        chainType: 'solana',
        assetType: 'spl',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({
      to: 'FuQPd1qZaexnx88CCL3mrr4d6o8LUCWA8WCkSvv86nYc',
      amount: '100',
      'chain-type': 'solana',
      token: 'USDC',
      decimals: '6',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.decimals).toBe(6)
  })

  // ── API error handling ──

  it('throws on API error response', async () => {
    const mock = mockFetch({ ok: false, error: 'Insufficient balance' })
    vi.stubGlobal('fetch', mock)

    await expect(walletTransfer({ to: '0x2', amount: '999', 'chain-id': '56' })).rejects.toThrow(
      'Insufficient balance',
    )
  })

  // ── API URL construction ──

  it('calls correct API endpoint with instance ID', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: '0x1',
        to: '0x2',
        amount: '1',
        hash: '0x',
        chainId: 56,
        chainType: 'ethereum',
        assetType: 'native',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({ to: '0x2', amount: '1', 'chain-id': '56' })

    const url = mock.mock.calls[0][0]
    expect(url).toBe('https://api.test/v1/instances/inst-123/wallet/transfer')
  })

  it('sends Authorization header', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        from: '0x1',
        to: '0x2',
        amount: '1',
        hash: '0x',
        chainId: 56,
        chainType: 'ethereum',
        assetType: 'native',
      },
    })
    vi.stubGlobal('fetch', mock)

    await walletTransfer({ to: '0x2', amount: '1', 'chain-id': '56' })

    const headers = mock.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer test-token')
  })
})
