/**
 * ows-wallet execute-steps — local OWS execution of TxStep[] sequences.
 *
 * Drop-in replacement for `purr execute` (which POSTs to api-server
 * /wallet/execute). Same input schema (`{steps: TxStep[]}`), same output
 * schema (`{results, from, chainId, chainType}`).
 *
 * Mirrors the algorithm of api-server services/step-executor.ts:
 *   1. Validate all chainIds match
 *   2. For each step:
 *      a. If conditional `allowance_lt`: query ERC-20 allowance; skip if enough
 *      b. Otherwise: build EVM tx → sign with OWS → broadcast → wait for receipt
 *         (last step's receipt wait is skipped to return tx hash immediately)
 *   3. Return results array
 *
 * Differences from server path:
 *   - No DB / instance lookup — wallet address comes from OWS getWallet
 *   - No platform dedup — agent is responsible
 *   - JSON-RPC over fetch (not Privy plugin) — direct EVM RPC calls
 *   - Skip Solana — TxStep is EVM-only by design (see types.ts)
 */

import {
  type TransactionSerializable,
  encodeFunctionData,
  isAddress,
  isHex,
  parseAbi,
  serializeTransaction,
} from 'viem'

import { parseEvmSig } from '../shared.js'

import {
  getWallet as owsGetWallet,
  signAndSend as owsCoreSignAndSend,
} from '@open-wallet-standard/core'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STEPS = 10
const RECEIPT_POLL_MS = 2_000
const RECEIPT_MAX_ATTEMPTS = 60 // 2 min total

// Default public RPCs — mirror api-server services/evm.ts CHAIN_CONFIG.
// Keep this list aligned with server SUPPORTED_CHAIN_IDS so behavior matches.
const DEFAULT_RPCS: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  97: 'https://bsc-testnet-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  1001: 'https://public-en-kairos.node.kaia.io',
  2818: 'https://rpc.morph.network',
  8217: 'https://public-en.node.kaia.io',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  46630: 'https://rpc.testnet.chain.robinhood.com',
}

const SUPPORTED_CHAIN_IDS = Object.keys(DEFAULT_RPCS)
  .map(Number)
  .sort((a, b) => a - b)

// OWS chain id is CAIP-2 — drives per-chain policy evaluation.
export function owsEvmChainId(chainId: number): string {
  return `eip155:${chainId}`
}

// Minimum maxFeePerGas — clears BSC private TX service min (~0.05 gwei) and
// covers stale eth_gasPrice on public RPCs. Also exported so build-transfer
// reproduces the same gas pricing the executor uses.
export const MIN_MAX_FEE = 1_000_000_000n

/**
 * Ensure hex string has even length — some upstream APIs (e.g. certain swap
 * routers) emit `0xabc` style calldata that some RPCs reject. Server's
 * step-executor.ts has the same helper for the same reason.
 */
export function normalizeHex(hex: string): string {
  if (!hex || hex === '0x') return '0x'
  if (hex.startsWith('0x') && hex.length % 2 !== 0) {
    return `0x0${hex.slice(2)}`
  }
  return hex
}

/**
 * Validate a TxStep BEFORE building / signing — fail fast on malformed input.
 * Mirrors trusted-wallet-service.ts validation (~L1060–1088): `to`, `data`,
 * `value`, `gasLimit` must all be valid hex/address strings if present.
 */
