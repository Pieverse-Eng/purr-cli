/**
 * ows-wallet build-transfer — builds an unsigned transfer tx and emits the
 * hex bytes for the agent to sign+broadcast with `ows sign send-tx`.
 *
 * Two-step flow (replaces the old fat `transfer` CLI):
 *
 *   1. purr ows-wallet build-transfer ...   → unsigned tx hex on stdout
 *   2. ows sign send-tx --chain ... --wallet ... --tx <hex>   → on-chain hash
 *
 * Mirrors the flag surface of `purr wallet transfer` so agents can swap in
 * OWS without re-learning args. EVM (native + ERC-20) builds an EIP-1559
 * type-2 tx with nonce / gas already populated. Solana (native + SPL) builds
 * the same byte format the OWS Node SDK consumes — `ows sign send-tx`
 * accepts identical input.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  type TransactionSerializable,
  encodeFunctionData,
  isAddress,
  parseAbi,
  parseUnits,
  serializeTransaction,
} from 'viem'

import { getWallet as owsGetWallet } from '@open-wallet-standard/core'

import {
  MIN_MAX_FEE,
  estimateGas,
  getChainId,
  getGasPrice,
  getNonce,
  normalizeHex,
  owsEvmChainId,
  resolveRpcUrl,
} from './ows-execute-steps.js'

const NATIVE_GAS_LIMIT = 21_000n
const ERC20_GAS_LIMIT = 100_000n
const SOL_DECIMALS = 9
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
// Freshness window after which the agent SHOULD rebuild rather than sign.
// EVM: nonce / gas drift. Solana: blockhash ~60s validity. We don't enforce
// this — `ows sign send-tx` will reject stale txs anyway — but we emit the
// deadline so agents can rebuild preemptively without a round-trip failure.
const TX_FRESHNESS_SECONDS = 60

// Classic SPL Token v1 (Token-2022 is a separate program; v1 covers
// USDC / USDT / BONK / JUP / RAY / JITOSOL — all common tokens as of 2026).
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
)
// TransferChecked (12) embeds expected decimals on-chain — wrong --decimals
// fails cleanly instead of silently moving 1000× amount.
const SPL_TRANSFER_CHECKED_OPCODE = 12
// Idempotent ATA create — tolerates concurrent creates between our existence
// check and the tx landing on-chain.
const ATA_CREATE_IDEMPOTENT_OPCODE = 1

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
])

// ---------------------------------------------------------------------------
// EVM decimals lookup (for ERC-20 when --decimals not provided)
// ---------------------------------------------------------------------------

interface EvmRpcResult<T> {
  jsonrpc: string
  id: number
  result?: T
  error?: { code: number; message: string }
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })
  const json = (await res.json()) as EvmRpcResult<string>
  if (json.error) throw new Error(`eth_call failed: ${json.error.message}`)
  if (!json.result) throw new Error('eth_call returned no result')
  return json.result
}

async function getTokenDecimals(rpcUrl: string, token: string): Promise<number> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'decimals', args: [] })
  const hex = await ethCall(rpcUrl, token, data)
  return Number.parseInt(hex, 16)
}

// ---------------------------------------------------------------------------
// Solana SPL helpers — hand-rolled instructions (no @solana/spl-token dep)
// ---------------------------------------------------------------------------

function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
}

function buildSplTransferCheckedInstruction(
  sourceAta: PublicKey,
  mint: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10)
  data.writeUInt8(SPL_TRANSFER_CHECKED_OPCODE, 0)
  data.writeBigUInt64LE(amount, 1)
  data.writeUInt8(decimals, 9)
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}

function buildCreateAtaIdempotentInstruction(
  payer: PublicKey,
  newAta: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: newAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([ATA_CREATE_IDEMPOTENT_OPCODE]),
  })
}

async function fetchMintInfo(
  connection: Connection,
  mint: PublicKey,
): Promise<{ decimals: number }> {
  const info = await connection.getParsedAccountInfo(mint)
  const value = info.value
  if (!value) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`)
  }
  if (!value.owner.equals(SPL_TOKEN_PROGRAM_ID)) {
    throw new Error(
      `Mint ${mint.toBase58()} is owned by ${value.owner.toBase58()}, not the classic SPL Token program. Token-2022 and other token programs are not supported.`,
    )
  }
  if (
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'parsed' in value.data
  ) {
    const parsed = (value.data as { parsed?: unknown }).parsed
    if (parsed && typeof parsed === 'object' && 'info' in parsed) {
      const decimals = (parsed as { info?: { decimals?: number } }).info?.decimals
      if (typeof decimals === 'number') return { decimals }
    }
  }
  throw new Error(`Failed to parse mint decimals for ${mint.toBase58()}`)
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface OwsBuildTransferInput {
  // One of --ows-wallet (look up from local OWS vault) or --from (raw addr)
  // is required. --ows-wallet is more ergonomic; --from skips the SDK lookup.
  owsWallet?: string
  from?: string
  to: string
  amount: string
  chainType?: 'ethereum' | 'solana'
  chainId?: number
  token?: string // EVM ERC-20 address, or Solana SPL mint
  decimals?: number // optional EVM override; Solana SPL cross-checks on-chain
  rpcUrl?: string
  vaultPath?: string // for owsGetWallet lookup when --ows-wallet supplied
  // EVM-only override: explicit gas limit (decimal or 0x hex). Useful on L2s
  // (Morph, Hyperliquid, ...) where the protocol's 21000 native-transfer
  // floor is below the actual cost (L1 data-availability fees, custom
  // precompiles). When omitted, native transfers use 21000 and ERC-20
  // transfers use eth_estimateGas.
  gasLimit?: string
}

export type OwsBuildTransferKind = 'evm-eip1559' | 'solana'

interface FreshnessMeta {
  builtAt: string // ISO timestamp at build
  staleAfter: string // ISO timestamp past which agent should rebuild
}

export interface OwsBuildTransferEvmMeta extends FreshnessMeta {
  nonce: number
  gasLimit: string // hex
  maxFeePerGas: string // hex
  maxPriorityFeePerGas: string // hex
  rpcUrl: string
  rpcUrlOverridden: boolean // true if --rpc-url was passed (sign step should match)
}

export interface OwsBuildTransferSolanaMeta extends FreshnessMeta {
  recentBlockhash: string
  rpcUrl: string
  rpcUrlOverridden: boolean
  createsDestinationAta?: boolean // SPL only
}

export interface OwsBuildTransferResult {
  chain: string // CAIP-2 — passes straight to `ows sign send-tx --chain`
  kind: OwsBuildTransferKind
  from: string
  to: string
  amount: string
  token?: string
  unsignedTxHex: string // pass to `ows sign send-tx --tx`
  nextStep: string // ready-to-run hint command
  meta: OwsBuildTransferEvmMeta | OwsBuildTransferSolanaMeta
}

// ---------------------------------------------------------------------------
// Sender resolution — prefer explicit --from, fall back to OWS vault lookup
// ---------------------------------------------------------------------------

type SenderResolution = 'from' | 'ows-wallet' | 'from+ows-wallet'

function validateSenderFormat(addr: string, expected: 'evm' | 'solana', source: string): void {
  if (expected === 'evm' && !isAddress(addr)) {
    throw new Error(`${source} is not a valid EVM address: ${JSON.stringify(addr)}`)
  }
  if (expected === 'solana') {
    try {
      new PublicKey(addr)
    } catch {
      throw new Error(`${source} is not a valid Solana address: ${JSON.stringify(addr)}`)
    }
  }
}

function lookupOwsAddress(
  owsWallet: string,
  vaultPath: string | undefined,
  expected: 'evm' | 'solana',
): string {
  const wallet = owsGetWallet(owsWallet, vaultPath)
  const account = wallet.accounts.find((a) =>
    expected === 'evm' ? a.chainId === 'eip155:1' : a.chainId.startsWith('solana:'),
  )
  if (!account) {
    throw new Error(`OWS wallet "${owsWallet}" has no ${expected} account`)
  }
  return account.address
}

/**
 * Resolve the sender address + enforce the contract that the address we build
 * against matches the wallet that will sign later.
 *
 * The unsigned EIP-1559 tx does NOT carry a sender — the signer recovers from
 * signature. That means if we pin a nonce for address A but the agent later
 * signs with wallet B, the tx can still broadcast from B if nonces happen to
 * line up ("send from wrong account" footgun). So when both --from and
 * --ows-wallet are supplied, we look up the wallet and hard-fail on mismatch.
 */
