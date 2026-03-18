#!/usr/bin/env node
declare const PURR_VERSION: string
import { configGet, configList, configSet } from './api-client.js'
import { executeStepsFromFile, executeStepsFromJson } from './executor.js'
import { requireArgOrFile } from './file-input.js'
import { walletAddress } from './wallet/address.js'
import { walletBalance } from './wallet/balance.js'
import { walletSign } from './wallet/sign.js'
import { walletSignTypedData } from './wallet/sign-typed-data.js'
import { walletTransfer } from './wallet/transfer.js'
import { buildApproveSteps } from './primitives/approve.js'
import { buildRawStep } from './primitives/raw.js'
import { buildTransferSteps } from './primitives/transfer.js'
import { NATIVE_EVM, parseChainId } from './shared.js'
import type { StepOutput } from './types.js'
import {
	createOrder,
	getNetworks,
	getQuote,
	getTradingPairs,
	queryOrder,
} from './vendors/binance-connect.js'
import { buildBitgetSwapSteps, buildBitgetSwapStepsFromCalldata } from './vendors/bitget.js'
import {
	buildFourMemeBuySteps,
	buildFourMemeCreateTokenSteps,
	buildFourMemeLoginChallenge,
	buildFourMemeSellSteps,
} from './vendors/fourmeme.js'
import { asterApi, buildAsterDepositSteps } from './vendors/aster.js'
import { dflowSwap } from './vendors/dflow.js'
import {
	buildListaDepositSteps,
	buildListaRedeemSteps,
	buildListaWithdrawSteps,
	listVaults,
} from './vendors/lista.js'
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
} from './vendors/pancake.js'
import {
	buildOpenSeaBuySteps,
	buildOpenSeaCancelListingPreview,
	buildOpenSeaCancelOfferPreview,
	buildOpenSeaListingPreview,
	buildOpenSeaOfferPreview,
	buildOpenSeaSellSteps,
	buildOpenSeaSwapSteps,
	cancelOpenSeaListing,
	cancelOpenSeaOffer,
	createOpenSeaListing,
	createOpenSeaOffer,
	OpenSeaCliError,
} from './vendors/opensea.js'

function parseArgs(argv: string[]): Record<string, string> {
	const result: Record<string, string> = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg.startsWith('--')) {
			const raw = arg.slice(2)
			const eqIdx = raw.indexOf('=')
			if (eqIdx > 0) {
				result[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1)
			} else {
				const next = argv[i + 1]
				if (next && !next.startsWith('--')) {
					result[raw] = next
					i++
				} else {
					result[raw] = 'true'
				}
			}
		}
	}
	return result
}

function requireArg(args: Record<string, string>, name: string): string {
	const val = args[name]
	if (val === undefined) {
		throw new Error(`Missing required argument: --${name}`)
	}
	return val
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks).toString('utf-8')
}

function parseIntegerArg(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid --${name}: "${value}"`)
	}
	return parsed
}

function parseFloatArg(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined
	const parsed = Number.parseFloat(value)
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid --${name}: "${value}"`)
	}
	return parsed
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined
	const normalized = value.trim().toLowerCase()
	if (['true', '1', 'yes'].includes(normalized)) return true
	if (['false', '0', 'no'].includes(normalized)) return false
	throw new Error(`Invalid boolean value: "${value}"`)
}

function parseDeadline(value: string): number {
	const n = Number.parseInt(value, 10)
	if (Number.isNaN(n) || n <= 0) {
		throw new Error(`Invalid --deadline: "${value}" — must be a positive unix timestamp`)
	}
	return n
}

function formatOpenSeaError(err: unknown): string {
	if (err instanceof OpenSeaCliError) {
		return JSON.stringify(
			{
				error: {
					code: err.code,
					message: err.message,
					...(err.details ? { details: err.details } : {}),
				},
			},
			null,
			2,
		)
	}

	const message = err instanceof Error ? err.message : String(err)
	return JSON.stringify(
		{
			error: {
				code: 'OPENSEA_ERROR',
				message,
			},
		},
		null,
		2,
	)
}