function validateStep(step: TxStep, idx: number): void {
  if (typeof step !== 'object' || step === null) {
    throw new Error(`Step ${idx}: not an object`)
  }
  if (typeof step.to !== 'string' || !isAddress(step.to)) {
    throw new Error(`Step ${idx}: invalid 'to' address: ${JSON.stringify(step.to)}`)
  }
  if (step.data !== undefined && step.data !== '' && !isHex(step.data)) {
    throw new Error(`Step ${idx}: 'data' must be a hex string starting with 0x`)
  }
  const value = step.value ?? '0x0'
  if (!isHex(value)) {
    throw new Error(
      `Step ${idx}: 'value' must be a hex string (e.g. "0x0"), got ${JSON.stringify(step.value)}`,
    )
  }
  if (step.gasLimit !== undefined && !isHex(step.gasLimit)) {
    throw new Error(
      `Step ${idx}: 'gasLimit' must be a hex string, got ${JSON.stringify(step.gasLimit)}`,
    )
  }
  if (typeof step.chainId !== 'number' || !Number.isFinite(step.chainId) || step.chainId <= 0) {
    throw new Error(`Step ${idx}: 'chainId' must be a positive number`)
  }
  if (step.conditional) {
    const c = step.conditional
    if (c.type !== 'allowance_lt') {
      throw new Error(`Step ${idx}: unsupported conditional type "${c.type}"`)
    }
    if (typeof c.token !== 'string' || !isAddress(c.token)) {
      throw new Error(`Step ${idx}: conditional.token invalid`)
    }
    if (typeof c.spender !== 'string' || !isAddress(c.spender)) {
      throw new Error(`Step ${idx}: conditional.spender invalid`)
    }
    if (typeof c.amount !== 'string' || c.amount.length === 0) {
      throw new Error(`Step ${idx}: conditional.amount required`)
    }
    try {
      BigInt(c.amount) // wei (decimal or hex both fine)
    } catch {
      throw new Error(`Step ${idx}: conditional.amount not parseable as BigInt`)
    }
  }
}

// ---------------------------------------------------------------------------
// Types — mirror src/types.ts and api-server step-executor.ts
// ---------------------------------------------------------------------------

export interface ConditionalCheck {
  type: 'allowance_lt'
  token: string
  spender: string
  amount: string
}

export interface TxStep {
  to: string
  data: string
  value: string
  chainId: number
  label?: string
  gasLimit?: string
  conditional?: ConditionalCheck
}

export interface StepResult {
  stepIndex: number
  label?: string
  hash: string
  status: 'success' | 'skipped'
}

export interface ExecuteStepsOwsInput {
  stepsJson: string
  owsWallet: string
  owsToken?: string
  rpcUrl?: string
  vaultPath?: string
}

export interface ExecuteStepsOwsResult {
  results: StepResult[]
  from: string
  chainId: number
  chainType: 'ethereum'
}

export class OwsStepExecutionError extends Error {
  constructor(
    message: string,
    public readonly partialResults: StepResult[],
    public readonly failedStepIndex: number,
  ) {
    super(message)
    this.name = 'OwsStepExecutionError'
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers (EVM)
// ---------------------------------------------------------------------------

interface RpcResponse<T> {
  jsonrpc: string
  id: number
  result?: T
  error?: { code: number; message: string }
}

let rpcReqId = 1

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

export async function getNonce(rpcUrl: string, address: string): Promise<number> {
  const hex = await evmRpc<string>(rpcUrl, 'eth_getTransactionCount', [address, 'pending'])
  return Number.parseInt(hex, 16)
}

export async function getGasPrice(rpcUrl: string): Promise<bigint> {
  const hex = await evmRpc<string>(rpcUrl, 'eth_gasPrice', [])
  return BigInt(hex)
}

export async function estimateGas(
  rpcUrl: string,
  tx: { from: string; to: string; data: string; value: string },
): Promise<bigint> {
  const hex = await evmRpc<string>(rpcUrl, 'eth_estimateGas', [tx])
  // Add 20% buffer for safety, mirror common practice.
  const raw = BigInt(hex)
  return (raw * 120n) / 100n
}

const ERC20_ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
])

async function getErc20Allowance(
  rpcUrl: string,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner as `0x${string}`, spender as `0x${string}`],
  })
  const hex = await evmRpc<string>(rpcUrl, 'eth_call', [{ to: token, data }, 'latest'])
  return BigInt(hex)
}

async function _sendRawTransaction(rpcUrl: string, signedHex: string): Promise<string> {
  return evmRpc<string>(rpcUrl, 'eth_sendRawTransaction', [signedHex])
}

export async function getChainId(rpcUrl: string): Promise<number> {
  const hex = await evmRpc<string>(rpcUrl, 'eth_chainId', [])
  return Number.parseInt(hex, 16)
}

interface RpcReceipt {
  status: string // '0x1' success, '0x0' reverted
  transactionHash: string
  blockNumber: string
}

