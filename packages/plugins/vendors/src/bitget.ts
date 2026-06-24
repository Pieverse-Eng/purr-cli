import { createHash, randomBytes, verify as cryptoVerify } from 'node:crypto'
import { apiPost, resolveCredentials } from '@pieverseio/purr-core/api-client'
import { isAddress } from 'viem'

const DEFAULT_BASE_URL = 'https://copenapi.bgwapi.io'
const DEFAULT_X402_MAX_AMOUNT_BASE_UNITS = '1000000'
const SECURITY_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAk18NCL9CoiE8OQ588ehJ\n' +
  'hVoCenARvVymahlH3Sw8URZATuZw4k8ZKC8Sf7Zu9i9l3L3K5X4m2I20UENkOBzP\n' +
  'YGCRHk3Dy8SQk/e7ucj/hXJH07yNDJuv1t1nWXRhvwpG8rdW03KpDhJy4pgcAMXl\n' +
  'JYnJYqhfj7HW/urMD0KXw7dLNKyWKBoaGzKkoRvvxTSDHk35cjETcYg6H+bEm+Px\n' +
  'a+GnIJkuN5U2/LfZ4WxgNiIdE2zacHLcFoFsM14jTQdcvPid+6ilY8SQCA3GWc72\n' +
  'n1RudWoTj1ThEUVNWXgcwxLFIdiLCNH1YF7qINdRrjOOCCBBBpr6jdANdI2e4Dcy\n' +
  'DQIDAQAB\n' +
  '-----END PUBLIC KEY-----'

const SECURITY_CHECK_PATHS = new Set([
  '/swap-go/swapx/makeOrder',
  '/userv2/order/makeTransferOrder',
])

export interface BitgetOrderExecuteArgs {
  orderId?: string
  fromChain?: string
  fromContract?: string
  fromSymbol?: string
  fromAddress?: string
  toChain?: string
  toContract?: string
  toSymbol?: string
  toAddress?: string
  fromAmount?: string
  slippage?: string
  market?: string
  protocol?: string
  source?: string
  chainId?: number
  makeOrderJson?: string
  raw?: boolean
  signer?: BitgetWalletSigner
}

export interface BitgetTransferExecuteArgs {
  chain?: string
  contract?: string
  fromAddress?: string
  toAddress?: string
  amount?: string
  memo?: string
  gasless?: boolean
  gaslessPayToken?: string
  override7702?: boolean
  chainId?: number
  transferOrderJson?: string
  raw?: boolean
  signer?: BitgetWalletSigner
}

export interface BitgetX402SignEip3009Args {
  token: string
  chainId: number
  to: string
  amount: string
  fromAddress?: string
  tokenName?: string
  tokenVersion?: string
  maxTimeoutSeconds?: number
  signer?: BitgetWalletSigner
}

export interface BitgetX402PayArgs {
  url: string
  method?: string
  data?: string
  chainId?: number
  fromAddress?: string
  maxAmountBaseUnits?: string
  responseTextLimit?: number
  tokenName?: string
  tokenVersion?: string
  signer?: BitgetWalletSigner
}

export interface BitgetSignedTransactions {
  orderId?: string
  txs: Array<Record<string, unknown>>
  address: string
}

export interface BitgetTypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface BitgetWalletSigner {
  label: string
  supportsRawDigest: boolean
  signTransactions: (
    payload: { orderId?: string; txs: Array<Record<string, unknown>> },
    chainId?: number,
  ) => Promise<BitgetSignedTransactions>
  resolveEvmAddress?: (chainId: number) => Promise<string>
  signTypedData?: (
    chainId: number,
    typedData: BitgetTypedDataPayload,
    expectedAddress?: string,
  ) => Promise<{ address: string; signature: string }>
}

interface BitgetApiResponse {
  status?: number
  error_code?: number
  msg?: string
  data?: Record<string, unknown>
  _security_check_valid?: boolean
  _security_request_check_valid?: boolean
  _security_double_check_valid?: boolean
  [key: string]: unknown
}

