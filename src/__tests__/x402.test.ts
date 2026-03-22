import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parsePaymentRequired,
  selectPaymentRequirements,
  buildEIP712ForEIP3009,
  buildEIP712ForPermit2,
  assembleEIP3009PaymentPayload,
  assemblePermit2PaymentPayload,
  assembleSvmPaymentPayload,
  encodePaymentPayload,
  getEvmChainId,
  isSolanaNetwork,
  getNetworkDisplayName,
  formatHumanAmount,
  PERMIT2_ADDRESS,
  EXACT_PERMIT2_PROXY_ADDRESS,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
} from '../x402/protocol.js'
import { x402Sign } from '../x402/sign.js'

// ── Test fixtures ──

const SAMPLE_REQUIREMENTS = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '100000',
  payTo: '0xRecipientAddress000000000000000000000001',
  maxTimeoutSeconds: 3600,
  extra: {
    name: 'USD Coin',
    version: '2',
    decimals: 6,
    assetTransferMethod: 'eip3009',
  },
}

const SAMPLE_PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/data' },
  accepts: [SAMPLE_REQUIREMENTS],
}

const SOLANA_REQUIREMENTS = {
  scheme: 'exact',
  network: SOLANA_MAINNET_CAIP2,
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '100000',
  payTo: '7Bb8rFjiY8BBbgW1YhUvE3anxqewCau7GW6VGKZazcCM',
  maxTimeoutSeconds: 3600,
  extra: {
    decimals: 6,
    feePayer: 'FacilitatorPubkey11111111111111111111111111',
  },
}

const SOLANA_PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/data' },
  accepts: [SOLANA_REQUIREMENTS],
}

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

// ── protocol.ts tests ──

describe('getEvmChainId', () => {
  it('parses valid CAIP-2 network', () => {
    expect(getEvmChainId('eip155:8453')).toBe(8453)
    expect(getEvmChainId('eip155:1')).toBe(1)
    expect(getEvmChainId('eip155:56')).toBe(56)
  })

  it('throws on invalid format', () => {
    expect(() => getEvmChainId('solana:mainnet')).toThrow('Unsupported network format')
    expect(() => getEvmChainId('eip155:abc')).toThrow('Invalid CAIP-2 chain ID')
  })
})

describe('isSolanaNetwork', () => {
  it('returns true for Solana CAIP-2 networks', () => {
    expect(isSolanaNetwork(SOLANA_MAINNET_CAIP2)).toBe(true)
    expect(isSolanaNetwork(SOLANA_DEVNET_CAIP2)).toBe(true)
    expect(isSolanaNetwork('solana:anything')).toBe(true)
  })

  it('returns false for non-Solana networks', () => {
    expect(isSolanaNetwork('eip155:8453')).toBe(false)
    expect(isSolanaNetwork('ethereum')).toBe(false)
  })
})

