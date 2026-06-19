import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { encodeFunctionData, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildApprovalStep,
  isNative,
  parseBigInt,
  requireAddress,
} from '@pieverseio/purr-core/shared'
import type { StepOutput } from '@pieverseio/purr-core/types'

// ---------------------------------------------------------------------------
// V3 API — build, sign, call in one shot
// Uses the official Aster V3 signing protocol:
//   1. Build an application/x-www-form-urlencoded param string without signature
//   2. Put that string in EIP-712 Message.msg
//   3. Sign typed data with the authorized API wallet
//   4. Call fapi.asterdex.com with all params + signature
// ---------------------------------------------------------------------------

const FAPI_BASE = 'https://fapi.asterdex.com'
const ASTER_EIP712_DOMAIN = {
  name: 'AsterSignTransaction',
  version: '1',
  chainId: 1666,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const
const ASTER_EIP712_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Message: [{ name: 'msg', type: 'string' }],
} as const
const ASTER_LOCAL_SIGN_DOMAIN = {
  ...ASTER_EIP712_DOMAIN,
  chainId: 1666n,
} as const
const ASTER_LOCAL_SIGN_TYPES = {
  Message: ASTER_EIP712_TYPES.Message,
} as const

let lastAsterNonce = 0n

export interface AsterApiArgs {
  method: string
  endpoint: string
  user: string
  privateKey?: string
  signer?: string
  baseUrl?: string
  params?: Record<string, string>
}

interface WalletEnsureResponse {
  ok: boolean
  data: {
    address: string
    chainId: number
    chainType: string
  }
  error?: string
}

interface WalletSignTypedDataResponse {
  ok: boolean
  data: {
    address: string
    signature: string
  }
  error?: string
}

interface PlatformAsterSigner {
  instanceId: string
  signer: string
}

function nextAsterNonce(): bigint {
  const now = BigInt(Date.now()) * 1000n
  lastAsterNonce = now > lastAsterNonce ? now : lastAsterNonce + 1n
  return lastAsterNonce
}

function paramsToString(params: Record<string, string>): string {
  return new URLSearchParams(
    Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ).toString()
}

function buildAsterTypedData(paramString: string) {
  return {
    domain: ASTER_EIP712_DOMAIN,
    types: ASTER_EIP712_TYPES,
    primaryType: 'Message',
    message: { msg: paramString },
  } as const
}

async function resolvePlatformAsterSigner(expectedSigner?: string): Promise<PlatformAsterSigner> {
  const { instanceId } = resolveCredentials()
  const expected = expectedSigner ? requireAddress(expectedSigner, 'signer') : undefined

  const ensure = await apiPost<WalletEnsureResponse>(`/v1/instances/${instanceId}/wallet/ensure`, {
    chainType: 'ethereum',
    chainId: 56,
  })
  if (!ensure.ok) {
    throw new Error(ensure.error ?? 'Failed to resolve platform wallet')
  }
  const signer = requireAddress(ensure.data.address, 'platform wallet address')
  if (expected && signer.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Platform wallet address ${signer} does not match Aster API signer ${expected}`)
  }

  return { instanceId, signer }
}

async function signAsterTypedDataWithPlatformWallet(
  instanceId: string,
  typedData: ReturnType<typeof buildAsterTypedData>,
  signer: string,
): Promise<`0x${string}`> {
  const signed = await apiPost<WalletSignTypedDataResponse>(
    `/v1/instances/${instanceId}/wallet/sign-typed-data`,
    {
      ...typedData,
      intent: {
        kind: 'typed_data',
        primaryType: typedData.primaryType,
        verifyingContract: ASTER_EIP712_DOMAIN.verifyingContract,
        chainId: 'eip155:56',
      },
    },
  )
  if (!signed.ok) {
    throw new Error(signed.error ?? 'Failed to sign Aster API request')
  }
  if (signed.data.address.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(
      `Aster API signature returned unexpected signer ${signed.data.address}; expected ${signer}`,
    )
  }

  const signature = signed.data.signature
  return (signature.startsWith('0x') ? signature : `0x${signature}`) as `0x${string}`
}

export async function asterApi(args: AsterApiArgs): Promise<unknown> {
  const user = requireAddress(args.user, 'user')
  const base = args.baseUrl ?? FAPI_BASE

  if (args.privateKey && args.signer) {
    throw new Error('Use either --private-key or --signer, not both')
  }

  const account = args.privateKey
    ? privateKeyToAccount(
        (args.privateKey.startsWith('0x')
          ? args.privateKey
          : `0x${args.privateKey}`) as `0x${string}`,
      )
    : undefined
  const platformSigner = account ? undefined : await resolvePlatformAsterSigner(args.signer)
  const signer = account?.address ?? (platformSigner as PlatformAsterSigner).signer

  // -- Build params --
  const apiParams: Record<string, string> = {}
  if (args.params) {
    for (const [k, v] of Object.entries(args.params)) {
      apiParams[k] = String(v)
    }
  }
  apiParams.timestamp = String(Date.now())

  // Nonce: microseconds since epoch (matching official: math.trunc(time.time() * 1000000))
  const nonce = nextAsterNonce()
  const signedParams: Record<string, string> = {
    ...apiParams,
    nonce: String(nonce),
    user,
    signer,
  }
  const typedData = buildAsterTypedData(paramsToString(signedParams))

  let signature: `0x${string}`
  if (account) {
    signature = await account.signTypedData({
      domain: ASTER_LOCAL_SIGN_DOMAIN,
      types: ASTER_LOCAL_SIGN_TYPES,
      primaryType: 'Message',
      message: typedData.message,
    })
  } else {
    signature = await signAsterTypedDataWithPlatformWallet(
      (platformSigner as PlatformAsterSigner).instanceId,
      typedData,
      signer,
    )
  }

  // -- Call API --
  const allParams: Record<string, string> = {
    ...signedParams,
    signature,
  }

  const method = args.method.toUpperCase()
  let res: Response

  if (method === 'GET') {
    const qs = paramsToString(allParams)
    res = await fetch(`${base}${args.endpoint}?${qs}`)
  } else {
    res = await fetch(`${base}${args.endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: paramsToString(allParams),
    })
  }

  return res.json()
}

