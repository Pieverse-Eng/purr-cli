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
	buildOpenSeaCancelListingPreview,
	buildOpenSeaCancelOfferSteps,
	buildOpenSeaCancelListingSteps,
	cancelOpenSeaOffer,
	cancelOpenSeaListing,
	createOpenSeaOffer,
	createOpenSeaListing,
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
const ERC1155_APPROVE_ABI = parseAbi(['function setApprovalForAll(address operator, bool approved)'])
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
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('builds buy steps for native ETH listing', async () => {
		const fulfillment = makeBasicFulfillment()

		const result = await buildOpenSeaBuySteps({
			wallet: WALLET,
			fulfillment,
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

		const result = await buildOpenSeaBuySteps({
			wallet: WALLET,
			fulfillment,
		})

		expect(result.steps).toHaveLength(2)
		// First step: ERC20 approval
		expect(result.steps[0].label).toBe('Approve ERC20 payment token for OpenSea')
		expect(result.steps[0].to.toLowerCase()).toBe(WETH.toLowerCase())
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.token.toLowerCase()).toBe(WETH.toLowerCase())
		expect(result.steps[0].conditional?.spender.toLowerCase()).toBe(
			OPENSEA_SEAPORT_V1_6.toLowerCase(),
		)
		expect(result.steps[0].conditional?.amount).toBe('1000000000000000000')
		const approveDecoded = decodeFunctionData({
			abi: ERC20_APPROVE_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(approveDecoded.functionName).toBe('approve')
		expect((approveDecoded.args?.[0] as string).toLowerCase()).toBe(
			OPENSEA_SEAPORT_V1_6.toLowerCase(),
		)
		expect(approveDecoded.args?.[1]).toBeGreaterThan(1000000000000000000n)
		// Second step: fulfillment
		expect(result.steps[1].label).toBe('OpenSea buy NFT')
	})

	it('rejects fulfillment payloads without a transaction', async () => {
		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment: {},
			}),
		).rejects.toThrow('did not include a transaction')
	})

	it('rejects fulfillment payloads with invalid chain', async () => {
		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment: {
					...makeBasicFulfillment(),
					fulfillment_data: {
						transaction: {
							...makeBasicFulfillment().fulfillment_data!.transaction!,
							chain: 0,
						},
					},
				},
			}),
		).rejects.toThrow('valid chain')
	})

	it('rejects fulfillment payloads on unsupported OpenSea chains', async () => {
		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment: {
					...makeBasicFulfillment(),
					fulfillment_data: {
						transaction: {
							...makeBasicFulfillment().fulfillment_data!.transaction!,
							chain: 56,
						},
					},
				},
			}),
		).rejects.toThrow('supported OpenSea chain')
	})

	it('rejects fulfillment payloads with mixed payment assets', async () => {
		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment: {
					protocol: 'seaport',
					fulfillment_data: {
						transaction: {
							function:
								'matchAdvancedOrders(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)',
							chain: 1,
							to: OPENSEA_SEAPORT_V1_6,
							value: '0',
							input_data: {
								orders: [
									{
										parameters: {
											offerer: ADDR_A,
											zone: NATIVE,
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
													startAmount: '10',
													endAmount: '10',
													recipient: ADDR_A,
												},
												{
													itemType: 1,
													token: WETH,
													identifierOrCriteria: '0',
													startAmount: '20',
													endAmount: '20',
													recipient: ADDR_B,
												},
											],
											orderType: 0,
											startTime: '0',
											endTime: '9999999999',
											zoneHash: `0x${'0'.repeat(64)}`,
											salt: '1',
											conduitKey: OPENSEA_CONDUIT_KEY,
											totalOriginalConsiderationItems: '2',
										},
										numerator: 1,
										denominator: 1,
										signature: '0x12',
										extraData: '0x',
									},
								],
								criteriaResolvers: [],
								fulfillments: [],
								recipient: WALLET,
							},
						},
					},
				},
			}),
		).rejects.toThrow('mixed payment assets')
	})

	it('rejects buy fulfillments whose recipient does not match the wallet', async () => {
		const fulfillment: OpenSeaFulfillmentResponse = {
			protocol: 'seaport',
			fulfillment_data: {
				transaction: {
					function:
						'matchAdvancedOrders(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)',
					chain: 1,
					to: OPENSEA_SEAPORT_V1_6,
					value: '0',
					input_data: {
						orders: [
							{
								parameters: {
									offerer: ADDR_A,
									zone: NATIVE,
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
											startAmount: '10',
											endAmount: '10',
											recipient: ADDR_A,
										},
									],
									orderType: 0,
									startTime: '0',
									endTime: '9999999999',
									zoneHash: `0x${'0'.repeat(64)}`,
									salt: '1',
									conduitKey: OPENSEA_CONDUIT_KEY,
									totalOriginalConsiderationItems: '1',
								},
								numerator: 1,
								denominator: 1,
								signature: '0x12',
								extraData: '0x',
							},
						],
						criteriaResolvers: [],
						fulfillments: [],
						recipient: ADDR_A,
					},
				},
			},
		}

		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment,
			}),
		).rejects.toThrow('recipient does not match wallet')
	})

	it('rejects malformed raw calldata in fulfillment responses', async () => {
		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment: {
					...makeBasicFulfillment(),
					fulfillment_data: {
						transaction: {
							...makeBasicFulfillment().fulfillment_data!.transaction!,
							data: '0xabc',
						},
					},
				},
			}),
		).rejects.toThrow('hex calldata')
	})

	it('rejects fulfillments with invalid target addresses', async () => {
		await expect(
			buildOpenSeaBuySteps({
				wallet: WALLET,
				fulfillment: {
					...makeBasicFulfillment(),
					fulfillment_data: {
						transaction: {
							...makeBasicFulfillment().fulfillment_data!.transaction!,
							to: 'not-an-address',
						},
					},
				},
			}),
		).rejects.toThrow('fulfillment target')
	})
})

