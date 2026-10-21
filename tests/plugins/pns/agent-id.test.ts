import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, parseAbi, zeroAddress } from 'viem'
import {
  AGENT_ID_REGISTRY,
  type AgentIdReader,
  checkAgentId,
  normalizeAgentIdHandle,
  pnsAiCheck,
} from '@pieverseio/purr-plugin-pns/agent-id'

const OWNER = '0x72B73415e263C2b976B2770ee764BACD02ec3004'
const ABI = parseAbi([
  'function isValidHandle(string handle) view returns (bool)',
  'function ownerOfHandle(string handle) view returns (address)',
])

function fakeReader(valid: boolean, owner: string): AgentIdReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isValidHandle: async (handle) => {
      calls.push(`isValidHandle:${handle}`)
      return valid
    },
    ownerOfHandle: async (handle) => {
      calls.push(`ownerOfHandle:${handle}`)
      return owner
    },
  }
}

describe('normalizeAgentIdHandle', () => {
  it('lowercases and strips .ai and .pie suffixes', () => {
    expect(normalizeAgentIdHandle(' Alice.ai ')).toBe('alice')
    expect(normalizeAgentIdHandle('alice.pie')).toBe('alice')
    expect(normalizeAgentIdHandle('alice')).toBe('alice')
  })

  it('rejects an empty handle', () => {
    expect(() => normalizeAgentIdHandle('.ai')).toThrow('Missing .ai handle')
  })
})

describe('checkAgentId', () => {
  it('reports a registered handle with its owner', async () => {
    const reader = fakeReader(true, OWNER)

    await expect(checkAgentId('heyi', reader)).resolves.toEqual({
      name: 'heyi.ai',
      handle: 'heyi',
      valid: true,
      registered: true,
      owner: OWNER,
    })
    expect(reader.calls).toEqual(['isValidHandle:heyi', 'ownerOfHandle:heyi'])
  })

  it('reports an unregistered handle when the registry returns the zero address', async () => {
    await expect(checkAgentId('kuroven.ai', fakeReader(true, zeroAddress))).resolves.toEqual({
      name: 'kuroven.ai',
      handle: 'kuroven',
      valid: true,
      registered: false,
      owner: null,
    })
  })

  it('stops at the registry naming rules without an owner lookup', async () => {
    const reader = fakeReader(false, OWNER)

    const result = await checkAgentId('foo-bar.pie', reader)

    expect(result).toMatchObject({
      name: 'foo-bar.ai',
      valid: false,
      registered: false,
      owner: null,
    })
    expect(result.reason).toContain('lowercase letters and digits')
    expect(reader.calls).toEqual(['isValidHandle:foo-bar'])
  })

  it('propagates RPC failures instead of reporting the handle as free', async () => {
    const reader: AgentIdReader = {
      isValidHandle: async () => true,
      ownerOfHandle: async () => {
        throw new Error('rpc down')
      },
    }

    await expect(checkAgentId('alice', reader)).rejects.toThrow('rpc down')
  })
})

describe('pnsAiCheck', () => {
  const rpcCalls: Array<{ to: string; functionName: string; args: readonly unknown[] }> = []

  beforeEach(() => {
    process.env.EVM_RPC_56 = 'https://bsc.test'
    process.env.WALLET_API_URL = 'https://api.test'
    process.env.WALLET_API_TOKEN = 'test-token'
    process.env.INSTANCE_ID = 'inst-123'
    rpcCalls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.href === 'https://api.test/v2/instances/inst-123/handles/mine') {
          return new Response(
            JSON.stringify({
              ok: true,
              data: { handle: 'alice', renderedHandle: 'alice.pie', walletAddress: OWNER },
            }),
          )
        }
        expect(url.host).toBe('bsc.test')
        const body = JSON.parse(String(init?.body)) as {
          id: number
          params: [{ to: string; data: `0x${string}` }]
        }
        const call = decodeFunctionData({ abi: ABI, data: body.params[0].data })
        rpcCalls.push({ to: body.params[0].to, functionName: call.functionName, args: call.args })
        const result =
          call.functionName === 'isValidHandle'
            ? encodeAbiParameters([{ type: 'bool' }], [true])
            : encodeAbiParameters([{ type: 'address' }], [zeroAddress])
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.EVM_RPC_56
    delete process.env.WALLET_API_URL
    delete process.env.WALLET_API_TOKEN
    delete process.env.INSTANCE_ID
  })

  it('defaults to the instance .pie handle and reads the BSC registry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await pnsAiCheck()

    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      name: 'alice.ai',
      handle: 'alice',
      valid: true,
      registered: false,
      owner: null,
    })
    expect(rpcCalls).toEqual([
      { to: AGENT_ID_REGISTRY, functionName: 'isValidHandle', args: ['alice'] },
      { to: AGENT_ID_REGISTRY, functionName: 'ownerOfHandle', args: ['alice'] },
    ])
  })

  it('checks an explicit name without the instance handle lookup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await pnsAiCheck('Bob.ai')

    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ name: 'bob.ai' })
    expect(rpcCalls.map((call) => call.args[0])).toEqual(['bob', 'bob'])
  })
})
