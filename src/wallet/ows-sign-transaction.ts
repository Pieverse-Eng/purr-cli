/**
 * ows-wallet sign-transaction — sign unsigned transactions via OWS local custody.
 *
 * Drop-in replacement for `purr wallet sign-transaction` (Privy-backed): same
 * input JSON schema, same output schema — but signatures are produced locally
 * with OWS (Open Wallet Standard) managed keys instead of the platform TEE.
 * Runs entirely inside the tenant pod, no platform signer call.
 *
 * Supports all signing modes handled by the Privy path EXCEPT gasPayMaster
 * (which needs raw-digest signing, unavailable in OWS SDK 1.2.4):
 *   - Raw EVM transactions (legacy + EIP-1559)
 *   - EIP-712 typed data (via { function: 'signTypeData' } markers)
 *   - Solana transactions (partial-sign preserves other signer slots)
 *   - gasPayMaster raw hash signing  →  REJECTED (exit code 2)
 *
 * Input JSON shape is permissive — the following are all accepted:
 *   { data: { orderId, txs } }   — raw vendor makeOrder response
 *   { orderId, txs }             — unwrapped order
 *   { txs }                      — just the txs array
 */

import {
  getWallet as owsGetWallet,
  signTransaction as owsCoreSignTransaction,
  signTypedData as owsSignTypedData,
} from '@open-wallet-standard/core'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { type TransactionSerializable, serializeTransaction } from 'viem'

import { parseEvmSig } from '../shared.js'

// OWS chain string for Solana. Per docs/sdk-cli.md + docs/07-supported-chains.md,
// OWS accepts chain family names, shorthand aliases, bare EVM chain IDs, and
// CAIP-2 identifiers. For EVM we build `eip155:<chainId>` per-call so that
// policy evaluation (e.g. `allowed_chains: ['eip155:8453']`) sees the real
// target chain — NOT a hardcoded alias like 'ethereum' (which would collapse
// Base/BSC/Arbitrum/Polygon to mainnet and break policy-scoped tokens).
const OWS_CHAIN_SOLANA = 'solana'

function owsEvmChainId(chainId: number): string {
  return `eip155:${chainId}`
}

// ---------------------------------------------------------------------------
// gasPayMaster rejection — OWS SDK 1.2.4 has no raw-digest API.
// ---------------------------------------------------------------------------

export const EXIT_CODE_GASPAYMASTER_UNSUPPORTED = 2

export class GasPayMasterUnsupportedError extends Error {
  readonly code = EXIT_CODE_GASPAYMASTER_UNSUPPORTED
  constructor() {
    super(
      'OWS wallet cannot sign raw digests (gasPayMaster / gasless mode). ' +
        'Retry the vendor confirm step with --feature user_gas.',
    )
    this.name = 'GasPayMasterUnsupportedError'
  }
}

// ---------------------------------------------------------------------------
// Shape detection — mirrors trusted-wallet-service.ts.
// ---------------------------------------------------------------------------

const SOLANA_CHAIN_ID = 501

interface DeriveTransaction {
  to?: string
  calldata?: string
  data?: string
  value?: string | number
  gasLimit?: string | number
  gasPrice?: string | number
  maxFeePerGas?: string | number
  maxPriorityFeePerGas?: string | number
  nonce?: string | number
  chainId?: string | number
  supportEIP1559?: boolean
  msgs?: Array<Record<string, unknown>>
  serializedTransaction?: string
  source?: { serializedTransaction?: string }
  [key: string]: unknown
}

function isSolanaTxItem(txItem: Record<string, unknown>): boolean {
  const derive = txItem.deriveTransaction as DeriveTransaction | undefined
  const chainId = txItem.chainId ?? derive?.chainId
  if (chainId != null && Number(chainId) === SOLANA_CHAIN_ID) return true
  const chain = String(txItem.chain ?? '').toLowerCase()
  if (chain === 'sol' || chain === 'solana') return true
  if (derive?.serializedTransaction) return true
  const source = (txItem.source ?? derive?.source) as { serializedTransaction?: string } | undefined
  if (source?.serializedTransaction) return true
  return false
}

/** Any non-empty msgs[] counts as Shape 3 — matches Privy dispatcher. */
function hasGasPayMasterMsgs(txItem: Record<string, unknown>): boolean {
  const derive = txItem.deriveTransaction as DeriveTransaction | undefined
  const msgs = (txItem.msgs || derive?.msgs) as Array<Record<string, unknown>> | undefined
  return Array.isArray(msgs) && msgs.length > 0
}

