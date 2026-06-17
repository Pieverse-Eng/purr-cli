import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPieIdentityProfile,
  listPieIdentityAccounts,
  lookupPieIdentityByAccount,
  pnsAccounts,
  pnsByAccount,
  pnsProfile,
  pnsResolve,
  resolvePieName,
} from '@pieverseio/purr-plugin-pns/resolve'
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

  it('looks up a .pie identity by paired account through the scoped platform route', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const mock = mockFetch({
      ok: true,
      data: {
        pieName: 'alice.pie',
      },
    })
    vi.stubGlobal('fetch', mock)

    const resolved = await lookupPieIdentityByAccount({
      channel: 'telegram',
      account: '@Alice',
    })

    expect(resolved).toEqual({ pieName: 'alice.pie' })
    expect(mock).toHaveBeenCalledOnce()
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v2/instances/inst-123/pie-identities/by-account?channel=telegram&account=%40Alice',
    )
    expect(mock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token')
  })

  it('requires instance credentials for scoped .pie identity endpoints', async () => {
    process.env.INSTANCE_ID = ''
    const mock = mockFetch({
      ok: true,
      data: { pieName: 'alice.pie' },
    })
    vi.stubGlobal('fetch', mock)

    await expect(
      lookupPieIdentityByAccount({ channel: 'line', account: 'line-user' }),
    ).rejects.toThrow('INSTANCE_ID env var or instance-id config')
    expect(mock).not.toHaveBeenCalled()
  })

  it('prints only the resolved pie name for by-account lookups', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const mock = mockFetch({
      ok: true,
      data: {
        pieName: 'alice.pie',
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await pnsByAccount({ channel: 'line', account: 'line-user' })

    expect(log).toHaveBeenCalledWith('alice.pie')
  })

  it('prints nothing for by-account lookups without a pairing', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const mock = mockFetch({
      ok: true,
      data: {
        pieName: null,
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await pnsByAccount({ channel: 'kakao', account: 'missing-user' })

    expect(log).not.toHaveBeenCalled()
  })

  it('rejects invalid by-account channels before calling the platform', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const mock = mockFetch({
      ok: true,
      data: {
        pieName: 'alice.pie',
      },
    })
    vi.stubGlobal('fetch', mock)

    await expect(pnsByAccount({ channel: 'wechat', account: 'alice' })).rejects.toThrow(
      'Invalid --channel: wechat. Use: telegram, line, kakao',
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('lists paired accounts for a .pie identity', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const mock = mockFetch({
      ok: true,
      data: {
        accounts: [
          { channel: 'telegram', accountId: '123', username: 'alice' },
          { channel: 'line', accountId: 'line-user', username: 'Line Alice' },
        ],
      },
    })
    vi.stubGlobal('fetch', mock)

    const result = await listPieIdentityAccounts('alice.pie')

    expect(result.accounts).toHaveLength(2)
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v2/instances/inst-123/pie-identities/alice.pie/accounts',
    )
  })

  it('prints paired accounts as pretty JSON', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const mock = mockFetch({
      ok: true,
      data: {
        accounts: [{ channel: 'telegram', accountId: '123', username: 'alice' }],
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    await pnsAccounts('alice')

    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        { accounts: [{ channel: 'telegram', accountId: '123', username: 'alice' }] },
        null,
        2,
      ),
    )
  })

  it('gets and prints a .pie identity profile as pretty JSON', async () => {
    process.env.INSTANCE_ID = 'inst-123'
    const profile = {
      pieName: 'alice.pie',
      agentType: 'hosted',
      runtimeType: 'hermes',
      walletAddress: '0x1234567890123456789012345678901234567890',
      active: true,
      gatewayStatus: 'running',
      merchant: {
        enabled: false,
        useUpstreamSkill: false,
        agentCard: null,
        agentCardStatus: 'not_enabled',
      },
    }
    const mock = mockFetch({
      ok: true,
      data: profile,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', mock)

    const resolved = await getPieIdentityProfile('alice.pie')
    await pnsProfile('alice.pie')

    expect(resolved).toEqual(profile)
    expect(mock.mock.calls[0][0]).toBe(
      'https://api.test/v2/instances/inst-123/pie-identities/alice.pie/profile',
    )
    expect(log).toHaveBeenCalledWith(JSON.stringify(profile, null, 2))
  })
})