describe('parsePaymentRequired', () => {
  it('parses JSON string', () => {
    const pr = parsePaymentRequired(JSON.stringify(SAMPLE_PAYMENT_REQUIRED))
    expect(pr.x402Version).toBe(2)
    expect(pr.accepts).toHaveLength(1)
    expect(pr.accepts[0].scheme).toBe('exact')
  })

  it('parses base64 string', () => {
    const pr = parsePaymentRequired(toBase64(SAMPLE_PAYMENT_REQUIRED))
    expect(pr.x402Version).toBe(2)
    expect(pr.accepts[0].network).toBe('eip155:8453')
  })

  it('parses object directly', () => {
    const pr = parsePaymentRequired(SAMPLE_PAYMENT_REQUIRED)
    expect(pr.x402Version).toBe(2)
  })

  it('normalizes v1 legacy EVM network aliases', () => {
    const v1Pr = {
      x402Version: 1,
      resource: { url: 'https://example.com' },
      accepts: [{ ...SAMPLE_REQUIREMENTS, network: 'base' }],
    }
    const pr = parsePaymentRequired(v1Pr)
    expect(pr.accepts[0].network).toBe('eip155:8453')
  })

  it('normalizes v1 legacy Solana network aliases', () => {
    const v1Pr = {
      x402Version: 1,
      resource: { url: 'https://example.com' },
      accepts: [{ ...SOLANA_REQUIREMENTS, network: 'solana' }],
    }
    const pr = parsePaymentRequired(v1Pr)
    expect(pr.accepts[0].network).toBe(SOLANA_MAINNET_CAIP2)
  })

  it('throws on invalid JSON', () => {
    expect(() => parsePaymentRequired('{invalid')).toThrow('not valid JSON')
  })

  it('throws on invalid base64', () => {
    expect(() => parsePaymentRequired('not-valid-base64!!!')).toThrow(
      'not valid base64-encoded JSON',
    )
  })

  it('throws on missing x402Version', () => {
    expect(() => parsePaymentRequired(JSON.stringify({ accepts: [] }))).toThrow(
      'missing x402Version',
    )
  })

  it('throws on missing accepts', () => {
    expect(() => parsePaymentRequired(JSON.stringify({ x402Version: 2 }))).toThrow(
      'missing or empty accepts',
    )
  })

  it('throws on empty accepts', () => {
    expect(() => parsePaymentRequired(JSON.stringify({ x402Version: 2, accepts: [] }))).toThrow(
      'missing or empty accepts',
    )
  })
})

describe('selectPaymentRequirements', () => {
  it('selects matching exact scheme on supported EVM chain', () => {
    const req = selectPaymentRequirements(SAMPLE_PAYMENT_REQUIRED)
    expect(req.scheme).toBe('exact')
    expect(req.network).toBe('eip155:8453')
  })

  it('selects matching Solana network', () => {
    const req = selectPaymentRequirements(SOLANA_PAYMENT_REQUIRED)
    expect(req.scheme).toBe('exact')
    expect(req.network).toBe(SOLANA_MAINNET_CAIP2)
  })

  it('skips non-exact schemes', () => {
    const pr = {
      ...SAMPLE_PAYMENT_REQUIRED,
      accepts: [
        { ...SAMPLE_REQUIREMENTS, scheme: 'upto', network: 'eip155:8453' },
        { ...SAMPLE_REQUIREMENTS, scheme: 'exact', network: 'eip155:8453' },
      ],
    }
    const req = selectPaymentRequirements(pr)
    expect(req.scheme).toBe('exact')
  })

  it('skips unsupported chains', () => {
    const pr = {
      ...SAMPLE_PAYMENT_REQUIRED,
      accepts: [
        { ...SAMPLE_REQUIREMENTS, network: 'eip155:99999' },
        { ...SAMPLE_REQUIREMENTS, network: 'eip155:8453' },
      ],
    }
    const req = selectPaymentRequirements(pr)
    expect(req.network).toBe('eip155:8453')
  })

  it('throws when no matching option', () => {
    const pr = {
      ...SAMPLE_PAYMENT_REQUIRED,
      accepts: [{ ...SAMPLE_REQUIREMENTS, network: 'eip155:99999' }],
    }
    expect(() => selectPaymentRequirements(pr)).toThrow('No supported payment option found')
  })

  it('respects custom supportedChainIds', () => {
    const req = selectPaymentRequirements(SAMPLE_PAYMENT_REQUIRED, {
      supportedChainIds: [8453],
    })
    expect(req.network).toBe('eip155:8453')

    expect(() =>
      selectPaymentRequirements(SAMPLE_PAYMENT_REQUIRED, { supportedChainIds: [56] }),
    ).toThrow('No supported payment option')
  })

  it('respects custom supportedSolanaNetworks', () => {
    const req = selectPaymentRequirements(SOLANA_PAYMENT_REQUIRED, {
      supportedSolanaNetworks: [SOLANA_MAINNET_CAIP2],
    })
    expect(req.network).toBe(SOLANA_MAINNET_CAIP2)

    expect(() =>
      selectPaymentRequirements(SOLANA_PAYMENT_REQUIRED, {
        supportedSolanaNetworks: [SOLANA_DEVNET_CAIP2],
      }),
    ).toThrow('No supported payment option')
  })

  it('selects first match when both EVM and Solana available', () => {
    const pr = {
      ...SAMPLE_PAYMENT_REQUIRED,
      accepts: [SOLANA_REQUIREMENTS, SAMPLE_REQUIREMENTS],
    }
    const req = selectPaymentRequirements(pr)
    // Solana is first, should be selected
    expect(req.network).toBe(SOLANA_MAINNET_CAIP2)
  })
})