interface PlatformSignTransactionResponse {
  ok: boolean
  data?: {
    txs: Array<Record<string, unknown>>
    address: string
  }
  error?: string
}

interface PlatformSignTypedDataResponse {
  ok: boolean
  data?: {
    address: string
    signature: string
  }
  error?: string
}

interface PlatformWalletEnsureResponse {
  ok: boolean
  data?: {
    address: string
    chainId: number
    chainType: string
  }
  error?: string
}

interface PaymentRequirement {
  scheme?: string
  network?: string
  asset?: string
  amount?: string | number
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
  [key: string]: unknown
}

function requireString(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Missing required argument: --${name}`)
  return value
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function compactJson(value: unknown): string {
  return JSON.stringify(value)
}

function makeBitgetSign(method: string, path: string, bodyStr: string, ts: string): string {
  return `0x${createHash('sha256')
    .update(method + path + bodyStr + ts)
    .digest('hex')}`
}

function strip0x(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
}

function verifySecurityHeader(signatureHex: string, data: string | Buffer): boolean {
  try {
    const sig = Buffer.from(strip0x(signatureHex), 'hex')
    return cryptoVerify(
      'RSA-SHA256',
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      SECURITY_PUBLIC_KEY_PEM,
      sig,
    )
  } catch {
    return false
  }
}

function hasOkStatus(resp: BitgetApiResponse): boolean {
  return resp.status === 0 && (resp.error_code === undefined || resp.error_code === 0)
}

function assertBitgetOk(resp: BitgetApiResponse, action: string): void {
  if (!hasOkStatus(resp)) {
    throw new Error(`${action} failed: ${JSON.stringify(resp)}`)
  }
}

function assertSecurity(resp: BitgetApiResponse, action: string): void {
  const failed: string[] = []
  if (resp._security_check_valid !== true) failed.push('security-check')
  if (resp._security_request_check_valid !== true) failed.push('security-request-check')
  if (resp._security_double_check_valid !== true) failed.push('security-double-check')
  if (failed.length > 0) {
    throw new Error(
      `${action} blocked: Bitget security signature verification failed (${failed.join(', ')})`,
    )
  }
}

async function bitgetPost(path: string, body: Record<string, unknown>): Promise<BitgetApiResponse> {
  const baseUrl = process.env.BITGET_WALLET_API_BASE_URL ?? DEFAULT_BASE_URL
  const ts = String(Date.now())
  const bodyStr = compactJson(body)
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      channel: 'toc_agent',
      brand: 'toc_agent',
      clientversion: '10.0.0',
      language: 'en',
      token: 'toc_agent',
      'X-SIGN': makeBitgetSign('POST', path, bodyStr, ts),
      'X-TIMESTAMP': ts,
    },
    body: bodyStr,
  })
  const responseBytes = Buffer.from(await res.arrayBuffer())
  const responseText = responseBytes.toString('utf8')
  if (!res.ok) {
    return { status: -1, error_code: res.status, msg: responseText.slice(0, 500) }
  }

  let parsed: BitgetApiResponse
  try {
    parsed = JSON.parse(responseText) as BitgetApiResponse
  } catch {
    return { status: -1, error_code: -1, msg: responseText.slice(0, 500) }
  }

  if (SECURITY_CHECK_PATHS.has(path) && parsed.status === 0) {
    const sigCheck = res.headers.get('security-check') ?? ''
    const sigReqCheck = res.headers.get('security-request-check') ?? ''
    const sigDoubleCheck = res.headers.get('security-double-check') ?? ''
    parsed._security_check_valid = !!sigCheck && verifySecurityHeader(sigCheck, responseBytes)
    parsed._security_request_check_valid =
      !!sigReqCheck && verifySecurityHeader(sigReqCheck, bodyStr)
    parsed._security_double_check_valid =
      !!sigDoubleCheck && verifySecurityHeader(sigDoubleCheck, sigCheck + sigReqCheck)
  }

  return parsed
}

async function signTransactionsViaPlatform(
  payload: { orderId?: string; txs: Array<Record<string, unknown>> },
  chainId?: number,
): Promise<BitgetSignedTransactions> {
  if (!Array.isArray(payload.txs) || payload.txs.length === 0) {
    throw new Error('Cannot sign empty txs array')
  }
  const { instanceId } = resolveCredentials()
  const body: Record<string, unknown> = { txs: payload.txs }
  if (chainId !== undefined) body.chainId = chainId
  const res = await apiPost<PlatformSignTransactionResponse>(
    `/v1/instances/${instanceId}/wallet/sign-transaction`,
    body,
  )
  if (!res.ok || !res.data) {
    throw new Error(res.error ?? 'Failed to sign transactions')
  }
  return {
    ...(payload.orderId ? { orderId: payload.orderId } : {}),
    txs: res.data.txs,
    address: res.data.address,
  }
}

async function resolvePlatformEvmAddress(chainId: number): Promise<string> {
  const { instanceId } = resolveCredentials()
  const ensure = await apiPost<PlatformWalletEnsureResponse>(
    `/v1/instances/${instanceId}/wallet/ensure`,
    {
      chainType: 'ethereum',
      chainId,
    },
  )
  if (!ensure.ok || !ensure.data) {
    throw new Error(ensure.error ?? 'Failed to resolve platform EVM wallet')
  }
  return ensure.data.address
}

async function signTypedDataViaPlatform(
  chainId: number,
  typedData: BitgetTypedDataPayload,
  expectedAddress?: string,
): Promise<{ address: string; signature: string }> {
  const { instanceId } = resolveCredentials()
  const expected = expectedAddress ?? (await resolvePlatformEvmAddress(chainId))
  const signed = await apiPost<PlatformSignTypedDataResponse>(
    `/v1/instances/${instanceId}/wallet/sign-typed-data`,
    typedData,
  )
  if (!signed.ok || !signed.data) {
    throw new Error(signed.error ?? 'Failed to sign typed data')
  }
  if (signed.data.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Typed data signature returned unexpected address ${signed.data.address}; expected ${expected}`,
    )
  }
  return signed.data
}

