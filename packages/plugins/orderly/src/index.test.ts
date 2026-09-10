import { createPublicKey, verify } from 'node:crypto'
import bs58 from 'bs58'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
} from 'viem'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  resolveCredentials: vi.fn(() => ({ instanceId: 'instance-123' })),
}))

vi.mock('@pieverseio/purr-core/api-client', () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  resolveCredentials: mocks.resolveCredentials,
}))

import {
  orderlyCanonicalMessage,
  orderlyCommand,
  orderlyHelp,
  solanaBase58SignatureToBase64Url,
} from './index.js'

const EVM_ADDRESS: `0x${string}` = '0x1111111111111111111111111111111111111111'
const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112'
const ACCOUNT_ID = `0x${'22'.repeat(32)}` as `0x${string}`
const VAULT_ADDRESS = '0x3333333333333333333333333333333333333333'
const TOKEN_ADDRESS = '0x4444444444444444444444444444444444444444'
// RFC 8032, test vector 1: an Ed25519 signature for an empty message.
const ED25519_PUBLIC_KEY_DER = Buffer.from(
  '302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
)
const TEE_SOLANA_SIGNATURE_BASE58 =
  '5awYiUvGiDFA33EJjj4TXJG44a5afJc8QjWRpGgQiu6b23jCr7yndW2fmp9ujwqJVe32J456wV3VF78Asb1obnTc'
const ORDERLY_SIGNATURE_BASE64URL =
  '5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockWallets(): void {
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('chain_type=ethereum')) return { ok: true, data: { address: EVM_ADDRESS } }
    if (path.endsWith('chain_type=solana')) return { ok: true, data: { address: SOLANA_ADDRESS } }
    throw new Error(`Unexpected wallet request: ${path}`)
  })
}

describe('Orderly request authentication', () => {
  it('keeps the exact query string and body in the canonical signed message', () => {
    expect(
      orderlyCanonicalMessage(
        '1700000000000',
        'POST',
        '/v1/order?symbol=PERP_BTC_USDC',
        '{"symbol":"PERP_BTC_USDC","side":"BUY"}',
      ),
    ).toBe('1700000000000POST/v1/order?symbol=PERP_BTC_USDC{"symbol":"PERP_BTC_USDC","side":"BUY"}')
  })

  it('converts a TEE base58 Ed25519 signature to Orderly unpadded base64url', () => {
    const signature = bs58.decode(TEE_SOLANA_SIGNATURE_BASE58)
    expect(signature).toHaveLength(64)
    expect(
      verify(
        null,
        Buffer.alloc(0),
        createPublicKey({ key: ED25519_PUBLIC_KEY_DER, format: 'der', type: 'spki' }),
        signature,
      ),
    ).toBe(true)
    expect(solanaBase58SignatureToBase64Url(TEE_SOLANA_SIGNATURE_BASE58)).toBe(
      ORDERLY_SIGNATURE_BASE64URL,
    )
  })
})