// ---------------------------------------------------------------------------
// Treasury contract ABI (2 functions only)
// ---------------------------------------------------------------------------

const TREASURY_ABI = parseAbi([
  'function deposit(address currency, uint256 amount, uint256 broker) external',
  'function depositNative(uint256 broker) external payable',
])

// ---------------------------------------------------------------------------
// Hardcoded treasury addresses (from Aster security audit whitelist SEC-01)
// ---------------------------------------------------------------------------

const TREASURY_ADDRESSES: Record<number, string> = {
  1: '0x604DD02d620633Ae427888d41bfd15e38483736E', // Ethereum
  56: '0x128463A60784c4D3f46c23Af3f65Ed859Ba87974', // BSC
  42161: '0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5', // Arbitrum
}

const SUPPORTED_CHAINS = Object.keys(TREASURY_ADDRESSES)
  .map(Number)
  .sort((a, b) => a - b)

// ---------------------------------------------------------------------------
// On-chain deposit steps
// ---------------------------------------------------------------------------

export interface AsterDepositArgs {
  token: string
  amountWei: string
  wallet: string
  chainId: number
  broker?: string
}

export function buildAsterDepositSteps(args: AsterDepositArgs): StepOutput {
  requireAddress(args.wallet, 'wallet')
  const amount = parseBigInt(args.amountWei, 'amount-wei')

  let broker: bigint
  if (args.broker) {
    try {
      broker = BigInt(args.broker)
    } catch {
      throw new Error(`Invalid --broker: "${args.broker}" — must be a non-negative integer`)
    }
    if (broker < 0n) {
      throw new Error(`Invalid --broker: "${args.broker}" — must be a non-negative integer`)
    }
  } else {
    broker = 1n
  }

  const treasury = TREASURY_ADDRESSES[args.chainId]
  if (!treasury) {
    throw new Error(
      `Unsupported chain for Aster deposit: ${args.chainId}. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
    )
  }

  if (isNative(args.token)) {
    const data = encodeFunctionData({
      abi: TREASURY_ABI,
      functionName: 'depositNative',
      args: [broker],
    })

    return {
      steps: [
        {
          to: treasury,
          data,
          value: `0x${amount.toString(16)}`,
          chainId: args.chainId,
          label: 'Aster treasury deposit (native)',
        },
      ],
    }
  }

  const tokenAddr = requireAddress(args.token, 'token')

  const depositData = encodeFunctionData({
    abi: TREASURY_ABI,
    functionName: 'deposit',
    args: [tokenAddr, amount, broker],
  })

  return {
    steps: [
      buildApprovalStep(
        tokenAddr,
        treasury,
        args.amountWei,
        args.chainId,
        'Approve token for Aster treasury',
      ),
      {
        to: treasury,
        data: depositData,
        value: '0x0',
        chainId: args.chainId,
        label: 'Aster treasury deposit (ERC-20)',
      },
    ],
  }
}