function platformWalletSigner(): BitgetWalletSigner {
  return {
    label: 'Platform wallet',
    supportsRawDigest: true,
    signTransactions: signTransactionsViaPlatform,
    resolveEvmAddress: resolvePlatformEvmAddress,
    signTypedData: signTypedDataViaPlatform,
  }
}

function resolveSigner(signer: BitgetWalletSigner | undefined): BitgetWalletSigner {
  return signer ?? platformWalletSigner()
}

async function assertSignerAddressBeforeSigning(
  signer: BitgetWalletSigner,
  expectedAddress: string | undefined,
  chainId?: number,
): Promise<void> {
  if (!expectedAddress || !signer.resolveEvmAddress) return
  const expected = requireEvmAddress(expectedAddress, 'from-address')
  const signerAddress = await signer.resolveEvmAddress(chainId ?? 56)
  if (signerAddress.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${signer.label} ${signerAddress} does not match --from-address ${expected}`)
  }
}

function assertSignedAddressMatches(
  signer: BitgetWalletSigner,
  expectedAddress: string | undefined,
  signedAddress: string,
): void {
  if (!expectedAddress) return
  const expected = requireEvmAddress(expectedAddress, 'from-address')
  if (signedAddress.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${signer.label} ${signedAddress} does not match --from-address ${expected}`)
  }
}

async function signTypedDataWithSigner(
  signer: BitgetWalletSigner,
  chainId: number,
  typedData: BitgetTypedDataPayload,
  expectedAddress?: string,
): Promise<{ address: string; signature: string }> {
  if (signer.signTypedData) {
    return signer.signTypedData(chainId, typedData, expectedAddress)
  }

  const signed = await signer.signTransactions(
    {
      txs: [
        {
          function: 'signTypeData',
          signTypeData: typedData,
        },
      ],
    },
    chainId,
  )
  assertSignedAddressMatches(signer, expectedAddress, signed.address)
  const sig = signed.txs[0]?.sig
  if (typeof sig !== 'string' || sig.length === 0) {
    throw new Error(`${signer.label} returned no typed-data signature`)
  }
  return { address: signed.address, signature: sig }
}

