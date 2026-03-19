import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const OPENSEA_BASE_URL = 'https://api.opensea.io'
export const OPENSEA_SEAPORT_V1_6 = '0x0000000000000068f116a894984e2db1123eb395'
export const OPENSEA_CONDUIT_KEY =
	'0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000'
export const OPENSEA_CONDUIT_ADDRESS = '0x1E0049783F008A0085193E00003D00cd54003c71'
const execFileAsync = promisify(execFile)

const OPEN_SEA_CHAIN_CONFIG = {
	ethereum: { apiName: 'ethereum', chainId: 1 },
	matic: { apiName: 'matic', chainId: 137 },
	polygon: { apiName: 'matic', chainId: 137 },
	arbitrum: { apiName: 'arbitrum', chainId: 42161 },
	optimism: { apiName: 'optimism', chainId: 10 },
	base: { apiName: 'base', chainId: 8453 },
	avalanche: { apiName: 'avalanche', chainId: 43114 },
	klaytn: { apiName: 'klaytn', chainId: 8217 },
	zora: { apiName: 'zora', chainId: 7777777 },
	blast: { apiName: 'blast', chainId: 81457 },
	sepolia: { apiName: 'sepolia', chainId: 11155111 },
} as const

type OpenSeaChainAlias = keyof typeof OPEN_SEA_CHAIN_CONFIG

function getConfig() {
	const apiKey = process.env.OPENSEA_API_KEY
	const baseUrl = (process.env.OPENSEA_BASE_URL ?? OPENSEA_BASE_URL).replace(/\/+$/, '')

	if (!apiKey) {
		throw new Error(
			'OpenSea API key is required. Set OPENSEA_API_KEY before running `purr opensea ...`',
		)
	}

	return { apiKey, baseUrl }
}

function extractApiErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as {
			errors?: string[]
			error?: string
			detail?: string
			message?: string
		}
		if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
			return parsed.errors.join('; ')
		}
		if (typeof parsed.error === 'string' && parsed.error) return parsed.error
		if (typeof parsed.detail === 'string' && parsed.detail) return parsed.detail
		if (typeof parsed.message === 'string' && parsed.message) return parsed.message
	} catch {
		// Fall through to the raw body below.
	}

	const trimmed = body.trim()
	return trimmed ? trimmed.slice(0, 500) : 'Unknown OpenSea API error'
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

function parseHttpError(message: string): { status: number; apiMessage: string } | null {
	const match = message.match(/OpenSea HTTP (\d+):\s*([\s\S]*)$/)
	if (!match) return null

	return {
		status: Number.parseInt(match[1], 10),
		apiMessage: extractApiErrorMessage(match[2] ?? ''),
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const { apiKey, baseUrl } = getConfig()
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'x-api-key': apiKey,
	}
	const url = `${baseUrl}${path}`

	try {
		const res = await fetch(url, {
			...init,
			headers,
			signal: AbortSignal.timeout(12000),
		})

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`OpenSea HTTP ${res.status}: ${text.slice(0, 500)}`)
		}

		return (await res.json()) as T
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('OpenSea HTTP ')) {
			throw error
		}

		// Node fetch does not reliably honor local proxy env vars in some environments.
		// Fall back to curl, which is already the canonical transport for the vendored skill.
		return curlRequest<T>(url, headers, init?.method, init?.body)
	}
}

async function curlRequest<T>(
	url: string,
	headers: Record<string, string>,
	method?: string,
	body?: BodyInit | null,
): Promise<T> {
	const args = ['-sS', '--connect-timeout', '10', '--max-time', '30', '-w', '\n%{http_code}']
	for (const [key, value] of Object.entries(headers)) {
		args.push('-H', `${key}: ${value}`)
	}

	if (method) {
		args.push('-X', method)
	}

	if (body != null) {
		args.push('--data', typeof body === 'string' ? body : String(body))
	}

	args.push(url)

	try {
		const { stdout } = await execFileAsync('curl', args, {
			maxBuffer: 1024 * 1024 * 2,
		})
		const newlineIndex = stdout.lastIndexOf('\n')
		const responseBody = newlineIndex >= 0 ? stdout.slice(0, newlineIndex) : stdout
		const statusText = newlineIndex >= 0 ? stdout.slice(newlineIndex + 1).trim() : ''
		const status = Number.parseInt(statusText, 10)

		if (!Number.isFinite(status)) {
			throw new Error(
				`Could not parse OpenSea HTTP status from curl output: ${statusText || 'missing'}`,
			)
		}
		if (status < 200 || status >= 300) {
			throw new Error(`OpenSea HTTP ${status}: ${responseBody.slice(0, 500)}`)
		}

		return JSON.parse(responseBody) as T
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`OpenSea request failed: ${message}`)
	}
}