describe('buildOpenSeaSellSteps', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('builds sell steps with NFT approval + fulfillment', async () => {
		const fulfillment = makeSellFulfillment()
		// ownerOf RPC call returns wallet as owner
		const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
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
			fulfillment,
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

	it('rejects fulfillment payloads without a transaction', async () => {
		await expect(
			buildOpenSeaSellSteps({
				fulfillment: {},
				wallet: WALLET,
			}),
		).rejects.toThrow('did not include a transaction')
	})

	it('rejects sell fulfillments on unsupported OpenSea chains', async () => {
		await expect(
			buildOpenSeaSellSteps({
				wallet: WALLET,
				fulfillment: {
					...makeSellFulfillment(),
					fulfillment_data: {
						transaction: {
							...makeSellFulfillment().fulfillment_data!.transaction!,
							chain: 56,
						},
					},
				},
			}),
		).rejects.toThrow('supported OpenSea chain')
	})

	it('rejects when wallet does not own the NFT in the fulfillment', async () => {
		const ownerResult = `0x000000000000000000000000${ADDR_A.slice(2).toLowerCase()}`
		const mock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
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

		await expect(
			buildOpenSeaSellSteps({
				fulfillment: makeSellFulfillment(),
				wallet: WALLET,
			}),
		).rejects.toThrow('is not the owner')
	})

	it('uses setApprovalForAll for ERC1155 sell fulfillment', async () => {
		const balanceResult = `0x${'0'.repeat(63)}1`
		const fulfillment: OpenSeaFulfillmentResponse = {
			...makeSellFulfillment(),
			fulfillment_data: {
				transaction: {
					...makeSellFulfillment().fulfillment_data!.transaction!,
					input_data: {
						...makeSellFulfillment().fulfillment_data!.transaction!.input_data!,
						advancedOrder: {
							...makeSellFulfillment().fulfillment_data!.transaction!.input_data!.advancedOrder!,
							parameters: {
								...makeSellFulfillment().fulfillment_data!.transaction!.input_data!.advancedOrder!
									.parameters,
								consideration: [
									{
										itemType: 3,
										token: NFT_CONTRACT,
										identifierOrCriteria: '1234',
										startAmount: '1',
										endAmount: '1',
										recipient: ADDR_C,
									},
								],
							},
						},
					},
				},
			},
		}

		const mock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				return {
					ok: true,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: balanceResult }),
				}
			}
			return { ok: true, json: () => Promise.resolve({}) }
		})
		vi.stubGlobal('fetch', mock)

		const result = await buildOpenSeaSellSteps({
			fulfillment,
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].label).toBe('Approve NFT collection for OpenSea')
		const approval = decodeFunctionData({
			abi: ERC1155_APPROVE_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(approval.functionName).toBe('setApprovalForAll')
		expect(approval.args).toEqual(['0x1E0049783F008A0085193E00003D00cd54003c71', true])
	})

	it('rejects malformed raw calldata in sell fulfillment responses', async () => {
		await expect(
			buildOpenSeaSellSteps({
				wallet: WALLET,
				fulfillment: {
					...makeSellFulfillment(),
					fulfillment_data: {
						transaction: {
							...makeSellFulfillment().fulfillment_data!.transaction!,
							data: '0xabc',
						},
					},
				},
			}),
		).rejects.toThrow('hex calldata')
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

	it('rejects swap quote transactions without a target contract', async () => {
		const quoteResponse: OpenSeaSwapQuoteResponse = {
			transactions: [
				{
					chain: 'base',
					data: '0xabcdef12',
					value: '0',
				},
			],
		}

		const mock = mockFetchSequence([{ url: /\/swap\/quote/, data: quoteResponse }])
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaSwapSteps({
				fromChain: 'base',
				fromAddress: NATIVE,
				toChain: 'base',
				toAddress: WETH,
				quantity: '1000',
				wallet: WALLET,
			}),
		).rejects.toThrow('did not include a target contract')
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
		expect(preview.steps[0].conditional?.type).toBe('allowance_lt')
		expect(preview.steps[0].conditional?.token.toLowerCase()).toBe(WETH.toLowerCase())
		expect(preview.steps[0].conditional?.spender.toLowerCase()).toBe(
			'0x1E0049783F008A0085193E00003D00cd54003c71'.toLowerCase(),
		)
		expect(preview.steps[0].conditional?.amount).toBe('500000000000000000')

		// Typed data should be Seaport EIP-712
		expect(preview.typedData.domain).toMatchObject({
			name: 'Seaport',
			version: '1.6',
			chainId: 1,
		})
		expect(preview.typedData.primaryType).toBe('OrderComponents')

		// Submit should include parameters
		expect(preview.submission.protocol_address).toBe(OPENSEA_SEAPORT_V1_6)
		expect(preview.submission.parameters.offerer.toLowerCase()).toBe(WALLET.toLowerCase())
		expect(preview.submission.parameters.counter).toBe('5')

		// Metadata
		expect(preview.metadata.collection).toBe('test-collection')
		expect(preview.metadata.paymentToken.toLowerCase()).toBe(WETH.toLowerCase())

		// Should include fee consideration items
		const feeItems = preview.submission.parameters.consideration.filter(
			(item) => item.recipient.toLowerCase() !== WALLET.toLowerCase(),
		)
		expect(feeItems.length).toBeGreaterThan(0)
	})

	it('rejects collections without an ERC20 offer currency', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
			contracts: [{ address: NFT_CONTRACT, chain: 'ethereum' }],
			pricing_currencies: {
				offer_currency: { symbol: 'ETH', address: NATIVE, decimals: 18 },
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

		const mock = vi.fn().mockImplementation(async (url: string) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, json: () => Promise.resolve(collection) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, json: () => Promise.resolve(nft) }
			}
			return { ok: true, json: () => Promise.resolve({}) }
		})
		vi.stubGlobal('fetch', mock)

		await expect(
			buildOpenSeaOfferPreview({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
				amount: '500000000000000000',
			}),
		).rejects.toThrow('does not expose an ERC20 offer currency')
	})

	it('rejects invalid wallet addresses in offer preview args', async () => {
		await expect(
			buildOpenSeaOfferPreview({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: 'not-an-address',
				amount: '500000000000000000',
			}),
		).rejects.toThrow('wallet')
	})

	it('rejects zero offer amounts', async () => {
		await expect(
			buildOpenSeaOfferPreview({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
				amount: '0',
			}),
		).rejects.toThrow('amount')
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
		expect(preview.submission.parameters.offer).toHaveLength(1)
		expect(preview.submission.parameters.offer[0].itemType).toBe(2) // ERC721

		// Consideration should include seller proceeds + fees
		expect(preview.submission.parameters.consideration.length).toBeGreaterThanOrEqual(2)

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

	it('rejects invalid wallet addresses in listing preview args', async () => {
		await expect(
			buildOpenSeaListingPreview({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: 'not-an-address',
				amount: '4000000000000000000',
			}),
		).rejects.toThrow('wallet')
	})

	it('rejects zero listing amounts', async () => {
		await expect(
			buildOpenSeaListingPreview({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
				amount: '0',
			}),
		).rejects.toThrow('amount')
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

describe('buildOpenSeaCancelListingPreview', () => {
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

	it('builds cancel preview with on-chain cancel step for listings', async () => {
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
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
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

		const preview = await buildOpenSeaCancelListingPreview({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(preview.mode).toBe('onchain-only')
		expect(preview.steps).toHaveLength(1)
		expect(preview.steps[0].label).toBe('Cancel OpenSea listing on-chain')
		expect(preview.metadata.orderKind).toBe('listing')
	})
})

describe('cancel preview step builders', () => {
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

	it('normalizes cancel-offer preview into plain StepOutput', async () => {
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
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		vi.stubGlobal('fetch', mockFetchSequence([{ url: /\/orders\/chain/, data: order }]))

		const result = await buildOpenSeaCancelOfferSteps({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(result).toEqual({
			steps: [
				expect.objectContaining({
					label: 'Cancel OpenSea offer on-chain',
					chainId: 1,
				}),
			],
		})
	})

	it('normalizes cancel-list preview into plain StepOutput', async () => {
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
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		vi.stubGlobal('fetch', mockFetchSequence([{ url: /\/orders\/chain/, data: order }]))

		const result = await buildOpenSeaCancelListingSteps({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(result).toEqual({
			steps: [
				expect.objectContaining({
					label: 'Cancel OpenSea listing on-chain',
					chainId: 1,
				}),
			],
		})
	})
})

describe('cancelOpenSeaOffer', () => {
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

	it('uses the official cancel API for signed-zone offers when it succeeds', async () => {
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
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes(`/orders/chain/ethereum/protocol/`)) {
				if (init?.method === 'POST') {
					return {
						ok: true,
						status: 200,
						json: () => Promise.resolve({ cancelled: true }),
						text: () => Promise.resolve('{"cancelled":true}'),
					}
				}
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve(order),
					text: () => Promise.resolve(JSON.stringify(order)),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		const result = await cancelOpenSeaOffer({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(result.mode).toBe('official')
		expect(result.official).toEqual({ cancelled: true })
		expect(result.metadata.signedZone).toBe(true)
		expect(mock).not.toHaveBeenCalledWith(
			expect.stringContaining('/wallet/execute'),
			expect.anything(),
		)
	})

	it('falls back to on-chain execution when the official cancel API rejects the maker identity', async () => {
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
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes(`/orders/chain/ethereum/protocol/`)) {
				if (init?.method === 'POST') {
					return {
						ok: false,
						status: 400,
						json: () =>
							Promise.resolve({
								errors: ['API key account does not match the expected maker'],
							}),
						text: () =>
							Promise.resolve(
								JSON.stringify({
									errors: ['API key account does not match the expected maker'],
								}),
							),
					}
				}
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve(order),
					text: () => Promise.resolve(JSON.stringify(order)),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: WALLET,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				const body = JSON.parse((init?.body as string | undefined) ?? '{}') as {
					steps?: Array<{ label?: string }>
				}
				expect(body.steps).toHaveLength(1)
				expect(body.steps?.[0]?.label).toBe('Cancel OpenSea offer on-chain')
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							results: [{ stepIndex: 0, label: body.steps?.[0]?.label, hash: '0xabc', status: 'success' }],
							from: WALLET,
							chainId: 1,
							chainType: 'evm',
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		const result = await cancelOpenSeaOffer({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(result.mode).toBe('official-fallback-onchain')
		expect(result.execution?.results[0]?.label).toBe('Cancel OpenSea offer on-chain')
	})

	it('rejects cancel-offer fallback execution when the instance wallet does not match the requested wallet', async () => {
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
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes(`/orders/chain/ethereum/protocol/`)) {
				if (init?.method === 'POST') {
					return {
						ok: false,
						status: 400,
						json: () =>
							Promise.resolve({
								errors: ['API key account does not match the expected maker'],
							}),
						text: () =>
							Promise.resolve(
								JSON.stringify({
									errors: ['API key account does not match the expected maker'],
								}),
							),
					}
				}
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve(order),
					text: () => Promise.resolve(JSON.stringify(order)),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: ADDR_A,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				throw new Error('cancel execution should not start when wallet mismatches')
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		await expect(
			cancelOpenSeaOffer({
				chain: 'ethereum',
				orderHash: ORDER_HASH,
				wallet: WALLET,
			}),
		).rejects.toThrow('instance wallet does not match requested wallet')
	})
})

describe('cancelOpenSeaListing', () => {
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

	it('executes on-chain cancel directly for non-signed listings', async () => {
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
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes(`/orders/chain/ethereum/protocol/`)) {
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve(order),
					text: () => Promise.resolve(JSON.stringify(order)),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: WALLET,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				const body = JSON.parse((init?.body as string | undefined) ?? '{}') as {
					steps?: Array<{ label?: string }>
				}
				expect(body.steps?.[0]?.label).toBe('Cancel OpenSea listing on-chain')
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							results: [{ stepIndex: 0, label: body.steps?.[0]?.label, hash: '0xdef', status: 'success' }],
							from: WALLET,
							chainId: 1,
							chainType: 'evm',
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		const result = await cancelOpenSeaListing({
			chain: 'ethereum',
			orderHash: ORDER_HASH,
			wallet: WALLET,
		})

		expect(result.mode).toBe('onchain')
		expect(result.execution?.results[0]?.label).toBe('Cancel OpenSea listing on-chain')
	})

	it('rejects cancel-list execution when the instance wallet does not match the requested wallet', async () => {
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
								startAmount: '500000000000000000',
								endAmount: '500000000000000000',
								recipient: WALLET,
							},
						],
						orderType: 0,
						startTime: '0',
						endTime: '9999999999',
						zoneHash: `0x${'0'.repeat(64)}`,
						salt: '12345',
						conduitKey: OPENSEA_CONDUIT_KEY,
						totalOriginalConsiderationItems: '1',
						counter: '5',
					},
				},
			},
		}

		const mock = vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
			if (typeof url === 'string' && url.includes(`/orders/chain/ethereum/protocol/`)) {
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve(order),
					text: () => Promise.resolve(JSON.stringify(order)),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: ADDR_A,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				throw new Error('cancel execution should not start when wallet mismatches')
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		await expect(
			cancelOpenSeaListing({
				chain: 'ethereum',
				orderHash: ORDER_HASH,
				wallet: WALLET,
			}),
		).rejects.toThrow('instance wallet does not match requested wallet')
	})
})

describe('createOpenSeaOffer', () => {
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

	it('executes approval, signs typed data, and returns submission details for offers', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
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
		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000005'

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(collection), text: () => Promise.resolve(JSON.stringify(collection)) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(nft), text: () => Promise.resolve(JSON.stringify(nft)) }
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: WALLET,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				const body = JSON.parse((init?.body as string | undefined) ?? '{}') as {
					steps?: Array<{ label?: string }>
				}
				expect(body.steps?.[0]?.label).toBe('Approve offer payment token for OpenSea')
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							results: [{ stepIndex: 0, label: body.steps?.[0]?.label, hash: '0xapprove', status: 'success' }],
							from: WALLET,
							chainId: 1,
							chainType: 'evm',
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: counterResult }),
					text: () => Promise.resolve('ok'),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		const result = await createOpenSeaOffer({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
			amount: '500000000000000000',
		})

		expect(result.approval?.results[0]?.label).toBe('Approve offer payment token for OpenSea')
		expect(result.typedData.primaryType).toBe('OrderComponents')
		expect(result.submission.path).toBe('/api/v2/orders/ethereum/seaport/offers')
		expect(result.submission.body).not.toHaveProperty('signature')
		expect(result.submission.signaturePlaceholder).toBe('__PURR_SIGNATURE__')
		expect(result.submission.jsonBodyTemplate).toContain('__PURR_SIGNATURE__')
		expect(mock).not.toHaveBeenCalledWith(
			expect.stringContaining('/wallet/sign-typed-data'),
			expect.anything(),
		)
	})

	it('rejects offer execution when the instance wallet does not match the requested wallet', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
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
		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000005'

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(collection), text: () => Promise.resolve(JSON.stringify(collection)) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(nft), text: () => Promise.resolve(JSON.stringify(nft)) }
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: ADDR_A,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				throw new Error('approval should not execute when wallet mismatches')
			}
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: counterResult }),
					text: () => Promise.resolve('ok'),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		await expect(
			createOpenSeaOffer({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
				amount: '500000000000000000',
			}),
		).rejects.toThrow('instance wallet does not match requested wallet')
	})

})

