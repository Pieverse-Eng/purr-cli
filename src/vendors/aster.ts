import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildApprovalStep, isNative, parseBigInt, requireAddress } from '../shared.js'
import type { StepOutput } from '../types.js'

// ---------------------------------------------------------------------------
// V3 API — build, sign, call in one shot
// Uses the official asterdex/api-docs v3-demo/tx.py signing protocol:
//   1. JSON-encode params (sorted keys, compact, all values as strings)
//   2. ABI-encode: (string, address, address, uint256) = (json, user, signer, nonce)
//   3. keccak256 the ABI-encoded data
//   4. personal_sign the resulting hash with the signer private key
//   5. Call fapi.asterdex.com with all params + signature
// ---------------------------------------------------------------------------

const FAPI_BASE = 'https://fapi.asterdex.com'

export interface AsterApiArgs {
  method: string
  endpoint: string
  user: string
  privateKey: string
  baseUrl?: string
  params?: Record<string, string>
}

export async function asterApi(args: AsterApiArgs): Promise<unknown> {
  const pk = args.privateKey.startsWith('0x') ? args.privateKey : `0x${args.privateKey}`
  const account = privateKeyToAccount(pk as `0x${string}`)
  const user = requireAddress(args.user, 'user')
  const signer = account.address
  const base = args.baseUrl ?? FAPI_BASE

  // -- Build params --
  const apiParams: Record<string, string> = {}
  if (args.params) {
    for (const [k, v] of Object.entries(args.params)) {
      apiParams[k] = String(v)
    }
  }
  if (!apiParams.recvWindow) apiParams.recvWindow = '50000'
  apiParams.timestamp = String(Date.now())

  // Nonce: microseconds since epoch (matching official: math.trunc(time.time() * 1000000))
  const nonce = BigInt(Date.now()) * 1000n

  // JSON encode: sorted keys, compact
  const sorted = Object.fromEntries(
    Object.entries(apiParams).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  const jsonStr = JSON.stringify(sorted)

  // ABI encode → keccak256 → personal_sign
  const encoded = encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [jsonStr, user as `0x${string}`, signer as `0x${string}`, nonce],
  )
  const hash = keccak256(encoded)
  const signature = await account.signMessage({ message: { raw: hash } })

  // -- Call API --
  const allParams: Record<string, string> = {
    ...apiParams,
    nonce: String(nonce),
    user,
    signer,
    signature,
  }

  const method = args.method.toUpperCase()
  let res: Response

  if (method === 'GET') {
    const qs = new URLSearchParams(allParams).toString()
    res = await fetch(`${base}${args.endpoint}?${qs}`)
  } else {
    res = await fetch(`${base}${args.endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(allParams).toString(),
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