// ---------------------------------------------------------------------------
// Decimal parsers — EXACT replicas of trusted-wallet-service.ts helpers.
// ---------------------------------------------------------------------------

function parseDecimalToBigInt(str: string, decimals: number): bigint {
  const [intPart, fracPart = ''] = str.split('.')
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(padded)
}

function parseGasPrice(raw: string | number | undefined): bigint {
  const str = String(raw ?? '0')
  if (str.includes('.')) {
    const f = Number.parseFloat(str)
    if (f > 0 && f < 1) return parseDecimalToBigInt(str, 18)
    return parseDecimalToBigInt(str, 9)
  }
  return BigInt(str)
}

function parseWeiValue(raw: string | number | undefined): bigint {
  const str = String(raw ?? '0')
  if (str.includes('.')) {
    return parseDecimalToBigInt(str, 18)
  }
  return BigInt(str)
}

// ---------------------------------------------------------------------------
// Shape 2: EIP-712 signTypeData — mirrors signEip712TypedData.
// ---------------------------------------------------------------------------

interface SignTypeDataPayload {
  domain?: Record<string, unknown>
  types?: Record<string, unknown>
  primaryType?: string
  message?: Record<string, unknown>
}

function normalizeDomain(domain: Record<string, unknown>): Record<string, unknown> {
  const out = { ...domain }
  if (typeof out.chainId === 'string') {
    const cid = out.chainId as string
    out.chainId = cid.startsWith('0x') ? Number.parseInt(cid, 16) : Number.parseInt(cid, 10)
  }
  return out
}

function signEip712(
  walletName: string,
  token: string | undefined,
  txItem: Record<string, unknown>,
  fallbackChainId: number,
  vaultPath?: string,
): string {
  const payload = txItem.signTypeData as SignTypeDataPayload | undefined
  if (!payload) {
    throw new Error('Tx has function signTypeData but missing signTypeData payload')
  }

  const domain = normalizeDomain(payload.domain ?? {})
  const typedData = {
    domain,
    types: payload.types ?? {},
    primaryType: payload.primaryType ?? 'Order',
    message: payload.message ?? {},
  }

  // Chain passed to OWS drives policy evaluation. Prefer the EIP-712 domain's
  // chainId (that's the chain the tx is semantically bound to); fall back to
  // the CLI --chain-id arg only when domain.chainId is missing.
  const chainId = typeof domain.chainId === 'number' ? domain.chainId : fallbackChainId

  const result = owsSignTypedData(
    walletName,
    owsEvmChainId(chainId),
    JSON.stringify(typedData),
    token,
    undefined,
    vaultPath,
  )
  return result.signature.startsWith('0x') ? result.signature : `0x${result.signature}`
}

// ---------------------------------------------------------------------------
// Shape 4: EVM raw tx — mirrors signSingleTxItem.
// ---------------------------------------------------------------------------

interface UnsignedEvmTxItem {
  to?: string
  data?: string
  value?: string | number
  gasLimit?: string | number
  gasPrice?: string | number
  nonce?: string | number
  chainId?: string | number
  deriveTransaction?: DeriveTransaction
  [key: string]: unknown
}

function buildEvmTxRequest(
  txItem: UnsignedEvmTxItem,
  fallbackChainId: number,
): TransactionSerializable {
  const derive = txItem.deriveTransaction
  const dataHex = (
    typeof txItem.data === 'string' ? txItem.data : (derive?.calldata ?? derive?.data ?? '0x')
  ) as `0x${string}`
  const to = (txItem.to || derive?.to || '') as `0x${string}`
  const nonce = Number(derive?.nonce ?? txItem.nonce ?? 0)
  const gas = BigInt(derive?.gasLimit ?? txItem.gasLimit ?? 0)
  const chainId = Number(txItem.chainId ?? derive?.chainId ?? fallbackChainId)
  const value = parseWeiValue(derive?.value ?? txItem.value)

  if (derive?.supportEIP1559 || derive?.maxFeePerGas) {
    return {
      chainId,
      nonce,
      to,
      value,
      gas,
      maxFeePerGas: BigInt(derive?.maxFeePerGas ?? 0),
      maxPriorityFeePerGas: BigInt(derive?.maxPriorityFeePerGas ?? 0),
      data: dataHex,
      type: 'eip1559' as const,
    }
  }

  return {
    chainId,
    nonce,
    to,
    value,
    gas,
    gasPrice: parseGasPrice(derive?.gasPrice ?? txItem.gasPrice),
    data: dataHex,
    type: 'legacy' as const,
  }
}