function unwrapBitgetData(resp: Record<string, unknown>): Record<string, unknown> {
  const data = resp.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  return resp
}

function txsFromMakeOrderResponse(resp: Record<string, unknown>): {
  orderId: string
  txs: Array<Record<string, unknown>>
  data: Record<string, unknown>
} {
  const data = unwrapBitgetData(resp)
  const orderId = data.orderId
  const txs = data.txs
  if (typeof orderId !== 'string' || !Array.isArray(txs) || txs.length === 0) {
    throw new Error('makeOrder response must contain data.orderId and non-empty data.txs')
  }
  return { orderId, txs: txs as Array<Record<string, unknown>>, data }
}

function isSolanaTxItem(txItem: Record<string, unknown>): boolean {
  const derive = txItem.deriveTransaction as Record<string, unknown> | undefined
  const chainId = txItem.chainId ?? derive?.chainId
  if (chainId != null && Number(chainId) === 501) return true
  const chain = String(txItem.chain ?? '').toLowerCase()
  if (chain === 'sol' || chain === 'solana') return true
  if (derive?.serializedTransaction) return true
  if (typeof txItem.serializedTx === 'string') return true
  const data = txItem.data as Record<string, unknown> | string | undefined
  if (typeof data === 'object' && data !== null && typeof data.serializedTx === 'string') {
    return true
  }
  const source = (txItem.source ?? derive?.source) as Record<string, unknown> | undefined
  return typeof source?.serializedTransaction === 'string'
}

function isTronTxItem(txItem: Record<string, unknown>): boolean {
  const chain = String(txItem.chain ?? '').toLowerCase()
  const derive = txItem.deriveTransaction as Record<string, unknown> | undefined
  const deriveChain = String(derive?.chain ?? '').toLowerCase()
  return chain === 'trx' || chain === 'tron' || deriveChain === 'trx' || deriveChain === 'tron'
}

function assertSupportedOrderTxs(txs: Array<Record<string, unknown>>): void {
  if (txs.some(isSolanaTxItem)) {
    throw new Error(
      'Bitget Solana order execution is out of scope because it may require partial signing',
    )
  }
  if (txs.some(isTronTxItem)) {
    throw new Error(
      'Bitget Tron order execution is out of scope because platform wallet signing does not support Tron',
    )
  }
}

async function makeOrder(args: BitgetOrderExecuteArgs): Promise<BitgetApiResponse> {
  return bitgetPost('/swap-go/swapx/makeOrder', {
    orderId: requireString(args.orderId, 'order-id'),
    fromChain: requireString(args.fromChain, 'from-chain'),
    fromContract: requireString(args.fromContract, 'from-contract'),
    fromSymbol: requireString(args.fromSymbol, 'from-symbol'),
    fromAddress: requireString(args.fromAddress, 'from-address'),
    toChain: requireString(args.toChain, 'to-chain'),
    toContract: args.toContract ?? '',
    toSymbol: requireString(args.toSymbol, 'to-symbol'),
    toAddress: requireString(args.toAddress, 'to-address'),
    fromAmount: requireString(args.fromAmount, 'from-amount'),
    slippage: requireString(args.slippage, 'slippage'),
    market: requireString(args.market, 'market'),
    protocol: requireString(args.protocol, 'protocol'),
    source: args.source ?? 'agent',
  })
}

async function sendOrder(
  orderId: string,
  txs: Array<Record<string, unknown>>,
): Promise<BitgetApiResponse> {
  return bitgetPost('/swap-go/swapx/send', { orderId, txs })
}

