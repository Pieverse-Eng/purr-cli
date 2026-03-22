import { toHex } from 'viem'

// ─── Constants ───────────────────────────────────────────────────────────────

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const EXACT_PERMIT2_PROXY_ADDRESS = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001'

/** EIP-3009 TransferWithAuthorization EIP-712 types. */
export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Permit2 PermitWitnessTransferFrom EIP-712 types. */
export const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const

/** Supported EVM chain IDs (mirrors platform evm.ts). */
export const SUPPORTED_CHAIN_IDS = [1, 10, 56, 137, 8453, 42161] as const

/** Solana CAIP-2 network identifiers. */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export const SOLANA_TESTNET_CAIP2 = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'

export const SUPPORTED_SOLANA_NETWORKS = [
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
] as const

const CHAIN_NAMES: Record<string, string> = {
  '1': 'Ethereum',
  '10': 'Optimism',
  '56': 'BSC',
  '137': 'Polygon',
  '8453': 'Base',
  '42161': 'Arbitrum',
  [SOLANA_MAINNET_CAIP2]: 'Solana',
  [SOLANA_DEVNET_CAIP2]: 'Solana Devnet',
  [SOLANA_TESTNET_CAIP2]: 'Solana Testnet',
}

const LEGACY_NETWORK_ALIASES: Record<string, string> = {
  ethereum: 'eip155:1',
  sepolia: 'eip155:11155111',
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  solana: SOLANA_MAINNET_CAIP2,
  'solana-devnet': SOLANA_DEVNET_CAIP2,
  'solana-testnet': SOLANA_TESTNET_CAIP2,
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PaymentRequirements {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

export interface PaymentRequired {
  x402Version: number
  resource: { url: string; description?: string; mimeType?: string }
  accepts: PaymentRequirements[]
  error?: string
  extensions?: Record<string, unknown>
}

export interface PaymentPayload {
  x402Version: number
  scheme?: string
  network?: string
  resource?: { url: string }
  accepted: PaymentRequirements
  payload: Record<string, unknown>
  extensions?: Record<string, unknown>
}

export interface EIP712Data {
  domain: Record<string, unknown>
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: string
  message: Record<string, unknown>
}

// ─── CAIP-2 Parsing ──────────────────────────────────────────────────────────

export function getEvmChainId(network: string): number {
  if (!network.startsWith('eip155:')) {
    throw new Error(`Unsupported network format: ${network} (expected eip155:CHAIN_ID)`)
  }
  const chainId = Number.parseInt(network.split(':')[1], 10)
  if (Number.isNaN(chainId)) {
    throw new Error(`Invalid CAIP-2 chain ID: ${network}`)
  }
  return chainId
}

export function isSolanaNetwork(network: string): boolean {
  return network.startsWith('solana:')
}

// ─── Nonce Generation ────────────────────────────────────────────────────────

function createNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

function createPermit2Nonce(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  return BigInt(toHex(randomBytes)).toString()
}

// ─── Parse ───────────────────────────────────────────────────────────────────

export function parsePaymentRequired(input: string | object): PaymentRequired {
  let parsed: unknown

  if (typeof input === 'object') {
    parsed = input
  } else {
    const trimmed = input.trim()
    // Try JSON first
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new Error('Invalid payment-required: not valid JSON')
      }
    } else {
      // Treat as base64
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8')
        parsed = JSON.parse(decoded)
      } catch {
        throw new Error('Invalid payment-required: not valid base64-encoded JSON')
      }
    }
  }

  const pr = parsed as Record<string, unknown>
  if (typeof pr.x402Version !== 'number') {
    throw new Error('Invalid payment-required: missing x402Version')
  }
  if (!Array.isArray(pr.accepts) || pr.accepts.length === 0) {
    throw new Error('Invalid payment-required: missing or empty accepts array')
  }
  const normalized = parsed as PaymentRequired
  if (normalized.x402Version === 1) {
    normalized.accepts = normalized.accepts.map((req) => ({
      ...req,
      network: LEGACY_NETWORK_ALIASES[req.network] ?? req.network,
    }))
  }

  return normalized
}

// ─── Select ──────────────────────────────────────────────────────────────────

export function selectPaymentRequirements(
  pr: PaymentRequired,
  options?: {
    supportedChainIds?: readonly number[]
    supportedSolanaNetworks?: readonly string[]
  },
): PaymentRequirements {
  const supportedChainIds = options?.supportedChainIds ?? SUPPORTED_CHAIN_IDS
  const supportedSolana = options?.supportedSolanaNetworks ?? SUPPORTED_SOLANA_NETWORKS

  for (const req of pr.accepts) {
    if (req.scheme !== 'exact') continue

    // Check Solana networks
    if (isSolanaNetwork(req.network)) {
      if ((supportedSolana as readonly string[]).includes(req.network)) {
        return req
      }
      continue
    }

    // Check EVM networks
    try {
      const chainId = getEvmChainId(req.network)
      if (supportedChainIds.includes(chainId)) {
        return req
      }
    } catch {
      // Skip entries with invalid network format
    }
  }

  const evmNames = supportedChainIds.map((id) => CHAIN_NAMES[String(id)] ?? `eip155:${id}`)
  const solNames = supportedSolana.map((n) => CHAIN_NAMES[n] ?? n)
  throw new Error(
    `No supported payment option found. Supported: ${[...evmNames, ...solNames].join(', ')}`,
  )
}