export interface OpenSeaConsiderationItem {
	itemType: number
	token: string
	identifierOrCriteria: string
	startAmount: string
	endAmount: string
	recipient: string
}

interface OpenSeaOfferItem {
	itemType: number
	token: string
	identifierOrCriteria: string
	startAmount: string
	endAmount: string
}

interface OpenSeaOfferCriteria {
	contract?: {
		address: string
	}
}

export interface OpenSeaBestListingResponse {
	order_hash: string
	chain: string
	protocol_address?: string
	price?: {
		current?: {
			currency?: string
			decimals?: number
			value: string
		}
	}
	status?: string
	protocol_data?: {
		parameters?: {
			offer?: OpenSeaOfferItem[]
			consideration?: OpenSeaConsiderationItem[]
			startTime?: string
			endTime?: string
		}
	}
}

export interface OpenSeaBestOfferResponse {
	order_hash: string
	chain: string
	protocol_address?: string
	price?: {
		currency?: string
		decimals?: number
		value: string
	}
	status?: string
	criteria?: OpenSeaOfferCriteria
	protocol_data?: {
		parameters?: {
			offer?: OpenSeaOfferItem[]
			consideration?: OpenSeaConsiderationItem[]
			startTime?: string
			endTime?: string
		}
	}
}

interface OpenSeaAdditionalRecipient {
	amount: string
	recipient: string
}

interface OpenSeaBasicOrderParameters {
	considerationToken: string
	considerationIdentifier: string
	considerationAmount: string
	offerer: string
	zone: string
	offerToken: string
	offerIdentifier: string
	offerAmount: string
	basicOrderType: number
	startTime: string
	endTime: string
	zoneHash: string
	salt: string
	offererConduitKey: string
	fulfillerConduitKey: string
	totalOriginalAdditionalRecipients: string
	additionalRecipients: OpenSeaAdditionalRecipient[]
	signature: string
}

export interface OpenSeaOrderParameters {
	offerer: string
	zone: string
	offer: OpenSeaOfferItem[]
	consideration: OpenSeaConsiderationItem[]
	orderType: number
	startTime: string
	endTime: string
	zoneHash: string
	salt: string
	conduitKey: string
	totalOriginalConsiderationItems: string
}

export interface OpenSeaOrderParametersWithCounter extends OpenSeaOrderParameters {
	counter: string
}

export interface OpenSeaOrderResponse {
	order_hash: string
	chain: string
	protocol_address?: string
	status?: string
	type?: string
	protocol_data?: {
		parameters?: OpenSeaOrderParametersWithCounter
		signature?: string | null
	}
}

export interface OpenSeaAdvancedOrder {
	parameters: OpenSeaOrderParameters
	numerator: number | string
	denominator: number | string
	signature: string
	extraData: string
}

export interface OpenSeaCollectionResponse {
	collection: string
	name?: string
	collection_offers_enabled?: boolean
	trait_offers_enabled?: boolean
	contracts?: Array<{
		address: string
		chain: string
	}>
	fees?: Array<{
		fee: number
		recipient: string
		required: boolean
	}>
	pricing_currencies?: {
		listing_currency?: {
			symbol?: string
			address: string
			chain?: string
			decimals?: number
			name?: string
		}
		offer_currency?: {
			symbol?: string
			address: string
			chain?: string
			decimals?: number
			name?: string
		}
	}
}

export interface OpenSeaNftResponse {
	nft?: {
		identifier: string
		collection?: string
		contract: string
		token_standard?: string
		name?: string
		owners?: Array<{
			address: string
			quantity: number | string
		}>
	}
}

export interface OpenSeaSwapQuote {
	total_price_usd?: number
	total_cost_usd?: number
	slippage_tolerance?: number
	estimated_duration_ms?: number
	marketplace_fee_bps?: number
}

export interface OpenSeaSwapTransaction {
	chain?: string | { identifier?: string; networkId?: number }
	to?: string
	data: string
	value?: string
}

export interface OpenSeaSwapQuoteResponse {
	quote?: OpenSeaSwapQuote
	transactions?: OpenSeaSwapTransaction[]
	swapQuote?: unknown
	swap?: {
		actions?: Array<{
			transactionSubmissionData?: {
				to?: string
				data: string
				value?: string
				chain?: string | { identifier?: string; networkId?: number }
			}
		}>
	}
}

export interface OpenSeaCriteriaResolver {
	orderIndex: number | string
	side: number | string
	index: number | string
	identifier: string
	criteriaProof: string[]
}

interface OpenSeaFulfillmentComponent {
	orderIndex: number | string
	itemIndex: number | string
}