function resolveSender(
  input: OwsBuildTransferInput,
  expected: 'evm' | 'solana',
): { from: string; resolvedVia: SenderResolution } {
  if (input.from && input.owsWallet) {
    validateSenderFormat(input.from, expected, '--from')
    const resolved = lookupOwsAddress(input.owsWallet, input.vaultPath, expected)
    const match =
      expected === 'evm'
        ? resolved.toLowerCase() === input.from.toLowerCase()
        : resolved === input.from
    if (!match) {
      throw new Error(
        `--from (${input.from}) does not match the ${expected} address of --ows-wallet "${input.owsWallet}" (${resolved}). ` +
          `Building with one sender and signing with another would either fail or broadcast from the wrong account. ` +
          `Drop one of the flags, or align them.`,
      )
    }
    return { from: resolved, resolvedVia: 'from+ows-wallet' }
  }
  if (input.from) {
    validateSenderFormat(input.from, expected, '--from')
    return { from: input.from, resolvedVia: 'from' }
  }
  if (!input.owsWallet) {
    throw new Error('Provide --from <address> or --ows-wallet <name>')
  }
  return {
    from: lookupOwsAddress(input.owsWallet, input.vaultPath, expected),
    resolvedVia: 'ows-wallet',
  }
}

// ---------------------------------------------------------------------------
// Shared output helpers
// ---------------------------------------------------------------------------

