import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pnsResolve, resolvePieName } from '@pieverseio/purr-plugin-pns/resolve'
import { mockFetch } from '../../helpers.js'

describe('pns resolve', () => {
  beforeEach(() => {
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'test-token'
    delete process.env.INSTANCE_ID
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
  })

  it('resolves a .pie name through the platform /v2 handle route without instance credentials', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        kind: 'handle',
        handle: 'alice',
        renderedHandle: 'alice.pie',
        walletAddress: '0x1234567890123456789012345678901234567890',
      },
    })
    vi.stubGlobal('fetch', mock)

    const resolved = await resolvePieName('alice.pie')

    expect(resolved.walletAddress).toBe('0x1234567890123456789012345678901234567890')
    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe('https://api.test/v2/handles/alice.pie')
    expect(mock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token')
  })

  it('accepts bare handles like the platform /v2 handle route', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        kind: 'handle',
        handle: 'alice',
        renderedHandle: 'alice.pie',
        walletAddress: '0x1234567890123456789012345678901234567890',
      },
    })
    vi.stubGlobal('fetch', mock)

    await resolvePieName('alice')

    expect(mock.mock.calls[0][0]).toBe('https://api.test/v2/handles/alice')
  })

  it('prints only the resolved wallet address', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        kind: 'handle',
        handle: 'alice',
        renderedHandle: 'alice.pie',
        walletAddress: '0x1234567890123456789012345678901234567890',
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await pnsResolve('alice.pie')

    expect(log).toHaveBeenCalledWith('0x1234567890123456789012345678901234567890')
  })

  it('uses the single purr pns resolve positional handle format', async () => {
    const mock = mockFetch({
      ok: true,
      data: {
        kind: 'handle',
        handle: 'alice',
        renderedHandle: 'alice.pie',
        walletAddress: '0x1234567890123456789012345678901234567890',
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await pnsResolve('alice')

    expect(log).toHaveBeenCalledWith('0x1234567890123456789012345678901234567890')
  })

  it('requires a PNS handle input', async () => {
    await expect(pnsResolve()).rejects.toThrow('Usage: purr pns resolve <handle>')
  })
})