function normalizedOrderOutput(input: {
  orderId: string
  signerAddress: string
  txCount: number
  makeOrderResponse: BitgetApiResponse | Record<string, unknown>
  sendResponse: BitgetApiResponse
  signedOrder: { orderId?: string; txs: Array<Record<string, unknown>>; address: string }
  raw?: boolean
}): Record<string, unknown> {
  if (input.raw) {
    return {
      type: 'bitget-order-execute',
      orderId: input.orderId,
      signerAddress: input.signerAddress,
      makeOrderResponse: input.makeOrderResponse,
      signedOrder: input.signedOrder,
      sendResponse: input.sendResponse,
    }
  }
  return {
    type: 'bitget-order-execute',
    orderId: input.orderId,
    signerAddress: input.signerAddress,
    txCount: input.txCount,
    send: input.sendResponse,
  }
}

export async function bitgetOrderExecute(
  args: BitgetOrderExecuteArgs,
): Promise<Record<string, unknown>> {
  const signer = resolveSigner(args.signer)
  const makeOrderResponse = args.makeOrderJson
    ? parseJsonObject(args.makeOrderJson, '--make-order-json')
    : await makeOrder(args)
  if (!args.makeOrderJson) {
    assertBitgetOk(makeOrderResponse as BitgetApiResponse, 'makeOrder')
    assertSecurity(makeOrderResponse as BitgetApiResponse, 'makeOrder')
  }

  const { orderId, txs } = txsFromMakeOrderResponse(makeOrderResponse)
  assertSupportedOrderTxs(txs)
  await assertSignerAddressBeforeSigning(
    signer,
    args.fromAddress,
    args.chainId ?? inferEvmChainIdFromTxs(txs),
  )
  const signedOrder = await signer.signTransactions({ orderId, txs }, args.chainId)
  assertSignedAddressMatches(signer, args.fromAddress, signedOrder.address)
  const sendResponse = await sendOrder(orderId, signedOrder.txs)
  assertBitgetOk(sendResponse, 'send')

  return normalizedOrderOutput({
    orderId,
    signerAddress: signedOrder.address,
    txCount: signedOrder.txs.length,
    makeOrderResponse,
    signedOrder,
    sendResponse,
    raw: args.raw,
  })
}

async function makeTransferOrder(args: BitgetTransferExecuteArgs): Promise<BitgetApiResponse> {
  const body: Record<string, unknown> = {
    chain: requireString(args.chain, 'chain'),
    contract: args.contract ?? '',
    from: requireString(args.fromAddress, 'from-address'),
    to: requireString(args.toAddress, 'to-address'),
    amount: requireString(args.amount, 'amount'),
  }
  if (args.memo) body.memo = args.memo
  if (args.gasless) body.noGas = true
  if (args.gaslessPayToken) body.noGasPayToken = args.gaslessPayToken
  if (args.override7702) body.override7702 = true
  return bitgetPost('/userv2/order/makeTransferOrder', body)
}

async function submitTransferOrder(orderId: string, sig: string): Promise<BitgetApiResponse> {
  return bitgetPost('/userv2/order/submitTransferOrder', { orderId, sig })
}

function transferDataFromResponse(resp: Record<string, unknown>): Record<string, unknown> {
  const data = unwrapBitgetData(resp)
  if (typeof data.orderId !== 'string') {
    throw new Error('makeTransferOrder response must contain data.orderId')
  }
  if (typeof data.source !== 'object' || data.source === null || Array.isArray(data.source)) {
    throw new Error('makeTransferOrder response must contain data.source')
  }
  return data
}

function evmSourceToTxItem(source: Record<string, unknown>): Record<string, unknown> {
  const evm = source.evm as Record<string, unknown> | undefined
  if (!evm) throw new Error('EVM transfer source is missing source.evm')
  const sourceType = String(source.type ?? '')
  return {
    deriveTransaction: {
      to: evm.to,
      data: evm.data ?? '0x',
      gasLimit: evm.gasLimit,
      nonce: evm.nonce,
      chainId: evm.chainId,
      gasPrice: evm.gasPrice,
      maxFeePerGas: evm.maxFeePerGas,
      maxPriorityFeePerGas: evm.maxPriorityFeePerGas,
      supportEIP1559: sourceType === 'evm_1559' || evm.maxFeePerGas !== undefined,
      value: evm.value ?? '0x0',
    },
  }
}