function buildFreshness(): FreshnessMeta {
  const now = Date.now()
  return {
    builtAt: new Date(now).toISOString(),
    staleAfter: new Date(now + TX_FRESHNESS_SECONDS * 1000).toISOString(),
  }
}

/**
 * Build the `nextStep` hint command. When the builder used --rpc-url, the
 * sign step MUST use the same endpoint — on Solana a blockhash from cluster
 * A is invalid on cluster B; on EVM the sign step needs to broadcast where
 * nonce and fees are priced against. We only echo --rpc-url when it was
 * explicitly passed as a flag, not when pulled from env (env carries through
 * to the child process anyway).
 */
function buildNextStep(args: {
  chain: string
  owsWallet: string | undefined
  unsignedTxHex: string
  rpcUrlFlag: string | undefined
}): string {
  const wallet = args.owsWallet ?? '<wallet-name>'
  const rpcFlag = args.rpcUrlFlag ? ` --rpc-url ${args.rpcUrlFlag}` : ''
  return `ows sign send-tx --chain ${args.chain} --wallet ${wallet} --tx ${args.unsignedTxHex}${rpcFlag} --json`
}

// ---------------------------------------------------------------------------
// EVM build (native + ERC-20)
// ---------------------------------------------------------------------------

async function buildEvmUnsigned(
  input: OwsBuildTransferInput,
): Promise<OwsBuildTransferResult> {
  if (!isAddress(input.to)) {
    throw new Error(`Invalid EVM --to address: ${JSON.stringify(input.to)}`)
  }
  if (input.chainId === undefined || !Number.isFinite(input.chainId) || input.chainId <= 0) {
    throw new Error('--chain-id must be a positive number for EVM transfers')
  }

  const { from } = resolveSender(input, 'evm')
  const rpcUrl = resolveRpcUrl(input.chainId, input.rpcUrl)

  // RPC sanity — refuse to build for the wrong chain (mirrors execute-steps
  // pre-flight). Catches stale EVM_RPC_URL or wrong --rpc-url before the user
  // signs a tx that targets a different chain than they think.
  const reportedChainId = await getChainId(rpcUrl)
  if (reportedChainId !== input.chainId) {
    throw new Error(
      `RPC at ${rpcUrl} reports chainId ${reportedChainId}, but --chain-id is ${input.chainId}. Refusing to build.`,
    )
  }

  let to: string
  let data: `0x${string}`
  let valueWei: bigint
  let isErc20: boolean

  if (input.token) {
    if (!isAddress(input.token)) {
      throw new Error(`Invalid --token address: ${JSON.stringify(input.token)}`)
    }
    const decimals = input.decimals ?? (await getTokenDecimals(rpcUrl, input.token))
    const amountUnits = parseUnits(input.amount, decimals)
    to = input.token
    data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [input.to as `0x${string}`, amountUnits],
    })
    valueWei = 0n
    isErc20 = true
  } else {
    valueWei = parseUnits(input.amount, 18)
    to = input.to
    data = '0x'
    isErc20 = false
  }

  const dataHex = normalizeHex(data) as `0x${string}`
  const valueHex = `0x${valueWei.toString(16)}`

  const [nonce, gasPrice] = await Promise.all([getNonce(rpcUrl, from), getGasPrice(rpcUrl)])

  // Gas limit:
  //   - Native ETH transfer: 21000 on L1 (protocol-mandated). On L2s with
  //     L1-DA fees / custom precompiles (Morph, Hyperliquid, ...) the
  //     effective floor is higher — caller can override via --gas-limit.
  //   - ERC-20 transfer: actual cost depends on the token contract (some do
  //     storage init on first recipient, some have hooks). A silent fallback
  //     to the 100k floor can emit an under-gassed tx that reverts on-chain
  //     — and `ows sign send-tx` signs the provided bytes as-is, it does not
  //     re-estimate. So on ERC-20 we treat estimate failure as a hard error.
  let gas: bigint
  if (input.gasLimit !== undefined) {
    // Explicit override wins for both native + ERC-20. Accepts decimal or
    // 0x-prefixed hex.
    try {
      gas = BigInt(input.gasLimit)
    } catch {
      throw new Error(`--gas-limit not parseable as integer: ${JSON.stringify(input.gasLimit)}`)
    }
    if (gas <= 0n) {
      throw new Error(`--gas-limit must be positive: ${input.gasLimit}`)
    }
  } else if (isErc20) {
    let estimated: bigint
    try {
      estimated = await estimateGas(rpcUrl, { from, to, data: dataHex, value: valueHex })
    } catch (err) {
      throw new Error(
        `eth_estimateGas failed for ERC-20 transfer: ${err instanceof Error ? err.message : String(err)}. ` +
          `This usually means the sender has insufficient token balance, the token contract is non-standard, or the RPC is unresponsive. ` +
          `Not emitting an unsigned tx with a guessed gas limit.`,
      )
    }
    gas = estimated > ERC20_GAS_LIMIT ? estimated : ERC20_GAS_LIMIT
  } else {
    gas = NATIVE_GAS_LIMIT
  }

  // Gas pricing — same shape as ows-execute-steps so build-transfer txs land
  // for the same reasons (BSC private TX min, stale gasPrice on public RPCs).
  const doubledGasPrice = gasPrice * 2n
  const maxFeePerGas = doubledGasPrice > MIN_MAX_FEE ? doubledGasPrice : MIN_MAX_FEE
  const maxPriorityFeePerGas = maxFeePerGas / 10n > 0n ? maxFeePerGas / 10n : 1n

  const txRequest: TransactionSerializable = {
    chainId: input.chainId,
    nonce,
    to: to as `0x${string}`,
    value: valueWei,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    data: dataHex,
    type: 'eip1559',
  }
  const unsignedTxHex = serializeTransaction(txRequest)
  const chain = owsEvmChainId(input.chainId)
  const freshness = buildFreshness()

  return {
    chain,
    kind: 'evm-eip1559',
    from,
    to: input.to,
    amount: input.amount,
    token: input.token,
    unsignedTxHex,
    nextStep: buildNextStep({
      chain,
      owsWallet: input.owsWallet,
      unsignedTxHex,
      rpcUrlFlag: input.rpcUrl,
    }),
    meta: {
      nonce,
      gasLimit: `0x${gas.toString(16)}`,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
      rpcUrl,
      rpcUrlOverridden: Boolean(input.rpcUrl),
      ...freshness,
    },
  }
}