describe('buildEIP712ForEIP3009', () => {
  it('builds correct domain and types', () => {
    const result = buildEIP712ForEIP3009('0xWallet', SAMPLE_REQUIREMENTS)

    expect(result.primaryType).toBe('TransferWithAuthorization')
    expect(result.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: SAMPLE_REQUIREMENTS.asset,
    })
    expect(result.types).toHaveProperty('TransferWithAuthorization')
    expect(result.message.from).toBe('0xWallet')
    expect(result.message.to).toBe(SAMPLE_REQUIREMENTS.payTo)
    expect(result.message.value).toBe('100000')
    expect(result.nonce).toMatch(/^0x/)
  })

  it('throws when name/version missing from extra', () => {
    const req = { ...SAMPLE_REQUIREMENTS, extra: {} }
    expect(() => buildEIP712ForEIP3009('0xWallet', req)).toThrow('EIP-712 domain parameters')
  })
})

describe('buildEIP712ForPermit2', () => {
  it('builds correct Permit2 structure', () => {
    const result = buildEIP712ForPermit2('0xWallet', SAMPLE_REQUIREMENTS)

    expect(result.primaryType).toBe('PermitWitnessTransferFrom')
    expect(result.domain).toEqual({
      name: 'Permit2',
      chainId: 8453,
      verifyingContract: PERMIT2_ADDRESS,
    })
    expect(result.types).toHaveProperty('PermitWitnessTransferFrom')
    expect(result.types).toHaveProperty('TokenPermissions')
    expect(result.types).toHaveProperty('Witness')

    const msg = result.message as Record<string, unknown>
    expect(msg.spender).toBe(EXACT_PERMIT2_PROXY_ADDRESS)
    expect((msg.permitted as Record<string, unknown>).token).toBe(SAMPLE_REQUIREMENTS.asset)
    expect((msg.witness as Record<string, unknown>).to).toBe(SAMPLE_REQUIREMENTS.payTo)
  })
})

describe('assembleEIP3009PaymentPayload + encodePaymentPayload', () => {
  it('produces valid base64 payload', () => {
    const eip712 = buildEIP712ForEIP3009('0xWallet', SAMPLE_REQUIREMENTS)
    const payload = assembleEIP3009PaymentPayload(2, SAMPLE_REQUIREMENTS, eip712, '0xSIGNATURE')

    expect(payload.x402Version).toBe(2)
    expect(payload.accepted).toBe(SAMPLE_REQUIREMENTS)
    expect(payload.payload).toHaveProperty('signature', '0xSIGNATURE')
    expect(payload.payload).toHaveProperty('authorization')

    const encoded = encodePaymentPayload(payload)
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
    expect(decoded.x402Version).toBe(2)
    expect(decoded.payload.signature).toBe('0xSIGNATURE')
  })
})

describe('assemblePermit2PaymentPayload + encodePaymentPayload', () => {
  it('produces valid base64 payload', () => {
    const eip712 = buildEIP712ForPermit2('0xWallet', SAMPLE_REQUIREMENTS)
    const payload = assemblePermit2PaymentPayload(
      2,
      SAMPLE_REQUIREMENTS,
      eip712,
      '0xSIGNATURE',
      '0xWallet',
    )

    expect(payload.x402Version).toBe(2)
    expect(payload.payload).toHaveProperty('signature', '0xSIGNATURE')
    expect(payload.payload).toHaveProperty('permit2Authorization')

    const auth = payload.payload.permit2Authorization as Record<string, unknown>
    expect(auth.from).toBe('0xWallet')
    expect(auth.spender).toBe(EXACT_PERMIT2_PROXY_ADDRESS)

    const encoded = encodePaymentPayload(payload)
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
    expect(decoded.payload.permit2Authorization.from).toBe('0xWallet')
  })
})