describe('Orderly API contracts', () => {
  beforeEach(() => {
    process.env.ORDERLY_BROKER_ID = 'broker-1'
    delete process.env.ORDERLY_RPC_URL_42161
    mocks.apiGet.mockReset()
    mocks.apiPost.mockReset()
    mocks.resolveCredentials.mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    delete process.env.ORDERLY_BROKER_ID
    delete process.env.ORDERLY_RPC_URL_42161
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses address, rather than user_address, when deriving a private identity', async () => {
    mockWallets()
    mocks.apiPost.mockResolvedValue({ ok: true, data: { signature: TEE_SOLANA_SIGNATURE_BASE58 } })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/get_account'))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      if (input.endsWith('/v1/client/holding'))
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/x-www-form-urlencoded',
        })
      if (input.endsWith('/v1/client/holding'))
        return json({ success: true, data: { holding: [] } })
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('balance', {})

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.orderly.org/v1/get_account?broker_id=broker-1&address=${EVM_ADDRESS}&chain_type=EVM`,
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('sends the base64url form of the TEE base58 signature in orderly-signature', async () => {
    mockWallets()
    mocks.apiPost.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith('/wallet/sign')) {
        expect(body).toMatchObject({ chainType: 'solana', scheme: 'raw', message: expect.any(String) })
        return { ok: true, data: { signature: TEE_SOLANA_SIGNATURE_BASE58 } }
      }
      throw new Error(`Unexpected wallet write: ${path}`)
    })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/get_account'))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      if (input.endsWith('/v1/client/holding')) {
        expect(init?.headers).toMatchObject({ 'orderly-signature': ORDERLY_SIGNATURE_BASE64URL })
        return json({ success: true, data: { holding: [] } })
      }
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('balance', {})
  })

  it('reads token chain_details and public_rpc_url for the Vault fee query', async () => {
    mockWallets()
    const expectedCallData = encodeFunctionData({
      abi: parseAbi([
        'function getDepositFee(address account, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) input) view returns (uint256)',
      ]),
      functionName: 'getDepositFee',
      args: [
        EVM_ADDRESS,
        {
          accountId: ACCOUNT_ID,
          brokerHash: keccak256(stringToHex('broker-1')),
          tokenHash: keccak256(stringToHex('USDC')),
          tokenAmount: 1_500_000n,
        },
      ],
    })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/get_account'))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      if (input.includes('/v1/public/chain_info')) {
        return json({
          success: true,
          data: [
            {
              chain_id: 42161,
              vault_address: VAULT_ADDRESS,
              public_rpc_url: 'https://rpc.example',
            },
          ],
        })
      }
      if (input.endsWith('/v1/public/token')) {
        return json({
          success: true,
          data: [
            {
              token: 'USDC',
              decimals: 6,
              chain_details: [{ chain_id: 42161, contract_address: TOKEN_ADDRESS, decimals: 6 }],
            },
          ],
        })
      }
      if (input === 'https://rpc.example') {
        const rpc = JSON.parse(String(init?.body))
        expect(rpc.params[0].data).toBe(expectedCallData)
        return json({ result: encodeAbiParameters(parseAbiParameters('uint256'), [7n]) })
      }
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('deposit', {
      'chain-id': '42161',
      token: 'USDC',
      amount: '1.5',
    })

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      feeWei: '7',
      feeSource: 'vault_rpc',
      steps: [
        {
          to: TOKEN_ADDRESS,
          signature: 'approve(address,uint256)',
          value: '0',
          conditional: {
            type: 'allowance_lt',
            token: TOKEN_ADDRESS,
            spender: VAULT_ADDRESS,
            amount: '1500000',
          },
        },
        { to: VAULT_ADDRESS, signature: 'deposit((bytes32,bytes32,bytes32,uint128))' },
      ],
    })
  })

  it('executes a deposit as one conditional, idempotent wallet step request', async () => {
    mockWallets()
    let executionBody: Record<string, unknown> | undefined
    mocks.apiPost.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith('/wallet/execute')) {
        executionBody = body
        return {
          ok: true,
          data: {
            results: [
              { stepIndex: 0, label: 'approve', hash: '0xapprove', status: 'skipped' },
              { stepIndex: 1, label: 'deposit', hash: '0xdeposit', status: 'success' },
            ],
          },
        }
      }
      throw new Error(`Unexpected wallet write: ${path}`)
    })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/get_account'))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      if (input.includes('/v1/public/chain_info')) {
        return json({
          success: true,
          data: [
            {
              chain_id: 42161,
              vault_address: VAULT_ADDRESS,
              public_rpc_url: 'https://rpc.example',
            },
          ],
        })
      }
      if (input.endsWith('/v1/public/token')) {
        return json({
          success: true,
          data: [
            {
              token: 'USDC',
              decimals: 6,
              chain_details: [{ chain_id: 42161, contract_address: TOKEN_ADDRESS, decimals: 6 }],
            },
          ],
        })
      }
      if (input === 'https://rpc.example') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'eth_call' })
        return json({ result: encodeAbiParameters(parseAbiParameters('uint256'), [7n]) })
      }
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('deposit', {
      'chain-id': '42161',
      token: 'USDC',
      amount: '1.5',
      execute: 'true',
    })

    expect(executionBody).toMatchObject({
      dedupKey: `instance-123:orderly-deposit:42161:${TOKEN_ADDRESS}:1500000`,
      steps: [
        {
          label: 'approve',
          to: TOKEN_ADDRESS,
          value: '0',
          conditional: {
            type: 'allowance_lt',
            token: TOKEN_ADDRESS,
            spender: VAULT_ADDRESS,
            amount: '1500000',
          },
        },
        { label: 'deposit', to: VAULT_ADDRESS, value: '7' },
      ],
    })
    expect(mocks.apiPost).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      execute: true,
      approvalSkipped: true,
      approveTxHash: null,
      depositTxHash: '0xdeposit',
    })
  })

  it('uses the current leverage and algo cancellation endpoint contracts', async () => {
    mockWallets()
    mocks.apiPost.mockImplementation(async (path: string) => {
      if (path.endsWith('/wallet/sign'))
        return { ok: true, data: { signature: TEE_SOLANA_SIGNATURE_BASE58 } }
      throw new Error(`Unexpected wallet write: ${path}`)
    })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/get_account'))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      if (input.endsWith('/v1/client/leverages')) {
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
        return json({ success: true, data: {} })
      }
      if (input.endsWith('/v1/algo/order?order_id=algo-1&symbol=PERP_BTC_USDC')) {
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/x-www-form-urlencoded',
        })
        return json({ success: true, data: {} })
      }
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('leverage-set', {
      symbol: 'PERP_BTC_USDC',
      leverage: '2',
      execute: 'true',
    })
    await orderlyCommand('algo-cancel', {
      'order-id': 'algo-1',
      symbol: 'PERP_BTC_USDC',
      execute: 'true',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.orderly.org/v1/client/leverages',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.orderly.org/v1/algo/order?order_id=algo-1&symbol=PERP_BTC_USDC',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('uses ledger decimals for withdrawals and appends chainType after signing', async () => {
    mockWallets()
    mocks.apiPost.mockImplementation(async (path: string) => {
      if (path.endsWith('/wallet/sign-typed-data'))
        return { ok: true, data: { signature: '0xtyped' } }
      if (path.endsWith('/wallet/sign'))
        return { ok: true, data: { signature: TEE_SOLANA_SIGNATURE_BASE58 } }
      throw new Error(`Unexpected wallet write: ${path}`)
    })
    let withdrawalBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/public/token')) {
        return json({
          success: true,
          data: [
            {
              token: 'USDC',
              decimals: 6,
              chain_details: [{ chain_id: 42161, contract_address: TOKEN_ADDRESS, decimals: 18 }],
            },
          ],
        })
      }
      if (input.includes('/v1/get_account'))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      if (input.endsWith('/v1/withdraw_nonce'))
        return json({ success: true, data: { withdraw_nonce: 9 } })
      if (input.endsWith('/v1/withdraw_request')) {
        withdrawalBody = JSON.parse(String(init?.body))
        return json({ success: true, data: { request_id: 'withdrawal-1' } })
      }
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('withdraw', {
      'chain-id': '42161',
      token: 'USDC',
      amount: '1.5',
      address: EVM_ADDRESS,
      execute: 'true',
    })

    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/instances/instance-123/wallet/sign-typed-data',
      expect.objectContaining({
        types: expect.objectContaining({
          Withdraw: expect.not.arrayContaining([{ name: 'chainType', type: 'string' }]),
        }),
        message: expect.not.objectContaining({ chainType: 'EVM' }),
      }),
    )
    expect(withdrawalBody).toMatchObject({
      signature: '0xtyped',
      userAddress: EVM_ADDRESS,
      verifyingContract: '0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203',
      message: {
        chainId: 42161,
        chainType: 'EVM',
        amount: '1500000',
      },
    })
  })

  it('never creates a Solana wallet while previewing onboarding', async () => {
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path.endsWith('chain_type=ethereum')) return { ok: true, data: { address: EVM_ADDRESS } }
      if (path.endsWith('chain_type=solana')) return { ok: false, error: 'No Solana wallet' }
      throw new Error(`Unexpected wallet request: ${path}`)
    })
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes('/v1/get_account')) return json({ message: 'Not found' }, 404)
      if (input.endsWith('/v1/registration_nonce')) return json({ success: true, data: 1 })
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('onboard', { 'chain-id': '42161' })

    expect(mocks.apiPost).not.toHaveBeenCalled()
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      execute: false,
      solanaAddress: null,
      solanaWalletCreationRequired: true,
      addOrderlyKey: { required: true, requiresSolanaWallet: true },
    })
  })

  it('treats code -1607 as unregistered and appends chainType to onboarding wire messages', async () => {
    mockWallets()
    mocks.apiPost.mockImplementation(async (path: string) => {
      if (path.endsWith('/wallet/sign-typed-data'))
        return { ok: true, data: { signature: '0xtyped' } }
      if (path.endsWith('/wallet/sign'))
        return { ok: true, data: { signature: TEE_SOLANA_SIGNATURE_BASE58 } }
      throw new Error(`Unexpected wallet write: ${path}`)
    })
    let registrationBody: Record<string, unknown> | undefined
    let addKeyBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/get_account'))
        return json({ success: false, code: -1607, message: 'Account not found' })
      if (input.endsWith('/v1/registration_nonce')) return json({ success: true, data: 1 })
      if (input.endsWith('/v1/register_account')) {
        registrationBody = JSON.parse(String(init?.body))
        return json({ success: true, data: { account_id: ACCOUNT_ID } })
      }
      if (input.endsWith('/v1/orderly_key')) {
        addKeyBody = JSON.parse(String(init?.body))
        return json({ success: true, data: {} })
      }
      if (input.endsWith('/v1/client/holding'))
        return json({ success: true, data: { holding: [] } })
      throw new Error(`Unexpected Orderly request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await orderlyCommand('onboard', { 'chain-id': '42161', execute: 'true' })

    const typedDataCalls = mocks.apiPost.mock.calls.filter(([path]) =>
      String(path).endsWith('/wallet/sign-typed-data'),
    )
    expect(typedDataCalls).toHaveLength(2)
    for (const [, request] of typedDataCalls) {
      expect((request as Record<string, unknown>).message).not.toHaveProperty('chainType')
    }
    expect(registrationBody).toMatchObject({ message: { chainType: 'EVM' } })
    expect(addKeyBody).toMatchObject({ message: { chainType: 'EVM' } })
    const addKeyMessage = (addKeyBody?.message ?? {}) as Record<string, unknown>
    expect(Number(addKeyMessage.expiration) - Number(addKeyMessage.timestamp)).toBe(
      365 * 24 * 60 * 60 * 1_000 - 5 * 60 * 1_000,
    )
  })
})

describe('Orderly CLI help', () => {
  it('documents preview-first writes and dynamic network discovery', () => {
    expect(orderlyHelp()).toContain('networks')
    expect(orderlyHelp()).toContain('--execute true')
    expect(orderlyHelp()).toContain('ORDERLY_BROKER_ID')
  })
})