// ---------------------------------------------------------------------------
// Solana native SOL build
// ---------------------------------------------------------------------------

async function buildSolanaNativeUnsigned(
  input: OwsBuildTransferInput,
): Promise<OwsBuildTransferResult> {
  const rpcUrl = input.rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC
  const connection = new Connection(rpcUrl, 'confirmed')

  const { from } = resolveSender(input, 'solana')
  const fromPubkey = new PublicKey(from)
  const toPubkey = new PublicKey(input.to)
  const lamports = parseUnits(input.amount, SOL_DECIMALS)

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
  )
  tx.feePayer = fromPubkey
  tx.recentBlockhash = blockhash

  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  const unsignedTxHex = `0x${Buffer.from(serialized).toString('hex')}`
  const freshness = buildFreshness()

  // Emit the generic chain name instead of hardcoding a cluster-specific
  // CAIP-2. `ows sign send-tx --chain solana` picks up the cluster from
  // --rpc-url (which we echo in nextStep when --rpc-url was overridden), so
  // devnet / testnet / custom-fork builds don't get a mismatched chain label.
  return {
    chain: 'solana',
    kind: 'solana',
    from,
    to: input.to,
    amount: input.amount,
    unsignedTxHex,
    nextStep: buildNextStep({
      chain: 'solana',
      owsWallet: input.owsWallet,
      unsignedTxHex,
      rpcUrlFlag: input.rpcUrl,
    }),
    meta: {
      recentBlockhash: blockhash,
      rpcUrl,
      rpcUrlOverridden: Boolean(input.rpcUrl),
      ...freshness,
    },
  }
}