async function signEvm7702Source(
  source: Record<string, unknown>,
  signer: BitgetWalletSigner,
): Promise<string> {
  if (!signer.supportsRawDigest) {
    throw new Error(`${signer.label} cannot sign Bitget EVM 7702 raw-digest payloads`)
  }
  const evm7702 = source.evm7702 as Record<string, unknown> | undefined
  const msgToSign = evm7702?.msgToSign
  if (!Array.isArray(msgToSign) || msgToSign.length === 0) {
    throw new Error('evm_7702 transfer source is missing source.evm7702.msgToSign')
  }
  const originalMsgs = msgToSign as Array<Record<string, unknown>>
  const signingMsgs = originalMsgs.map((msg) => ({
    ...msg,
    signType: typeof msg.signType === 'string' ? msg.signType : 'eth_sign',
  }))
  const signed = await signer.signTransactions({ txs: [{ msgs: signingMsgs }] })
  const signedMsgs = signed.txs[0]?.msgs as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(signedMsgs) || signedMsgs.length !== originalMsgs.length) {
    throw new Error(`${signer.label} returned invalid evm_7702 signatures`)
  }
  return JSON.stringify(
    originalMsgs.map((msg, index) => ({
      ...msg,
      sig: signedMsgs[index].sig,
    })),
  )
}

async function signTransferSource(
  source: Record<string, unknown>,
  fallbackChainId?: number,
  signer: BitgetWalletSigner = platformWalletSigner(),
  expectedAddress?: string,
): Promise<string> {
  const sourceType = String(source.type ?? '')
  if (sourceType === 'evm_legacy' || sourceType === 'evm_1559') {
    const signed = await signer.signTransactions(
      { txs: [evmSourceToTxItem(source)] },
      fallbackChainId,
    )
    assertSignedAddressMatches(signer, expectedAddress, signed.address)
    const sig = signed.txs[0]?.sig
    if (typeof sig !== 'string' || sig.length === 0) {
      throw new Error(`${signer.label} returned no EVM transfer signature`)
    }
    return sig
  }
  if (sourceType === 'evm_7702') {
    return signEvm7702Source(source, signer)
  }
  if (sourceType === 'sol_raw' || sourceType === 'sol_partial') {
    throw new Error(
      'Bitget Solana transfer execution is out of scope because it requires partial signing',
    )
  }
  if (sourceType === 'evm_morph_altfee') {
    throw new Error('Bitget Morph AltFee transfer execution is out of scope')
  }
  throw new Error(`Unsupported Bitget transfer source.type: ${sourceType || '(missing)'}`)
}

function assertTransferSafe(data: Record<string, unknown>, gaslessRequested?: boolean): void {
  if (data.estimateRevert === true) {
    throw new Error('makeTransferOrder returned estimateRevert=true; refusing to sign')
  }
  const noGas = data.noGas as Record<string, unknown> | undefined
  if (gaslessRequested && noGas?.available !== true) {
    throw new Error('Gasless transfer was requested but Bitget did not mark gasless as available')
  }
}

function normalizedTransferOutput(input: {
  orderId: string
  sourceType: string
  makeTransferResponse: BitgetApiResponse | Record<string, unknown>
  submitResponse: BitgetApiResponse
  sig: string
  raw?: boolean
}): Record<string, unknown> {
  if (input.raw) {
    return {
      type: 'bitget-transfer-execute',
      orderId: input.orderId,
      sourceType: input.sourceType,
      makeTransferResponse: input.makeTransferResponse,
      sig: input.sig,
      submitResponse: input.submitResponse,
    }
  }
  return {
    type: 'bitget-transfer-execute',
    orderId: input.orderId,
    sourceType: input.sourceType,
    submit: input.submitResponse,
  }
}

