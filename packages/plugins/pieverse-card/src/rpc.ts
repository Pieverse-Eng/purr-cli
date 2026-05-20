import { decodeFunctionResult, type Hex, encodeFunctionData } from 'viem'
import { ERC8183_ABI } from './abi.js'
import { BNB_CHAIN_ID, DEFAULT_RPCS, RECEIPT_POLL_MS, RECEIPT_TIMEOUT_MS } from './constants.js'
import { requireEvmAddress, sleep } from './guards.js'
import type {
  OnChainJob,
  PieverseCardOptions,
  PurchaseIntent,
  RpcReceipt,
  RpcResponse,
} from './types.js'

let rpcReqId = 1

export async function readOnChainJob(intent: PurchaseIntent, jobId: string): Promise<OnChainJob> {
  const data = encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  })
  const raw = await evmRpc<Hex>(resolveRpcUrl(intent.chainId), 'eth_call', [
    {
      to: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
      data,
    },
    'latest',
  ])
  const decoded = decodeFunctionResult({
    abi: ERC8183_ABI,
    functionName: 'getJob',
    data: raw,
  }) as unknown
  const job = normalizeOnChainJob(decoded)
  if (!job) {
    throw new Error(`ERC-8183 getJob returned an invalid job for jobId ${jobId}`)
  }
  return job
}

export async function readCommercePaymentToken(intent: PurchaseIntent): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'paymentToken',
  })
  const raw = await evmRpc<Hex>(resolveRpcUrl(intent.chainId), 'eth_call', [
    {
      to: requireEvmAddress(intent.commerceAddress, 'erc8183.commerceAddress'),
      data,
    },
    'latest',
  ])
  const decoded = decodeFunctionResult({
    abi: ERC8183_ABI,
    functionName: 'paymentToken',
    data: raw,
  })
  if (typeof decoded !== 'string') throw new Error('ERC-8183 paymentToken returned invalid data')
  return requireEvmAddress(decoded, 'erc8183.paymentToken')
}

function normalizeOnChainJob(decoded: unknown): OnChainJob | null {
  const job = Array.isArray(decoded) ? decoded[0] : decoded
  if (!job || typeof job !== 'object') return null
  const record = job as Record<string, unknown>
  const tuple = job as ArrayLike<unknown>
  const id = (record.id ?? tuple[0]) as unknown
  const expiredAt = (record.expiredAt ?? tuple[6]) as unknown
  const status = (record.status ?? tuple[7]) as unknown
  if (typeof id !== 'bigint' || typeof expiredAt !== 'bigint') return null
  return { id, expiredAt, status: Number(status) }
}

export async function waitForReceipt(
  chainId: number,
  txHash: string,
  options: PieverseCardOptions,
): Promise<RpcReceipt> {
  const rpcUrl = resolveRpcUrl(chainId)
  const pollMs = options.receiptPollMs ?? RECEIPT_POLL_MS
  const deadline = Date.now() + (options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS)
  let lastError: unknown

  while (Date.now() <= deadline) {
    let receipt: RpcReceipt | null
    try {
      receipt = await evmRpc<RpcReceipt | null>(rpcUrl, 'eth_getTransactionReceipt', [txHash])
    } catch (error) {
      lastError = error
      await sleep(pollMs)
      continue
    }

    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`transaction reverted: ${txHash}`)
      return receipt
    }

    await sleep(pollMs)
  }

  const reason = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for tx receipt ${txHash}${reason}`)
}

export function resolveRpcUrl(chainId: number): string {
  const envOverride =
    process.env[`EVM_RPC_${chainId}`] ||
    (chainId === BNB_CHAIN_ID ? process.env.BNB_RPC_URL : undefined) ||
    process.env.EVM_RPC_URL
  if (envOverride) return envOverride
  const def = DEFAULT_RPCS[chainId]
  if (!def && chainId === BNB_CHAIN_ID) return 'https://bsc-rpc.publicnode.com'
  if (!def) throw new Error(`No RPC URL configured for chainId ${chainId}`)
  return def
}

async function evmRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcReqId++, method, params }),
  })
  if (!res.ok) {
    throw new Error(`EVM RPC ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = (await res.json()) as RpcResponse<T>
  if (json.error) {
    throw new Error(`EVM RPC ${method} error ${json.error.code}: ${json.error.message}`)
  }
  if (json.result === undefined) {
    throw new Error(`EVM RPC ${method} returned no result`)
  }
  return json.result
}
