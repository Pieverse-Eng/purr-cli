import { decodeFunctionData, parseAbi } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	normalizeOpenSeaChain,
	OPENSEA_SEAPORT_V1_6,
	OPENSEA_CONDUIT_KEY,
	type OpenSeaBestListingResponse,
	type OpenSeaBestOfferResponse,
	type OpenSeaFulfillmentResponse,
	type OpenSeaCollectionResponse,
	type OpenSeaNftResponse,
	type OpenSeaOrderResponse,
	type OpenSeaSwapQuoteResponse,
} from '../vendors/opensea-api.js'
import {
	buildOpenSeaBuySteps,
	buildOpenSeaSellSteps,
	buildOpenSeaSwapSteps,
	buildOpenSeaOfferPreview,
	buildOpenSeaListingPreview,
	buildOpenSeaCancelOfferPreview,
	OpenSeaCliError,
} from '../vendors/opensea.js'

const WALLET = '0x1234567890123456789012345678901234567890'
const NFT_CONTRACT = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const NATIVE = '0x0000000000000000000000000000000000000000'
const ORDER_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111'
const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ADDR_C = '0xcccccccccccccccccccccccccccccccccccccccc'
const SWAP_TARGET = '0xdeadbeef00000000000000000000000000000001'
const SWAP_TARGET_2 = '0xdeadbeef00000000000000000000000000000002'

const BASIC_ORDER_ABI = parseAbi([
	'function fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
])

const ERC20_APPROVE_ABI = parseAbi([
	'function approve(address spender, uint256 amount) returns (bool)',
])
const SEAPORT_CANCEL_ABI = parseAbi([
	'function cancel((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems,uint256 counter)[] orders) returns (bool cancelled)',
])

// -- Helpers ----------------------------------------------------------------

function mockFetchSequence(responses: Array<{ url: RegExp; data: unknown }>) {
	return vi.fn().mockImplementation(async (url: string) => {
		const match = responses.find((r) => r.url.test(url))
		if (!match) throw new Error(`Unexpected fetch URL: ${url}`)
		return {
			ok: true,
			status: 200,
			json: () => Promise.resolve(match.data),
			text: () => Promise.resolve(JSON.stringify(match.data)),
		}
	})
}

function makeBasicListing(overrides?: Partial<OpenSeaBestListingResponse>): OpenSeaBestListingResponse {
	return {
		order_hash: ORDER_HASH,
		chain: 'ethereum',
		protocol_address: OPENSEA_SEAPORT_V1_6,
		status: 'ACTIVE',
		price: {
			current: { currency: 'ETH', decimals: 18, value: '1000000000000000000' },
		},
		protocol_data: {
			parameters: {
				offer: [
					{
						itemType: 2,
						token: NFT_CONTRACT,
						identifierOrCriteria: '1234',
						startAmount: '1',
						endAmount: '1',
					},
				],
				consideration: [
					{
						itemType: 0,
						token: NATIVE,
						identifierOrCriteria: '0',
						startAmount: '900000000000000000',
						endAmount: '900000000000000000',
						recipient: ADDR_A,
					},
					{
						itemType: 0,
						token: NATIVE,
						identifierOrCriteria: '0',
						startAmount: '100000000000000000',
						endAmount: '100000000000000000',
						recipient: ADDR_B,
					},
				],
				startTime: '0',
				endTime: '9999999999',
			},
		},
		...overrides,
	}
}

function makeBasicFulfillment(): OpenSeaFulfillmentResponse {
	return {
		protocol: 'seaport',
		fulfillment_data: {
			transaction: {
				function:
					'fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
				chain: 1,
				to: OPENSEA_SEAPORT_V1_6,
				value: '1000000000000000000',
				input_data: {
					parameters: {
						considerationToken: NATIVE,
						considerationIdentifier: '0',
						considerationAmount: '900000000000000000',
						offerer: ADDR_A,
						zone: NATIVE,
						offerToken: NFT_CONTRACT,
						offerIdentifier: '1234',
						offerAmount: '1',
						basicOrderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						salt: '12345',
						offererConduitKey: OPENSEA_CONDUIT_KEY,
						fulfillerConduitKey:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						totalOriginalAdditionalRecipients: '1',
						additionalRecipients: [
							{
								amount: '100000000000000000',
								recipient: ADDR_B,
							},
						],
						signature: '0xdeadbeef',
					},
				},
			},
		},
	}
}