// ─── Build EIP-712 ──────────────────────────────────────────────────────────

export function buildEIP712ForEIP3009(
  wallet: string,
  requirements: PaymentRequirements,
): EIP712Data & { nonce: `0x${string}` } {
  const chainId = getEvmChainId(requirements.network)
  const name = requirements.extra?.name as string | undefined
  const version = requirements.extra?.version as string | undefined

  if (!name || !version) {
    throw new Error(
      `EIP-712 domain parameters (name, version) are required in payment requirements extra for asset ${requirements.asset}`,
    )
  }

  const nonce = createNonce()
  const now = Math.floor(Date.now() / 1000)

  return {
    domain: {
      name,
      version,
      chainId,
      verifyingContract: requirements.asset,
    },
    types: AUTHORIZATION_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: wallet,
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: (now - 600).toString(),
      validBefore: (now + requirements.maxTimeoutSeconds).toString(),
      nonce,
    },
    nonce,
  }
}

export function buildEIP712ForPermit2(
  wallet: string,
  requirements: PaymentRequirements,
): EIP712Data & { nonce: string } {
  const chainId = getEvmChainId(requirements.network)
  const nonce = createPermit2Nonce()
  const now = Math.floor(Date.now() / 1000)
  const validAfter = (now - 600).toString()
  const deadline = (now + requirements.maxTimeoutSeconds).toString()

  return {
    domain: {
      name: 'Permit2',
      chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: PERMIT2_WITNESS_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: {
        token: requirements.asset,
        amount: requirements.amount,
      },
      spender: EXACT_PERMIT2_PROXY_ADDRESS,
      nonce,
      deadline,
      witness: {
        to: requirements.payTo,
        validAfter,
      },
    },
    nonce,
  }
}

// ─── Assemble & Encode ──────────────────────────────────────────────────────

export function assembleEIP3009PaymentPayload(
  x402Version: number,
  requirements: PaymentRequirements,
  eip712: EIP712Data & { nonce: `0x${string}` },
  signature: string,
  resource?: { url: string },
): PaymentPayload {
  return {
    x402Version,
    scheme: requirements.scheme,
    network: requirements.network,
    resource,
    accepted: requirements,
    payload: {
      signature,
      authorization: {
        from: eip712.message.from,
        to: eip712.message.to,
        value: eip712.message.value,
        validAfter: eip712.message.validAfter,
        validBefore: eip712.message.validBefore,
        nonce: eip712.nonce,
      },
    },
  }
}

export function assemblePermit2PaymentPayload(
  x402Version: number,
  requirements: PaymentRequirements,
  eip712: EIP712Data & { nonce: string },
  signature: string,
  wallet: string,
  resource?: { url: string },
): PaymentPayload {
  const msg = eip712.message as {
    permitted: { token: string; amount: string }
    spender: string
    nonce: string
    deadline: string
    witness: { to: string; validAfter: string }
  }
  return {
    x402Version,
    scheme: requirements.scheme,
    network: requirements.network,
    resource,
    accepted: requirements,
    payload: {
      signature,
      permit2Authorization: {
        from: wallet,
        permitted: msg.permitted,
        spender: msg.spender,
        nonce: msg.nonce,
        deadline: msg.deadline,
        witness: msg.witness,
      },
    },
  }
}

export function assembleSvmPaymentPayload(
  x402Version: number,
  requirements: PaymentRequirements,
  transaction: string,
  resource?: { url: string },
): PaymentPayload {
  return {
    x402Version,
    scheme: requirements.scheme,
    network: requirements.network,
    resource,
    accepted: requirements,
    payload: {
      transaction,
    },
  }
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// ─── Describe ────────────────────────────────────────────────────────────────

export function getNetworkDisplayName(network: string): string {
  if (CHAIN_NAMES[network]) return CHAIN_NAMES[network]
  if (isSolanaNetwork(network)) return network
  try {
    const chainId = getEvmChainId(network)
    return CHAIN_NAMES[String(chainId)] ?? `Chain ${chainId}`
  } catch {
    return network
  }
}

export function formatHumanAmount(amount: string, decimals: number): string {
  const raw = BigInt(amount)
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const frac = raw % divisor
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${fracStr}`
}