function signEvmRawTx(
  walletName: string,
  token: string | undefined,
  txItem: UnsignedEvmTxItem,
  fallbackChainId: number,
  vaultPath?: string,
): string {
  const txRequest = buildEvmTxRequest(txItem, fallbackChainId)
  const unsigned = serializeTransaction(txRequest)

  // OWS Node SDK: signTransaction returns a signature (and optional recoveryId)
  // for the digest of the submitted tx bytes. We then re-serialize with viem,
  // mirroring the field-by-field logic of signSingleTxItem in
  // trusted-wallet-service.ts. Chain id is passed as CAIP-2 so that per-chain
  // policies (e.g. allowed_chains: ['eip155:8453']) evaluate correctly.
  const result = owsCoreSignTransaction(
    walletName,
    owsEvmChainId(txRequest.chainId as number),
    unsigned.startsWith('0x') ? unsigned.slice(2) : unsigned,
    token,
    undefined,
    vaultPath,
  )

  const { r, s, v } = parseEvmSig(
    result.signature,
    (result as { recoveryId?: number | null }).recoveryId,
  )
  return serializeTransaction(txRequest, { r, s, v })
}

// ---------------------------------------------------------------------------
// Shape 1: Solana — sign message bytes, patch sig into user's signer slot.
// ---------------------------------------------------------------------------

function extractSolanaSerializedTx(txItem: Record<string, unknown>): string {
  const derive = txItem.deriveTransaction as DeriveTransaction | undefined

  // 1. txItem.data.serializedTx (nested wrapper)
  const data = txItem.data
  if (typeof data === 'object' && data !== null) {
    const nested = data as Record<string, unknown>
    if (typeof nested.serializedTx === 'string') return nested.serializedTx
  }

  // 2. deriveTransaction.source.serializedTransaction (gasPayMaster mode)
  const deriveSource = derive?.source as Record<string, unknown> | undefined
  if (typeof deriveSource?.serializedTransaction === 'string') {
    return deriveSource.serializedTransaction
  }

  // 3. txItem.source.serializedTransaction
  const txSource = txItem.source as Record<string, unknown> | undefined
  if (typeof txSource?.serializedTransaction === 'string') {
    return txSource.serializedTransaction
  }

  // 4. deriveTransaction.serializedTransaction
  if (typeof derive?.serializedTransaction === 'string') {
    return derive.serializedTransaction
  }

  // 5. txItem.data as raw string (fallback)
  if (typeof data === 'string' && data.length > 0) return data

  throw new Error(
    `Cannot find serialized Solana transaction in tx item (keys: ${Object.keys(txItem).join(', ')})`,
  )
}

function signSolanaTx(
  walletName: string,
  userSolanaAddress: string,
  token: string | undefined,
  txItem: Record<string, unknown>,
  vaultPath?: string,
): string {
  const txBase58 = extractSolanaSerializedTx(txItem)
  const txBytes = bs58.decode(txBase58)

  // VersionedTransaction.deserialize handles both legacy and V0.
  const vtx = VersionedTransaction.deserialize(txBytes)
  const accountKeys = vtx.message.staticAccountKeys
  const numSigners = vtx.message.header.numRequiredSignatures

  const userPubkey = new PublicKey(userSolanaAddress)
  let slotIdx = -1
  for (let i = 0; i < numSigners; i++) {
    if (accountKeys[i].equals(userPubkey)) {
      slotIdx = i
      break
    }
  }
  if (slotIdx < 0) {
    throw new Error(
      `OWS wallet address ${userSolanaAddress} is not a required signer for this Solana tx ` +
        `(signers: ${accountKeys
          .slice(0, numSigners)
          .map((k) => k.toBase58())
          .join(', ')})`,
    )
  }

  // Empirically (SDK v1.2.4): for Solana, signTransaction returns the raw
  // Ed25519 signature of the parsed message bytes without touching other
  // signer slots. We patch it into the user's slot — preserving any relayer
  // signatures already present (partial-sign for gasless flows).
  const result = owsCoreSignTransaction(
    walletName,
    OWS_CHAIN_SOLANA,
    Buffer.from(txBytes).toString('hex'),
    token,
    undefined,
    vaultPath,
  )
  const sigBytes = Buffer.from(result.signature.replace(/^0x/, ''), 'hex')
  if (sigBytes.length !== 64) {
    throw new Error(`Expected 64-byte Ed25519 signature from OWS, got ${sigBytes.length} bytes`)
  }
  vtx.signatures[slotIdx] = new Uint8Array(sigBytes)

  return bs58.encode(vtx.serialize())
}