async function waitForReceipt(rpcUrl: string, hash: string): Promise<RpcReceipt> {
  for (let i = 0; i < RECEIPT_MAX_ATTEMPTS; i++) {
    try {
      const r = await evmRpc<RpcReceipt | null>(rpcUrl, 'eth_getTransactionReceipt', [hash])
      if (r) return r
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS))
  }
  throw new Error(`Tx receipt timed out for ${hash}`)
}

// ---------------------------------------------------------------------------
// OWS signing — viem build → OWS signAndSend
// ---------------------------------------------------------------------------

/**
 * Build an unsigned EVM tx and hand it to OWS `signAndSend`, which signs
 * locally and broadcasts via the OWS SDK. Returns the on-chain tx hash.
 *
 * This replaces the prior two-step sign-then-broadcast pattern with a single
 * SDK call. Receipt polling (for intermediate steps) is still done separately
 * by the outer loop — `signAndSend` only returns after broadcast, not after
 * inclusion.
 */
async function signAndBroadcastStep(args: {
  walletName: string
  token: string | undefined
  vaultPath?: string
  rpcUrl: string
  fromAddress: string
  step: TxStep
}): Promise<string> {
  const { walletName, token, vaultPath, rpcUrl, fromAddress, step } = args

  const dataHex = normalizeHex(step.data || '0x') as `0x${string}`
  const valueWei = BigInt(step.value || '0x0')

  const [nonce, gasPrice] = await Promise.all([getNonce(rpcUrl, fromAddress), getGasPrice(rpcUrl)])
  const gas = step.gasLimit
    ? BigInt(step.gasLimit)
    : await estimateGas(rpcUrl, {
        from: fromAddress,
        to: step.to,
        data: dataHex,
        value: `0x${valueWei.toString(16)}`,
      })

  // OWS signAndSend rejects legacy (type 0) EVM txs — demands 0x01/0x02.
  // Build as EIP-1559 (type 2). We need non-trivial gas pricing because:
  //   - eth_gasPrice on some public RPCs returns stale / underpriced values
  //   - OWS's internal BSC routing uses a private TX service with its own
  //     minimum gas price (seen: 0.05 gwei). Our max(2×gasPrice, 1 gwei floor,
  //     module const MIN_MAX_FEE) clears typical minimums on BSC / L2s.
  const doubledGasPrice = gasPrice * 2n
  const maxFeePerGas = doubledGasPrice > MIN_MAX_FEE ? doubledGasPrice : MIN_MAX_FEE
  const maxPriorityFeePerGas = maxFeePerGas / 10n > 0n ? maxFeePerGas / 10n : 1n
  const txRequest: TransactionSerializable = {
    chainId: step.chainId,
    nonce,
    to: step.to as `0x${string}`,
    value: valueWei,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    data: dataHex,
    type: 'eip1559',
  }

  const unsigned = serializeTransaction(txRequest)
  const hex = unsigned.startsWith('0x') ? unsigned.slice(2) : unsigned

  const result = owsCoreSignAndSend(
    walletName,
    owsEvmChainId(step.chainId),
    hex,
    token,
    undefined, // index
    rpcUrl,
    vaultPath,
  ) as { txHash?: string; hash?: string }

  const hash = result.txHash ?? result.hash
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error('OWS signAndSend returned no txHash')
  }
  return hash
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function resolveRpcUrl(chainId: number, override?: string): string {
  if (override) return override
  const envOverride = process.env[`EVM_RPC_${chainId}`] || process.env.EVM_RPC_URL
  if (envOverride) return envOverride
  const def = DEFAULT_RPCS[chainId]
  if (!def) {
    throw new Error(
      `No RPC URL for chainId ${chainId}. Pass --rpc-url, set EVM_RPC_${chainId} env, or extend DEFAULT_RPCS.`,
    )
  }
  return def
}