// ---------------------------------------------------------------------------
// Solana SPL token build (auto-creates destination ATA if missing)
// ---------------------------------------------------------------------------

async function buildSolanaSplUnsigned(
  input: OwsBuildTransferInput,
): Promise<OwsBuildTransferResult> {
  if (!input.token) {
    throw new Error('SPL transfer requires --token <mint>')
  }
  const rpcUrl = input.rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC
  const connection = new Connection(rpcUrl, 'confirmed')

  const { from } = resolveSender(input, 'solana')

  let ownerPubkey: PublicKey
  let recipientPubkey: PublicKey
  let mintPubkey: PublicKey
  try {
    ownerPubkey = new PublicKey(from)
    recipientPubkey = new PublicKey(input.to)
    mintPubkey = new PublicKey(input.token)
  } catch (err) {
    throw new Error(`Invalid Solana pubkey: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Reject off-curve recipient — its ATA would be unspendable. Same guard as
  // @solana/spl-token's allowOwnerOffCurve=false default.
  if (!PublicKey.isOnCurve(recipientPubkey.toBytes())) {
    throw new Error(
      `Recipient ${recipientPubkey.toBase58()} is off-curve (not a normal wallet). Funds sent to its ATA would be unspendable. Refusing to build.`,
    )
  }

  const { decimals: mintDecimals } = await fetchMintInfo(connection, mintPubkey)
  if (input.decimals !== undefined && input.decimals !== mintDecimals) {
    throw new Error(
      `--decimals ${input.decimals} does not match on-chain mint decimals ${mintDecimals} for ${mintPubkey.toBase58()}`,
    )
  }
  const amountBaseUnits = parseUnits(input.amount, mintDecimals)

  const sourceAta = findAssociatedTokenAddress(ownerPubkey, mintPubkey)
  const destAta = findAssociatedTokenAddress(recipientPubkey, mintPubkey)

  const instructions: TransactionInstruction[] = []
  const destInfo = await connection.getAccountInfo(destAta)
  const createsDestinationAta = !destInfo
  if (createsDestinationAta) {
    instructions.push(
      buildCreateAtaIdempotentInstruction(ownerPubkey, destAta, recipientPubkey, mintPubkey),
    )
  }
  instructions.push(
    buildSplTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destAta,
      ownerPubkey,
      amountBaseUnits,
      mintDecimals,
    ),
  )

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction().add(...instructions)
  tx.feePayer = ownerPubkey
  tx.recentBlockhash = blockhash

  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  const unsignedTxHex = `0x${Buffer.from(serialized).toString('hex')}`
  const freshness = buildFreshness()

  return {
    chain: 'solana',
    kind: 'solana',
    from,
    to: input.to,
    amount: input.amount,
    token: input.token,
    unsignedTxHex,
    nextStep: buildNextStep({
      chain: 'solana',
      owsWallet: input.owsWallet,
      unsignedTxHex,
      rpcUrlFlag: input.rpcUrl,
    }),
    meta: {
      recentBlockhash: blockhash,
      rpcUrl,
      rpcUrlOverridden: Boolean(input.rpcUrl),
      createsDestinationAta,
      ...freshness,
    },
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function owsBuildTransfer(
  input: OwsBuildTransferInput,
): Promise<OwsBuildTransferResult> {
  const chainType = input.chainType ?? 'ethereum'
  if (chainType === 'solana') {
    try {
      new PublicKey(input.to)
    } catch {
      throw new Error(`Invalid Solana --to address: ${JSON.stringify(input.to)}`)
    }
    return input.token ? buildSolanaSplUnsigned(input) : buildSolanaNativeUnsigned(input)
  }
  return buildEvmUnsigned(input)
}

export const __testing = {
  findAssociatedTokenAddress,
  buildSplTransferCheckedInstruction,
  buildCreateAtaIdempotentInstruction,
  fetchMintInfo,
  resolveSender,
  SPL_TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TRANSFER_CHECKED_OPCODE,
  ATA_CREATE_IDEMPOTENT_OPCODE,
}