export async function bitgetTransferExecute(
  args: BitgetTransferExecuteArgs,
): Promise<Record<string, unknown>> {
  const signer = resolveSigner(args.signer)
  const makeTransferResponse = args.transferOrderJson
    ? parseJsonObject(args.transferOrderJson, '--transfer-order-json')
    : await makeTransferOrder(args)
  if (!args.transferOrderJson) {
    assertBitgetOk(makeTransferResponse as BitgetApiResponse, 'makeTransferOrder')
    assertSecurity(makeTransferResponse as BitgetApiResponse, 'makeTransferOrder')
  }
  const data = transferDataFromResponse(makeTransferResponse)
  assertTransferSafe(data, args.gasless)
  const orderId = data.orderId as string
  const source = data.source as Record<string, unknown>
  const sourceType = String(source.type ?? '')
  let expectedFrom: string | undefined
  let sourceChainId: number | undefined
  if (sourceType === 'evm_legacy' || sourceType === 'evm_1559' || sourceType === 'evm_7702') {
    expectedFrom =
      args.fromAddress ??
      (typeof data.from === 'string' ? data.from : undefined) ??
      (typeof source.from === 'string' ? source.from : undefined)
    sourceChainId = args.chainId ?? inferEvmChainIdFromSource(source)
    await assertSignerAddressBeforeSigning(signer, expectedFrom, sourceChainId)
  }
  const sig = await signTransferSource(source, sourceChainId ?? args.chainId, signer, expectedFrom)
  const submitResponse = await submitTransferOrder(orderId, sig)
  assertBitgetOk(submitResponse, 'submitTransferOrder')
  return normalizedTransferOutput({
    orderId,
    sourceType,
    makeTransferResponse,
    submitResponse,
    sig,
    raw: args.raw,
  })
}

function randomNonceHex(): string {
  return `0x${randomBytes(32).toString('hex')}`
}

function requireEvmAddress(value: string, name: string): string {
  if (!isAddress(value)) throw new Error(`Invalid ${name}: expected 0x EVM address`)
  return value
}