describe('assembleSvmPaymentPayload', () => {
  it('produces valid SVM payload with transaction field', () => {
    const payload = assembleSvmPaymentPayload(
      2,
      SOLANA_REQUIREMENTS,
      'base64EncodedTransaction==',
      { url: 'https://api.example.com/data' },
    )

    expect(payload.x402Version).toBe(2)
    expect(payload.scheme).toBe('exact')
    expect(payload.network).toBe(SOLANA_MAINNET_CAIP2)
    expect(payload.accepted).toBe(SOLANA_REQUIREMENTS)
    expect(payload.payload).toEqual({ transaction: 'base64EncodedTransaction==' })

    const encoded = encodePaymentPayload(payload)
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
    expect(decoded.payload.transaction).toBe('base64EncodedTransaction==')
  })
})

describe('getNetworkDisplayName', () => {
  it('returns known EVM chain names', () => {
    expect(getNetworkDisplayName('eip155:8453')).toBe('Base')
    expect(getNetworkDisplayName('eip155:1')).toBe('Ethereum')
    expect(getNetworkDisplayName('eip155:56')).toBe('BSC')
  })

  it('returns Solana network names', () => {
    expect(getNetworkDisplayName(SOLANA_MAINNET_CAIP2)).toBe('Solana')
    expect(getNetworkDisplayName(SOLANA_DEVNET_CAIP2)).toBe('Solana Devnet')
  })

  it('returns fallback for unknown networks', () => {
    expect(getNetworkDisplayName('eip155:99999')).toBe('Chain 99999')
  })
})

describe('formatHumanAmount', () => {
  it('formats USDC amounts (6 decimals)', () => {
    expect(formatHumanAmount('100000', 6)).toBe('0.1')
    expect(formatHumanAmount('1000000', 6)).toBe('1')
    expect(formatHumanAmount('1500000', 6)).toBe('1.5')
    expect(formatHumanAmount('123456', 6)).toBe('0.123456')
  })

  it('formats ETH amounts (18 decimals)', () => {
    expect(formatHumanAmount('1000000000000000000', 18)).toBe('1')
    expect(formatHumanAmount('500000000000000000', 18)).toBe('0.5')
  })

  it('formats zero', () => {
    expect(formatHumanAmount('0', 6)).toBe('0')
  })
})

// ── x402Sign command tests ──