export interface OpenSeaFulfillmentMatch {
	offerComponents: OpenSeaFulfillmentComponent[]
	considerationComponents: OpenSeaFulfillmentComponent[]
}

export interface OpenSeaFulfillmentResponse {
	protocol?: string
	fulfillment_data?: {
		transaction?: {
			function?: string
			chain?: number
			to: string
			value: string
			data?: string
			input_data?: {
				parameters?: OpenSeaBasicOrderParameters
				data?: string
				advancedOrder?: OpenSeaAdvancedOrder
				orders?: OpenSeaAdvancedOrder[]
				criteriaResolvers?: OpenSeaCriteriaResolver[]
				fulfillments?: OpenSeaFulfillmentMatch[]
				fulfillerConduitKey?: string
				recipient?: string
			}
		}
	}
}

export async function getOrder(args: {
	chain: string
	orderHash: string
	protocolAddress?: string
}): Promise<OpenSeaOrderResponse> {
	const normalizedChain = normalizeOpenSeaChain(args.chain)
	try {
		const response = await request<{ order?: OpenSeaOrderResponse }>(
			`/api/v2/orders/chain/${encodeURIComponent(normalizedChain.apiName)}/protocol/${encodeURIComponent(args.protocolAddress ?? OPENSEA_SEAPORT_V1_6)}/${encodeURIComponent(args.orderHash)}`,
		)

		if (!response.order) {
			throw new Error(`OpenSea order lookup did not include an order for ${args.orderHash}`)
		}

		return response.order
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			if (httpError.status === 404) {
				throw new Error(`OpenSea order not found for ${args.orderHash}: ${httpError.apiMessage}`)
			}
			throw new Error(`OpenSea order lookup failed for ${args.orderHash}: ${httpError.apiMessage}`)
		}

		throw new Error(`OpenSea order lookup failed for ${args.orderHash}: ${message}`)
	}
}

export async function cancelOrder(args: {
	chain: string
	orderHash: string
	protocolAddress?: string
}): Promise<unknown> {
	const normalizedChain = normalizeOpenSeaChain(args.chain)
	try {
		return await request(
			`/api/v2/orders/chain/${encodeURIComponent(normalizedChain.apiName)}/protocol/${encodeURIComponent(args.protocolAddress ?? OPENSEA_SEAPORT_V1_6)}/${encodeURIComponent(args.orderHash)}/cancel`,
			{
				method: 'POST',
				body: JSON.stringify({}),
			},
		)
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			throw new Error(
				`OpenSea order cancellation failed for ${args.orderHash}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(`OpenSea order cancellation failed for ${args.orderHash}: ${message}`)
	}
}

export function normalizeOpenSeaChain(chain: string): {
	input: string
	apiName: string
	chainId: number
} {
	const normalized = chain.trim().toLowerCase() as OpenSeaChainAlias
	const config = OPEN_SEA_CHAIN_CONFIG[normalized]
	if (!config) {
		throw new Error(
			`Unsupported OpenSea chain: "${chain}". Supported: ${Object.keys(OPEN_SEA_CHAIN_CONFIG).join(', ')}`,
		)
	}

	return {
		input: normalized,
		apiName: config.apiName,
		chainId: config.chainId,
	}
}

export async function getBestListing(args: {
	collection: string
	tokenId: string
}): Promise<OpenSeaBestListingResponse> {
	try {
		return await request<OpenSeaBestListingResponse>(
			`/api/v2/listings/collection/${encodeURIComponent(args.collection)}/nfts/${encodeURIComponent(args.tokenId)}/best`,
		)
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			if (httpError.status === 404) {
				throw new Error(
					`No active OpenSea listing found for ${args.collection} #${args.tokenId}. ${httpError.apiMessage}`,
				)
			}
			throw new Error(
				`OpenSea listing lookup failed for ${args.collection} #${args.tokenId}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(
			`OpenSea listing lookup failed for ${args.collection} #${args.tokenId}: ${message}`,
		)
	}
}

export async function getBestOffer(args: {
	collection: string
	tokenId: string
}): Promise<OpenSeaBestOfferResponse> {
	try {
		return await request<OpenSeaBestOfferResponse>(
			`/api/v2/offers/collection/${encodeURIComponent(args.collection)}/nfts/${encodeURIComponent(args.tokenId)}/best`,
		)
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			if (httpError.status === 404) {
				throw new Error(
					`No active OpenSea offer found for ${args.collection} #${args.tokenId}. ${httpError.apiMessage}`,
				)
			}
			throw new Error(
				`OpenSea offer lookup failed for ${args.collection} #${args.tokenId}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(
			`OpenSea offer lookup failed for ${args.collection} #${args.tokenId}: ${message}`,
		)
	}
}

