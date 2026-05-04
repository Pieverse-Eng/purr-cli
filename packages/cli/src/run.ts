#!/usr/bin/env node
declare const PURR_VERSION: string
import { readFileSync } from 'node:fs'
import { configGet, configList, configSet } from '@pieverseio/purr-core/api-client'
import { executeStepsFromFile, executeStepsFromJson } from '@pieverseio/purr-core/executor'
import { requireArgOrFile } from '@pieverseio/purr-core/file-input'
import { NATIVE_EVM, parseChainId } from '@pieverseio/purr-core/shared'
import { SOLANA_CHAIN_ID, resolveToken } from '@pieverseio/purr-core/token-registry'
import type { StepOutput } from '@pieverseio/purr-core/types'
import { buildAbiCallStep } from '@pieverseio/purr-plugin-evm/abi-call'
import { buildApproveSteps } from '@pieverseio/purr-plugin-evm/approve'
import { buildRawStep } from '@pieverseio/purr-plugin-evm/raw'
import { buildTransferSteps } from '@pieverseio/purr-plugin-evm/transfer'
import {
  createOrder,
  getNetworks,
  getQuote,
  getTradingPairs,
  queryOrder,
} from '@pieverseio/purr-plugin-vendors/binance-connect'
import {
  buildFourMemeBuySteps,
  buildFourMemeCreateTokenSteps,
  buildFourMemeLoginChallenge,
  buildFourMemeSellSteps,
} from '@pieverseio/purr-plugin-vendors/fourmeme'
import { asterApi, buildAsterDepositSteps } from '@pieverseio/purr-plugin-vendors/aster'
import {
  buildListaDepositSteps,
  buildListaRedeemSteps,
  buildListaWithdrawSteps,
  listVaults,
} from '@pieverseio/purr-plugin-vendors/lista'
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
} from '@pieverseio/purr-plugin-vendors/pancake'
import {
  buildOpenSeaBuySteps,
  ensureOpenSeaExecutionWalletMatches,
  buildOpenSeaSellSteps,
  OpenSeaCliError,
} from '@pieverseio/purr-plugin-vendors/opensea'
import { parseOpenSeaFulfillmentInput } from '@pieverseio/purr-plugin-vendors/opensea-input'
import {
  findBySlug,
  findInstallConflict,
  getInstalled,
  recordInstall,
  recordRemove,
} from '@pieverseio/purr-plugin-store/state'
import {
  resolveSlug,
  parseQualifiedSlug,
  SOURCES,
  type SourceId,
} from '@pieverseio/purr-plugin-store/resolve'
import { removeFromAgents } from '@pieverseio/purr-plugin-store/skill-dirs'
import { walletAbiCall } from '@pieverseio/purr-plugin-wallet/abi-call'
import { walletAddress } from '@pieverseio/purr-plugin-wallet/address'
import { walletBalance } from '@pieverseio/purr-plugin-wallet/balance'
import { walletSign } from '@pieverseio/purr-plugin-wallet/sign'
import { walletSignTransaction } from '@pieverseio/purr-plugin-wallet/sign-transaction'
import { walletSignTypedData } from '@pieverseio/purr-plugin-wallet/sign-typed-data'
import { walletTransfer } from '@pieverseio/purr-plugin-wallet/transfer'
import { handleInstanceCommand } from './instance.js'
import type { PluginId, PluginRuntimeMap, PurrCliOptions } from './types.js'

const pluginLoaders: { [K in PluginId]: () => Promise<PluginRuntimeMap[K]> } = {
  ows: async () => (await import('@pieverseio/purr-plugin-ows')).owsRuntime,
}

const pluginDisabledMessages = {
  ows: 'OWS commands are not available in this purr build. Use a Linux/macOS build or WSL.',
} satisfies Record<PluginId, string>

function disabledPluginReason(options: PurrCliOptions, pluginId: PluginId): string | undefined {
  return options.disabledPlugins?.[pluginId]
}