describe('x402Sign', () => {
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

  it('throws when --payment-required is missing', async () => {
    await expect(x402Sign({})).rejects.toThrow('--payment-required')
  })

  it('signs EIP-3009 payment and outputs paymentSignature', async () => {
    let callCount = 0
    const mock = vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
      callCount++
      const body = JSON.parse(opts.body)

      if (callCount === 1) {
        // wallet/ensure
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, data: { address: '0xWalletAddr' } }),
          text: () =>
            Promise.resolve(JSON.stringify({ ok: true, data: { address: '0xWalletAddr' } })),
        })
      }

      // wallet/sign-typed-data
      expect(body.primaryType).toBe('TransferWithAuthorization')
      expect(body.domain.name).toBe('USD Coin')
      expect(body.domain.version).toBe('2')
      expect(body.domain.chainId).toBe(8453)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            data: { address: '0xWalletAddr', signature: '0xABCDEF' },
          }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              data: { address: '0xWalletAddr', signature: '0xABCDEF' },
            }),
          ),
      })
    })
    vi.stubGlobal('fetch', mock)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await x402Sign({ 'payment-required': toBase64(SAMPLE_PAYMENT_REQUIRED) })

    expect(mock).toHaveBeenCalledTimes(2)
    expect(consoleSpy).toHaveBeenCalledOnce()
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)
    expect(output.walletAddress).toBe('0xWalletAddr')
    expect(output.chainId).toBe(8453)
    expect(output.scheme).toBe('exact')
    expect(output.paymentSignature).toBeTruthy()

    // Verify the payment signature decodes correctly
    const decoded = JSON.parse(Buffer.from(output.paymentSignature, 'base64').toString('utf-8'))
    expect(decoded.x402Version).toBe(2)
    expect(decoded.payload.signature).toBe('0xABCDEF')
    expect(decoded.payload.authorization).toBeDefined()
    expect(decoded.payload.authorization.from).toBe('0xWalletAddr')
  })

  it('signs Permit2 payment when assetTransferMethod is permit2', async () => {
    const permit2Pr = {
      ...SAMPLE_PAYMENT_REQUIRED,
      accepts: [
        {
          ...SAMPLE_REQUIREMENTS,
          extra: { ...SAMPLE_REQUIREMENTS.extra, assetTransferMethod: 'permit2' },
        },
      ],
    }

    let callCount = 0
    const mock = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, data: { address: '0xWalletAddr' } }),
          text: () =>
            Promise.resolve(JSON.stringify({ ok: true, data: { address: '0xWalletAddr' } })),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            data: { address: '0xWalletAddr', signature: '0xPERMIT2SIG' },
          }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              data: { address: '0xWalletAddr', signature: '0xPERMIT2SIG' },
            }),
          ),
      })
    })
    vi.stubGlobal('fetch', mock)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await x402Sign({ 'payment-required': toBase64(permit2Pr) })

    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)
    const decoded = JSON.parse(Buffer.from(output.paymentSignature, 'base64').toString('utf-8'))
    expect(decoded.payload.permit2Authorization).toBeDefined()
    expect(decoded.payload.permit2Authorization.from).toBe('0xWalletAddr')
    expect(decoded.payload.signature).toBe('0xPERMIT2SIG')
  })

  it('signs Solana x402 payment via x402-sign-solana endpoint', async () => {
    const mock = vi.fn().mockImplementation((url: string) => {
      // Single call to x402-sign-solana (no wallet/ensure needed)
      expect(url).toContain('x402-sign-solana')
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            data: {
              transaction: 'base64SignedSolanaTx==',
              walletAddress: 'SolWalletAddr1111111111111111111111111111111',
            },
          }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              data: {
                transaction: 'base64SignedSolanaTx==',
                walletAddress: 'SolWalletAddr1111111111111111111111111111111',
              },
            }),
          ),
      })
    })
    vi.stubGlobal('fetch', mock)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await x402Sign({ 'payment-required': toBase64(SOLANA_PAYMENT_REQUIRED) })

    expect(mock).toHaveBeenCalledOnce()
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)
    expect(output.walletAddress).toBe('SolWalletAddr1111111111111111111111111111111')
    expect(output.scheme).toBe('exact')
    expect(output.network).toBe(SOLANA_MAINNET_CAIP2)
    expect(output.paymentSignature).toBeTruthy()

    // Verify the payment signature decodes to SVM payload
    const decoded = JSON.parse(Buffer.from(output.paymentSignature, 'base64').toString('utf-8'))
    expect(decoded.x402Version).toBe(2)
    expect(decoded.payload.transaction).toBe('base64SignedSolanaTx==')
    expect(decoded.scheme).toBe('exact')
    expect(decoded.network).toBe(SOLANA_MAINNET_CAIP2)
  })

  it('throws when Solana payment lacks feePayer', async () => {
    const noFeePayerPr = {
      ...SOLANA_PAYMENT_REQUIRED,
      accepts: [{ ...SOLANA_REQUIREMENTS, extra: { decimals: 6 } }],
    }
    await expect(x402Sign({ 'payment-required': toBase64(noFeePayerPr) })).rejects.toThrow(
      'feePayer is required',
    )
  })

  it('throws on unsupported chain', async () => {
    const unsupportedPr = {
      ...SAMPLE_PAYMENT_REQUIRED,
      accepts: [{ ...SAMPLE_REQUIREMENTS, network: 'eip155:99999' }],
    }
    await expect(x402Sign({ 'payment-required': toBase64(unsupportedPr) })).rejects.toThrow(
      'No supported payment option found',
    )
  })

  it('throws on invalid payment-required input', async () => {
    await expect(x402Sign({ 'payment-required': '{bad json' })).rejects.toThrow('not valid JSON')
  })
})