describe('createOpenSeaListing', () => {
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

	it('executes approval, signs typed data, and returns submission details for listings', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
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
		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000003'
		const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(collection), text: () => Promise.resolve(JSON.stringify(collection)) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(nft), text: () => Promise.resolve(JSON.stringify(nft)) }
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: WALLET,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				const body = JSON.parse((init?.body as string | undefined) ?? '{}') as {
					steps?: Array<{ label?: string }>
				}
				expect(body.steps?.[0]?.label).toBe('Approve NFT for OpenSea')
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							results: [{ stepIndex: 0, label: body.steps?.[0]?.label, hash: '0xapprove-nft', status: 'success' }],
							from: WALLET,
							chainId: 1,
							chainType: 'evm',
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				const callData = body.params?.[0]?.data as string | undefined
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							jsonrpc: '2.0',
							id: 1,
							result: callData?.startsWith('0x6352211e') ? ownerResult : counterResult,
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		const result = await createOpenSeaListing({
			chain: 'ethereum',
			collection: 'test-collection',
			tokenId: '1234',
			wallet: WALLET,
			amount: '4000000000000000000',
		})

		expect(result.approval?.results[0]?.label).toBe('Approve NFT for OpenSea')
		expect(result.typedData.primaryType).toBe('OrderComponents')
		expect(result.submission.path).toBe('/api/v2/orders/ethereum/seaport/listings')
		expect(result.submission.body).not.toHaveProperty('signature')
		expect(result.submission.signaturePlaceholder).toBe('__PURR_SIGNATURE__')
		expect(result.submission.jsonBodyTemplate).toContain('__PURR_SIGNATURE__')
		expect(mock).not.toHaveBeenCalledWith(
			expect.stringContaining('/wallet/sign-typed-data'),
			expect.anything(),
		)
	})

	it('rejects listing execution when the instance wallet does not match the requested wallet', async () => {
		const collection: OpenSeaCollectionResponse = {
			collection: 'test-collection',
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
		const counterResult = '0x0000000000000000000000000000000000000000000000000000000000000003'
		const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`

		const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.includes('/collections/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(collection), text: () => Promise.resolve(JSON.stringify(collection)) }
			}
			if (typeof url === 'string' && url.includes('/nfts/')) {
				return { ok: true, status: 200, json: () => Promise.resolve(nft), text: () => Promise.resolve(JSON.stringify(nft)) }
			}
			if (typeof url === 'string' && url.includes('/wallet/ensure')) {
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							ok: true,
							data: {
								address: ADDR_A,
								chainId: 1,
								chainType: 'ethereum',
								createdNow: false,
							},
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			if (typeof url === 'string' && url.includes('/wallet/execute')) {
				throw new Error('approval should not execute when wallet mismatches')
			}
			const body = init?.body ? JSON.parse(init.body as string) : {}
			if (body.method === 'eth_call') {
				const callData = body.params?.[0]?.data as string | undefined
				return {
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							jsonrpc: '2.0',
							id: 1,
							result: callData?.startsWith('0x6352211e') ? ownerResult : counterResult,
						}),
					text: () => Promise.resolve('ok'),
				}
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		})
		vi.stubGlobal('fetch', mock)

		await expect(
			createOpenSeaListing({
				chain: 'ethereum',
				collection: 'test-collection',
				tokenId: '1234',
				wallet: WALLET,
				amount: '4000000000000000000',
			}),
		).rejects.toThrow('instance wallet does not match requested wallet')
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
		vi.stubGlobal('fetch', vi.fn())
		await expect(
			buildOpenSeaSwapSteps({
				fromChain: 'base',
				fromAddress: NATIVE,
				toChain: 'base',
				toAddress: WETH,
				quantity: '1000',
				wallet: WALLET,
			}),
		).rejects.toThrow('OPENSEA_API_KEY')
	})
})
