import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'
import { walletAbiCall } from '../wallet/abi-call.js'
import { mockFetch } from './helpers.js'

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'

const OK_RESPONSE = {
  ok: true,
  data: {
    hash: '0xabc',
    from: '0xInstanceWallet',
    chainId: 2818,
    chainType: 'ethereum',
    transactionId: 'privy-tx-1',
  },
}

describe('walletAbiCall', () => {
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

  // ── Argument validation ──

  it('throws when --to is missing', async () => {
    await expect(
      walletAbiCall({ signature: 'register()', args: '[]', 'chain-id': '2818' }),
    ).rejects.toThrow('--to')
  })

  it('throws when --signature is missing', async () => {
    await expect(
      walletAbiCall({ to: IDENTITY_REGISTRY, args: '[]', 'chain-id': '2818' }),
    ).rejects.toThrow('--signature')
  })

  it('throws when --args is missing', async () => {
    await expect(
      walletAbiCall({ to: IDENTITY_REGISTRY, signature: 'register()', 'chain-id': '2818' }),
    ).rejects.toThrow('--args')
  })

  it('throws when --chain-id is missing', async () => {
    await expect(
      walletAbiCall({ to: IDENTITY_REGISTRY, signature: 'register()', args: '[]' }),
    ).rejects.toThrow('--chain-id')
  })

  it('throws when --args is not valid JSON', async () => {
    await expect(
      walletAbiCall({
        to: IDENTITY_REGISTRY,
        signature: 'register()',
        args: 'not json',
        'chain-id': '2818',
      }),
    ).rejects.toThrow('Invalid --args')
  })

  it('throws when --args JSON is not an array', async () => {
    await expect(
      walletAbiCall({
        to: IDENTITY_REGISTRY,
        signature: 'register()',
        args: '{"x":1}',
        'chain-id': '2818',
      }),
    ).rejects.toThrow('JSON array')
  })

  it('throws when --signature does not look like a function signature', async () => {
    await expect(
      walletAbiCall({
        to: IDENTITY_REGISTRY,
        signature: 'not a signature',
        args: '[]',
        'chain-id': '2818',
      }),
    ).rejects.toThrow('Invalid --signature')
  })

  // ── Request body shape ──

  it('sends {to, abi, functionName, args, chainId} to /wallet/execute', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    await walletAbiCall({
      to: IDENTITY_REGISTRY,
      signature: 'register(string)',
      args: '["https://example.com/agent.json"]',
      'chain-id': '2818',
    })

    const url = mock.mock.calls[0][0]
    expect(url).toBe('https://api.test/v1/instances/inst-123/wallet/execute')

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body).toEqual({
      to: IDENTITY_REGISTRY,
      abi: ['function register(string)'],
      functionName: 'register',
      args: ['https://example.com/agent.json'],
      chainId: 2818,
    })
  })

  it('extracts functionName even when signature already starts with "function "', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    await walletAbiCall({
      to: IDENTITY_REGISTRY,
      signature: 'function register(string)',
      args: '["uri"]',
      'chain-id': '2818',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.functionName).toBe('register')
    expect(body.abi).toEqual(['function register(string)'])
  })

  it('forwards optional --value as hex', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    await walletAbiCall({
      to: IDENTITY_REGISTRY,
      signature: 'register()',
      args: '[]',
      'chain-id': '2818',
      value: '0x2386f26fc10000',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.value).toBe('0x2386f26fc10000')
  })

  it('forwards optional --gas-limit', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    await walletAbiCall({
      to: IDENTITY_REGISTRY,
      signature: 'register()',
      args: '[]',
      'chain-id': '2818',
      'gas-limit': '0x30d40',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    expect(body.gasLimit).toBe('0x30d40')
  })

  // ── EIP-8004 signatures parse + encode correctly via viem ──
  // These tests bypass the mock and invoke viem directly to verify that each
  // function signature we document in morph/SKILL.md is valid ABI that viem
  // accepts. If parseAbi + encodeFunctionData produce valid calldata here,
  // the same inputs will work server-side (the server uses the same viem APIs).

  describe('EIP-8004 signature viem compatibility', () => {
    it('register() — bare mint', () => {
      const abi = parseAbi(['function register()'])
      const data = encodeFunctionData({ abi, functionName: 'register', args: [] })
      expect(data).toMatch(/^0x[0-9a-f]{8}$/) // just the 4-byte selector
    })

    it('register(string) — with URI', () => {
      const abi = parseAbi(['function register(string)'])
      const data = encodeFunctionData({
        abi,
        functionName: 'register',
        args: ['https://example.com/agent.json'],
      })
      expect(data.startsWith('0x')).toBe(true)
      expect(data.length).toBeGreaterThan(10)
    })

    it('register(string,(string,bytes)[]) — with URI + metadata tuple array', () => {
      const abi = parseAbi(['function register(string,(string,bytes)[])'])
      const nameHex = `0x${Buffer.from('MorphBot', 'utf-8').toString('hex')}` as `0x${string}`
      const roleHex = `0x${Buffer.from('assistant', 'utf-8').toString('hex')}` as `0x${string}`
      const data = encodeFunctionData({
        abi,
        functionName: 'register',
        args: [
          'https://example.com/agent.json',
          [
            ['name', nameHex],
            ['role', roleHex],
          ],
        ],
      })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('giveFeedback — full 8-arg signature', () => {
      const abi = parseAbi([
        'function giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)',
      ])
      const data = encodeFunctionData({
        abi,
        functionName: 'giveFeedback',
        args: [
          42n,
          450n,
          2,
          'quality',
          '',
          '',
          'https://example.com/review/1',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        ],
      })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('setMetadata(uint256,string,bytes)', () => {
      const abi = parseAbi(['function setMetadata(uint256,string,bytes)'])
      const valueHex = `0x${Buffer.from('assistant', 'utf-8').toString('hex')}` as `0x${string}`
      const data = encodeFunctionData({
        abi,
        functionName: 'setMetadata',
        args: [42n, 'role', valueHex],
      })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('setAgentURI(uint256,string)', () => {
      const abi = parseAbi(['function setAgentURI(uint256,string)'])
      const data = encodeFunctionData({
        abi,
        functionName: 'setAgentURI',
        args: [42n, 'https://example.com/agent-v2.json'],
      })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('unsetAgentWallet(uint256)', () => {
      const abi = parseAbi(['function unsetAgentWallet(uint256)'])
      const data = encodeFunctionData({ abi, functionName: 'unsetAgentWallet', args: [42n] })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('revokeFeedback(uint256,uint64)', () => {
      const abi = parseAbi(['function revokeFeedback(uint256,uint64)'])
      const data = encodeFunctionData({ abi, functionName: 'revokeFeedback', args: [42n, 0n] })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('appendResponse(uint256,address,uint64,string,bytes32)', () => {
      const abi = parseAbi([
        'function appendResponse(uint256,address,uint64,string,bytes32)',
      ])
      const data = encodeFunctionData({
        abi,
        functionName: 'appendResponse',
        args: [
          42n,
          '0x1234567890123456789012345678901234567890',
          0n,
          'https://example.com/response.json',
          // keccak256 of the URI — any 32-byte hex works for the encoding test
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        ],
      })
      expect(data.startsWith('0x')).toBe(true)
    })

    it('setAgentWallet(uint256,address,uint256,bytes)', () => {
      const abi = parseAbi(['function setAgentWallet(uint256,address,uint256,bytes)'])
      const sigBytes = `0x${'ab'.repeat(65)}` as `0x${string}`
      const data = encodeFunctionData({
        abi,
        functionName: 'setAgentWallet',
        args: [42n, '0x1234567890123456789012345678901234567890', 1710000000n, sigBytes],
      })
      expect(data.startsWith('0x')).toBe(true)
    })
  })

  // ── End-to-end wire + viem check ──
  // Verifies that the body we send to the server, when piped through viem's
  // parseAbi + encodeFunctionData (server's exact pipeline), produces valid
  // calldata. This is the closest we can get to a server integration test
  // without spinning up the actual API server.

  it('CLI body is consumable by server-side viem pipeline (register with metadata)', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    const nameHex = `0x${Buffer.from('MorphBot', 'utf-8').toString('hex')}`
    const argsJson = JSON.stringify([
      'https://example.com/agent.json',
      [['name', nameHex]],
    ])

    await walletAbiCall({
      to: IDENTITY_REGISTRY,
      signature: 'register(string,(string,bytes)[])',
      args: argsJson,
      'chain-id': '2818',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)

    // Simulate what the server does: parseAbi(body.abi) + encodeFunctionData(...)
    const abi = parseAbi(body.abi as string[])
    const calldata = encodeFunctionData({
      abi,
      functionName: body.functionName,
      args: body.args,
    })

    expect(calldata.startsWith('0x')).toBe(true)
    // Selector for register(string,(string,bytes)[]) should be deterministic.
    // Just confirm it's present and followed by ABI-encoded params.
    expect(calldata.length).toBeGreaterThan(10)
  })

  it('CLI body is consumable by server-side viem pipeline (agent-feedback)', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    await walletAbiCall({
      to: REPUTATION_REGISTRY,
      signature: 'giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)',
      args: JSON.stringify([
        42,
        450,
        2,
        'quality',
        '',
        '',
        'https://example.com/review/1',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ]),
      'chain-id': '2818',
    })

    const body = JSON.parse(mock.mock.calls[0][1].body)
    const abi = parseAbi(body.abi as string[])
    const calldata = encodeFunctionData({
      abi,
      functionName: body.functionName,
      args: body.args,
    })
    expect(calldata.startsWith('0x')).toBe(true)
  })

  // ── API error handling ──

  it('throws on API error response', async () => {
    const mock = mockFetch({ ok: false, error: 'Insufficient gas' })
    vi.stubGlobal('fetch', mock)

    await expect(
      walletAbiCall({
        to: IDENTITY_REGISTRY,
        signature: 'register()',
        args: '[]',
        'chain-id': '2818',
      }),
    ).rejects.toThrow('Insufficient gas')
  })

  it('sends Authorization header', async () => {
    const mock = mockFetch(OK_RESPONSE)
    vi.stubGlobal('fetch', mock)

    await walletAbiCall({
      to: IDENTITY_REGISTRY,
      signature: 'register()',
      args: '[]',
      'chain-id': '2818',
    })

    const headers = mock.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer test-token')
  })
})