async function main(): Promise<void> {
	const [group, command, ...rest] = process.argv.slice(2)

	if (group === 'version' || group === '--version' || group === '-v') {
		console.log(`purr ${PURR_VERSION}`)
		return
	}

	if (group === 'execute') {
		const execArgs = parseArgs([command, ...rest].filter(Boolean))
		const stepsFile = execArgs['steps-file']
		if (!stepsFile) {
			throw new Error('Usage: purr execute --steps-file /tmp/purr_steps.json [--dedup-key <key>]')
		}
		const result = await executeStepsFromFile(stepsFile, execArgs['dedup-key'])
		console.log(JSON.stringify(result, null, 2))
		return
	}

	if (group === 'config') {
		switch (command) {
			case 'set': {
				const key = rest[0]
				const value = rest[1]
				if (!key || !value) {
					throw new Error(
						'Usage: purr config set <key> <value>\nKeys: api-url, api-token, instance-id',
					)
				}
				configSet(key, value)
				console.log(`Set ${key}`)
				return
			}
			case 'get': {
				const key = rest[0]
				if (!key) {
					throw new Error('Usage: purr config get <key>\nKeys: api-url, api-token, instance-id')
				}
				const val = configGet(key)
				if (val === undefined) {
					console.error(`Key "${key}" is not set`)
					process.exit(1)
				}
				console.log(val)
				return
			}
			case 'list': {
				const all = configList()
				if (Object.keys(all).length === 0) {
					console.log('No configuration set. Use: purr config set <key> <value>')
				} else {
					for (const [k, v] of Object.entries(all)) {
						console.log(`${k} = ${v}`)
					}
				}
				return
			}
			default:
				throw new Error('Usage: purr config <set|get|list>\nKeys: api-url, api-token, instance-id')
		}
	}

	if (!group || group === '--help' || group === '-h') {
		console.log(`Usage: purr <group> <command> [options]

Groups:
  aster             Aster DEX registration + on-chain deposits (ETH, BSC, Arbitrum)
  bitget            Bitget multi-chain swap (quotes + encodes automatically)
  binance-connect   Fiat on-ramp via Binance Connect (buy crypto with fiat)
  dflow             DFlow Solana-only swap
  fourmeme          four.meme BSC flows (login challenge, buy, sell, create-token)
  opensea           OpenSea execution/signing helpers for official OpenSea workflows
  pancake           PancakeSwap calldata builder (V2/V3 swap, LP, farm, syrup)
  lista             Lista DAO vault calldata builder
  wallet            Wallet operations (address, balance, sign, sign-typed-data, transfer)
  execute           Execute on-chain steps from a JSON file
  evm               EVM primitives (approve, transfer, raw)
  config            Manage persistent credentials (set, get, list)
  version           Print version

Examples:
  purr dflow swap --from-token So111...1112 --to-token <mint> --amount 0.1 --wallet <addr>
  purr dflow swap --from-token So111...1112 --to-token <mint> --amount 0.1 --wallet <addr> --execute
  purr fourmeme login-challenge --wallet 0x...
  purr bitget swap --from-token 0x... --to-token 0x... --from-amount 0.05 --chain bnb --wallet 0x...
  purr fourmeme buy --token 0x... --wallet 0x... --funds 0.1
  purr fourmeme sell --token 0x... --wallet 0x... --amount 1000
  purr fourmeme create-token --wallet 0x... --login-nonce abc --login-signature-file /tmp/fourmeme_login_signature.txt --name "My Token" --symbol MTK --description "..." --label AI --image-url https://example.com/logo.png
  purr opensea buy --chain ethereum --collection pudgypenguins --token-id 5598 --wallet 0x...
  purr opensea sell --chain ethereum --collection pudgypenguins --token-id 7576 --wallet 0x...
  purr opensea cancel-offer --chain ethereum --order-hash 0x... --wallet 0x...
  purr opensea cancel-list --chain ethereum --order-hash 0x... --wallet 0x...
  purr opensea make-offer --chain ethereum --collection pudgypenguins --token-id 7576 --wallet 0x... --amount 200000000000000
  purr opensea create-list --chain ethereum --collection pudgypenguins --token-id 7576 --wallet 0x... --amount 4250000000000000000
  purr opensea swap --from-chain base --from-address 0x0000000000000000000000000000000000000000 --to-chain base --to-address 0x4200000000000000000000000000000000000006 --quantity 1000000000000000 --wallet 0x...
  purr opensea swap --from-chain base --from-address 0x0000000000000000000000000000000000000000 --to-chain base --to-address 0x4200000000000000000000000000000000000006 --quantity 1000000000000000 --wallet 0x... --execute
  purr binance-connect quote --fiat USD --crypto USDT --amount 50
  purr binance-connect buy --fiat USD --crypto USDT --amount 50 --network BSC --wallet 0x...
  purr pancake swap --path 0xA,0xB --amount-in-wei 1000 --amount-out-min-wei 500 --wallet 0x... --deadline 1710000000 --chain-id 56
  purr pancake add-liquidity --token-a 0x... --token-b 0x... --amount-a-wei 1000 --amount-b-wei 2000 --wallet 0x... --deadline 1710000000 --chain-id 56
  purr pancake remove-liquidity --pair-address 0x... --token0 0x... --token1 0x... --lp-amount-wei 5000 --wallet 0x... --deadline 1710000000 --chain-id 56
  purr pancake stake --pid 2 --amount-wei 1000 --lp-token 0x... --chain-id 56
  purr pancake harvest --pid 2 --lp-token 0x... --chain-id 56
  purr pancake v3-mint --token0 0x... --token1 0x... --fee 2500 --tick-lower -100 --tick-upper 100 --amount0-wei 1000 --amount1-wei 2000 --wallet 0x... --chain-id 56
  purr pancake v3-stake --token-id 12345 --wallet 0x... --chain-id 56
  purr pancake syrup-stake --pool-address 0x... --amount-wei 1000 --chain-id 56
  purr lista list-vaults
  purr lista list-vaults --zone classic
  purr lista deposit --vault 0x... --amount-wei 1000 --token 0x... --wallet 0x... --chain-id 56
  purr lista deposit --vault 0x... --amount-wei 1000 --token 0x... --wallet 0x... --chain-id 56 --execute
  purr aster api --endpoint /fapi/v3/balance --user 0x... --private-key 0x...
  purr aster api --method POST --endpoint /fapi/v3/order --user 0x... --private-key 0x... --symbol BTCUSDT --side BUY --type LIMIT --quantity 0.001 --price 50000 --timeInForce GTC
  purr aster deposit --token 0x... --amount-wei 1000 --wallet 0x... --chain-id 56
  purr wallet address --chain-type ethereum
  purr wallet balance --chain-type ethereum --chain-id 56
  purr wallet balance --token 0x55d3...7955 --chain-id 56
  purr wallet sign --address 0x... --message "Hello"
  purr wallet sign-typed-data --address 0x... --data '{"domain":...,"types":...,"primaryType":"...","message":...}'
  purr wallet transfer --to 0x... --amount 0.01 --chain-id 56
  purr wallet transfer --to 0x... --amount 1000 --chain-id 56 --token 0x55d3...7955
  purr execute --steps-file /tmp/purr_steps.json
  purr execute --steps-file /tmp/purr_steps.json --dedup-key my-swap-123
  purr pancake swap --path 0xA,0xB --amount-in-wei 1000 --amount-out-min-wei 500 --wallet 0x... --deadline 1710000000 --chain-id 56 --execute
  purr evm approve --token 0x... --spender 0x... --amount 1000 --chain-id 56
  purr evm raw --to 0x... --data 0xAbcDef --chain-id 56`)
		process.exit(0)
	}

	const args = parseArgs(rest)
	const executeFlag = args.execute === 'true'
	let output: StepOutput

	switch (group) {
		case 'aster': {
			if (command === 'api') {
				const reserved = new Set(['method', 'endpoint', 'user', 'private-key', 'base-url'])
				const apiParams: Record<string, string> = {}
				for (const [k, v] of Object.entries(args)) {
					if (!reserved.has(k)) apiParams[k] = v
				}
				const result = await asterApi({
					method: args.method ?? 'GET',
					endpoint: requireArg(args, 'endpoint'),
					user: requireArg(args, 'user'),
					privateKey: requireArg(args, 'private-key'),
					baseUrl: args['base-url'],
					params: Object.keys(apiParams).length > 0 ? apiParams : undefined,
				})
				console.log(JSON.stringify(result, null, 2))
				return
			}
			const chainId = parseChainId(requireArg(args, 'chain-id'))
			switch (command) {
				case 'deposit':
					output = buildAsterDepositSteps({
						token: requireArg(args, 'token'),
						amountWei: requireArg(args, 'amount-wei'),
						wallet: requireArg(args, 'wallet'),
						chainId,
						broker: args.broker,
					})
					break
				default:
					throw new Error(`Unknown aster command: ${command}. Use: api, deposit`)
			}
			break
		}

		case 'bitget': {
			if (command !== 'swap') throw new Error(`Unknown bitget command: ${command}`)

			if (args.calldata) {
				// Legacy mode: pre-fetched calldata JSON
				let calldata = args.calldata
				if (calldata === '-') {
					calldata = await readStdin()
				}
				output = buildBitgetSwapStepsFromCalldata({
					calldata,
					fromToken: requireArg(args, 'from-token'),
					amountWei: requireArg(args, 'amount-wei'),
					chainId: parseChainId(requireArg(args, 'chain-id')),
				})
			} else {
				// Full flow: quote → calldata → steps
				output = await buildBitgetSwapSteps({
					fromToken: requireArg(args, 'from-token'),
					toToken: requireArg(args, 'to-token'),
					fromAmount: requireArg(args, 'from-amount'),
					chain: requireArg(args, 'chain'),
					wallet: requireArg(args, 'wallet'),
					slippage: args.slippage ? Number.parseFloat(args.slippage) : undefined,
				})
			}
			break
		}

		// DFlow swap is executed server-side — early return like wallet commands
		case 'dflow': {
			if (command !== 'swap') throw new Error(`Unknown dflow command: ${command}. Use: swap`)
			const dflowResult = await dflowSwap({
				fromToken: requireArg(args, 'from-token'),
				toToken: requireArg(args, 'to-token'),
				amount: requireArg(args, 'amount'),
				wallet: requireArg(args, 'wallet'),
				slippage: args.slippage ? Number.parseFloat(args.slippage) : undefined,
			})
			console.log(JSON.stringify(dflowResult, null, 2))
			return
		}

		// login-challenge returns non-StepOutput JSON — early return like binance-connect
		case 'fourmeme': {
			if (command === 'login-challenge') {
				const challenge = await buildFourMemeLoginChallenge({
					wallet: requireArg(args, 'wallet'),
				})
				console.log(JSON.stringify(challenge))
				return
			}
			switch (command) {
				case 'buy':
					output = await buildFourMemeBuySteps({
						token: requireArg(args, 'token'),
						wallet: requireArg(args, 'wallet'),
						amount: args.amount,
						funds: args.funds,
						slippage: args.slippage ? Number.parseFloat(args.slippage) : undefined,
					})
					break
				case 'sell':
					output = await buildFourMemeSellSteps({
						token: requireArg(args, 'token'),
						wallet: requireArg(args, 'wallet'),
						amount: requireArg(args, 'amount'),
						slippage: args.slippage ? Number.parseFloat(args.slippage) : undefined,
					})
					break
				case 'create-token':
					output = await buildFourMemeCreateTokenSteps({
						wallet: requireArg(args, 'wallet'),
						loginNonce: requireArg(args, 'login-nonce'),
						loginSignature: requireArgOrFile(
							args,
							'login-signature',
							'login-signature-file',
						) as `0x${string}`,
						name: requireArg(args, 'name'),
						symbol: requireArg(args, 'symbol'),
						description: requireArg(args, 'description'),
						label: requireArg(args, 'label'),
						imageUrl: args['image-url'],
						imageFile: args['image-file'],
						website: args.website,
						twitter: args.twitter,
						telegram: args.telegram,
						preSale: args['pre-sale'],
						xMode: parseBooleanFlag(args['x-mode']),
						antiSniper: parseBooleanFlag(args['anti-sniper']),
						launchTime: parseIntegerArg(args['launch-time'], 'launch-time'),
						taxFeeRate: parseIntegerArg(args['tax-fee-rate'], 'tax-fee-rate'),
						taxBurnRate: parseIntegerArg(args['tax-burn-rate'], 'tax-burn-rate'),
						taxDivideRate: parseIntegerArg(args['tax-divide-rate'], 'tax-divide-rate'),
						taxLiquidityRate: parseIntegerArg(args['tax-liquidity-rate'], 'tax-liquidity-rate'),
						taxRecipientRate: parseIntegerArg(args['tax-recipient-rate'], 'tax-recipient-rate'),
						taxRecipientAddress: args['tax-recipient-address'],
						taxMinSharing: args['tax-min-sharing'],
						creationFee: args['creation-fee'],
					})
					break
				default:
					throw new Error(
						`Unknown fourmeme command: ${command}. Use: login-challenge, buy, sell, create-token`,
					)
			}
			break
		}

		// Binance Connect returns raw API JSON, not StepOutput — early return
		case 'binance-connect': {
			let result: unknown
			switch (command) {
				case 'pairs':
					result = await getTradingPairs()
					break
				case 'networks':
					result = await getNetworks()
					break
				case 'quote':
					result = await getQuote({
						fiatCurrency: requireArg(args, 'fiat'),
						cryptoCurrency: requireArg(args, 'crypto'),
						fiatAmount: requireArg(args, 'amount'),
						network: args.network,
						paymentMethod: args['payment-method'],
					})
					break
				case 'buy':
					result = await createOrder({
						fiatCurrency: requireArg(args, 'fiat'),
						cryptoCurrency: requireArg(args, 'crypto'),
						fiatAmount: requireArg(args, 'amount'),
						cryptoNetwork: requireArg(args, 'network'),
						walletAddress: requireArg(args, 'wallet'),
						externalOrderId: args['order-id'],
						paymentMethod: args['payment-method'],
					})
					break
				case 'status':
					result = await queryOrder(requireArg(args, 'order-id'))
					break
				default:
					throw new Error(
						`Unknown binance-connect command: ${command}. Use: pairs, networks, quote, buy, status`,
					)
			}
			console.log(JSON.stringify(result))
			return
		}

		case 'opensea': {
			switch (command) {
				case 'buy':
					output = await buildOpenSeaBuySteps({
						chain: requireArg(args, 'chain'),
						collection: requireArg(args, 'collection'),
						tokenId: requireArg(args, 'token-id'),
						wallet: requireArg(args, 'wallet'),
					})
					break
				case 'sell':
					output = await buildOpenSeaSellSteps({
						chain: requireArg(args, 'chain'),
						collection: requireArg(args, 'collection'),
						tokenId: requireArg(args, 'token-id'),
						wallet: requireArg(args, 'wallet'),
					})
					break
				case 'cancel-offer': {
					const cancelArgs = {
						chain: requireArg(args, 'chain'),
						orderHash: requireArg(args, 'order-hash'),
						wallet: requireArg(args, 'wallet'),
						protocolAddress: args['protocol-address'],
					}
					if (executeFlag) {
						const result = await cancelOpenSeaOffer(cancelArgs)
						console.log(JSON.stringify(result, null, 2))
						return
					}
					const preview = await buildOpenSeaCancelOfferPreview(cancelArgs)
					console.log(JSON.stringify(preview, null, 2))
					return
				}
				case 'cancel-list': {
					const cancelArgs = {
						chain: requireArg(args, 'chain'),
						orderHash: requireArg(args, 'order-hash'),
						wallet: requireArg(args, 'wallet'),
						protocolAddress: args['protocol-address'],
					}
					if (executeFlag) {
						const result = await cancelOpenSeaListing(cancelArgs)
						console.log(JSON.stringify(result, null, 2))
						return
					}
					const preview = await buildOpenSeaCancelListingPreview(cancelArgs)
					console.log(JSON.stringify(preview, null, 2))
					return
				}
				case 'make-offer': {
					const offerArgs = {
						chain: requireArg(args, 'chain'),
						collection: requireArg(args, 'collection'),
						tokenId: requireArg(args, 'token-id'),
						wallet: requireArg(args, 'wallet'),
						amount: requireArg(args, 'amount'),
						protocolAddress: args['protocol-address'],
						startTime: parseIntegerArg(args['start-time'], 'start-time'),
						endTime: parseIntegerArg(args['end-time'], 'end-time'),
						durationSeconds: parseIntegerArg(args['duration-seconds'], 'duration-seconds'),
					}
					if (executeFlag) {
						const result = await createOpenSeaOffer(offerArgs)
						console.log(JSON.stringify(result, null, 2))
						return
					}
					const preview = await buildOpenSeaOfferPreview(offerArgs)
					console.log(JSON.stringify(preview, null, 2))
					return
				}
				case 'create-list': {
					const listingArgs = {
						chain: requireArg(args, 'chain'),
						collection: requireArg(args, 'collection'),
						tokenId: requireArg(args, 'token-id'),
						wallet: requireArg(args, 'wallet'),
						amount: requireArg(args, 'amount'),
						protocolAddress: args['protocol-address'],
						startTime: parseIntegerArg(args['start-time'], 'start-time'),
						endTime: parseIntegerArg(args['end-time'], 'end-time'),
						durationSeconds: parseIntegerArg(args['duration-seconds'], 'duration-seconds'),
					}
					if (executeFlag) {
						const result = await createOpenSeaListing(listingArgs)
						console.log(JSON.stringify(result, null, 2))
						return
					}
					const preview = await buildOpenSeaListingPreview(listingArgs)
					console.log(JSON.stringify(preview, null, 2))
					return
				}
				case 'swap':
					output = await buildOpenSeaSwapSteps({
						fromChain: requireArg(args, 'from-chain'),
						fromAddress: requireArg(args, 'from-address'),
						toChain: requireArg(args, 'to-chain'),
						toAddress: requireArg(args, 'to-address'),
						quantity: requireArg(args, 'quantity'),
						wallet: requireArg(args, 'wallet'),
						slippage: parseFloatArg(args.slippage, 'slippage'),
						recipient: args.recipient,
					})
					break
				default:
					throw new Error(
						`Unknown opensea command: ${command}. Use: buy, sell, cancel-offer, cancel-list, make-offer, create-list, swap`,
					)
			}
			break
		}

		case 'pancake': {
			const chainId = parseChainId(requireArg(args, 'chain-id'))
			switch (command) {
				case 'swap':
					output = buildPancakeSwapSteps({
						path: requireArg(args, 'path').split(','),
						amountInWei: requireArg(args, 'amount-in-wei'),
						amountOutMinWei: requireArg(args, 'amount-out-min-wei'),
						wallet: requireArg(args, 'wallet'),
						deadline: parseDeadline(requireArg(args, 'deadline')),
						chainId,
						router: args.router,
					})
					break
				case 'add-liquidity':
					output = buildPancakeAddLiquiditySteps({
						tokenA: requireArg(args, 'token-a'),
						tokenB: requireArg(args, 'token-b'),
						amountAWei: requireArg(args, 'amount-a-wei'),
						amountBWei: requireArg(args, 'amount-b-wei'),
						wallet: requireArg(args, 'wallet'),
						deadline: parseDeadline(requireArg(args, 'deadline')),
						chainId,
						router: args.router,
					})
					break
				case 'remove-liquidity':
					output = buildPancakeRemoveLiquiditySteps({
						pairAddress: requireArg(args, 'pair-address'),
						token0: requireArg(args, 'token0'),
						token1: requireArg(args, 'token1'),
						lpAmountWei: requireArg(args, 'lp-amount-wei'),
						wallet: requireArg(args, 'wallet'),
						deadline: parseDeadline(requireArg(args, 'deadline')),
						chainId,
						router: args.router,
					})
					break
				case 'stake':
				case 'unstake':
				case 'harvest':
					output = buildPancakeFarmSteps({
						action: command,
						pid: Number.parseInt(requireArg(args, 'pid'), 10),
						amountWei: command === 'harvest' ? '0' : requireArg(args, 'amount-wei'),
						lpToken: requireArg(args, 'lp-token'),
						chainId,
						masterChef: args['master-chef'],
					})
					break
				case 'v3-mint':
					output = buildV3MintSteps({
						token0: requireArg(args, 'token0'),
						token1: requireArg(args, 'token1'),
						fee: Number.parseInt(requireArg(args, 'fee'), 10),
						tickLower: Number.parseInt(requireArg(args, 'tick-lower'), 10),
						tickUpper: Number.parseInt(requireArg(args, 'tick-upper'), 10),
						amount0Wei: requireArg(args, 'amount0-wei'),
						amount1Wei: requireArg(args, 'amount1-wei'),
						wallet: requireArg(args, 'wallet'),
						deadline: args.deadline ? parseDeadline(args.deadline) : undefined,
						chainId,
					})
					break
				case 'v3-increase':
					output = buildV3IncreaseLiquiditySteps({
						tokenId: requireArg(args, 'token-id'),
						amount0Wei: requireArg(args, 'amount0-wei'),
						amount1Wei: requireArg(args, 'amount1-wei'),
						deadline: args.deadline ? parseDeadline(args.deadline) : undefined,
						chainId,
					})
					break
				case 'v3-decrease':
					output = buildV3DecreaseLiquiditySteps({
						tokenId: requireArg(args, 'token-id'),
						liquidity: requireArg(args, 'liquidity'),
						amount0MinWei: args['amount0-min-wei'] ?? '0',
						amount1MinWei: args['amount1-min-wei'] ?? '0',
						deadline: args.deadline ? parseDeadline(args.deadline) : undefined,
						chainId,
					})
					break
				case 'v3-collect':
					output = buildV3CollectSteps({
						tokenId: requireArg(args, 'token-id'),
						wallet: requireArg(args, 'wallet'),
						chainId,
					})
					break
				case 'v3-stake':
				case 'v3-unstake':
				case 'v3-harvest':
					output = buildPancakeV3FarmSteps({
						action: command.slice(3) as 'stake' | 'unstake' | 'harvest',
						tokenId: requireArg(args, 'token-id'),
						wallet: requireArg(args, 'wallet'),
						chainId,
					})
					break
				case 'syrup-stake':
					output = buildSyrupStakeSteps({
						poolAddress: requireArg(args, 'pool-address'),
						amountWei: requireArg(args, 'amount-wei'),
						chainId,
					})
					break
				case 'syrup-unstake':
					output = buildSyrupUnstakeSteps({
						poolAddress: requireArg(args, 'pool-address'),
						amountWei: requireArg(args, 'amount-wei'),
						chainId,
					})
					break
				default:
					throw new Error(
						`Unknown pancake command: ${command}. Use: swap, add-liquidity, remove-liquidity, stake, unstake, harvest, v3-mint, v3-increase, v3-decrease, v3-collect, v3-stake, v3-unstake, v3-harvest, syrup-stake, syrup-unstake`,
					)
			}
			break
		}

		case 'lista': {
			if (command === 'list-vaults') {
				const result = await listVaults(args.zone)
				console.log(JSON.stringify(result, null, 2))
				return
			}
			const chainId = parseChainId(requireArg(args, 'chain-id'))
			switch (command) {
				case 'deposit':
					output = buildListaDepositSteps({
						vault: requireArg(args, 'vault'),
						amountWei: requireArg(args, 'amount-wei'),
						token: requireArg(args, 'token'),
						wallet: requireArg(args, 'wallet'),
						chainId,
					})
					break
				case 'redeem':
					output = buildListaRedeemSteps({
						vault: requireArg(args, 'vault'),
						sharesWei: requireArg(args, 'shares-wei'),
						wallet: requireArg(args, 'wallet'),
						chainId,
					})
					break
				case 'withdraw':
					output = buildListaWithdrawSteps({
						vault: requireArg(args, 'vault'),
						amountWei: requireArg(args, 'amount-wei'),
						wallet: requireArg(args, 'wallet'),
						chainId,
					})
					break
				default:
					throw new Error(
						`Unknown lista command: ${command}. Use: list-vaults, deposit, redeem, withdraw`,
					)
			}
			break
		}

		case 'evm': {
			const chainId = parseChainId(requireArg(args, 'chain-id'))
			switch (command) {
				case 'approve':
					output = buildApproveSteps({
						token: requireArg(args, 'token'),
						spender: requireArg(args, 'spender'),
						amount: requireArg(args, 'amount'),
						chainId,
					})
					break
				case 'transfer':
					output = buildTransferSteps({
						token: args.token ?? NATIVE_EVM,
						to: requireArg(args, 'to'),
						amountWei: requireArg(args, 'amount-wei'),
						chainId,
					})
					break
				case 'raw':
					output = buildRawStep({
						to: requireArg(args, 'to'),
						data: requireArg(args, 'data'),
						value: args.value,
						chainId,
						label: args.label,
						gasLimit: args['gas-limit'],
					})
					break
				default:
					throw new Error(`Unknown evm command: ${command}. Use: approve, transfer, raw`)
			}
			break
		}

		case 'wallet': {
			switch (command) {
				case 'address':
					await walletAddress(args)
					return
				case 'balance':
					await walletBalance(args)
					return
				case 'sign':
					await walletSign(args)
					return
				case 'sign-typed-data':
					await walletSignTypedData(args)
					return
				case 'transfer':
					await walletTransfer(args)
					return
				default:
					throw new Error(
						`Unknown wallet command: ${command}. Use: address, balance, sign, sign-typed-data, transfer`,
					)
			}
		}

		default:
			throw new Error(
				`Unknown group: ${group}. Use: aster, bitget, binance-connect, dflow, fourmeme, opensea, pancake, lista, evm, wallet, execute, config, version`,
			)
	}

	if (executeFlag) {
		const json = JSON.stringify(output)
		const result = await executeStepsFromJson(json, args['dedup-key'])
		console.log(JSON.stringify(result, null, 2))
	} else {
		console.log(JSON.stringify(output))
	}
}

main().catch((err) => {
	if (process.argv[2] === 'opensea') {
		console.error(formatOpenSeaError(err))
		process.exit(1)
	}
	console.error(err.message)
	process.exit(1)
})
