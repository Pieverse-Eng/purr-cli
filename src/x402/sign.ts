import { apiPost, resolveCredentials } from '../api-client.js'
import { requireArgOrFile } from '../file-input.js'
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
} from './protocol.js'

interface WalletEnsureResponse {
  ok: boolean
  data: { address: string }
  error?: string
}

interface WalletSignTypedDataResponse {
  ok: boolean
  data: { address: string; signature: string }
  error?: string
}

interface X402SignSolanaResponse {
  ok: boolean
  data: { transaction: string; walletAddress: string }
  error?: string
}

async function signSolana(
  instanceId: string,
  pr: ReturnType<typeof parsePaymentRequired>,
  requirements: ReturnType<typeof selectPaymentRequirements>,
): Promise<void> {
  const feePayer = requirements.extra?.feePayer as string | undefined
  if (!feePayer) {
    throw new Error('feePayer is required in payment requirements extra for Solana x402')
  }

  const decimals = requirements.extra?.decimals as number | undefined

  const signRes = await apiPost<X402SignSolanaResponse>(
    `/v1/instances/${instanceId}/wallet/x402-sign-solana`,
    {
      asset: requirements.asset,
      amount: requirements.amount,
      payTo: requirements.payTo,
      feePayer,
      ...(decimals !== undefined && { decimals }),
    },
  )
  if (!signRes.ok) {
    throw new Error(signRes.error ?? 'Failed to sign Solana x402 transaction')
  }

  const payload = assembleSvmPaymentPayload(
    pr.x402Version,
    requirements,
    signRes.data.transaction,
    pr.resource,
  )
  const paymentSignature = encodePaymentPayload(payload)

  console.log(
    JSON.stringify({
      paymentSignature,
      walletAddress: signRes.data.walletAddress,
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      payTo: requirements.payTo,
    }),
  )
}

async function signEvm(
  instanceId: string,
  pr: ReturnType<typeof parsePaymentRequired>,
  requirements: ReturnType<typeof selectPaymentRequirements>,
): Promise<void> {
  const chainId = getEvmChainId(requirements.network)

  const ensureRes = await apiPost<WalletEnsureResponse>(
    `/v1/instances/${instanceId}/wallet/ensure`,
    { chainType: 'ethereum' },
  )
  if (!ensureRes.ok) {
    throw new Error(ensureRes.error ?? 'Failed to ensure wallet')
  }
  const walletAddress = ensureRes.data.address

  const method = (requirements.extra?.assetTransferMethod as string) ?? 'eip3009'
  let paymentSignature: string

  if (method === 'permit2') {
    const eip712 = buildEIP712ForPermit2(walletAddress, requirements)
    const signRes = await apiPost<WalletSignTypedDataResponse>(
      `/v1/instances/${instanceId}/wallet/sign-typed-data`,
      {
        domain: eip712.domain,
        types: eip712.types,
        primaryType: eip712.primaryType,
        message: eip712.message,
      },
    )
    if (!signRes.ok) {
      throw new Error(signRes.error ?? 'Failed to sign typed data')
    }
    const payload = assemblePermit2PaymentPayload(
      pr.x402Version,
      requirements,
      eip712,
      signRes.data.signature,
      walletAddress,
      pr.resource,
    )
    paymentSignature = encodePaymentPayload(payload)
  } else {
    const eip712 = buildEIP712ForEIP3009(walletAddress, requirements)
    const signRes = await apiPost<WalletSignTypedDataResponse>(
      `/v1/instances/${instanceId}/wallet/sign-typed-data`,
      {
        domain: eip712.domain,
        types: eip712.types,
        primaryType: eip712.primaryType,
        message: eip712.message,
      },
    )
    if (!signRes.ok) {
      throw new Error(signRes.error ?? 'Failed to sign typed data')
    }
    const payload = assembleEIP3009PaymentPayload(
      pr.x402Version,
      requirements,
      eip712,
      signRes.data.signature,
      pr.resource,
    )
    paymentSignature = encodePaymentPayload(payload)
  }

  console.log(
    JSON.stringify({
      paymentSignature,
      walletAddress,
      chainId,
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      payTo: requirements.payTo,
    }),
  )
}

export async function x402Sign(args: Record<string, string>): Promise<void> {
  const { instanceId } = resolveCredentials()

  const input = requireArgOrFile(args, 'payment-required', 'payment-required-file')
  const pr = parsePaymentRequired(input)
  const requirements = selectPaymentRequirements(pr)

  if (isSolanaNetwork(requirements.network)) {
    await signSolana(instanceId, pr, requirements)
  } else {
    await signEvm(instanceId, pr, requirements)
  }
}