function makeBasicOffer(overrides?: Partial<OpenSeaBestOfferResponse>): OpenSeaBestOfferResponse {
	return {
		order_hash: ORDER_HASH,
		chain: 'ethereum',
		protocol_address: OPENSEA_SEAPORT_V1_6,
		status: 'ACTIVE',
		price: { currency: 'WETH', decimals: 18, value: '500000000000000000' },
		criteria: { contract: { address: NFT_CONTRACT } },
		protocol_data: {
			parameters: {
				offer: [
					{
						itemType: 1,
						token: WETH,
						identifierOrCriteria: '0',
						startAmount: '500000000000000000',
						endAmount: '500000000000000000',
					},
				],
				consideration: [
					{
						itemType: 2,
						token: NFT_CONTRACT,
						identifierOrCriteria: '1234',
						startAmount: '1',
						endAmount: '1',
						recipient: ADDR_C,
					},
				],
				startTime: '0',
				endTime: '9999999999',
			},
		},
		...overrides,
	}
}

function makeSellFulfillment(): OpenSeaFulfillmentResponse {
	return {
		protocol: 'seaport',
		fulfillment_data: {
			transaction: {
				function:
					'fulfillAdvancedOrder(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData),(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[],bytes32,address)',
				chain: 1,
				to: OPENSEA_SEAPORT_V1_6,
				value: '0',
				data: '0xabcdef1234567890',
				input_data: {
					advancedOrder: {
						parameters: {
							offerer: ADDR_C,
							zone: NATIVE,
							offer: [
								{
									itemType: 1,
									token: WETH,
									identifierOrCriteria: '0',
									startAmount: '500000000000000000',
									endAmount: '500000000000000000',
								},
							],
							consideration: [
								{
									itemType: 2,
									token: NFT_CONTRACT,
									identifierOrCriteria: '1234',
									startAmount: '1',
									endAmount: '1',
									recipient: ADDR_C,
								},
							],
							orderType: 0,
							startTime: '0',
							endTime: '9999999999',
							zoneHash:
								'0x0000000000000000000000000000000000000000000000000000000000000000',
							salt: '67890',
							conduitKey: OPENSEA_CONDUIT_KEY,
							totalOriginalConsiderationItems: '1',
						},
						numerator: 1,
						denominator: 1,
						signature: '0xdeadbeef',
						extraData: '0x',
					},
					fulfillerConduitKey: OPENSEA_CONDUIT_KEY,
					recipient: WALLET,
				},
			},
		},
	}
}

// -- Tests ------------------------------------------------------------------

describe('normalizeOpenSeaChain', () => {
	it('normalizes ethereum', () => {
		const result = normalizeOpenSeaChain('ethereum')
		expect(result).toEqual({ input: 'ethereum', apiName: 'ethereum', chainId: 1 })
	})

	it('normalizes polygon alias to matic', () => {
		const result = normalizeOpenSeaChain('polygon')
		expect(result).toEqual({ input: 'polygon', apiName: 'matic', chainId: 137 })
	})

	it('is case-insensitive', () => {
		const result = normalizeOpenSeaChain('  Base  ')
		expect(result).toEqual({ input: 'base', apiName: 'base', chainId: 8453 })
	})

	it('throws for unsupported chain', () => {
		expect(() => normalizeOpenSeaChain('solana')).toThrow('Unsupported OpenSea chain')
	})

	it('normalizes all supported chains', () => {
		const chains = [
			'ethereum',
			'matic',
			'polygon',
			'arbitrum',
			'optimism',
			'base',
			'avalanche',
			'klaytn',
			'zora',
			'blast',
			'sepolia',
		]
		for (const chain of chains) {
			expect(() => normalizeOpenSeaChain(chain)).not.toThrow()
		}
	})
})