export async function owsExecuteSteps(input: ExecuteStepsOwsInput): Promise<ExecuteStepsOwsResult> {
  let parsed: { steps?: unknown }
  try {
    parsed = JSON.parse(input.stepsJson)
  } catch {
    throw new Error('Invalid --steps-json: not valid JSON')
  }
  const steps = (parsed.steps ?? parsed) as unknown
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('--steps-json must contain a non-empty steps array')
  }
  const stepArr = steps as TxStep[]
  if (stepArr.length > MAX_STEPS) {
    throw new Error(`Too many steps: ${stepArr.length} (max ${MAX_STEPS})`)
  }

  // Per-step structural validation — fail fast on malformed input (mirrors
  // server's trusted-wallet-service.ts validation).
  for (let i = 0; i < stepArr.length; i++) {
    validateStep(stepArr[i], i)
  }

  // All steps must target the same chain + chain must be in the supported
  // set (mirror api-server step-executor.ts L91 + L94-103).
  const chainId = stepArr[0].chainId
  for (const s of stepArr) {
    if (s.chainId !== chainId) {
      throw new Error(`Mixed chainIds: ${chainId} and ${s.chainId}. All steps must match.`)
    }
  }
  // Allowlist check — only enforced when no --rpc-url override (the override
  // implies user knows what they're doing on a custom chain).
  if (!input.rpcUrl && !SUPPORTED_CHAIN_IDS.includes(chainId)) {
    throw new Error(
      `Unsupported chainId ${chainId}. Supported: ${SUPPORTED_CHAIN_IDS.join(', ')}. Pass --rpc-url to override.`,
    )
  }

  const rpcUrl = resolveRpcUrl(chainId, input.rpcUrl)

  // RPC sanity check — refuse to proceed if RPC reports a different chainId
  // than what the steps target. Catches stale EVM_RPC_URL / wrong --rpc-url.
  try {
    const reportedChainId = await getChainId(rpcUrl)
    if (reportedChainId !== chainId) {
      throw new Error(
        `RPC at ${rpcUrl} reports chainId ${reportedChainId}, but steps target ${chainId}. Refusing to broadcast.`,
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Refusing to broadcast')) throw err
    throw new Error(
      `Failed to verify RPC chainId at ${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const wallet = owsGetWallet(input.owsWallet, input.vaultPath)
  const evmAccount = wallet.accounts.find((a) => a.chainId === 'eip155:1')
  if (!evmAccount) {
    throw new Error(`OWS wallet "${input.owsWallet}" has no EVM account`)
  }
  const fromAddress = evmAccount.address

  const results: StepResult[] = []

  for (let i = 0; i < stepArr.length; i++) {
    const step = stepArr[i]

    // Conditional check: skip if ERC-20 allowance already sufficient
    if (step.conditional?.type === 'allowance_lt') {
      const allowance = await getErc20Allowance(
        rpcUrl,
        step.conditional.token,
        fromAddress,
        step.conditional.spender,
      )
      const required = BigInt(step.conditional.amount)
      if (allowance >= required) {
        results.push({ stepIndex: i, label: step.label, hash: '', status: 'skipped' })
        continue
      }
    }

    // OWS signs locally and broadcasts in a single SDK call — no manual
    // eth_sendRawTransaction step.
    let hash: string
    try {
      hash = await signAndBroadcastStep({
        walletName: input.owsWallet,
        token: input.owsToken,
        vaultPath: input.vaultPath,
        rpcUrl,
        fromAddress,
        step,
      })
    } catch (err) {
      throw new OwsStepExecutionError(
        `Step ${i} (${step.label ?? 'unnamed'}) signAndSend failed: ${err instanceof Error ? err.message : String(err)}`,
        results,
        i,
      )
    }

    const isLast = i === stepArr.length - 1
    if (!isLast) {
      try {
        const receipt = await waitForReceipt(rpcUrl, hash)
        if (receipt.status !== '0x1') {
          throw new OwsStepExecutionError(
            `Step ${i} (${step.label ?? 'unnamed'}) reverted on-chain: ${hash}`,
            results,
            i,
          )
        }
      } catch (err) {
        if (err instanceof OwsStepExecutionError) throw err
        throw new OwsStepExecutionError(
          `Step ${i} (${step.label ?? 'unnamed'}) receipt error: ${err instanceof Error ? err.message : String(err)}`,
          results,
          i,
        )
      }
    }

    results.push({ stepIndex: i, label: step.label, hash, status: 'success' })
  }

  return { results, from: fromAddress, chainId, chainType: 'ethereum' }
}

// Internal exports for tests
export const __testing = {
  parseEvmSig,
  resolveRpcUrl,
  owsEvmChainId,
  normalizeHex,
  validateStep,
  SUPPORTED_CHAIN_IDS,
}
