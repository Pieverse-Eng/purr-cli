import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, parseAbi } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBitgetSwapStepsFromCalldata } from '../vendors/bitget.js'
import {
	buildFourMemeBuySteps,
	buildFourMemeCreateTokenSteps,
	buildFourMemeLoginChallenge,
	buildFourMemeSellSteps,
	FOUR_MEME_TEST_CONSTANTS,
} from '../vendors/fourmeme.js'
import {
	buildPancakeAddLiquiditySteps,
	buildPancakeFarmSteps,
	buildPancakeRemoveLiquiditySteps,
	buildPancakeSwapSteps,
	buildPancakeV3FarmSteps,
	buildSyrupStakeSteps,
	buildSyrupUnstakeSteps,
	buildV3CollectSteps,
	buildV3DecreaseLiquiditySteps,
	buildV3IncreaseLiquiditySteps,
	buildV3MintSteps,
} from '../vendors/pancake.js'
import { buildAsterDepositSteps } from '../vendors/aster.js'
import {
	buildListaDepositSteps,
	buildListaRedeemSteps,
	buildListaWithdrawSteps,
} from '../vendors/lista.js'
import {
	buildOpenSeaBuySteps,
	buildOpenSeaSellSteps,
} from '../vendors/opensea.js'

const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const WALLET = '0x1234567890123456789012345678901234567890'
const VAULT = '0x6d6783c146f2b0b2774c1725297f1845dc502525'
const NATIVE = '0x0000000000000000000000000000000000000000'
const TM1 = FOUR_MEME_TEST_CONSTANTS.DEFAULT_TOKEN_MANAGER_V1
const TM2 = FOUR_MEME_TEST_CONSTANTS.DEFAULT_TOKEN_MANAGER_V2
const HELPER = FOUR_MEME_TEST_CONSTANTS.DEFAULT_TOKEN_MANAGER_HELPER3
const TOKEN = '0x1111111111111111111111111111111111111111'
const QUOTE = '0x2222222222222222222222222222222222222222'
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395'
const OPENSEA_CONDUIT = '0x1E0049783F008A0085193E00003D00cd54003c71'
const OPENSEA_CONDUIT_KEY =
	'0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000'
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`

const FOUR_MEME_V1_TEST_ABI = parseAbi([
	'function purchaseToken(uint256 origin, address token, address to, uint256 amount, uint256 maxFunds) payable',
	'function purchaseTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
	'function saleToken(address tokenAddress, uint256 amount)',
])

const FOUR_MEME_V2_TEST_ABI = parseAbi([
	'function buyToken(bytes args, uint256 time, bytes signature) payable',
	'function buyToken(uint256 origin, address token, address to, uint256 amount, uint256 maxFunds) payable',
	'function buyTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
	'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)',
	'function createToken(bytes createArg, bytes signature) payable',
])

class FakeFourMemeApiClient {
	public uploadedFiles: string[] = []
	public loginCalls: Array<{ wallet: string; nonce: string; signature: string }> = []
	public createCalls: Array<{ accessToken: string; payload: Record<string, unknown> }> = []

	constructor(
		private readonly config: {
			nonce?: string
			accessToken?: string
			imageUrl?: string
			createArg?: `0x${string}`
			signature?: `0x${string}`
			failLogin?: string
			failCreate?: string
			raisedToken?: typeof FOUR_MEME_TEST_CONSTANTS.DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG
		} = {},
	) {}

	async generateNonce(): Promise<string> {
		return this.config.nonce ?? 'nonce-123'
	}

	async loginDex(args: { wallet: string; nonce: string; signature: string }): Promise<string> {
		this.loginCalls.push(args)
		if (this.config.failLogin) throw new Error(this.config.failLogin)
		return this.config.accessToken ?? 'access-token'
	}

	async uploadTokenImage(args: { filePath: string }): Promise<string> {
		this.uploadedFiles.push(args.filePath)
		return this.config.imageUrl ?? 'https://static.four.meme/market/test-image.png'
	}

	async createToken(args: {
		payload: Record<string, unknown>
		accessToken: string
	}): Promise<{ createArg: `0x${string}`; signature: `0x${string}` }> {
		this.createCalls.push(args)
		if (this.config.failCreate) throw new Error(this.config.failCreate)
		return {
			createArg: this.config.createArg ?? '0x1234',
			signature: this.config.signature ?? '0xabcd',
		}
	}

	async getRaisedTokenConfig() {
		return this.config.raisedToken ?? FOUR_MEME_TEST_CONSTANTS.DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG
	}
}

class FakeFourMemeClient {
	constructor(
		private readonly config: {
			version: 1 | 2
			quote?: `0x${string}`
			template?: bigint
			feeSetting?: bigint
			buyQuote?: [bigint, bigint, bigint, bigint, bigint, bigint]
			sellQuote?: [bigint, bigint]
			tokenDecimals?: number
			quoteDecimals?: number
		},
	) {}

	async readContract(args: {
		address: `0x${string}`
		functionName: string
		args?: readonly unknown[]
	}): Promise<unknown> {
		const quote = this.config.quote ?? (NATIVE as `0x${string}`)
		switch (args.functionName) {
			case 'decimals':
				if (args.address.toLowerCase() === TOKEN.toLowerCase()) {
					return this.config.tokenDecimals ?? 18
				}
				if (args.address.toLowerCase() === quote.toLowerCase()) {
					return this.config.quoteDecimals ?? 18
				}
				return 18
			case 'getTokenInfo':
				expect(args.address.toLowerCase()).toBe(HELPER.toLowerCase())
				return [
					BigInt(this.config.version),
					this.config.version === 1 ? TM1 : TM2,
					quote,
					0n,
					0n,
					0n,
					0n,
					0n,
					0n,
					0n,
					0n,
					false,
				]
			case '_tokenInfos':
				expect(args.address.toLowerCase()).toBe(TM2.toLowerCase())
				return [TOKEN, quote, this.config.template ?? 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]
			case '_tokenInfoEx1s':
				expect(args.address.toLowerCase()).toBe(TM2.toLowerCase())
				return [0n, 0n, this.config.feeSetting ?? 0n, 0n, 0n]
			case 'tryBuy': {
				const [
					estimatedAmount,
					estimatedCost,
					estimatedFee,
					amountMsgValue,
					amountApproval,
					amountFunds,
				] = this.config.buyQuote ?? [1000n, 900n, 100n, 1000n, 0n, 1000n]
				return [
					this.config.version === 1 ? TM1 : TM2,
					quote,
					estimatedAmount,
					estimatedCost,
					estimatedFee,
					amountMsgValue,
					amountApproval,
					amountFunds,
				]
			}
			case 'trySell': {
				const [funds, fee] = this.config.sellQuote ?? [1000n, 100n]
				return [this.config.version === 1 ? TM1 : TM2, quote, funds, fee]
			}
			default:
				throw new Error(`Unexpected readContract call: ${args.functionName}`)
		}
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('buildBitgetSwapStepsFromCalldata', () => {
	it('handles txs[] format', () => {
		const calldata = JSON.stringify({
			txs: [
				{ to: ROUTER, data: '0xABC', value: '0x0' },
				{ to: WALLET, data: '0xDEF', value: '0x0' },
			],
		})
		const result = buildBitgetSwapStepsFromCalldata({
			calldata,
			fromToken: USDT,
			amountWei: '1000000',
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].label).toContain('approval')
		expect(result.steps[1].label).toContain('swap')
	})

	it('handles flat format for native token', () => {
		const calldata = JSON.stringify({
			contract: ROUTER,
			calldata: '0xSwapData',
			computeUnits: 200000,
		})
		const result = buildBitgetSwapStepsFromCalldata({
			calldata,
			fromToken: NATIVE,
			amountWei: '1000000000000000000',
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].value).toBe(`0x${(10n ** 18n).toString(16)}`)
		expect(result.steps[0].gasLimit).toBe(Math.ceil(200000 * 1.3).toString())
	})

	it('handles flat format for ERC-20 with conditional approval', () => {
		const calldata = JSON.stringify({
			contract: ROUTER,
			calldata: '0xSwapData',
		})
		const result = buildBitgetSwapStepsFromCalldata({
			calldata,
			fromToken: USDT,
			amountWei: '1000000',
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.amount).toBe('1000000')
		expect(result.steps[1].label).toBe('Bitget swap')
	})

	it('throws on empty response', () => {
		expect(() =>
			buildBitgetSwapStepsFromCalldata({
				calldata: JSON.stringify({}),
				fromToken: USDT,
				amountWei: '1000',
				chainId: 56,
			}),
		).toThrow('no transaction data')
	})

	it('throws on invalid JSON', () => {
		expect(() =>
			buildBitgetSwapStepsFromCalldata({
				calldata: 'not json',
				fromToken: USDT,
				amountWei: '1000',
				chainId: 56,
			}),
		).toThrow('not valid JSON')
	})

	it('throws on non-object JSON', () => {
		expect(() =>
			buildBitgetSwapStepsFromCalldata({
				calldata: '"string"',
				fromToken: USDT,
				amountWei: '1000',
				chainId: 56,
			}),
		).toThrow('expected a JSON object')
	})

	it('throws on invalid amountWei', () => {
		expect(() =>
			buildBitgetSwapStepsFromCalldata({
				calldata: JSON.stringify({ contract: ROUTER, calldata: '0x' }),
				fromToken: NATIVE,
				amountWei: 'abc',
				chainId: 56,
			}),
		).toThrow('Invalid amount-wei')
	})
})

describe('buildOpenSeaBuySteps', () => {
	it('normalizes ERC20 fulfillment JSON into approval plus buy steps', async () => {
		const result = await buildOpenSeaBuySteps({
			wallet: WALLET,
			fulfillment: {
				fulfillment_data: {
					transaction: {
						function:
							'fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
						chain: 1,
						to: SEAPORT,
						value: '0',
						input_data: {
							parameters: {
								considerationToken: USDT,
								considerationIdentifier: '0',
								considerationAmount: '1000',
								offerer: '0x9999999999999999999999999999999999999999',
								zone: '0x8888888888888888888888888888888888888888',
								offerToken: TOKEN,
								offerIdentifier: '1234',
								offerAmount: '1',
								basicOrderType: 0,
								startTime: '1',
								endTime: '9999999999',
								zoneHash: ZERO_BYTES32,
								salt: '1',
								offererConduitKey: ZERO_BYTES32,
								fulfillerConduitKey: OPENSEA_CONDUIT_KEY,
								totalOriginalAdditionalRecipients: '1',
								additionalRecipients: [{ amount: '50', recipient: WALLET }],
								signature: '0x12',
							},
						},
					},
				},
			},
		})

		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].to).toBe(USDT)
		expect(result.steps[0].conditional?.spender).toBe(OPENSEA_CONDUIT)
		expect(result.steps[0].conditional?.amount).toBe('1050')
		expect(result.steps[1]).toMatchObject({
			to: SEAPORT,
			value: '0x0',
			chainId: 1,
			label: 'OpenSea buy NFT',
		})
		expect((result.steps[1].data as string).startsWith('0x')).toBe(true)
		expect((result.steps[1].data as string).length).toBeGreaterThan(10)
	})

	it('supports native-priced fulfillment JSON without an approval step', async () => {
		const result = await buildOpenSeaBuySteps({
			wallet: WALLET,
			fulfillment: {
				fulfillment_data: {
					transaction: {
						chain: 1,
						to: SEAPORT,
						value: '1000',
						data: '0xdeadbeef',
						input_data: {
							parameters: {
								considerationToken: NATIVE,
								considerationIdentifier: '0',
								considerationAmount: '1000',
								offerer: '0x9999999999999999999999999999999999999999',
								zone: '0x8888888888888888888888888888888888888888',
								offerToken: TOKEN,
								offerIdentifier: '1234',
								offerAmount: '1',
								basicOrderType: 0,
								startTime: '1',
								endTime: '9999999999',
								zoneHash: ZERO_BYTES32,
								salt: '1',
								offererConduitKey: ZERO_BYTES32,
								fulfillerConduitKey: ZERO_BYTES32,
								totalOriginalAdditionalRecipients: '0',
								additionalRecipients: [],
								signature: '0x12',
							},
						},
					},
				},
			},
		})

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0]).toMatchObject({
			to: SEAPORT,
			data: '0xdeadbeef',
			value: '0x3e8',
			label: 'OpenSea buy NFT',
		})
	})
})

describe('buildOpenSeaSellSteps', () => {
	it('normalizes offer fulfillment JSON into NFT approval plus sell steps', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				json: async () => ({
					result: encodeAbiParameters([{ type: 'address' }], [WALLET as `0x${string}`]),
				}),
			})),
		)

		const result = await buildOpenSeaSellSteps({
			fulfillment: {
				fulfillment_data: {
					transaction: {
						function:
							'fulfillAdvancedOrder(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData),(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[],bytes32,address)',
						chain: 1,
						to: SEAPORT,
						value: '0',
						data: '0xbeef',
						input_data: {
							advancedOrder: {
								parameters: {
									offerer: '0x9999999999999999999999999999999999999999',
									zone: '0x8888888888888888888888888888888888888888',
									offer: [
										{
											itemType: 1,
											token: USDT,
											identifierOrCriteria: '0',
											startAmount: '1000',
											endAmount: '1000',
										},
									],
									consideration: [
										{
											itemType: 2,
											token: TOKEN,
											identifierOrCriteria: '1234',
											startAmount: '1',
											endAmount: '1',
											recipient: WALLET,
										},
									],
									orderType: 0,
									startTime: '1',
									endTime: '9999999999',
									zoneHash: ZERO_BYTES32,
									salt: '1',
									conduitKey: OPENSEA_CONDUIT_KEY,
									totalOriginalConsiderationItems: '1',
								},
								numerator: '1',
								denominator: '1',
								signature: '0x12',
								extraData: '0x',
							},
							fulfillerConduitKey: OPENSEA_CONDUIT_KEY,
							recipient: WALLET,
						},
					},
				},
			},
			wallet: WALLET,
		})

		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].to).toBe(TOKEN)
		const approval = decodeFunctionData({
			abi: parseAbi(['function approve(address to, uint256 tokenId)']),
			data: result.steps[0].data as `0x${string}`,
		})
		expect(approval.functionName).toBe('approve')
		expect(approval.args).toEqual([OPENSEA_CONDUIT, 1234n])
		expect(result.steps[1]).toMatchObject({
			to: SEAPORT,
			data: '0xbeef',
			value: '0x0',
			chainId: 1,
			label: 'OpenSea sell NFT',
		})
	})
})

describe('buildPancakeSwapSteps', () => {
	it('encodes swapExactETHForTokens for native→token', () => {
		const result = buildPancakeSwapSteps({
			path: [NATIVE, USDT],
			amountInWei: '1000000000000000000',
			amountOutMinWei: '500000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		// No approval needed for native
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].value).not.toBe('0x0')
		expect(result.steps[0].label).toContain('PancakeSwap')
	})

	it('encodes swapExactTokensForETH for token→native with approval', () => {
		const result = buildPancakeSwapSteps({
			path: [USDT, NATIVE],
			amountInWei: '1000000',
			amountOutMinWei: '500000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[1].value).toBe('0x0')
	})

	it('encodes swapExactTokensForTokens for token→token with approval', () => {
		const result = buildPancakeSwapSteps({
			path: [USDT, WBNB],
			amountInWei: '1000000',
			amountOutMinWei: '500000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
	})

	it('throws on path with fewer than 2 tokens', () => {
		expect(() =>
			buildPancakeSwapSteps({
				path: [USDT],
				amountInWei: '1000000',
				amountOutMinWei: '500000',
				wallet: WALLET,
				deadline: 1710000000,
				chainId: 56,
			}),
		).toThrow('at least 2 tokens')
	})

	it('trims whitespace from path entries', () => {
		const result = buildPancakeSwapSteps({
			path: [` ${NATIVE} `, ` ${USDT} `],
			amountInWei: '1000000000000000000',
			amountOutMinWei: '500000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		// Native→token: should be 1 step (no approval for native)
		expect(result.steps).toHaveLength(1)
	})
})

describe('Lista vault steps', () => {
	it('deposit: approval + deposit step', () => {
		const result = buildListaDepositSteps({
			vault: VAULT,
			amountWei: '10000000000000000000',
			token: USDT,
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.spender).toBe(VAULT)
		expect(result.steps[1].label).toContain('deposit')
	})

	it('redeem: single step', () => {
		const result = buildListaRedeemSteps({
			vault: VAULT,
			sharesWei: '5000000000000000000',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].label).toContain('redeem')
	})

	it('withdraw: single step', () => {
		const result = buildListaWithdrawSteps({
			vault: VAULT,
			amountWei: '3000000000000000000',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].label).toContain('withdraw')
	})

	it('throws on invalid amountWei', () => {
		expect(() =>
			buildListaDepositSteps({
				vault: VAULT,
				amountWei: '-1',
				token: USDT,
				wallet: WALLET,
				chainId: 56,
			}),
		).toThrow('greater than 0')
	})
})

describe('four.meme steps', () => {
	it('builds V1 amount-based native buy with slippage-adjusted value', async () => {
		const client = new FakeFourMemeClient({
			version: 1,
			buyQuote: [1000n, 900n, 100n, 1000n, 0n, 0n],
		})

		const result = await buildFourMemeBuySteps(
			{ token: TOKEN, wallet: WALLET, amount: '1', slippage: 0.03 },
			client,
		)

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].chainId).toBe(56)
		expect(result.steps[0].value).toBe('0x406')

		const decoded = decodeFunctionData({
			abi: FOUR_MEME_V1_TEST_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('purchaseToken')
		expect(decoded.args[4]).toBe(1030n)
	})

	it('builds V1 funds-based buy via purchaseTokenAMAP', async () => {
		const client = new FakeFourMemeClient({
			version: 1,
			buyQuote: [1200n, 1100n, 100n, 500000000000000000n, 0n, 500000000000000000n],
		})

		const result = await buildFourMemeBuySteps(
			{ token: TOKEN, wallet: WALLET, funds: '0.5', slippage: 0.1 },
			client,
		)

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].value).toBe('0x6f05b59d3b20000')

		const decoded = decodeFunctionData({
			abi: FOUR_MEME_V1_TEST_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('purchaseTokenAMAP')
		expect(decoded.args[3]).toBe(500000000000000000n)
		expect(decoded.args[4]).toBe(1080n)
	})

	it('builds V2 standard buy with quote approval', async () => {
		const client = new FakeFourMemeClient({
			version: 2,
			quote: QUOTE as `0x${string}`,
			buyQuote: [2500n, 2000n, 200n, 0n, 2200n, 0n],
			quoteDecimals: 6,
		})

		const result = await buildFourMemeBuySteps(
			{ token: TOKEN, wallet: WALLET, amount: '1', slippage: 0.05 },
			client,
		)

		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.spender).toBe(TM2)
		expect(result.steps[0].conditional?.amount).toBe('2200')
		expect(result.steps[1].value).toBe('0x0')

		const decoded = decodeFunctionData({
			abi: FOUR_MEME_V2_TEST_ABI,
			data: result.steps[1].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('buyToken')
		expect(decoded.args[4]).toBe(2310n)
	})

	it('builds X Mode buy with encoded args', async () => {
		const client = new FakeFourMemeClient({
			version: 2,
			template: 0x10000n,
			buyQuote: [1500n, 1000n, 100n, 1100n, 0n, 0n],
		})

		const result = await buildFourMemeBuySteps(
			{ token: TOKEN, wallet: WALLET, amount: '1', slippage: 0.02 },
			client,
		)

		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].label).toContain('X Mode')

		const decoded = decodeFunctionData({
			abi: FOUR_MEME_V2_TEST_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('buyToken')

		const encodedArgs = decoded.args[0] as `0x${string}`
		const params = decodeAbiParameters(
			[
				{ type: 'uint256', name: 'origin' },
				{ type: 'address', name: 'token' },
				{ type: 'address', name: 'to' },
				{ type: 'uint256', name: 'amount' },
				{ type: 'uint256', name: 'maxFunds' },
				{ type: 'uint256', name: 'funds' },
				{ type: 'uint256', name: 'minAmount' },
			],
			encodedArgs,
		)
		expect(params[4]).toBe(1122n)
	})

	it('builds sell steps with approval and minFunds bound', async () => {
		const client = new FakeFourMemeClient({
			version: 2,
			sellQuote: [1000n, 100n],
		})

		const result = await buildFourMemeSellSteps(
			{ token: TOKEN, wallet: WALLET, amount: '2', slippage: 0.1 },
			client,
		)

		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.amount).toBe('2000000000000000000')
		expect(result.steps[1].value).toBe('0x0')

		const decoded = decodeFunctionData({
			abi: FOUR_MEME_V2_TEST_ABI,
			data: result.steps[1].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('sellToken')
		expect(decoded.args[3]).toBe(900n)
	})

	it('rejects both amount and funds on buy', async () => {
		const client = new FakeFourMemeClient({ version: 2 })
		await expect(
			buildFourMemeBuySteps({ token: TOKEN, wallet: WALLET, amount: '1', funds: '1' }, client),
		).rejects.toThrow('exactly one of --amount or --funds')
	})

	it('rejects buy without amount or funds', async () => {
		const client = new FakeFourMemeClient({ version: 2 })
		await expect(buildFourMemeBuySteps({ token: TOKEN, wallet: WALLET }, client)).rejects.toThrow(
			'exactly one of --amount or --funds',
		)
	})

	it('rejects invalid token address', async () => {
		const client = new FakeFourMemeClient({ version: 2 })
		await expect(
			buildFourMemeBuySteps({ token: 'not-an-address', wallet: WALLET, amount: '1' }, client),
		).rejects.toThrow('Invalid token')
	})

	it('rejects unsupported slippage', async () => {
		const client = new FakeFourMemeClient({ version: 2 })
		await expect(
			buildFourMemeSellSteps({ token: TOKEN, wallet: WALLET, amount: '1', slippage: 2 }, client),
		).rejects.toThrow('--slippage must be between 0 and 1')
	})

	it('builds a login challenge from the nonce API', async () => {
		const api = new FakeFourMemeApiClient({ nonce: 'nonce-xyz' })
		const result = await buildFourMemeLoginChallenge({ wallet: WALLET }, api)
		expect(result).toEqual({
			wallet: WALLET,
			nonce: 'nonce-xyz',
			message: 'You are sign in Meme nonce-xyz',
		})
	})

	it('builds create-token step with image url and default fee + presale value', async () => {
		const api = new FakeFourMemeApiClient({
			createArg: '0xdeadbeef',
			signature: '0xcafe',
			raisedToken: {
				...FOUR_MEME_TEST_CONSTANTS.DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG,
				buyFee: '0.5',
			},
		})

		const result = await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-1',
				loginSignature: '0xsigned',
				name: 'Release',
				symbol: 'RELS',
				description: 'Release desc',
				label: 'AI',
				imageUrl: 'https://static.four.meme/market/test-logo.png',
				website: 'https://example.com',
				twitter: 'https://x.com/example',
				telegram: 'https://t.me/example',
				preSale: '0.1',
				xMode: true,
				antiSniper: true,
			},
			api,
		)

		expect(api.uploadedFiles).toEqual([])
		expect(api.loginCalls[0]).toEqual({
			wallet: WALLET,
			nonce: 'nonce-1',
			signature: '0xsigned',
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(TM2)
		expect(result.steps[0].value).toBe('0x186cc6acd4b0000')
		expect(result.steps[0].label).toContain('AI')
		expect(result.steps[0].label).toContain('X Mode')
		expect(result.steps[0].label).toContain('AntiSniper')

		const decoded = decodeFunctionData({
			abi: FOUR_MEME_V2_TEST_ABI,
			data: result.steps[0].data as `0x${string}`,
		})
		expect(decoded.functionName).toBe('createToken')
		expect(decoded.args[0]).toBe('0xdeadbeef')
		expect(decoded.args[1]).toBe('0xcafe')

		expect(api.createCalls[0].accessToken).toBe('access-token')
		expect(api.createCalls[0].payload).toMatchObject({
			name: 'Release',
			shortName: 'RELS',
			symbol: 'BNB',
			imgUrl: 'https://static.four.meme/market/test-logo.png',
			label: 'AI',
			onlyMPC: true,
			feePlan: true,
			preSale: '0.1',
			raisedAmount: '0.1',
		})
	})

	it('sets raisedAmount equal to preSale (zero when omitted)', async () => {
		const api = new FakeFourMemeApiClient()
		await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-ra',
				loginSignature: '0xsigned',
				name: 'NoPresale',
				symbol: 'NPS',
				description: 'no presale',
				label: 'Meme',
				imageUrl: 'https://static.four.meme/market/test-logo.png',
			},
			api,
		)

		expect(api.createCalls[0].payload).toMatchObject({
			preSale: '0',
			raisedAmount: '0',
		})
	})

	it('sets raisedAmount to match explicit preSale value', async () => {
		const api = new FakeFourMemeApiClient()
		await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-rb',
				loginSignature: '0xsigned',
				name: 'WithPresale',
				symbol: 'WPS',
				description: 'with presale',
				label: 'AI',
				imageUrl: 'https://static.four.meme/market/test-logo.png',
				preSale: '0.5',
			},
			api,
		)

		expect(api.createCalls[0].payload).toMatchObject({
			preSale: '0.5',
			raisedAmount: '0.5',
		})
	})

	it('uses explicit creationFee override for create-token value', async () => {
		const api = new FakeFourMemeApiClient()
		const result = await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-fee',
				loginSignature: '0xsigned',
				name: 'Fee',
				symbol: 'FEE',
				description: 'override fee',
				label: 'AI',
				imageUrl: 'https://static.four.meme/market/test-logo.png',
				preSale: '0.1',
				creationFee: '0.02',
			},
			api,
		)

		expect(result.steps[0].value).toBe('0x1aa535d3d0c0000')
	})

	it('uploads image files before create-token', async () => {
		const api = new FakeFourMemeApiClient({
			imageUrl: 'https://static.four.meme/market/uploaded.png',
		})

		await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-2',
				loginSignature: '0xsigned',
				name: 'Upload',
				symbol: 'UP',
				description: 'Uses upload',
				label: 'Meme',
				imageFile: './fixtures/logo.png',
			},
			api,
		)

		expect(api.uploadedFiles).toEqual(['./fixtures/logo.png'])
		expect(api.createCalls[0].payload.imgUrl).toBe('https://static.four.meme/market/uploaded.png')
	})

	it('encodes tax-token config when supplied', async () => {
		const api = new FakeFourMemeApiClient()

		await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-3',
				loginSignature: '0xsigned',
				name: 'Tax',
				symbol: 'TAX',
				description: 'Tax token',
				label: 'Defi',
				imageUrl: 'https://static.four.meme/market/test-tax.png',
				taxFeeRate: 5,
				taxBurnRate: 20,
				taxDivideRate: 30,
				taxLiquidityRate: 40,
				taxRecipientRate: 10,
				taxRecipientAddress: QUOTE,
				taxMinSharing: '100000',
			},
			api,
		)

		expect(api.createCalls[0].payload).toMatchObject({
			label: 'Defi',
			tokenTaxInfo: {
				feeRate: 5,
				burnRate: 20,
				divideRate: 30,
				liquidityRate: 40,
				recipientRate: 10,
				recipientAddress: QUOTE,
				minSharing: '100000',
			},
		})
	})

	it('rejects unsupported token labels', async () => {
		const api = new FakeFourMemeApiClient()
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-4',
					loginSignature: '0xsigned',
					name: 'BadLabel',
					symbol: 'BAD',
					description: 'bad label',
					label: 'NFT',
					imageUrl: 'https://static.four.meme/market/test-bad.png',
				},
				api,
			),
		).rejects.toThrow('Unsupported label')
		expect(api.loginCalls).toEqual([])
	})

	it('rejects invalid tax configuration', async () => {
		const api = new FakeFourMemeApiClient()
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-5',
					loginSignature: '0xsigned',
					name: 'BadTax',
					symbol: 'BTX',
					description: 'bad tax',
					label: 'AI',
					imageUrl: 'https://static.four.meme/market/test-tax.png',
					taxFeeRate: 5,
					taxBurnRate: 20,
					taxDivideRate: 30,
					taxLiquidityRate: 40,
					taxRecipientRate: 20,
					taxRecipientAddress: QUOTE,
					taxMinSharing: '100000',
				},
				api,
			),
		).rejects.toThrow('tax allocation rates must sum to 100')
	})

	it('rejects inconsistent recipient settings', async () => {
		const api = new FakeFourMemeApiClient()
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-6',
					loginSignature: '0xsigned',
					name: 'Recipient',
					symbol: 'RCP',
					description: 'recipient mismatch',
					label: 'AI',
					imageUrl: 'https://static.four.meme/market/test-tax.png',
					taxFeeRate: 5,
					taxBurnRate: 20,
					taxDivideRate: 30,
					taxLiquidityRate: 50,
					taxRecipientRate: 0,
					taxRecipientAddress: QUOTE,
					taxMinSharing: '100000',
				},
				api,
			),
		).rejects.toThrow('taxRecipientAddress must be empty when taxRecipientRate is 0')
	})

	it('rejects malformed minSharing values', async () => {
		const api = new FakeFourMemeApiClient()
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-7',
					loginSignature: '0xsigned',
					name: 'MinShare',
					symbol: 'MIN',
					description: 'bad min sharing',
					label: 'AI',
					imageUrl: 'https://static.four.meme/market/test-tax.png',
					taxFeeRate: 5,
					taxBurnRate: 20,
					taxDivideRate: 30,
					taxLiquidityRate: 40,
					taxRecipientRate: 10,
					taxRecipientAddress: QUOTE,
					taxMinSharing: '123456',
				},
				api,
			),
		).rejects.toThrow('taxMinSharing must be a base-10 integer matching d × 10^n with n >= 5')
	})

	it('throws when no image is provided', async () => {
		const api = new FakeFourMemeApiClient()
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-noimg',
					loginSignature: '0xsigned',
					name: 'NoImage',
					symbol: 'NIM',
					description: 'no image token',
					label: 'Meme',
				},
				api,
			),
		).rejects.toThrow('An image is required: provide --image-url or --image-file')
	})

	it('downloads and re-uploads external (non-CDN) image URLs', async () => {
		const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic
		const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(fakeImageBytes, {
				status: 200,
				headers: { 'content-type': 'image/png' },
			}),
		)

		const api = new FakeFourMemeApiClient()
		await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-ext',
				loginSignature: '0xsigned',
				name: 'External',
				symbol: 'EXT',
				description: 'external image token',
				label: 'Meme',
				imageUrl: 'https://cdn.example.com/cat.png',
			},
			api,
		)

		// fetch was called to download the external image
		expect(mockFetch).toHaveBeenCalledWith('https://cdn.example.com/cat.png')
		// downloaded file was uploaded via the API client
		expect(api.uploadedFiles).toHaveLength(1)
		expect(api.uploadedFiles[0]).toMatch(/fourmeme-upload-.*\.png$/)
		// the payload uses the uploaded CDN URL (from the fake API client)
		expect(api.createCalls[0].payload.imgUrl).toBe('https://static.four.meme/market/test-image.png')

		mockFetch.mockRestore()
	})

	it('passes four.meme CDN URLs through without downloading', async () => {
		const mockFetch = vi.spyOn(globalThis, 'fetch')
		const api = new FakeFourMemeApiClient()

		await buildFourMemeCreateTokenSteps(
			{
				wallet: WALLET,
				loginNonce: 'nonce-cdn',
				loginSignature: '0xsigned',
				name: 'CDN',
				symbol: 'CDN',
				description: 'cdn image token',
				label: 'Meme',
				imageUrl: 'https://static.four.meme/market/existing-logo.png',
			},
			api,
		)

		// fetch should NOT have been called for the image
		expect(mockFetch).not.toHaveBeenCalled()
		// no upload
		expect(api.uploadedFiles).toEqual([])
		// CDN URL passed through directly
		expect(api.createCalls[0].payload.imgUrl).toBe(
			'https://static.four.meme/market/existing-logo.png',
		)

		mockFetch.mockRestore()
	})

	it('rejects invalid image source combinations', async () => {
		const api = new FakeFourMemeApiClient()
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-8',
					loginSignature: '0xsigned',
					name: 'Images',
					symbol: 'IMG',
					description: 'two images',
					label: 'AI',
					imageUrl: 'https://static.four.meme/market/test-logo.png',
					imageFile: './logo.png',
				},
				api,
			),
		).rejects.toThrow('Provide only one of --image-url or --image-file')
	})

	it('surfaces API errors during create-token', async () => {
		const api = new FakeFourMemeApiClient({ failCreate: 'upstream boom' })
		await expect(
			buildFourMemeCreateTokenSteps(
				{
					wallet: WALLET,
					loginNonce: 'nonce-9',
					loginSignature: '0xsigned',
					name: 'Fail',
					symbol: 'FAIL',
					description: 'api failure',
					label: 'AI',
					imageUrl: 'https://static.four.meme/market/test-logo.png',
				},
				api,
			),
		).rejects.toThrow('upstream boom')
	})
})

const MASTER_CHEF = '0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652'
const LP_TOKEN = '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0'
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'

describe('buildPancakeAddLiquiditySteps', () => {
	it('native + ERC-20: 1 approval + addLiquidityETH', () => {
		const result = buildPancakeAddLiquiditySteps({
			tokenA: NATIVE,
			tokenB: USDT,
			amountAWei: '1000000000000000000',
			amountBWei: '500000000000000000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.token).toBe(USDT)
		expect(result.steps[1].value).not.toBe('0x0')
		expect(result.steps[1].label).toContain('addLiquidityETH')
	})

	it('two ERC-20: 2 approvals + addLiquidity', () => {
		const result = buildPancakeAddLiquiditySteps({
			tokenA: USDT,
			tokenB: USDC,
			amountAWei: '1000000000000000000',
			amountBWei: '500000000000000000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(3)
		expect(result.steps[0].conditional?.token).toBe(USDT)
		expect(result.steps[1].conditional?.token).toBe(USDC)
		expect(result.steps[2].label).toContain('addLiquidity')
		expect(result.steps[2].value).toBe('0x0')
	})

	it('throws when both tokens are native', () => {
		expect(() =>
			buildPancakeAddLiquiditySteps({
				tokenA: NATIVE,
				tokenB: NATIVE,
				amountAWei: '1000',
				amountBWei: '1000',
				wallet: WALLET,
				deadline: 1710000000,
				chainId: 56,
			}),
		).toThrow('both be native')
	})
})

describe('buildPancakeRemoveLiquiditySteps', () => {
	it('pair with WBNB: approval + removeLiquidityETH', () => {
		const result = buildPancakeRemoveLiquiditySteps({
			pairAddress: LP_TOKEN,
			token0: WBNB,
			token1: USDT,
			lpAmountWei: '5000000000000000000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.token).toBe(LP_TOKEN)
		expect(result.steps[1].label).toContain('removeLiquidityETH')
	})

	it('pair without WBNB: approval + removeLiquidity', () => {
		const result = buildPancakeRemoveLiquiditySteps({
			pairAddress: LP_TOKEN,
			token0: USDT,
			token1: USDC,
			lpAmountWei: '5000000000000000000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[1].label).toContain('removeLiquidity')
		expect(result.steps[1].label).not.toContain('ETH')
	})
})

describe('buildPancakeFarmSteps', () => {
	it('stake: approval + deposit', () => {
		const result = buildPancakeFarmSteps({
			action: 'stake',
			pid: 2,
			amountWei: '1000000000000000000',
			lpToken: LP_TOKEN,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.spender).toBe(MASTER_CHEF)
		expect(result.steps[1].to).toBe(MASTER_CHEF)
		expect(result.steps[1].label).toContain('stake')
	})

	it('unstake: withdraw only (no approval)', () => {
		const result = buildPancakeFarmSteps({
			action: 'unstake',
			pid: 2,
			amountWei: '1000000000000000000',
			lpToken: LP_TOKEN,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(MASTER_CHEF)
		expect(result.steps[0].label).toContain('unstake')
	})

	it('harvest: deposit(pid, 0) — no approval', () => {
		const result = buildPancakeFarmSteps({
			action: 'harvest',
			pid: 2,
			amountWei: '0',
			lpToken: LP_TOKEN,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(MASTER_CHEF)
		expect(result.steps[0].label).toContain('harvest')
	})

	it('stake with zero amount: no approval', () => {
		const result = buildPancakeFarmSteps({
			action: 'stake',
			pid: 2,
			amountWei: '0',
			lpToken: LP_TOKEN,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
	})
})

const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const MASTER_CHEF_V3 = '0x556B9306565093C855AEA9AE92A594704c2Cd59e'
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
const POOL_ADDRESS = '0x1234567890123456789012345678901234567891'

describe('buildPancakeV3FarmSteps', () => {
	it('stake: generates safeTransferFrom to MasterChef V3', () => {
		const result = buildPancakeV3FarmSteps({
			action: 'stake',
			tokenId: '12345',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(POSITION_MANAGER)
		expect(result.steps[0].label).toContain('V3 farm stake')
		expect(result.steps[0].value).toBe('0x0')
	})

	it('unstake: generates withdraw on MasterChef V3', () => {
		const result = buildPancakeV3FarmSteps({
			action: 'unstake',
			tokenId: '12345',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(MASTER_CHEF_V3)
		expect(result.steps[0].label).toContain('V3 farm unstake')
	})

	it('harvest: generates harvest on MasterChef V3', () => {
		const result = buildPancakeV3FarmSteps({
			action: 'harvest',
			tokenId: '12345',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(MASTER_CHEF_V3)
		expect(result.steps[0].label).toContain('V3 farm harvest')
	})
})

describe('buildSyrupStakeSteps', () => {
	it('generates approve + deposit', () => {
		const result = buildSyrupStakeSteps({
			poolAddress: POOL_ADDRESS,
			amountWei: '1000000000000000000',
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.token).toBe(CAKE)
		expect(result.steps[0].conditional?.spender).toBe(POOL_ADDRESS)
		expect(result.steps[1].to).toBe(POOL_ADDRESS)
		expect(result.steps[1].label).toContain('Syrup Pool deposit')
	})
})

describe('buildSyrupUnstakeSteps', () => {
	it('generates withdraw only', () => {
		const result = buildSyrupUnstakeSteps({
			poolAddress: POOL_ADDRESS,
			amountWei: '1000000000000000000',
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(POOL_ADDRESS)
		expect(result.steps[0].label).toContain('Syrup Pool withdraw')
	})
})

describe('buildV3MintSteps', () => {
	it('ERC-20 pair: 2 approvals + mint', () => {
		const result = buildV3MintSteps({
			token0: USDT,
			token1: USDC,
			fee: 2500,
			tickLower: -100,
			tickUpper: 100,
			amount0Wei: '1000000000000000000',
			amount1Wei: '2000000000000000000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(3)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.token).toBe(USDT)
		expect(result.steps[1].conditional?.type).toBe('allowance_lt')
		expect(result.steps[1].conditional?.token).toBe(USDC)
		expect(result.steps[2].to).toBe(POSITION_MANAGER)
		expect(result.steps[2].label).toContain('V3 mint')
		expect(result.steps[2].value).toBe('0x0')
	})

	it('native BNB pair: 1 approval + multicall with refundETH', () => {
		const result = buildV3MintSteps({
			token0: NATIVE,
			token1: USDT,
			fee: 2500,
			tickLower: -100,
			tickUpper: 100,
			amount0Wei: '1000000000000000000',
			amount1Wei: '2000000000000000000',
			wallet: WALLET,
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(2)
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.token).toBe(USDT)
		expect(result.steps[1].to).toBe(POSITION_MANAGER)
		expect(result.steps[1].label).toContain('multicall')
		expect(result.steps[1].value).not.toBe('0x0')
	})

	it('throws when both tokens are native', () => {
		expect(() =>
			buildV3MintSteps({
				token0: NATIVE,
				token1: WBNB,
				fee: 2500,
				tickLower: -100,
				tickUpper: 100,
				amount0Wei: '1000',
				amount1Wei: '2000',
				wallet: WALLET,
				deadline: 1710000000,
				chainId: 56,
			}),
		).toThrow('both be native')
	})
})

describe('buildV3IncreaseLiquiditySteps', () => {
	it('generates increaseLiquidity step', () => {
		const result = buildV3IncreaseLiquiditySteps({
			tokenId: '12345',
			amount0Wei: '1000000000000000000',
			amount1Wei: '2000000000000000000',
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(POSITION_MANAGER)
		expect(result.steps[0].label).toContain('increaseLiquidity')
	})
})

describe('buildV3DecreaseLiquiditySteps', () => {
	it('generates decreaseLiquidity step', () => {
		const result = buildV3DecreaseLiquiditySteps({
			tokenId: '12345',
			liquidity: '5000000000000000000',
			amount0MinWei: '0',
			amount1MinWei: '0',
			deadline: 1710000000,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(POSITION_MANAGER)
		expect(result.steps[0].label).toContain('decreaseLiquidity')
	})
})

describe('buildV3CollectSteps', () => {
	it('generates collect step with maxUint128', () => {
		const result = buildV3CollectSteps({
			tokenId: '12345',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(POSITION_MANAGER)
		expect(result.steps[0].label).toContain('collect')
	})
})

// ============================================================================
// Aster deposit steps
// ============================================================================

const ASTER_TREASURY_ETH = '0x604DD02d620633Ae427888d41bfd15e38483736E'
const ASTER_TREASURY_BSC = '0x128463A60784c4D3f46c23Af3f65Ed859Ba87974'
const ASTER_TREASURY_ARB = '0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5'

describe('buildAsterDepositSteps', () => {
	it('native deposit: single depositNative step with value', () => {
		const result = buildAsterDepositSteps({
			token: NATIVE,
			amountWei: '1000000000000000000',
			wallet: WALLET,
			chainId: 56,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(ASTER_TREASURY_BSC)
		expect(result.steps[0].value).not.toBe('0x0')
		expect(result.steps[0].value).toBe('0xde0b6b3a7640000')
		expect(result.steps[0].label).toContain('native')
		expect(result.steps[0].chainId).toBe(56)
	})

	it('ERC-20 deposit: conditional approval + deposit step', () => {
		const result = buildAsterDepositSteps({
			token: USDT,
			amountWei: '10000000000000000000',
			wallet: WALLET,
			chainId: 1,
		})
		expect(result.steps).toHaveLength(2)
		// Approval step
		expect(result.steps[0].conditional?.type).toBe('allowance_lt')
		expect(result.steps[0].conditional?.spender).toBe(ASTER_TREASURY_ETH)
		expect(result.steps[0].conditional?.token).toBe(USDT)
		expect(result.steps[0].to).toBe(USDT)
		// Deposit step
		expect(result.steps[1].to).toBe(ASTER_TREASURY_ETH)
		expect(result.steps[1].value).toBe('0x0')
		expect(result.steps[1].label).toContain('ERC-20')
		expect(result.steps[1].chainId).toBe(1)
	})

	it('uses correct treasury address for Arbitrum', () => {
		const result = buildAsterDepositSteps({
			token: NATIVE,
			amountWei: '500000000000000000',
			wallet: WALLET,
			chainId: 42161,
		})
		expect(result.steps).toHaveLength(1)
		expect(result.steps[0].to).toBe(ASTER_TREASURY_ARB)
		expect(result.steps[0].chainId).toBe(42161)
	})

	it('throws on unsupported chainId', () => {
		expect(() =>
			buildAsterDepositSteps({
				token: NATIVE,
				amountWei: '1000000000000000000',
				wallet: WALLET,
				chainId: 137,
			}),
		).toThrow('Unsupported chain for Aster deposit: 137')
	})

	it('throws on zero amount', () => {
		expect(() =>
			buildAsterDepositSteps({
				token: NATIVE,
				amountWei: '0',
				wallet: WALLET,
				chainId: 56,
			}),
		).toThrow('greater than 0')
	})

	it('throws on invalid wallet address', () => {
		expect(() =>
			buildAsterDepositSteps({
				token: NATIVE,
				amountWei: '1000000000000000000',
				wallet: 'not-an-address',
				chainId: 56,
			}),
		).toThrow('Invalid wallet')
	})

	it('uses custom broker ID when provided', () => {
		const result = buildAsterDepositSteps({
			token: NATIVE,
			amountWei: '1000000000000000000',
			wallet: WALLET,
			chainId: 56,
			broker: '42',
		})
		expect(result.steps).toHaveLength(1)
		// The broker is encoded in calldata — just verify it doesn't throw
		expect(result.steps[0].data).toBeTruthy()
	})

	it('defaults broker to 1 when omitted', () => {
		const withDefault = buildAsterDepositSteps({
			token: NATIVE,
			amountWei: '1000000000000000000',
			wallet: WALLET,
			chainId: 56,
		})
		const withExplicit = buildAsterDepositSteps({
			token: NATIVE,
			amountWei: '1000000000000000000',
			wallet: WALLET,
			chainId: 56,
			broker: '1',
		})
		expect(withDefault.steps[0].data).toBe(withExplicit.steps[0].data)
	})

	it('throws on invalid broker ID', () => {
		expect(() =>
			buildAsterDepositSteps({
				token: NATIVE,
				amountWei: '1000000000000000000',
				wallet: WALLET,
				chainId: 56,
				broker: 'not-a-number',
			}),
		).toThrow('Invalid --broker')
	})
})