describe('buildOpenSeaBuySteps', () => {
	beforeEach(() => {
		process.env.WALLET_API_URL = 'https://test.example.com'
		process.env.WALLET_API_TOKEN = 'test-token'
		process.env.INSTANCE_ID = 'test-instance'
		process.env.OPENSEA_API_KEY = 'test-key'
	})

	afterEach(() => {
		delete process.env.WALLET_API_URL
		delete process.env.WALLET_API_TOKEN
		delete process.env.INSTANCE_ID
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('builds buy steps for native ETH listing', async () => {
		const listing = makeBasicListing()
		const fulfillment = makeBasicFulfillment()

		const mock = mockFetchSequence([
			{ url: /\/best$/, data: listing },
			{ url: /\/fulfillment_data/, data: fulfillment },
		])
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaBuySteps({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].chainId).toBe(1)
		expect(result.steps[0].to.toLowerCase()).toBe(OPENSEA_SEAPORT_V1_6.toLowerCase())
		expect(result.steps[0].label).toBe('OpenSea buy NFT')
		// Value should be 1 ETH in hex
		expect(BigInt(result.steps[0].value)).toBe(1000000000000000000n)
		// Verify it produced valid fulfillBasicOrder calldata
		const decoded = decodeFunctionData({
			abi: BASIC_ORDER_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('fulfillBasicOrder_efficient_6GL6yc')
	})

	it('adds ERC20 approval step for ERC20-priced listing', async () => {
		const listing = makeBasicListing({
			protocol_data: {
				parameters: {
					offer: [
						{
							itemType: 2,
							token: NFT_CONTRACT,
							identifierOrCriteria: '1234',
							startAmount: '1',
							endAmount: '1',
						},
					],
					consideration: [
						{
							itemType: 1,
							token: WETH,
							identifierOrCriteria: '0',
							startAmount: '900000000000000000',
							endAmount: '900000000000000000',
							recipient: ADDR_A,
						},
						{
							itemType: 1,
							token: WETH,
							identifierOrCriteria: '0',
							startAmount: '100000000000000000',
							endAmount: '100000000000000000',
							recipient: ADDR_B,
						},
					],
					startTime: '0',
					endTime: '9999999999',
				},
			},
		})

		const fulfillment: OpenSeaFulfillmentResponse = {
			...makeBasicFulfillment(),
			fulfillment_data: {
				transaction: {
					...makeBasicFulfillment().fulfillment_data!.transaction!,
					value: '0',
					input_data: {
						parameters: {
							...makeBasicFulfillment().fulfillment_data!.transaction!.input_data!
								.parameters!,
							considerationToken: WETH,
							considerationAmount: '900000000000000000',
							fulfillerConduitKey:
								'0x0000000000000000000000000000000000000000000000000000000000000000',
						},
					},
				},
			},
		}

		const mock = mockFetchSequence([
			{ url: /\/best$/, data: listing },
			{ url: /\/fulfillment_data/, data: fulfillment },
		])
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaBuySteps({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(2)
		// First step: ERC20 approval
		expect(result.steps[0].label).toBe('Approve ERC20 payment token for OpenSea')
		expect(result.steps[0].to.toLowerCase()).toBe(WETH.toLowerCase())
		const approveDecoded = decodeFunctionData({
			abi: ERC20_APPROVE_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(approveDecoded.functionName).toBe('approve')
		// Second step: fulfillment
		expect(result.steps[1].label).toBe('OpenSea buy NFT')
	})

	it('rejects expired listing', async () => {
		const listing = makeBasicListing({
			protocol_data: {
				parameters: {
					...makeBasicListing().protocol_data!.parameters!,
					endTime: '1000000000', // well in the past
				},
			},
		})

		const mock = mockFetchSequence([{ url: /\/best$/, data: listing }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaBuySteps({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
			}),
		).rejects.toThrow('expired')
	})

	it('rejects inactive listing', async () => {
		const listing = makeBasicListing({ status: 'CANCELLED' })

		const mock = mockFetchSequence([{ url: /\/best$/, data: listing }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaBuySteps({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
			}),
		).rejects.toThrow('not active')
	})

	it('rejects invalid wallet address', async () => {
		await expect(
			buildOpenSeaBuySteps({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: 'not-an-address',
			}),
		).rejects.toThrow('Invalid wallet')
	})

	it('rejects invalid token ID', async () => {
		await expect(
			buildOpenSeaBuySteps({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: 'abc',
				wallet: WALLET,
			}),
		).rejects.toThrow('Invalid --token-id')
	})
})

describe('buildOpenSeaSellSteps', () => {
	beforeEach(() => {
		process.env.WALLET_API_URL = 'https://test.example.com'
		process.env.WALLET_API_TOKEN = 'test-token'
		process.env.INSTANCE_ID = 'test-instance'
		process.env.OPENSEA_API_KEY = 'test-key'
	})

	afterEach(() => {
		delete process.env.WALLET_API_URL
		delete process.env.WALLET_API_TOKEN
		delete process.env.INSTANCE_ID
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('builds sell steps with NFT approval + fulfillment', async () => {
		const offer = makeBasicOffer()
		const fulfillment = makeSellFulfillment()
		// ownerOf RPC call returns wallet as owner
		const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/offers/')) {
				if (url.includes('fulfillment_data')) {
					return {
						ok: true,
						json: () => Promise.resolve(fulfillment),
						text: () => Promise.resolve(JSON.stringify(fulfillment)),
					}
				}
				return {
					ok: true,
					json: () => Promise.resolve(offer),
					text: () => Promise.resolve(JSON.stringify(offer)),
				}
			}
			// RPC call for ownerOf
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				return {
					ok: true,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: ownerResult }),
				}
			}
			return { ok: true, json: () => Promise.resolve({}) }
		})
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaSellSteps({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(2)
		// First: NFT approval
		expect(result.steps[0].label).toMatch(/Approve NFT/)
		expect(result.steps[0].to.toLowerCase()).toBe(NFT_CONTRACT.toLowerCase())
		// Second: sell tx
		expect(result.steps[1].label).toBe('OpenSea sell NFT')
		expect(result.steps[1].to.toLowerCase()).toBe(OPENSEA_SEAPORT_V1_6.toLowerCase())
	})

	it('rejects expired offer', async () => {
		const offer = makeBasicOffer({
			protocol_data: {
				parameters: {
					...makeBasicOffer().protocol_data!.parameters!,
					endTime: '1000000000',
				},
			},
		})

		const mock = mockFetchSequence([{ url: /\/best$/, data: offer }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaSellSteps({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
			}),
		).rejects.toThrow('expired')
	})
})

describe('buildOpenSeaSwapSteps', () => {
	beforeEach(() => {
		process.env.WALLET_API_URL = 'https://test.example.com'
		process.env.WALLET_API_TOKEN = 'test-token'
		process.env.INSTANCE_ID = 'test-instance'
		process.env.OPENSEA_API_KEY = 'test-key'
	})

	afterEach(() => {
		delete process.env.WALLET_API_URL
		delete process.env.WALLET_API_TOKEN
		delete process.env.INSTANCE_ID
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('builds swap steps from quote response', async () => {
		const quoteResponse: OpenSeaSwapQuoteResponse = {
			quote: { total_price_usd: 10 },
			transactions: [
				{
					chain: 'base',
					to: SWAP_TARGET,
					data: '0x12345678',
					value: '1000000000000000',
				},
			],
		}

		const mock = mockFetchSequence([{ url: /\/swap\/quote/, data: quoteResponse }])
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaSwapSteps({
			fromChain: 'base',
			fromAddress: NATIVE,
			toChain: 'base',
			toAddress: '0x4200000000000000000000000000000000000006',
			quantity: '1000000000000000',
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].chainId).toBe(8453)
		expect(result.steps[0].label).toBe('OpenSea swap')
		expect(BigInt(result.steps[0].value)).toBe(1000000000000000n)
	})

	it('handles multi-step swap with approval', async () => {
		const quoteResponse: OpenSeaSwapQuoteResponse = {
			transactions: [
				{
					chain: 'ethereum',
					to: SWAP_TARGET,
					data: '0x095ea7b300000000000000000000000000000000000000000000000000000000',
					value: '0',
				},
				{
					chain: 'ethereum',
					to: SWAP_TARGET_2,
					data: '0xabcdef12',
					value: '0',
				},
			],
		}

		const mock = mockFetchSequence([{ url: /\/swap\/quote/, data: quoteResponse }])
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaSwapSteps({
			fromChain: 'ethereum',
			fromAddress: WETH,
			toChain: 'ethereum',
			toAddress: NATIVE,
			quantity: '500000000000000000',
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].label).toBe('Approve token for OpenSea swap')
		expect(result.steps[1].label).toBe('OpenSea swap')
	})

	it('rejects invalid slippage', async () => {
		await expect(
			buildOpenSeaSwapSteps({
				fromChain: 'base',
				fromAddress: NATIVE,
				toChain: 'base',
				toAddress: WETH,
				quantity: '1000',
				wallet: WALLET,
				slippage: 0.9,
			}),
		).rejects.toThrow('slippage')
	})

	it('handles fallback swap.actions format', async () => {
		const quoteResponse: OpenSeaSwapQuoteResponse = {
			swap: {
				actions: [
					{
						transactionSubmissionData: {
							to: SWAP_TARGET,
							data: '0xabcdef12',
							value: '0',
							chain: 'base',
						},
					},
				],
			},
		}

		const mock = mockFetchSequence([{ url: /\/swap\/quote/, data: quoteResponse }])
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaSwapSteps({
			fromChain: 'base',
			fromAddress: NATIVE,
			toChain: 'base',
			toAddress: WETH,
			quantity: '1000',
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].chainId).toBe(8453)
	})
})

describe('buildOpenSeaOfferPreview', () => {
	beforeEach(() => {
		process.env.WALLET_API_URL = 'https://test.example.com'
		process.env.WALLET_API_TOKEN = 'test-token'
		process.env.INSTANCE_ID = 'test-instance'
		process.env.OPENSEA_API_KEY = 'test-key'
	})

	afterEach(() => {
		delete process.env.WALLET_API_URL
		delete process.env.WALLET_API_TOKEN
		delete process.env.INSTANCE_ID
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('builds offer preview with ERC20 approval and typed data', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
			name: 'Test',
			contracts: [{ address: NFT_CONTRACT, chain: 'ethereum' }],
			fees: [{ fee: 2.5, recipient: ADDR_B, required: true }],
			pricing_currencies: {
				offer_currency: { symbol: 'WETH', address: WETH, decimals: 18 },
			},
		}

		const nft: OpenSeaNftResponse = {
			nft: {
				identifier: '1234',
				collection: 'test-collection',
				contract: NFT_CONTRACT,
				token_standard: 'erc721',
			},
		}

		// getCounter RPC
		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000005'

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, json: () => Promise.resolve(collection) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, json: () => Promise.resolve(nft) }
			}
			// RPC for getCounter
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				return {
					ok: true,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: counterResult }),
				}
			}
			return { ok: true, json: () => Promise.resolve({}) }
		})
		vi.stubGlobal('fetch', mock)

		const preview = await buildOpenSeaOfferPreview({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
			amount: '500000000000000000',
		})

		// Should have an ERC20 approval step
		expect(preview.steps).toHaveLength(1)
		expect(preview.steps[0].label).toBe('Approve offer payment token for OpenSea')

		// Typed data should be Seaport EIP-712
		expect(preview.typedData.domain).toMatchObject({
			name: 'Seaport',
			version: '1.6',
			chainId: 1,
		})
		expect(preview.typedData.primaryType).toBe('OrderComponents')

		// Submit should include parameters
		expect(preview.submit.protocol_address).toBe(OPENSEA_SEAPORT_V1_6)
		expect(preview.submit.parameters.offerer.toLowerCase()).toBe(WALLET.toLowerCase())
		expect(preview.submit.parameters.counter).toBe('5')

		// Metadata
		expect(preview.metadata.collection).toBe('test-collection')
		expect(preview.metadata.paymentToken.toLowerCase()).toBe(WETH.toLowerCase())

		// Should include fee consideration items
		const feeItems = preview.submit.parameters.consideration.filter(
			(item) => item.recipient.toLowerCase() !== WALLET.toLowerCase(),
		)
		expect(feeItems.length).toBeGreaterThan(0)
	})
})

describe('buildOpenSeaListingPreview', () => {
	beforeEach(() => {
		process.env.WALLET_API_URL = 'https://test.example.com'
		process.env.WALLET_API_TOKEN = 'test-token'
		process.env.INSTANCE_ID = 'test-instance'
		process.env.OPENSEA_API_KEY = 'test-key'
	})

	afterEach(() => {
		delete process.env.WALLET_API_URL
		delete process.env.WALLET_API_TOKEN
		delete process.env.INSTANCE_ID
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('builds listing preview with NFT approval and typed data', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
			name: 'Test',
			contracts: [{ address: NFT_CONTRACT, chain: 'ethereum' }],
			fees: [{ fee: 2.5, recipient: ADDR_B, required: true }],
			pricing_currencies: {
				listing_currency: { symbol: 'ETH', address: NATIVE, decimals: 18 },
			},
		}

		const nft: OpenSeaNftResponse = {
			nft: {
				identifier: '1234',
				collection: 'test-collection',
				contract: NFT_CONTRACT,
				token_standard: 'erc721',
			},
		}

		// getCounter and ownerOf RPC calls
		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000003'
		const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, json: () => Promise.resolve(collection) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, json: () => Promise.resolve(nft) }
			}
			// RPC calls
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				const callData = body.params?.[0]?.data as string | undefined
				// ownerOf selector: 0x6352211e
				if (callData?.startsWith('0x6352211e')) {
					return {
						ok: true,
						json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: ownerResult }),
					}
				}
				// getCounter selector: 0xf07ec373
				return {
					ok: true,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: counterResult }),
				}
			}
			return { ok: true, json: () => Promise.resolve({}) }
		})
		vi.stubGlobal('fetch', mock)

		const preview = await buildOpenSeaListingPreview({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
			amount: '4000000000000000000',
		})

		// Should have an NFT approval step
		expect(preview.steps).toHaveLength(1)
		expect(preview.steps[0].label).toMatch(/Approve NFT/)

		// Typed data
		expect(preview.typedData.primaryType).toBe('OrderComponents')

		// Offer item should be the NFT
		expect(preview.submit.parameters.offer).toHaveLength(1)
		expect(preview.submit.parameters.offer[0].itemType).toBe(2) // ERC721

		// Consideration should include seller proceeds + fees
		expect(preview.submit.parameters.consideration.length).toBeGreaterThanOrEqual(2)

		// Metadata
		expect(preview.metadata.paymentItemType).toBe(0) // native
	})

	it('rejects listing amount too small to cover fees', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
			contracts: [{ address: NFT_CONTRACT, chain: 'ethereum' }],
			fees: [{ fee: 100, recipient: ADDR_B, required: true }],
			pricing_currencies: {
				listing_currency: { symbol: 'ETH', address: NATIVE, decimals: 18 },
			},
		}

		const nft: OpenSeaNftResponse = {
			nft: {
				identifier: '1234',
				contract: NFT_CONTRACT,
				token_standard: 'erc721',
			},
		}

		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000001'

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, json: () => Promise.resolve(collection) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, json: () => Promise.resolve(nft) }
			}
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				return {
					ok: true,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: counterResult }),
				}
			}
			return { ok: true, json: () => Promise.resolve({}) }
		})
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaListingPreview({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
				amount: '100', // way too small to cover 100% fee
			}),
		).rejects.toThrow('not enough to cover required fees')
	})
})

