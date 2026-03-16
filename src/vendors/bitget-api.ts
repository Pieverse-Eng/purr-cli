/**
 * Bitget Wallet ToB API client for purr CLI.
 *
 * Ported from packages/api-server/src/services/bitget.ts — HMAC-SHA256
 * authenticated HTTP client for swap quote + calldata endpoints.
 *
 * Credentials: BGW_API_KEY / BGW_API_SECRET env vars, or built-in demo keys.
 */

import { createHmac } from 'node:crypto'

const BASE_URL = 'https://bopenapi.bgwapi.io'

const DEFAULT_API_KEY = '4843D8C3F1E20772C0E634EDACC5C5F9A0E2DC92'
const DEFAULT_API_SECRET = 'F2ABFDC684BDC6775FD6286B8D06A3AAD30FD587'
const DEFAULT_PARTNER_CODE = 'bgw_swap_public'

function getCredentials() {
	const apiKey = process.env.BGW_API_KEY || DEFAULT_API_KEY
	const apiSecret = process.env.BGW_API_SECRET || DEFAULT_API_SECRET
	return { apiKey, apiSecret }
}

/** Deterministic JSON stringification (sorted keys, compact) */
function stableStringify(obj: unknown): string {
	if (obj === null || obj === undefined) return ''
	if (typeof obj !== 'object') return JSON.stringify(obj)
	if (Array.isArray(obj)) {
		return `[${obj.map((item) => stableStringify(item)).join(',')}]`
	}
	const keys = Object.keys(obj as Record<string, unknown>).sort()
	const pairs = keys.map(
		(k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`,
	)
	return `{${pairs.join(',')}}`
}

function signRequest(
	apiPath: string,
	bodyStr: string,
	apiKey: string,
	apiSecret: string,
	timestamp: string,
): string {
	const content: Record<string, string> = {
		apiPath,
		body: bodyStr,
		'x-api-key': apiKey,
		'x-api-timestamp': timestamp,
	}
	return createHmac('sha256', apiSecret).update(stableStringify(content)).digest('base64')
}

export interface BitgetApiResponse {
	status?: number
	data?: unknown
	error?: string
	message?: string
}

async function bitgetRequest(
	path: string,
	body?: Record<string, unknown>,
): Promise<BitgetApiResponse> {
	const { apiKey, apiSecret } = getCredentials()
	const timestamp = String(Date.now())
	const bodyStr = body ? stableStringify(body) : ''
	const signature = signRequest(path, bodyStr, apiKey, apiSecret, timestamp)

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'x-api-key': apiKey,
		'x-api-timestamp': timestamp,
		'x-api-signature': signature,
	}

	if (path.includes('/swapx/')) {
		headers['Partner-Code'] = process.env.BGW_PARTNER_CODE || DEFAULT_PARTNER_CODE
	}

	const res = await fetch(`${BASE_URL}${path}`, {
		method: 'POST',
		headers,
		body: bodyStr || undefined,
	})

	if (!res.ok) {
		const text = await res.text()
		return { error: `HTTP ${res.status}`, message: text.slice(0, 500) }
	}

	return (await res.json()) as BitgetApiResponse
}

// ---------------------------------------------------------------------------
// Swap endpoints
// ---------------------------------------------------------------------------

export interface SwapQuoteParams {
	fromChain: string
	fromContract: string
	toContract: string
	fromAmount: string
	fromAddress: string
}

export async function swapQuote(params: SwapQuoteParams): Promise<BitgetApiResponse> {
	return bitgetRequest('/bgw-pro/swapx/pro/quote', {
		fromChain: params.fromChain,
		fromContract: params.fromContract,
		toChain: params.fromChain,
		toContract: params.toContract,
		fromAmount: params.fromAmount,
		estimateGas: false,
		fromAddress: params.fromAddress,
	})
}

export interface SwapCalldataParams {
	fromChain: string
	fromContract: string
	toContract: string
	fromAmount: string
	fromAddress: string
	toAddress: string
	market: string
	slippage: number // percentage, e.g. 3 = 3%
}

export interface SwapCalldataResult {
	txs?: Array<{
		to: string
		data: string
		value: string
		gasLimit?: string
	}>
	contract?: string
	calldata?: string
	computeUnits?: number
}

export async function swapCalldata(params: SwapCalldataParams): Promise<BitgetApiResponse> {
	return bitgetRequest('/bgw-pro/swapx/pro/swap', {
		fromChain: params.fromChain,
		fromContract: params.fromContract,
		toChain: params.fromChain,
		toContract: params.toContract,
		fromAmount: params.fromAmount,
		fromAddress: params.fromAddress,
		toAddress: params.toAddress,
		market: params.market,
		slippage: params.slippage,
	})
}