export async function getListingFulfillmentData(args: {
	chain: string
	orderHash: string
	wallet: string
	protocolAddress?: string
}): Promise<OpenSeaFulfillmentResponse> {
	const normalizedChain = normalizeOpenSeaChain(args.chain)
	try {
		return await request<OpenSeaFulfillmentResponse>('/api/v2/listings/fulfillment_data', {
			method: 'POST',
			body: JSON.stringify({
				listing: {
					hash: args.orderHash,
					chain: normalizedChain.apiName,
					protocol_address: args.protocolAddress ?? OPENSEA_SEAPORT_V1_6,
				},
				fulfiller: {
					address: args.wallet,
				},
			}),
		})
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			throw new Error(
				`OpenSea fulfillment lookup failed for order ${args.orderHash}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(`OpenSea fulfillment lookup failed for order ${args.orderHash}: ${message}`)
	}
}

export async function getCollection(args: {
	collection: string
}): Promise<OpenSeaCollectionResponse> {
	try {
		return await request<OpenSeaCollectionResponse>(
			`/api/v2/collections/${encodeURIComponent(args.collection)}`,
		)
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			if (httpError.status === 404) {
				throw new Error(`OpenSea collection not found: ${args.collection}. ${httpError.apiMessage}`)
			}
			throw new Error(
				`OpenSea collection lookup failed for ${args.collection}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(`OpenSea collection lookup failed for ${args.collection}: ${message}`)
	}
}

export async function getNft(args: {
	chain: string
	contract: string
	tokenId: string
}): Promise<OpenSeaNftResponse> {
	const normalizedChain = normalizeOpenSeaChain(args.chain)
	try {
		return await request<OpenSeaNftResponse>(
			`/api/v2/chain/${encodeURIComponent(normalizedChain.apiName)}/contract/${encodeURIComponent(args.contract)}/nfts/${encodeURIComponent(args.tokenId)}`,
		)
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			if (httpError.status === 404) {
				throw new Error(
					`OpenSea NFT not found for ${args.contract} #${args.tokenId}: ${httpError.apiMessage}`,
				)
			}
			throw new Error(
				`OpenSea NFT lookup failed for ${args.contract} #${args.tokenId}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(`OpenSea NFT lookup failed for ${args.contract} #${args.tokenId}: ${message}`)
	}
}

export async function getOfferFulfillmentData(args: {
	chain: string
	orderHash: string
	wallet: string
	contractAddress: string
	tokenId: string
	protocolAddress?: string
}): Promise<OpenSeaFulfillmentResponse> {
	const normalizedChain = normalizeOpenSeaChain(args.chain)
	try {
		return await request<OpenSeaFulfillmentResponse>('/api/v2/offers/fulfillment_data', {
			method: 'POST',
			body: JSON.stringify({
				offer: {
					hash: args.orderHash,
					chain: normalizedChain.apiName,
					protocol_address: args.protocolAddress ?? OPENSEA_SEAPORT_V1_6,
				},
				fulfiller: {
					address: args.wallet,
				},
				consideration: {
					asset_contract_address: args.contractAddress,
					token_id: args.tokenId,
				},
			}),
		})
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			throw new Error(
				`OpenSea offer fulfillment lookup failed for order ${args.orderHash}: ${httpError.apiMessage}`,
			)
		}

		throw new Error(
			`OpenSea offer fulfillment lookup failed for order ${args.orderHash}: ${message}`,
		)
	}
}

export async function getSwapQuote(args: {
	fromChain: string
	fromAddress: string
	toChain: string
	toAddress: string
	quantity: string
	address: string
	slippage?: number
	recipient?: string
}): Promise<OpenSeaSwapQuoteResponse> {
	const fromChain = normalizeOpenSeaChain(args.fromChain)
	const toChain = normalizeOpenSeaChain(args.toChain)
	const params = new URLSearchParams({
		from_chain: fromChain.apiName,
		from_address: args.fromAddress,
		to_chain: toChain.apiName,
		to_address: args.toAddress,
		quantity: args.quantity,
		address: args.address,
	})
	if (args.slippage !== undefined) {
		params.set('slippage', args.slippage.toString())
	}
	if (args.recipient) {
		params.set('recipient', args.recipient)
	}

	try {
		return await request<OpenSeaSwapQuoteResponse>(`/api/v2/swap/quote?${params.toString()}`)
	} catch (error) {
		const message = getErrorMessage(error)
		const httpError = parseHttpError(message)
		if (httpError) {
			throw new Error(`OpenSea swap quote failed: ${httpError.apiMessage}`)
		}

		throw new Error(`OpenSea swap quote failed: ${message}`)
	}
}