describe('buildOpenSeaCancelOfferPreview', () => {
	beforeEach(() => {
		process.env.WALLET_API_URL = 'https://test.example.com'
		process.env.WALLET_API_TOKEN = 'test-token'
		process.env.INSTANCE_ID = 'test-instance'
		process.env.OPENSEA_API_KEY = 'test-key'
	})

	afterEach(() => {
		delete process.env.WALLET_API_URL
		delete process.env.WALLET_API_TOKEN
		delete process.env.INSTANCE_ID
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('builds cancel preview with on-chain cancel step', async () => {
		const order: { order: OpenSeaOrderResponse } = {
			order: {
				order_hash: ORDER_HASH,
				chain: 'ethereum',
				protocol_address: OPENSEA_SEAPORT_V1_6,
				status: 'ACTIVE',
				protocol_data: {
					parameters: {
						offerer: WALLET,
						zone: NATIVE,
						offer: [
							{
								itemType: 1,
								token: WETH,
								identifierOrCriteria: '0',
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
							},
						],
						consideration: [
							{
								itemType: 2,
								token: NFT_CONTRACT,
								identifierOrCriteria: '1234',
								startAmount: '1',
								endAmount: '1',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = mockFetchSequence([{ url: /\/orders\/chain/, data: order }])
		vi.stubGlobal('fetch', mock)

		const preview = await buildOpenSeaCancelOfferPreview({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(preview.mode).toBe('onchain-only')
		expect(preview.steps).toHaveLength(1)
		expect(preview.steps[0].label).toBe('Cancel OpenSea offer on-chain')
		expect(preview.steps[0].to.toLowerCase()).toBe(OPENSEA_SEAPORT_V1_6.toLowerCase())

		// Verify it encodes a Seaport cancel call
		const decoded = decodeFunctionData({
			abi: SEAPORT_CANCEL_ABI,
			data: preview.steps[0].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('cancel')

		expect(preview.metadata.orderKind).toBe('offer')
		expect(preview.metadata.offerer.toLowerCase()).toBe(WALLET.toLowerCase())
	})

	it('uses official-first mode for signed zone orders', async () => {
		const signedZone = '0x000056f7000000ece9003ca63978907a00ffd100'
		const order: { order: OpenSeaOrderResponse } = {
			order: {
				order_hash: ORDER_HASH,
				chain: 'ethereum',
				protocol_address: OPENSEA_SEAPORT_V1_6,
				status: 'ACTIVE',
				protocol_data: {
					parameters: {
						offerer: WALLET,
						zone: signedZone,
						offer: [
							{
								itemType: 1,
								token: WETH,
								identifierOrCriteria: '0',
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
							},
						],
						consideration: [
							{
								itemType: 2,
								token: NFT_CONTRACT,
								identifierOrCriteria: '1234',
								startAmount: '1',
								endAmount: '1',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = mockFetchSequence([{ url: /\/orders\/chain/, data: order }])
		vi.stubGlobal('fetch', mock)

		const preview = await buildOpenSeaCancelOfferPreview({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(preview.mode).toBe('official-first')
		expect(preview.official).toBeDefined()
		expect(preview.metadata.signedZone).toBe(true)
	})

	it('rejects cancel when offerer does not match wallet', async () => {
		const differentWallet = '0x9999999999999999999999999999999999999999' as const
		const order: { order: OpenSeaOrderResponse } = {
			order: {
				order_hash: ORDER_HASH,
				chain: 'ethereum',
				protocol_address: OPENSEA_SEAPORT_V1_6,
				status: 'ACTIVE',
				protocol_data: {
					parameters: {
						offerer: differentWallet,
						zone: NATIVE,
						offer: [
							{
								itemType: 1,
								token: WETH,
								identifierOrCriteria: '0',
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
							},
						],
						consideration: [
							{
								itemType: 2,
								token: NFT_CONTRACT,
								identifierOrCriteria: '1234',
								startAmount: '1',
								endAmount: '1',
								recipient: differentWallet,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = mockFetchSequence([{ url: /\/orders\/chain/, data: order }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaCancelOfferPreview({
				chain: 'ethereum',
				orderHash: ORDER_HASH,
				wallet: WALLET,
			}),
		).rejects.toThrow('does not match wallet')
	})

	it('rejects cancel of non-active order', async () => {
		const order: { order: OpenSeaOrderResponse } = {
			order: {
				order_hash: ORDER_HASH,
				chain: 'ethereum',
				status: 'CANCELLED',
				protocol_data: {
					parameters: {
						offerer: WALLET,
						zone: NATIVE,
						offer: [
							{
								itemType: 1,
								token: WETH,
								identifierOrCriteria: '0',
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
							},
						],
						consideration: [
							{
								itemType: 2,
								token: NFT_CONTRACT,
								identifierOrCriteria: '1234',
								startAmount: '1',
								endAmount: '1',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = mockFetchSequence([{ url: /\/orders\/chain/, data: order }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaCancelOfferPreview({
				chain: 'ethereum',
				orderHash: ORDER_HASH,
				wallet: WALLET,
			}),
		).rejects.toThrow('not active')
	})

	it('rejects cancel-offer when order is actually a listing', async () => {
		const order: { order: OpenSeaOrderResponse } = {
			order: {
				order_hash: ORDER_HASH,
				chain: 'ethereum',
				protocol_address: OPENSEA_SEAPORT_V1_6,
				status: 'ACTIVE',
				protocol_data: {
					parameters: {
						offerer: WALLET,
						zone: NATIVE,
						offer: [
							{
								itemType: 2, // NFT in offer = listing, not an offer
								token: NFT_CONTRACT,
								identifierOrCriteria: '1234',
								startAmount: '1',
								endAmount: '1',
							},
						],
						consideration: [
							{
								itemType: 0,
								token: NATIVE,
								identifierOrCriteria: '0',
								startAmount: '1000',
								endAmount: '1000',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash:
							'0x0000000000000000000000000000000000000000000000000000000000000000',
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = mockFetchSequence([{ url: /\/orders\/chain/, data: order }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaCancelOfferPreview({
				chain: 'ethereum',
				orderHash: ORDER_HASH,
				wallet: WALLET,
			}),
		).rejects.toThrow('listing, not a offer')
	})
})

describe('OpenSeaCliError', () => {
	it('has code and details', () => {
		const error = new OpenSeaCliError('test message', 'TEST_CODE', { key: 'value' })
		expect(error.message).toBe('test message')
		expect(error.code).toBe('TEST_CODE')
		expect(error.details).toEqual({ key: 'value' })
		expect(error.name).toBe('OpenSeaCliError')
		expect(error).toBeInstanceOf(Error)
	})

	it('works without details', () => {
		const error = new OpenSeaCliError('test', 'CODE')
		expect(error.details).toBeUndefined()
	})
})

describe('opensea-api config', () => {
	afterEach(() => {
		delete process.env.OPENSEA_API_KEY
		vi.restoreAllMocks()
	})

	it('rejects when OPENSEA_API_KEY is not set', async () => {
		delete process.env.OPENSEA_API_KEY
		// Any API function that calls getConfig() should throw.
		// We use getBestListing imported through the build functions.
		await expect(
			buildOpenSeaBuySteps({
				chain: 'ethereum',
				collection: 'test',
				tokenId: '1',
				wallet: WALLET,
			}),
		).rejects.toThrow('OPENSEA_API_KEY')
	})
})