function parseMaybeChainId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(String(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function inferEvmChainIdFromTxs(txs: Array<Record<string, unknown>>): number | undefined {
  for (const tx of txs) {
    const derive = tx.deriveTransaction as Record<string, unknown> | undefined
    const chainId = parseMaybeChainId(tx.chainId ?? derive?.chainId)
    if (chainId !== undefined) return chainId
  }
  return undefined
}

function inferEvmChainIdFromSource(source: Record<string, unknown>): number | undefined {
  const evm = source.evm as Record<string, unknown> | undefined
  return parseMaybeChainId(evm?.chainId)
}

export async function bitgetX402SignEip3009(
  args: BitgetX402SignEip3009Args,
): Promise<Record<string, unknown>> {
  const signer = resolveSigner(args.signer)
  const now = Math.floor(Date.now() / 1000)
  const validAfter = now - 600
  const validBefore = now + (args.maxTimeoutSeconds ?? 60)
  const token = requireEvmAddress(args.token, 'token')
  const to = requireEvmAddress(args.to, 'to')
  const from = args.fromAddress
    ? requireEvmAddress(args.fromAddress, 'from-address')
    : signer.resolveEvmAddress
      ? await signer.resolveEvmAddress(args.chainId)
      : undefined
  if (!from) {
    throw new Error(`Missing --from-address for ${signer.label}`)
  }
  const typedData = {
    domain: {
      name: args.tokenName ?? 'USD Coin',
      version: args.tokenVersion ?? '2',
      chainId: args.chainId,
      verifyingContract: token,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value: args.amount,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce: randomNonceHex(),
    },
  }
  const signed = await signTypedDataWithSigner(
    signer,
    args.chainId,
    {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    },
    from,
  )
  return {
    signature: signed.signature,
    authorization: {
      from: signed.address,
      to,
      value: args.amount,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce: typedData.message.nonce,
    },
  }
}

function decodePaymentRequiredHeader(header: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('payment-required header is not valid base64 JSON')
  }
}

function selectPaymentRequirement(paymentRequired: Record<string, unknown>): PaymentRequirement {
  const accepts = paymentRequired.accepts
  if (Array.isArray(accepts) && accepts.length > 0) {
    return accepts[0] as PaymentRequirement
  }
  return paymentRequired as PaymentRequirement
}

function assertX402AmountWithinCap(req: PaymentRequirement, maxAmountBaseUnits: string): void {
  const amount = BigInt(String(req.amount ?? '0'))
  const cap = BigInt(maxAmountBaseUnits)
  if (amount > cap) {
    throw new Error(
      `Payment amount ${amount.toString()} exceeds max ${cap.toString()} base units; refusing to sign`,
    )
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function parsePaymentResponseHeader(headers: Headers): unknown {
  const raw = headers.get('payment-response')
  if (!raw) return undefined
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return raw
  }
}

export async function bitgetX402Pay(args: BitgetX402PayArgs): Promise<Record<string, unknown>> {
  const method = (args.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {}
  if (args.data !== undefined) headers['Content-Type'] = 'application/json'
  const initial = await fetch(args.url, {
    method,
    headers,
    body: args.data,
  })
  const initialText = await initial.text()
  if (initial.status !== 402) {
    return {
      type: 'bitget-x402-pay',
      paid: false,
      status: initial.status,
      body: initialText.slice(0, args.responseTextLimit ?? 5000),
    }
  }

  const paymentHeader = initial.headers.get('payment-required')
  if (!paymentHeader) throw new Error('402 response missing payment-required header')
  const paymentRequired = decodePaymentRequiredHeader(paymentHeader)
  const req = selectPaymentRequirement(paymentRequired)
  const network = String(req.network ?? '')
  if (network.startsWith('solana:')) {
    throw new Error(
      'Bitget Solana x402 payment is out of scope because it requires partial signing',
    )
  }
  if (!network.startsWith('eip155:')) {
    throw new Error(`Unsupported x402 network: ${network || '(missing)'}`)
  }
  const chainId = args.chainId ?? Number.parseInt(network.slice('eip155:'.length), 10)
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`Invalid x402 chain id from network: ${network}`)
  }
  const extra = (req.extra ?? {}) as Record<string, unknown>
  const methodName = String(extra.assetTransferMethod ?? 'eip3009')
  if (methodName !== 'eip3009') {
    throw new Error(`Unsupported x402 assetTransferMethod: ${methodName}`)
  }
  assertX402AmountWithinCap(req, args.maxAmountBaseUnits ?? DEFAULT_X402_MAX_AMOUNT_BASE_UNITS)
  const signed = await bitgetX402SignEip3009({
    token: requireString(req.asset as string | undefined, 'asset'),
    chainId,
    to: requireString(req.payTo as string | undefined, 'payTo'),
    amount: String(req.amount ?? '0'),
    tokenName: args.tokenName ?? (typeof extra.name === 'string' ? extra.name : undefined),
    tokenVersion:
      args.tokenVersion ?? (typeof extra.version === 'string' ? extra.version : undefined),
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    fromAddress: args.fromAddress,
    signer: args.signer,
  })
  const paymentPayload = {
    x402Version: 2,
    accepted: req,
    payload: signed,
  }
  const paidHeaders = {
    ...headers,
    'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
  }
  const paid = await fetch(args.url, {
    method,
    headers: paidHeaders,
    body: args.data,
  })
  const paidText = await paid.text()
  return {
    type: 'bitget-x402-pay',
    paid: true,
    request: {
      method,
      url: args.url,
    },
    payment: {
      network,
      amount: String(req.amount ?? '0'),
      asset: req.asset,
      payTo: req.payTo,
      payer: (signed.authorization as Record<string, unknown>).from,
    },
    response: {
      status: paid.status,
      headers: headersToRecord(paid.headers),
      paymentResponse: parsePaymentResponseHeader(paid.headers),
      body: paidText.slice(0, args.responseTextLimit ?? 5000),
    },
  }
}

export const __testing = {
  txsFromMakeOrderResponse,
  isSolanaTxItem,
  isTronTxItem,
  evmSourceToTxItem,
  transferDataFromResponse,
  decodePaymentRequiredHeader,
  selectPaymentRequirement,
  signTypedDataWithSigner,
}