// ---------------------------------------------------------------------------
// Entry point — mirrors walletSignTransaction signature, adds OWS identity
// fields that Privy gets from the instance config.
// ---------------------------------------------------------------------------

export interface OwsWalletSignOptions {
  /** OWS wallet name or UUID (required). */
  owsWallet: string
  /** OWS API token (`ows_key_...`) or owner passphrase. Empty string accepted. */
  owsToken?: string
  /** Optional vault path override (default ~/.ows/). */
  vaultPath?: string
}

export async function owsWalletSignTransaction(
  txsJson: string,
  chainId: number | undefined,
  opts: OwsWalletSignOptions,
): Promise<{
  orderId?: string
  txs: Array<Record<string, unknown>>
  address: string
}> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(txsJson)
  } catch {
    throw new Error('Invalid --txs-json: not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid --txs-json: expected a JSON object')
  }

  // Support all three shapes: { data: { orderId, txs } }, { orderId, txs }, { txs }
  const data = (parsed.data ?? parsed) as Record<string, unknown>
  const orderId = data.orderId
  const txs = data.txs as Array<Record<string, unknown>> | undefined

  if (orderId !== undefined && typeof orderId !== 'string') {
    throw new Error('--txs-json: orderId, if present, must be a string')
  }
  if (!txs || !Array.isArray(txs) || txs.length === 0) {
    throw new Error('--txs-json must contain a non-empty txs array')
  }

  // OWS-specific: resolve wallet + account addresses. In the Privy path this
  // is implicit via the instance config.
  const wallet = owsGetWallet(opts.owsWallet, opts.vaultPath)
  const evmAccount = wallet.accounts.find((a) => a.chainId === 'eip155:1')
  const solanaAccount = wallet.accounts.find((a) => a.chainId.startsWith('solana:'))

  const needsSolana = txs.some(isSolanaTxItem)
  const needsEvm = txs.some((tx) => !isSolanaTxItem(tx))
  if (needsEvm && !evmAccount) {
    throw new Error(`OWS wallet "${opts.owsWallet}" has no EVM account (eip155)`)
  }
  if (needsSolana && !solanaAccount) {
    throw new Error(`OWS wallet "${opts.owsWallet}" has no Solana account`)
  }

  const fallbackChainId = chainId ?? 56
  const token = opts.owsToken

  // Per-item dispatch — shape detection order matches Privy's signTransaction
  // in trusted-wallet-service.ts (~line 727):
  //   1. Solana           → signSolanaTx
  //   2. signTypeData     → signEip712       (wins over msgs if both present)
  //   3. msgs (Shape 3)   → REJECT (OWS can't sign raw digests)
  //   4. default          → signEvmRawTx
  for (const txItem of txs) {
    if (isSolanaTxItem(txItem)) {
      txItem.sig = signSolanaTx(
        opts.owsWallet,
        solanaAccount!.address,
        token,
        txItem,
        opts.vaultPath,
      )
      continue
    }

    if (txItem.function === 'signTypeData') {
      txItem.sig = signEip712(opts.owsWallet, token, txItem, fallbackChainId, opts.vaultPath)
      continue
    }

    if (hasGasPayMasterMsgs(txItem)) {
      throw new GasPayMasterUnsupportedError()
    }

    txItem.sig = signEvmRawTx(
      opts.owsWallet,
      token,
      txItem as UnsignedEvmTxItem,
      fallbackChainId,
      opts.vaultPath,
    )
  }

  const result: {
    orderId?: string
    txs: Array<Record<string, unknown>>
    address: string
  } = {
    txs,
    address: needsSolana ? (solanaAccount?.address ?? '') : (evmAccount?.address ?? ''),
  }
  if (typeof orderId === 'string') {
    result.orderId = orderId
  }
  return result
}

// ---------------------------------------------------------------------------
// Internal exports for tests (not part of the public API).
// ---------------------------------------------------------------------------

export const __testing = {
  parseGasPrice,
  parseWeiValue,
  parseDecimalToBigInt,
  isSolanaTxItem,
  hasGasPayMasterMsgs,
  buildEvmTxRequest,
  normalizeDomain,
  extractSolanaSerializedTx,
}