function requirePluginEnabled(options: PurrCliOptions, pluginId: PluginId): void {
  const disabledReason = disabledPluginReason(options, pluginId)
  if (disabledReason !== undefined) {
    throw new Error(disabledReason || pluginDisabledMessages[pluginId])
  }
}

function isPluginEnabled(options: PurrCliOptions, pluginId: PluginId): boolean {
  return disabledPluginReason(options, pluginId) === undefined
}

async function loadPlugin<K extends PluginId>(pluginId: K): Promise<PluginRuntimeMap[K]> {
  return await pluginLoaders[pluginId]()
}

async function requirePlugin<K extends PluginId>(
  options: PurrCliOptions,
  pluginId: K,
): Promise<PluginRuntimeMap[K]> {
  requirePluginEnabled(options, pluginId)
  return await loadPlugin(pluginId)
}

function currentVersion(): string {
  return typeof PURR_VERSION === 'string' ? PURR_VERSION : 'dev'
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h') {
      result.h = 'true'
    } else if (arg.startsWith('--')) {
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

const SLUG_RE = /^([a-z0-9-]+:)?[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i
function validatedSlug(raw: string): { slug: string } | { error: true; message: string } {
  if (!SLUG_RE.test(raw)) {
    return { error: true, message: `Invalid skill slug: "${raw}"` }
  }
  return { slug: raw }
}

function parseIntegerArg(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
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

export async function runPurrCli(options: PurrCliOptions = {}): Promise<void> {
  const [group, command, ...rest] = process.argv.slice(2)

  if (group === 'version' || group === '--version' || group === '-v') {
    console.log(`purr ${currentVersion()}`)
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

  // OWS-local equivalent of `purr execute` — same flag surface, local signing.
  if (group === 'ows-execute') {
    const ows = await requirePlugin(options, 'ows')
    const execArgs = parseArgs([command, ...rest].filter(Boolean))
    const stepsFile = execArgs['steps-file']
    if (!stepsFile) {
      throw new Error(
        'Usage: purr ows-execute --steps-file /tmp/purr_steps.json --ows-wallet <name> [--rpc-url <url>] [--ows-token <ows_key_...>]',
      )
    }
    const stepsJson = readFileSync(stepsFile, 'utf-8')
    const result = await ows.executeSteps({
      stepsJson,
      owsWallet: requireArg(execArgs, 'ows-wallet'),
      owsToken: execArgs['ows-token'] ?? process.env.OWS_PASSPHRASE,
      rpcUrl: execArgs['rpc-url'],
    })
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
  binance-connect   Fiat on-ramp via Binance Connect (buy crypto with fiat)
  ows-wallet        OWS-backed sign-transaction + build-transfer (drop-in for 'wallet sign-transaction'; build-transfer emits unsigned hex for 'ows sign send-tx')
  ows-execute       OWS-local step execution (drop-in for 'execute'; signs + broadcasts locally)
  fourmeme          four.meme BSC flows (login challenge, buy, sell, create-token)
  opensea           OpenSea execution helpers for official OpenSea workflows
  pancake           PancakeSwap calldata builder (V2/V3 swap, LP, farm, syrup)
  lista             Lista DAO vault calldata builder
  wallet            Wallet operations (address, balance, sign, sign-typed-data, sign-transaction, transfer, abi-call)
  instance          Instance billing status and trusted-wallet renewal
  execute           Execute on-chain steps from a JSON file
  evm               EVM primitives (approve, transfer, raw)
  config            Manage persistent credentials (set, get, list)
  version           Print version

Examples:
  purr fourmeme login-challenge --wallet 0x...
  purr wallet sign-transaction --txs-json '{"orderId":"...","txs":[...]}'
  purr fourmeme buy --token 0x... --wallet 0x... --funds 0.1
  purr fourmeme sell --token 0x... --wallet 0x... --amount 1000
  purr fourmeme create-token --wallet 0x... --login-nonce abc --login-signature-file /tmp/fourmeme_login_signature.txt --name "My Token" --symbol MTK --description "..." --label AI --image-url https://example.com/logo.png
  purr opensea buy --wallet 0x... --fulfillment-json '{"fulfillment_data":{"transaction":{...}}}'
  purr opensea buy --wallet 0x... --fulfillment-file ./fulfillment.json
  purr opensea sell --wallet 0x... --fulfillment-json '{"fulfillment_data":{"transaction":{...}}}'
  purr opensea sell --wallet 0x... --fulfillment-file ./fulfillment.json
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
  purr ows-wallet sign-transaction --ows-wallet treasury --txs-json-file /tmp/order.json
  OWS_PASSPHRASE=ows_key_... purr ows-wallet sign-transaction --ows-wallet treasury --txs-json-file /tmp/order.json
  purr ows-execute --steps-file /tmp/steps.json --ows-wallet treasury
  OWS_PASSPHRASE=ows_key_... purr ows-execute --steps-file /tmp/steps.json --ows-wallet treasury --rpc-url https://...
  purr ows-wallet build-transfer --ows-wallet treasury --to 0x... --amount 0.01 --chain-id 56
  purr ows-wallet build-transfer --ows-wallet treasury --to 0x... --amount 10 --chain-id 56 --token 0x<erc20-contract>
  # then: ows sign send-tx --chain eip155:56 --wallet treasury --tx <unsignedTxHex from above>
  purr aster api --endpoint /fapi/v3/balance --user 0x... --private-key 0x...
  purr aster api --method POST --endpoint /fapi/v3/order --user 0x... --private-key 0x... --symbol BTCUSDT --side BUY --type LIMIT --quantity 0.001 --price 50000 --timeInForce GTC
  purr aster deposit --token 0x... --amount-wei 1000 --wallet 0x... --chain-id 56
  purr wallet address --chain-type ethereum
  purr wallet balance --chain-type ethereum --chain-id 56
  purr wallet balance --token 0x55d3...7955 --chain-id 56
  purr instance status
  purr instance renew --chain-id 56 --token-address 0x55d3...7955 --yes
  purr wallet sign --address 0x... --message "Hello"
  purr wallet sign-typed-data --address 0x... --data '{"domain":...,"types":...,"primaryType":"...","message":...}'
  purr wallet transfer --to 0x... --amount 0.01 --chain-id 56
  purr wallet transfer --to 0x... --amount 1000 --chain-id 56 --token 0x55d3...7955
  purr wallet transfer --to FuQPd1q... --amount 0.5 --chain-type solana
  purr wallet transfer --to FuQPd1q... --amount 100 --chain-type solana --token EPjFWdd5...
  purr wallet abi-call --to 0x... --signature 'register(string)' --args '["https://example.com/agent.json"]' --chain-id 2818
  purr execute --steps-file /tmp/purr_steps.json
  purr execute --steps-file /tmp/purr_steps.json --dedup-key my-swap-123
  purr pancake swap --path 0xA,0xB --amount-in-wei 1000 --amount-out-min-wei 500 --wallet 0x... --deadline 1710000000 --chain-id 56 --execute
  purr evm approve --token 0x... --spender 0x... --amount 1000 --chain-id 56
  purr evm raw --to 0x... --data 0xAbcDef --chain-id 56
  purr evm abi-call --to 0x... --signature 'register(string)' --args '["uri"]' --chain-id 2818
  purr store list
  purr store list --search <keyword> --limit 10
  purr store info <slug>
  purr store install <slug>
  purr store install <source>:<slug>
  purr store remove <slug>`)
    process.exit(0)
  }

  const args = parseArgs(rest)
  const executeFlag = args.execute === 'true'
  let output: StepOutput

  switch (group) {
    case 'instance': {
      await handleInstanceCommand(command, args)
      return
    }

    case 'ows-wallet': {
      const ows = await requirePlugin(options, 'ows')
      if (command === 'sign-transaction') {
        // --txs-json inline or --txs-json-file <path>. File form is preferred
        // when the envelope contains long hex calldata — `$(cat file)` inline
        // echoes the whole payload to the agent's bash run-mode, which can
        // cause the LLM to mangle the hex on later turns.
        const txsJson = requireArgOrFile(args, 'txs-json', 'txs-json-file')
        const result = await ows.signTransaction(
          txsJson,
          parseIntegerArg(args['chain-id'], 'chain-id'),
          {
            owsWallet: requireArg(args, 'ows-wallet'),
            owsToken: args['ows-token'] ?? process.env.OWS_PASSPHRASE,
          },
        )
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (command === 'build-transfer') {
        // Pure builder — emits an unsigned tx hex on stdout. Agent then runs
        // `ows sign send-tx --chain ... --wallet ... --tx <hex>` to sign and
        // broadcast locally. Mirrors flag surface of `purr wallet transfer`.
        const chainType = (args['chain-type'] ?? 'ethereum') as 'ethereum' | 'solana'
        if (chainType !== 'ethereum' && chainType !== 'solana') {
          throw new Error(`Invalid --chain-type: ${chainType}. Use 'ethereum' or 'solana'.`)
        }
        const chainId =
          chainType === 'ethereum' ? parseIntegerArg(args['chain-id'], 'chain-id') : undefined
        if (chainType === 'ethereum' && chainId === undefined) {
          throw new Error('--chain-id is required for EVM transfers')
        }
        // `--token` may be a ticker ("USDT", "USDC", "BONK") or a raw address.
        // If it resolves to the native sentinel (`--token BNB` / `ETH` on EVM,
        // or wrapped-native on Solana), treat as native transfer — the builder
        // accepts `undefined` as "native" and would otherwise try decimals()
        // on the zero address.
        let resolvedToken = args.token
          ? resolveToken(args.token, chainType === 'solana' ? SOLANA_CHAIN_ID : (chainId as number))
          : undefined
        if (resolvedToken && resolvedToken.toLowerCase() === NATIVE_EVM.toLowerCase()) {
          resolvedToken = undefined
        }
        const result = await ows.buildTransfer({
          owsWallet: args['ows-wallet'],
          from: args.from,
          to: requireArg(args, 'to'),
          amount: requireArg(args, 'amount'),
          chainType,
          chainId,
          token: resolvedToken,
          decimals: args.decimals ? parseIntegerArg(args.decimals, 'decimals') : undefined,
          rpcUrl: args['rpc-url'],
          gasLimit: args['gas-limit'],
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }
      throw new Error(
        `Unknown ows-wallet command: ${command}. Use: sign-transaction, build-transfer`,
      )
    }

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
            token: resolveToken(requireArg(args, 'token'), chainId),
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
            token: resolveToken(requireArg(args, 'token'), 56),
            wallet: requireArg(args, 'wallet'),
            amount: args.amount,
            funds: args.funds,
            slippage: args.slippage ? Number.parseFloat(args.slippage) : undefined,
          })
          break
        case 'sell':
          output = await buildFourMemeSellSteps({
            token: resolveToken(requireArg(args, 'token'), 56),
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
            wallet: requireArg(args, 'wallet'),
            fulfillment: parseOpenSeaFulfillmentInput(args),
          })
          break
        case 'sell':
          output = await buildOpenSeaSellSteps({
            wallet: requireArg(args, 'wallet'),
            fulfillment: parseOpenSeaFulfillmentInput(args),
          })
          break
        default:
          throw new Error(`Unknown opensea command: ${command}. Use: buy, sell`)
      }
      break
    }

    case 'pancake': {
      const chainId = parseChainId(requireArg(args, 'chain-id'))
      switch (command) {
        case 'swap':
          output = buildPancakeSwapSteps({
            path: requireArg(args, 'path')
              .split(',')
              .map((t) => resolveToken(t.trim(), chainId)),
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
            tokenA: resolveToken(requireArg(args, 'token-a'), chainId),
            tokenB: resolveToken(requireArg(args, 'token-b'), chainId),
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
            token0: resolveToken(requireArg(args, 'token0'), chainId),
            token1: resolveToken(requireArg(args, 'token1'), chainId),
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
            token0: resolveToken(requireArg(args, 'token0'), chainId),
            token1: resolveToken(requireArg(args, 'token1'), chainId),
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
            token: resolveToken(requireArg(args, 'token'), chainId),
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
            token: resolveToken(requireArg(args, 'token'), chainId),
            spender: requireArg(args, 'spender'),
            amount: requireArg(args, 'amount'),
            chainId,
          })
          break
        case 'transfer':
          output = buildTransferSteps({
            token: args.token ? resolveToken(args.token, chainId) : NATIVE_EVM,
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
        case 'abi-call':
          // Builder twin of `purr wallet abi-call` — encodes calldata locally
          // (viem) and emits steps[]. Pipe to `purr execute` (server-side
          // Privy) or `purr ows-execute` (local OWS custody).
          output = buildAbiCallStep({
            to: requireArg(args, 'to'),
            signature: requireArg(args, 'signature'),
            argsJson: requireArg(args, 'args'),
            chainId,
            value: args.value,
            gasLimit: args['gas-limit'],
            label: args.label,
          })
          break
        default:
          throw new Error(`Unknown evm command: ${command}. Use: approve, transfer, raw, abi-call`)
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
        case 'sign-transaction': {
          // Sign unsigned txs from a vendor API (Bitget makeOrder, Bulbaswap
          // bridge makeSwapOrder, etc) via managed custody — no broadcast.
          const txsJson = requireArg(args, 'txs-json')
          const result = await walletSignTransaction(
            txsJson,
            parseIntegerArg(args['chain-id'], 'chain-id'),
          )
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'transfer':
          await walletTransfer(args)
          return
        case 'abi-call':
          await walletAbiCall(args)
          return
        default:
          throw new Error(
            `Unknown wallet command: ${command}. Use: address, balance, sign, sign-typed-data, sign-transaction, transfer, abi-call`,
          )
      }
    }

    case 'store': {
      if (command === 'install') {
        const slugInput = args.slug || (rest[0] && !rest[0].startsWith('--') ? rest[0] : '')
        if (!slugInput) {
          console.error('Missing required argument: <slug>')
          process.exit(1)
        }
        const v = validatedSlug(slugInput)
        if ('error' in v) {
          console.error(v.message)
          process.exit(1)
        }
        const isGlobal = args.global === 'true'
        const resolved = await resolveSlug(v.slug)
        if (resolved.status === 'not_found') {
          console.error(`Skill "${v.slug}" not found in any source`)
          process.exit(1)
        }
        if (resolved.status === 'ambiguous') {
          process.exitCode = 2
          console.log(
            JSON.stringify(
              {
                status: 'ambiguous',
                slug: v.slug,
                message:
                  'Found in multiple sources. Ask the user to choose one using its qualified_slug.',
                candidates: resolved.candidates,
                ...(resolved.warnings?.length ? { warnings: resolved.warnings } : {}),
              },
              null,
              2,
            ),
          )
          return
        }
        const { source, slug, meta } = resolved
        if (!source || !meta) {
          console.error(`Unexpected resolution state for "${v.slug}"`)
          process.exit(1)
        }
        const qualifiedSlug = `${source}:${slug}`
        const conflict = findInstallConflict(qualifiedSlug, slug)
        if (conflict) {
          console.error(
            `Skill "${slug}" is already installed from ${conflict.source}. Remove ${conflict.qualified} before installing ${qualifiedSlug}.`,
          )
          process.exit(1)
        }
        try {
          const result = await SOURCES[source as SourceId].install(slug, {
            isGlobal,
            meta,
          })
          if ((result.skill?.installed?.length ?? 0) === 0) {
            const detail = result.skill?.errors?.length
              ? ` (${result.skill.errors.map((e) => `${e.agent}: ${e.reason}`).join('; ')})`
              : ''
            throw new Error(`Install failed: no agent directories were updated${detail}`)
          }
          recordInstall(result.qualified_slug, {
            source,
            version: meta.version,
            ...(result.commit ? { commit: result.commit } : {}),
            skill: { installed: result.skill?.installed || [] },
          })
          console.log(
            JSON.stringify(
              {
                ...result,
                ...(resolved.warnings?.length ? { warnings: resolved.warnings } : {}),
              },
              null,
              2,
            ),
          )
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err))
          console.error(e.message)
          process.exit(1)
        }
        return
      }

      if (command === 'list') {
        const search = args.search
        const category = args.category
        const limit = args.limit ? Number.parseInt(args.limit, 10) : 20
        const offset = args.offset ? Number.parseInt(args.offset, 10) : 0
        const sourceFilter = args.source || 'all'
        const VALID_SOURCES = ['all', ...Object.keys(SOURCES)]
        if (!VALID_SOURCES.includes(sourceFilter)) {
          console.error(`Invalid --source: "${sourceFilter}". Use: ${VALID_SOURCES.join(', ')}`)
          process.exit(1)
        }
        const activeSources =
          sourceFilter === 'all' ? (Object.keys(SOURCES) as SourceId[]) : [sourceFilter as SourceId]

        const settled = await Promise.allSettled(
          activeSources.map((id) => SOURCES[id].list({ search, category, limit, offset })),
        )

        const warnings: string[] = []
        const perSource: {
          slug: string
          source: string
          qualified_slug: string
          name: string
          version: string
          category: string
          description: string
          components: string[]
        }[][] = []
        // This is the raw sum of totals across all sources. Duplicates that exist
        // in multiple sources are counted more than once, matching the original
        // purr-store behavior.
        let total = 0
        settled.forEach((r, i) => {
          const id = activeSources[i]
          if (r.status === 'fulfilled') {
            const rows = r.value.skills.slice()
            perSource.push(rows)
            total += r.value.total ?? rows.length
          } else {
            warnings.push(`source ${id} unavailable: ${r.reason?.message || r.reason}`)
          }
        })

        const SOURCE_ORDER: Record<string, number> = { pieverse: 0, okx: 1 }
        const cmpByOrder = (
          a: { source: string; slug: string },
          b: { source: string; slug: string },
        ) =>
          (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9) ||
          a.slug.localeCompare(b.slug)

        function interleave<T>(queues: T[][]): T[] {
          const qs = queues.map((q) => [...q])
          const out: T[] = []
          while (qs.some((q) => q.length)) {
            for (const q of qs) {
              if (q.length) {
                const item = q.shift()
                if (item !== undefined) out.push(item)
              }
            }
          }
          return out
        }

        const merged =
          activeSources.length > 1
            ? interleave(perSource.map((rows) => rows.sort(cmpByOrder)))
            : perSource[0] || []
        const sliced = merged.slice(0, limit)

        console.log(
          JSON.stringify(
            {
              total,
              skills: sliced.map((r) => ({
                slug: r.slug,
                source: r.source,
                qualified_slug: r.qualified_slug,
                name: r.name,
                version: r.version,
                category: r.category,
                description: r.description,
                components: r.components,
              })),
              ...(warnings.length ? { warnings } : {}),
            },
            null,
            2,
          ),
        )
        return
      }

      if (command === 'info') {
        const slugInput = args.slug || (rest[0] && !rest[0].startsWith('--') ? rest[0] : '')
        if (!slugInput) {
          console.error('Missing required argument: <slug>')
          process.exit(1)
        }
        const v = validatedSlug(slugInput)
        if ('error' in v) {
          console.error(v.message)
          process.exit(1)
        }
        const resolved = await resolveSlug(v.slug)
        if (resolved.status === 'not_found') {
          console.error(`Skill "${v.slug}" not found in any source`)
          process.exit(1)
        }
        if (resolved.status === 'ambiguous') {
          console.log(
            JSON.stringify(
              {
                status: 'ambiguous',
                slug: v.slug,
                message: 'Found in multiple sources. Use a qualified slug to pick one.',
                candidates: resolved.candidates,
                ...(resolved.warnings?.length ? { warnings: resolved.warnings } : {}),
              },
              null,
              2,
            ),
          )
          return
        }
        console.log(
          JSON.stringify(
            {
              ...resolved.meta,
              ...(resolved.warnings?.length ? { warnings: resolved.warnings } : {}),
            },
            null,
            2,
          ),
        )
        return
      }

      if (command === 'remove') {
        const slugInput = args.slug || (rest[0] && !rest[0].startsWith('--') ? rest[0] : '')
        if (!slugInput) {
          console.error('Missing required argument: <slug>')
          process.exit(1)
        }
        const v = validatedSlug(slugInput)
        if ('error' in v) {
          console.error(v.message)
          process.exit(1)
        }
        const isGlobal = args.global === 'true'
        const { source: qualifiedSource, slug: bare } = parseQualifiedSlug(v.slug)
        const entries = qualifiedSource
          ? (() => {
              const rec = getInstalled(`${qualifiedSource}:${bare}`)
              return rec ? [{ qualified: `${qualifiedSource}:${bare}`, ...rec }] : []
            })()
          : findBySlug(bare)

        if (entries.length === 0) {
          const skill = removeFromAgents(bare, isGlobal)
          if (skill.removed.length === 0) {
            console.error(`Skill "${v.slug}" is not installed`)
            process.exit(1)
          }
          console.log(JSON.stringify({ slug: bare, source: 'unknown', skill }, null, 2))
          return
        }

        if (entries.length > 1) {
          process.exitCode = 2
          console.log(
            JSON.stringify(
              {
                status: 'ambiguous',
                slug: v.slug,
                message: 'Same slug installed from multiple sources. Use a qualified slug.',
                candidates: entries.map((e) => ({
                  source: e.source,
                  qualified_slug: e.qualified,
                  version: e.version,
                  installed_at: e.installed_at,
                  remove_command: `purr store remove ${e.qualified}`,
                })),
              },
              null,
              2,
            ),
          )
          return
        }

        const entry = entries[0]
        const result = await SOURCES[entry.source as SourceId].remove(bare, entry, {
          isGlobal,
        })
        recordRemove(entry.qualified as string)
        console.log(
          JSON.stringify(
            { slug: bare, qualified_slug: entry.qualified, source: entry.source, ...result },
            null,
            2,
          ),
        )
        return
      }

      throw new Error(`Unknown store command: ${command}. Use: install, list, info, remove`)
    }

    default:
      throw new Error(
        `Unknown group: ${group}. Use: aster, binance-connect, ows-wallet, ows-execute, fourmeme, opensea, pancake, lista, evm, wallet, instance, execute, config, version, store`,
      )
  }

  if (executeFlag) {
    if (group === 'opensea' && args.wallet && output && Array.isArray(output.steps)) {
      await ensureOpenSeaExecutionWalletMatches(args.wallet, output.steps)
    }
    const json = JSON.stringify(output)
    const result = await executeStepsFromJson(json, args['dedup-key'])
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(JSON.stringify(output))
  }
}

export async function handleCliError(err: unknown, options: PurrCliOptions = {}): Promise<void> {
  const ows = isPluginEnabled(options, 'ows')
    ? await loadPlugin('ows').catch(() => undefined)
    : undefined
  if (process.argv[2] === 'opensea') {
    console.error(formatOpenSeaError(err))
    process.exit(1)
  }
  if (ows?.isGasPayMasterUnsupportedError(err)) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`error: ${message}`)
    process.exit(ows.gasPayMasterUnsupportedExitCode)
  }
  if (ows?.isStepExecutionError(err)) {
    console.error(
      `error: step ${err.failedStepIndex} failed — ${err.message}\n` +
        `partial results: ${JSON.stringify(err.partialResults, null, 2)}`,
    )
    process.exit(1)
  }
  // Preserve err.code from OWS SDK (POLICY_DENIED, API_KEY_EXPIRED,
  // INVALID_PASSPHRASE, etc.) so automation can react programmatically.
  const code = (err as { code?: unknown })?.code
  const exitCode = (err as { exitCode?: unknown })?.exitCode
  const message = err instanceof Error ? err.message : String(err)
  if (typeof code === 'string' && code.length > 0) {
    console.error(`error [${code}]: ${message}`)
  } else {
    console.error(message)
  }
  process.exit(typeof exitCode === 'number' ? exitCode : 1)
}
