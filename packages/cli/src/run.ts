#!/usr/bin/env node
declare const PURR_VERSION: string
import { readFileSync } from 'node:fs'
import { configGet, configList, configSet } from '@pieverseio/purr-core/api-client'
import { executeStepsFromFile, executeStepsFromJson } from '@pieverseio/purr-core/executor'
import { handleDepsCommand } from './deps.js'
import { requireArgOrFile } from '@pieverseio/purr-core/file-input'
import { parseJsonCliArg } from '@pieverseio/purr-core/json-input'
import { NATIVE_EVM, parseChainId } from '@pieverseio/purr-core/shared'
import { SOLANA_CHAIN_ID, resolveToken } from '@pieverseio/purr-core/token-registry'
import type { StepOutput } from '@pieverseio/purr-core/types'
import {
  balancerAdd,
  balancerAddQuote,
  balancerHelp,
  balancerPools,
  balancerQuote,
  balancerRemove,
  balancerRemoveQuote,
  balancerSwap,
} from '@pieverseio/purr-plugin-balancer'
import { buildAbiCallStep } from '@pieverseio/purr-plugin-evm/abi-call'
import { buildApproveSteps } from '@pieverseio/purr-plugin-evm/approve'
import { buildRawStep } from '@pieverseio/purr-plugin-evm/raw'
import { buildTransferSteps } from '@pieverseio/purr-plugin-evm/transfer'
import { pieverseCard } from '@pieverseio/purr-plugin-pieverse-card/card'
import { pieversePurrfectYap } from '@pieverseio/purr-plugin-pieverse-card/purrfect-yap'
import {
  pnsAccounts,
  pnsByAccount,
  pnsProfile,
  pnsResolve,
} from '@pieverseio/purr-plugin-pns/resolve'
import {
  createOrder,
  getNetworks,
  getP2PTradingPairs,
  getPaymentMethods,
  getQuote,
  getTradingPairs,
  queryOrder,
} from '@pieverseio/purr-plugin-vendors/binance-onchain-pay'
import {
  buildFourMemeBuyWithBnbSteps,
  buildFourMemeBuySteps,
  buildFourMemeCreateTokenSteps,
  buildFourMemeLoginChallenge,
  buildFourMemeSellSteps,
  buildFourMemeSellForBnbSteps,
  buildFourMemeTaxClaimSteps,
  getFourMemeAgentWalletStatus,
  getFourMemeRaisedTokenConfigs,
  getFourMemeTaxRewards,
} from '@pieverseio/purr-plugin-vendors/fourmeme'
import { asterApi, buildAsterDepositSteps } from '@pieverseio/purr-plugin-vendors/aster'
import {
  bitgetOrderExecute,
  bitgetTransferExecute,
  bitgetX402Pay,
  bitgetX402SignEip3009,
  type BitgetWalletSigner,
} from '@pieverseio/purr-plugin-vendors/bitget'
import {
  dflowExecuteOrder,
  dflowMetadata,
  dflowOrder,
  dflowPositions,
  dflowPredictionOrderStatus,
  dflowPriorityFees,
  dflowQuote,
  dflowStream,
} from '@pieverseio/purr-plugin-vendors/dflow'
import {
  buildListaDepositSteps,
  buildListaRedeemSteps,
  buildListaWithdrawSteps,
  listVaults,
} from '@pieverseio/purr-plugin-vendors/lista'
import {
  buildPieverseStakeSteps,
  buildPieverseWithdrawBatchSteps,
  buildPieverseWithdrawSteps,
  getPieverseStakingDeployment,
  listPieverseStakingDeployments,
  readPieverseStakingPositions,
} from '@pieverseio/purr-plugin-vendors/pieverse-staking'
import {
  HyperliquidCliError,
  hyperliquidCommand,
  hyperliquidHelp,
} from '@pieverseio/purr-plugin-hyperliquid/index'
import { LighterCliError, lighterCommand, lighterHelp } from '@pieverseio/purr-plugin-lighter/index'
import { OseroCliError, oseroCommand, oseroHelp } from '@pieverseio/purr-plugin-vendors/osero'
import {
  PredictCliError,
  predictCommand,
  predictHelp,
} from '@pieverseio/purr-plugin-vendors/predict'
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
  buildOpenSeaActionSteps,
  buildOpenSeaTransactionSteps,
  ensureOpenSeaExecutionWalletMatches,
  signOpenSeaMessage,
  signOpenSeaTypedData,
  buildOpenSeaSellSteps,
  OpenSeaCliError,
} from '@pieverseio/purr-plugin-vendors/opensea'
import {
  parseOpenSeaActionsInput,
  parseOpenSeaFulfillmentInput,
  parseOpenSeaMessageInput,
  parseOpenSeaPaymentInput,
  parseOpenSeaTransactionInput,
  parseOpenSeaTypedDataInput,
} from '@pieverseio/purr-plugin-vendors/opensea-input'
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
import { getWalletAddress, walletAddress } from '@pieverseio/purr-plugin-wallet/address'
import { walletBalance } from '@pieverseio/purr-plugin-wallet/balance'
import {
  redpacketClaim,
  redpacketPending,
  redpacketSend,
  redpacketSent,
} from '@pieverseio/purr-plugin-wallet/redpacket'
import { walletSign } from '@pieverseio/purr-plugin-wallet/sign'
import { walletSignOkxX402 } from '@pieverseio/purr-plugin-wallet/sign-okx-x402'
import { walletSignTransaction } from '@pieverseio/purr-plugin-wallet/sign-transaction'
import { walletSignTypedData } from '@pieverseio/purr-plugin-wallet/sign-typed-data'
import { walletTransfer } from '@pieverseio/purr-plugin-wallet/transfer'
import { walletUniswap } from '@pieverseio/purr-plugin-wallet/uniswap'
import {
  treasureCodeAttempt,
  treasureCodeFinalUnlock,
  treasureCodeVault,
} from '@pieverseio/purr-plugin-wallet/treasure-code'
import { handleInstanceCommand } from './instance.js'
import { pieTransfer } from './pie.js'
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

async function handleBalancerCommand(
  command: string | undefined,
  args: Record<string, string>,
): Promise<void> {
  if (args.h === 'true' || args.help === 'true') {
    console.log(balancerHelp())
    return
  }
  switch (command) {
    case 'pools':
      await balancerPools(args)
      return
    case 'quote':
      await balancerQuote(args)
      return
    case 'swap':
      await balancerSwap(args)
      return
    case 'add-quote':
      await balancerAddQuote(args)
      return
    case 'add':
      await balancerAdd(args)
      return
    case 'remove-quote':
      await balancerRemoveQuote(args)
      return
    case 'remove':
      await balancerRemove(args)
      return
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(balancerHelp())
      return
    default:
      throw new Error(
        `Unknown balancer command: ${command}. Use: pools, quote, swap, add-quote, add, remove-quote, remove`,
      )
  }
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
        if (next !== undefined && !next.startsWith('--')) {
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

function rejectUnsupportedArgs(
  args: Record<string, string>,
  rawArgs: readonly string[],
  allowedArgs: readonly string[],
  command: string,
): void {
  const allowed = new Set(allowedArgs)
  const unsupported = Object.keys(args)
    .filter((name) => !allowed.has(name))
    .map((name) => `--${name}`)

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (!arg.startsWith('--')) {
      unsupported.push(arg)
      continue
    }

    const raw = arg.slice(2)
    const equalsIndex = raw.indexOf('=')
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw
    if (equalsIndex < 0 && name !== 'execute') {
      const next = rawArgs[index + 1]
      if (next !== undefined && !next.startsWith('-')) index++
    }
  }

  const uniqueUnsupported = [...new Set(unsupported)]
  if (uniqueUnsupported.length > 0) {
    throw new Error(
      `Unsupported argument${uniqueUnsupported.length === 1 ? '' : 's'} for ${command}: ${uniqueUnsupported.join(', ')}`,
    )
  }
}

function optionalJsonArg<T extends Record<string, unknown>>(
  args: Record<string, string>,
  name: string,
  fileName: string,
): T | undefined {
  if (args[name] === undefined && args[fileName] === undefined) {
    return undefined
  }
  return parseJsonCliArg<T>(
    requireArgOrFile(args, name, fileName),
    args[fileName] ? fileName : name,
  )
}

function parseAmountTypeArg(value: string | undefined): 1 | 2 | undefined {
  const parsed = parseIntegerArg(value, 'amount-type')
  if (parsed === undefined) return undefined
  if (parsed !== 1 && parsed !== 2) {
    throw new Error('Invalid --amount-type: expected 1 for fiat amount or 2 for crypto amount')
  }
  return parsed
}

function requireAmountTypeArg(args: Record<string, string>): 1 | 2 {
  return parseAmountTypeArg(requireArg(args, 'amount-type')) as 1 | 2
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

function parseNumberArg(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  const parsed = Number(trimmed)
  if (!trimmed || !Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function requireNumberArg(args: Record<string, string>, name: string): number {
  return parseNumberArg(requireArg(args, name), name) as number
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

function dflowOrderOutput<T extends Record<string, unknown>>(value: T, raw: boolean): T {
  const safeValue: Record<string, unknown> = { ...value }
  if (!raw) delete safeValue.order
  return safeValue as T
}

function rejectLegacyDflowAuthArgs(args: Record<string, string>): void {
  if (args['api-key'] !== undefined) {
    throw new Error(
      '--api-key is no longer supported; DFlow authentication is managed by the platform',
    )
  }
  if (args['base-url'] !== undefined) {
    throw new Error(
      '--base-url is no longer supported; DFlow requests are routed through the platform',
    )
  }
}

function owsBitgetSigner(
  ows: PluginRuntimeMap['ows'],
  args: Record<string, string>,
): BitgetWalletSigner {
  const owsWallet = requireArg(args, 'ows-wallet')
  const owsToken = args['ows-token'] ?? process.env.OWS_PASSPHRASE
  return {
    label: 'OWS wallet',
    supportsRawDigest: false,
    signTransactions: (payload, chainId) =>
      ows.signTransaction(JSON.stringify(payload), chainId, {
        owsWallet,
        owsToken,
      }),
    resolveEvmAddress: async () =>
      ows.address({
        owsWallet,
        chainType: 'ethereum',
      }).address,
  }
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

  if (group === 'deps') {
    await handleDepsCommand(command, rest)
    return
  }

  if (!group || group === '--help' || group === '-h') {
    console.log(`Usage: purr <group> <command> [options]

Groups:
  deps              Install pinned skill CLIs for remote agents (install, list)
  aster             Aster DEX registration + on-chain deposits (ETH, BSC, Arbitrum)
  balancer          Balancer pool discovery, swaps, and V2/V3 liquidity operations
  bitget           Bitget Wallet order, transfer, and EVM x402 execution through platform wallet signing
  binance-onchain-pay  Binance Onchain Pay fiat on-ramp and order APIs
  dflow           DFlow trading, positions, and market data through platform access
  ows-wallet        OWS-backed wallet ops and OWS-scoped Bitget execution
  ows-execute       OWS-local step execution (drop-in for 'execute'; signs + broadcasts locally)
  fourmeme          four.meme BSC flows (login, raised tokens, buy/sell, tax, agent, create-token)
  opensea           OpenSea execution helpers for official OpenSea workflows
  osero             Osero USDS/sUSDS routes through the platform TEE wallet
  predict-fun       Predict.fun market data and trading through the platform TEE wallet
  pancake           PancakeSwap calldata builder (V2/V3 swap, LP, farm, syrup)
  lista             Lista DAO vault calldata builder
  pieverse          Pieverse campaigns and PIEVERSE staking
  pns               Pie Name Service and identity lookup helpers
  .pie              Resolve .pie identities and transfer to their wallets
  wallet            Wallet operations (address, balance, sign, sign-typed-data, sign-okx-x402, sign-transaction, transfer, abi-call, uniswap)
  redpacket         P2P XLayer USDT0 redpackets (send, pending, claim, sent)
  treasure-code     Pieverse Treasure Code game — one command per action (vault, attempt, final-unlock); each owns the full payment-required→sign→submit→poll flow
  instance          Instance status, credits, token renewal, and top-up
  hyperliquid       Hyperliquid account, market data, orders, transfers, deposits, and withdrawals
  lighter           Lighter account, market data, orders, deposits, and withdrawals
  execute           Execute on-chain steps from a JSON file
  evm               EVM primitives (approve, transfer, raw)
  config            Manage persistent credentials (set, get, list)
  version           Print version

Examples:
  purr fourmeme login-challenge --wallet 0x...
  purr fourmeme raised-tokens
  purr wallet sign-transaction --txs-json '{"orderId":"...","txs":[...]}'
  purr fourmeme buy --token 0x... --wallet 0x... --funds 0.1
  purr fourmeme buy-with-bnb --token 0x... --wallet 0x... --funds 0.1 --min-amount 1000
  purr fourmeme sell --token 0x... --wallet 0x... --amount 1000
  purr fourmeme sell-for-bnb --token 0x... --wallet 0x... --amount 1000 --min-funds 0.1
  purr fourmeme agent-wallet --wallet 0x...
  purr fourmeme tax-rewards --token 0x... --wallet 0x...
  purr fourmeme tax-claim --token 0x... --wallet 0x...
  purr fourmeme create-token --wallet 0x... --login-nonce abc --login-signature-file /tmp/fourmeme_login_signature.txt --name "My Token" --symbol MTK --description "..." --label AI --image-url https://example.com/logo.png --raised-token BNB
  purr bitget order-execute --order-id <id> --from-chain bnb --from-contract <token> --from-symbol USDT --from-address 0x... --to-chain bnb --to-contract "" --to-symbol BNB --to-address 0x... --from-amount 5 --slippage 0.03 --market <id> --protocol <id>
  purr bitget transfer-execute --chain base --contract 0x... --from-address 0x... --to-address 0x... --amount 10 --gasless true
  purr bitget x402-pay --url https://api.example.com/premium --method POST --data '{"fileSize":100}'
  purr ows-wallet bitget-order-execute --ows-wallet treasury --order-id <id> --from-chain bnb --from-contract <token> --from-symbol USDT --from-address 0x... --to-chain bnb --to-contract "" --to-symbol BNB --to-address 0x... --from-amount 5 --slippage 0.03 --market <id> --protocol <id>
  purr ows-wallet bitget-transfer-execute --ows-wallet treasury --chain base --contract 0x... --from-address 0x... --to-address 0x... --amount 10
  purr ows-wallet bitget-x402-pay --ows-wallet treasury --url https://api.example.com/premium --method POST --data '{"fileSize":100}'
  purr dflow order --input-mint <mint> --output-mint <mint> --amount <atomic> --params-json '{"slippageBps":"auto"}'
  purr dflow quote --input-mint <mint> --output-mint <mint> --amount <atomic>
  purr dflow execute-order --order-file /tmp/dflow-order.json
  purr dflow prediction-order-status --signature <transaction-signature> --poll true
  purr dflow positions
  purr dflow metadata --path markets --query-json '{"status":"active","limit":10}'
  purr dflow priority-fees
  purr dflow stream --channel prices --tickers KXTEST --max-events 10
  purr dflow stream --channel priority-fees --max-events 3
  purr opensea buy --wallet 0x... --fulfillment-json '{"fulfillment_data":{"transaction":{...}}}'
  purr opensea buy --wallet 0x... --fulfillment-file ./fulfillment.json
  purr opensea sell --wallet 0x... --fulfillment-json '{"fulfillment_data":{"transaction":{...}}}'
  purr opensea sell --wallet 0x... --fulfillment-file ./fulfillment.json
  purr opensea tx --wallet 0x... --chain-id 8453 --tx-json '{"transaction":{"to":"0x...","data":"0x..."}}'
  purr opensea actions --wallet 0x... --chain-id 8453 --actions-file ./opensea-actions.json
  purr opensea sign-order --wallet 0x... --typed-data-file ./seaport-order.json
  purr opensea sign-message --wallet 0x... --message "Sign in with Ethereum..."
  purr opensea sign-payment --wallet 0x... --payment-file ./x402-typed-data.json  # signs payment typed data only
  purr binance-onchain-pay payment-method-list --fiat USD --crypto USDT --total-amount 50 --amount-type 1 --network BSC
  purr binance-onchain-pay p2p-trading-pairs --fiat USD
  purr binance-onchain-pay estimated-quote --fiat USD --crypto USDT --requested-amount 50 --amount-type 1 --pay-method-code BUY_CARD
  purr binance-onchain-pay pre-order --fiat USD --crypto USDT --requested-amount 50 --amount-type 1 --network BSC --address 0x...
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
  purr osero balances --chain base
  purr osero apy --chain base
  purr osero preview --action mint-susds --chain base --amount 1000000
  purr osero execute --action mint-susds --chain base --amount 1000000
  purr predict-fun markets --status OPEN --first 20
  purr predict-fun market-quote --market-id 12345
  purr predict-fun order-preview --market-id 12345 --outcome YES --side BUY --strategy MARKET --spend 1
  purr predict-fun order-execute --preview-id 00000000-0000-4000-8000-000000000000
  purr predict-fun stream --topics orderbook:12345,wallet --max-events 10
  purr pieverse card purchase --partner okx --channel telegram
  purr pieverse card create-job --purchase-id 00000000-0000-0000-0000-000000000000
  purr pieverse card fund --purchase-id 00000000-0000-0000-0000-000000000000
  purr pieverse card deliverable --purchase-id 00000000-0000-0000-0000-000000000000 --wait
  purr pieverse purrfect-yap purchase
  purr pieverse purrfect-yap create-job --purchase-id 00000000-0000-0000-0000-000000000000
  purr pieverse purrfect-yap fund --purchase-id 00000000-0000-0000-0000-000000000000
  purr pieverse purrfect-yap result --purchase-id 00000000-0000-0000-0000-000000000000 --wait
  purr pieverse staking contracts
  purr pieverse staking positions --chain-id 1
  purr pieverse staking stake --amount-wei 1000000000000000000 --duration 90d --chain-id 1 --execute
  purr pieverse staking withdraw --stake-id 0 --chain-id 1 --execute
  purr pieverse staking withdraw-batch --stake-ids 0,1 --chain-id 56 --execute
  purr pns resolve alice
  purr pns by-account --channel telegram --account @alice
  purr pns accounts alice.pie
  purr pns profile alice.pie
  purr .pie transfer --pie alice.pie --amount 0.01 --chain-id 56
  purr .pie transfer --channel telegram --account @alice --amount 0.01 --chain-id 56
  purr .pie transfer --channel line --account line-user --amount 100 --chain-id 56 --token USDT
  purr ows-wallet sign-transaction --ows-wallet treasury --txs-json-file /tmp/order.json
  OWS_PASSPHRASE=ows_key_... purr ows-wallet sign-transaction --ows-wallet treasury --txs-json-file /tmp/order.json
  purr ows-execute --steps-file /tmp/steps.json --ows-wallet treasury
  OWS_PASSPHRASE=ows_key_... purr ows-execute --steps-file /tmp/steps.json --ows-wallet treasury --rpc-url https://...
  purr ows-wallet build-transfer --ows-wallet treasury --to 0x... --amount 0.01 --chain-id 56
  purr ows-wallet build-transfer --ows-wallet treasury --to 0x... --amount 10 --chain-id 56 --token 0x<erc20-contract>
  # then: ows sign send-tx --chain eip155:56 --wallet treasury --tx <unsignedTxHex from above>
  purr aster api --endpoint /fapi/v3/balance --user 0x...
  purr aster api --method POST --endpoint /fapi/v3/order --user 0x... --symbol BTCUSDT --side BUY --type LIMIT --quantity 0.001 --price 50000 --timeInForce GTC
  purr aster deposit --token 0x... --amount-wei 1000 --wallet 0x... --chain-id 56
  purr wallet address --chain-type ethereum
  purr wallet balance --chain-type ethereum --chain-id 56
  purr wallet balance --token 0x55d3...7955 --chain-id 56
  purr wallet balance --chain robinhood --token USDG
  purr wallet uniswap --from ETH --to SPCX --amount 0.003 --chain robinhood
  purr wallet uniswap --from ETH --to SPCX --amount 0.003 --chain robinhood --execute
  purr balancer pools --chain base --tokens WETH,USDC --protocol-version 3
  purr balancer quote --chain base --from ETH --to USDC --amount 0.001 --kind exact-in
  purr balancer swap --chain base --from ETH --to USDC --amount 0.001 --min-amount-out <raw> --execute
  purr redpacket send --recipient alice.pie --amount 0.1
  purr redpacket pending --sender bob.pie
  purr redpacket claim
  purr redpacket sent --limit 20 --offset 0
  purr instance status
  purr instance credits
  purr hyperliquid account
  purr hyperliquid status
  purr hyperliquid enable
  purr hyperliquid snapshot
  purr hyperliquid symbol --coin CXMT
  purr hyperliquid order --body-file ./hyperliquid-order.json
  purr hyperliquid deposit --amount 5
  purr lighter status
  purr lighter account
  purr lighter deposit-networks
  purr lighter order --market-id 0 --side buy --size 0.01 --price 3000
  purr lighter deposit --amount 5 --source-chain-id 8453
  purr instance payment-methods
  purr instance renew --token usdt-bsc --yes
  purr instance renew --token usdc-xlayer --yes
  purr instance topup --credits 100 --token USDT --yes
  purr instance topup --credits 100 --token usdc-monad --yes
  purr wallet sign --address 0x... --message "Hello"
  purr wallet sign-typed-data --address 0x... --data '{"domain":...,"types":...,"primaryType":"...","message":...}'
  purr wallet sign-okx-x402 --expected '{"amountBaseUnits":"1","chainId":196,"tokenAddress":"0x779ded...","payTo":"0x..."}'
  purr treasure-code vault
  purr treasure-code attempt
  purr treasure-code attempt --guess crocodile
  purr treasure-code final-unlock --words-file /tmp/words.json
  purr wallet transfer --to 0x... --amount 0.01 --chain-id 56
  purr wallet transfer --to 0x... --amount 1000 --chain-id 56 --token 0x55d3...7955
  purr wallet transfer --to 0x... --amount 100 --chain robinhood --token USDG
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
  let stakingDisplayChainId: number | undefined

  switch (group) {
    case 'instance': {
      await handleInstanceCommand(command, args)
      return
    }

    case 'hyperliquid': {
      if (!command || command === 'help' || command === '--help' || command === '-h') {
        console.log(hyperliquidHelp())
        return
      }
      await hyperliquidCommand(command, args)
      return
    }

    case 'lighter': {
      if (!command || command === 'help' || command === '--help' || command === '-h') {
        console.log(lighterHelp())
        return
      }
      await lighterCommand(command, args)
      return
    }

    case 'osero': {
      if (!command || command === 'help' || command === '--help' || command === '-h') {
        console.log(oseroHelp())
        return
      }
      await oseroCommand(command, args)
      return
    }

    case 'predict-fun': {
      if (!command || command === 'help' || command === '--help' || command === '-h') {
        console.log(predictHelp())
        return
      }
      await predictCommand(command, args, rest)
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
      if (command === 'bitget-order-execute') {
        const makeOrderJson =
          args['make-order-json'] !== undefined || args['make-order-file'] !== undefined
            ? requireArgOrFile(args, 'make-order-json', 'make-order-file')
            : undefined
        const result = await bitgetOrderExecute({
          orderId: args['order-id'],
          fromChain: args['from-chain'],
          fromContract: args['from-contract'],
          fromSymbol: args['from-symbol'],
          fromAddress: requireArg(args, 'from-address'),
          toChain: args['to-chain'],
          toContract: args['to-contract'],
          toSymbol: args['to-symbol'],
          toAddress: args['to-address'],
          fromAmount: args['from-amount'],
          slippage: args.slippage,
          market: args.market,
          protocol: args.protocol,
          source: args.source,
          chainId: parseIntegerArg(args['chain-id'], 'chain-id'),
          makeOrderJson,
          raw: parseBooleanFlag(args.raw),
          signer: owsBitgetSigner(ows, args),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (command === 'bitget-transfer-execute') {
        const transferOrderJson =
          args['transfer-order-json'] !== undefined || args['transfer-order-file'] !== undefined
            ? requireArgOrFile(args, 'transfer-order-json', 'transfer-order-file')
            : undefined
        const result = await bitgetTransferExecute({
          chain: args.chain,
          contract: args.contract,
          fromAddress: requireArg(args, 'from-address'),
          toAddress: args['to-address'],
          amount: args.amount,
          memo: args.memo,
          gasless: parseBooleanFlag(args.gasless),
          gaslessPayToken: args['gasless-pay-token'],
          override7702: parseBooleanFlag(args['override-7702']),
          chainId: parseIntegerArg(args['chain-id'], 'chain-id'),
          transferOrderJson,
          raw: parseBooleanFlag(args.raw),
          signer: owsBitgetSigner(ows, args),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (command === 'bitget-x402-sign-eip3009') {
        const result = await bitgetX402SignEip3009({
          token: requireArg(args, 'token'),
          chainId: parseChainId(requireArg(args, 'chain-id')),
          to: requireArg(args, 'to'),
          amount: requireArg(args, 'amount'),
          fromAddress: args['from-address'],
          tokenName: args['token-name'],
          tokenVersion: args['token-version'],
          maxTimeoutSeconds: parseIntegerArg(args['max-timeout'], 'max-timeout'),
          signer: owsBitgetSigner(ows, args),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (command === 'bitget-x402-pay') {
        const data =
          args.data !== undefined || args['data-file'] !== undefined
            ? requireArgOrFile(args, 'data', 'data-file')
            : undefined
        const result = await bitgetX402Pay({
          url: requireArg(args, 'url'),
          method: args.method,
          data,
          chainId: args['chain-id'] ? parseChainId(args['chain-id']) : undefined,
          fromAddress: args['from-address'],
          maxAmountBaseUnits: args['max-amount-base-units'],
          responseTextLimit: parseIntegerArg(args['response-text-limit'], 'response-text-limit'),
          tokenName: args['token-name'],
          tokenVersion: args['token-version'],
          signer: owsBitgetSigner(ows, args),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }
      throw new Error(
        `Unknown ows-wallet command: ${command}. Use: sign-transaction, build-transfer, bitget-order-execute, bitget-transfer-execute, bitget-x402-sign-eip3009, bitget-x402-pay`,
      )
    }

    case 'aster': {
      if (command === 'api') {
        const reserved = new Set([
          'method',
          'endpoint',
          'user',
          'private-key',
          'signer',
          'base-url',
        ])
        const apiParams: Record<string, string> = {}
        for (const [k, v] of Object.entries(args)) {
          if (!reserved.has(k)) apiParams[k] = v
        }
        const result = await asterApi({
          method: args.method ?? 'GET',
          endpoint: requireArg(args, 'endpoint'),
          user: requireArg(args, 'user'),
          privateKey: args['private-key'],
          signer: args.signer,
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

    case 'bitget': {
      switch (command) {
        case 'order-execute': {
          const makeOrderJson =
            args['make-order-json'] !== undefined || args['make-order-file'] !== undefined
              ? requireArgOrFile(args, 'make-order-json', 'make-order-file')
              : undefined
          const result = await bitgetOrderExecute({
            orderId: args['order-id'],
            fromChain: args['from-chain'],
            fromContract: args['from-contract'],
            fromSymbol: args['from-symbol'],
            fromAddress: args['from-address'],
            toChain: args['to-chain'],
            toContract: args['to-contract'],
            toSymbol: args['to-symbol'],
            toAddress: args['to-address'],
            fromAmount: args['from-amount'],
            slippage: args.slippage,
            market: args.market,
            protocol: args.protocol,
            source: args.source,
            chainId: parseIntegerArg(args['chain-id'], 'chain-id'),
            makeOrderJson,
            raw: parseBooleanFlag(args.raw),
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'transfer-execute': {
          const transferOrderJson =
            args['transfer-order-json'] !== undefined || args['transfer-order-file'] !== undefined
              ? requireArgOrFile(args, 'transfer-order-json', 'transfer-order-file')
              : undefined
          const result = await bitgetTransferExecute({
            chain: args.chain,
            contract: args.contract,
            fromAddress: args['from-address'],
            toAddress: args['to-address'],
            amount: args.amount,
            memo: args.memo,
            gasless: parseBooleanFlag(args.gasless),
            gaslessPayToken: args['gasless-pay-token'],
            override7702: parseBooleanFlag(args['override-7702']),
            chainId: parseIntegerArg(args['chain-id'], 'chain-id'),
            transferOrderJson,
            raw: parseBooleanFlag(args.raw),
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'x402-sign-eip3009': {
          const result = await bitgetX402SignEip3009({
            token: requireArg(args, 'token'),
            chainId: parseChainId(requireArg(args, 'chain-id')),
            to: requireArg(args, 'to'),
            amount: requireArg(args, 'amount'),
            tokenName: args['token-name'],
            tokenVersion: args['token-version'],
            maxTimeoutSeconds: parseIntegerArg(args['max-timeout'], 'max-timeout'),
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'x402-sign-solana':
          throw new Error(
            'Bitget Solana x402 signing is out of scope because it requires partial signing',
          )
        case 'x402-pay': {
          const data =
            args.data !== undefined || args['data-file'] !== undefined
              ? requireArgOrFile(args, 'data', 'data-file')
              : undefined
          const result = await bitgetX402Pay({
            url: requireArg(args, 'url'),
            method: args.method,
            data,
            chainId: args['chain-id'] ? parseChainId(args['chain-id']) : undefined,
            maxAmountBaseUnits: args['max-amount-base-units'],
            responseTextLimit: parseIntegerArg(args['response-text-limit'], 'response-text-limit'),
            tokenName: args['token-name'],
            tokenVersion: args['token-version'],
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        default:
          throw new Error(
            `Unknown bitget command: ${command}. Use: order-execute, transfer-execute, x402-sign-eip3009, x402-pay`,
          )
      }
    }

    case 'dflow': {
      rejectLegacyDflowAuthArgs(args)
      switch (command) {
        case 'quote': {
          const paramsJson =
            args['params-json'] !== undefined || args['params-file'] !== undefined
              ? requireArgOrFile(args, 'params-json', 'params-file')
              : undefined
          const raw = parseBooleanFlag(args.raw) === true
          const result = await dflowQuote({
            inputMint: args['input-mint'],
            outputMint: args['output-mint'],
            amount: args.amount,
            paramsJson,
            raw,
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'order': {
          const paramsJson =
            args['params-json'] !== undefined || args['params-file'] !== undefined
              ? requireArgOrFile(args, 'params-json', 'params-file')
              : undefined
          const raw = parseBooleanFlag(args.raw) === true
          const result = await dflowOrder({
            inputMint: args['input-mint'],
            outputMint: args['output-mint'],
            amount: args.amount,
            paramsJson,
            raw,
          })
          if (parseBooleanFlag(args.execute) === true) {
            const safeResult = dflowOrderOutput(result, raw)
            const executed = await dflowExecuteOrder({
              orderJson: JSON.stringify(result.order),
              rpcUrl: args['rpc-url'],
              poll: parseBooleanFlag(args.poll),
              pollTimeoutMs: parseIntegerArg(args['poll-timeout-ms'], 'poll-timeout-ms'),
              pollIntervalMs: parseIntegerArg(args['poll-interval-ms'], 'poll-interval-ms'),
              raw,
            })
            console.log(JSON.stringify({ ...safeResult, execution: executed }, null, 2))
            return
          }
          console.log(JSON.stringify(dflowOrderOutput(result, raw), null, 2))
          return
        }
        case 'execute-order': {
          const orderJson = requireArgOrFile(args, 'order-json', 'order-file')
          const result = await dflowExecuteOrder({
            orderJson,
            rpcUrl: args['rpc-url'],
            poll: parseBooleanFlag(args.poll),
            pollTimeoutMs: parseIntegerArg(args['poll-timeout-ms'], 'poll-timeout-ms'),
            pollIntervalMs: parseIntegerArg(args['poll-interval-ms'], 'poll-interval-ms'),
            raw: parseBooleanFlag(args.raw),
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'prediction-order-status': {
          const result = await dflowPredictionOrderStatus({
            signature: args.signature,
            lastValidBlockHeight: args['last-valid-block-height'],
            poll: parseBooleanFlag(args.poll),
            timeoutMs: parseIntegerArg(args['timeout-ms'], 'timeout-ms'),
            intervalMs: parseIntegerArg(args['interval-ms'], 'interval-ms'),
            raw: parseBooleanFlag(args.raw),
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'positions': {
          console.log(JSON.stringify(await dflowPositions(), null, 2))
          return
        }
        case 'priority-fees': {
          console.log(JSON.stringify(await dflowPriorityFees(), null, 2))
          return
        }
        case 'metadata': {
          const queryJson =
            args['query-json'] !== undefined || args['query-file'] !== undefined
              ? requireArgOrFile(args, 'query-json', 'query-file')
              : undefined
          const bodyJson =
            args['body-json'] !== undefined || args['body-file'] !== undefined
              ? requireArgOrFile(args, 'body-json', 'body-file')
              : undefined
          const result = await dflowMetadata({ path: args.path, queryJson, bodyJson })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'stream': {
          const result = await dflowStream({
            channel: args.channel,
            tickers: args.tickers,
            all: parseBooleanFlag(args.all),
            maxEvents: parseIntegerArg(args['max-events'], 'max-events'),
            timeoutMs: parseIntegerArg(args['timeout-ms'], 'timeout-ms'),
            onMessage: (message) => {
              console.log(JSON.stringify({ type: 'dflow-stream-event', data: message }))
            },
          })
          console.log(JSON.stringify(result))
          return
        }
        default:
          throw new Error(
            `Unknown dflow command: ${command}. Use: quote, order, execute-order, prediction-order-status, positions, priority-fees, metadata, stream`,
          )
      }
    }

    // login-challenge returns non-StepOutput JSON — early return like binance-onchain-pay
    case 'fourmeme': {
      if (command === 'login-challenge') {
        const challenge = await buildFourMemeLoginChallenge({
          wallet: requireArg(args, 'wallet'),
        })
        console.log(JSON.stringify(challenge))
        return
      }
      if (command === 'raised-tokens') {
        const configs = await getFourMemeRaisedTokenConfigs()
        console.log(JSON.stringify(configs, null, 2))
        return
      }
      if (command === 'agent-wallet') {
        const status = await getFourMemeAgentWalletStatus({
          wallet: requireArg(args, 'wallet'),
        })
        console.log(JSON.stringify(status, null, 2))
        return
      }
      if (command === 'tax-rewards') {
        const rewards = await getFourMemeTaxRewards({
          token: resolveToken(requireArg(args, 'token'), 56),
          wallet: requireArg(args, 'wallet'),
        })
        console.log(JSON.stringify(rewards, null, 2))
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
        case 'buy-with-bnb':
          output = await buildFourMemeBuyWithBnbSteps({
            token: resolveToken(requireArg(args, 'token'), 56),
            wallet: requireArg(args, 'wallet'),
            funds: requireArg(args, 'funds'),
            minAmount: requireArg(args, 'min-amount'),
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
        case 'sell-for-bnb':
          output = await buildFourMemeSellForBnbSteps({
            token: resolveToken(requireArg(args, 'token'), 56),
            wallet: requireArg(args, 'wallet'),
            amount: requireArg(args, 'amount'),
            minFunds: requireArg(args, 'min-funds'),
            to: args.to,
            feeRate: parseIntegerArg(args['fee-rate'], 'fee-rate'),
            feeRecipient: args['fee-recipient'],
          })
          break
        case 'tax-claim':
          output = buildFourMemeTaxClaimSteps({
            token: resolveToken(requireArg(args, 'token'), 56),
            wallet: requireArg(args, 'wallet'),
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
            raisedToken: args['raised-token'],
          })
          break
        default:
          throw new Error(
            `Unknown fourmeme command: ${command}. Use: login-challenge, raised-tokens, buy, buy-with-bnb, sell, sell-for-bnb, create-token, agent-wallet, tax-rewards, tax-claim`,
          )
      }
      break
    }

    // Binance Onchain Pay returns raw API JSON, not StepOutput — early return
    case 'binance-onchain-pay': {
      let result: unknown
      switch (command) {
        case 'trading-pairs':
          result = await getTradingPairs()
          break
        case 'crypto-network':
          result = await getNetworks()
          break
        case 'p2p-trading-pairs':
          result = await getP2PTradingPairs({
            fiatCurrency: args.fiat,
          })
          break
        case 'payment-method-list':
          result = await getPaymentMethods({
            fiatCurrency: args.fiat,
            cryptoCurrency: args.crypto,
            totalAmount: parseNumberArg(args['total-amount'], 'total-amount'),
            amountType: parseAmountTypeArg(args['amount-type']),
            network: args.network,
            contractAddress: args['contract-address'],
            lang: args.lang,
          })
          break
        case 'estimated-quote':
          result = await getQuote({
            fiatCurrency: requireArg(args, 'fiat'),
            requestedAmount: requireNumberArg(args, 'requested-amount'),
            payMethodCode: requireArg(args, 'pay-method-code'),
            amountType: requireAmountTypeArg(args),
            cryptoCurrency: args.crypto,
            network: args.network,
            address: args.address,
            contractAddress: args['contract-address'],
          })
          break
        case 'pre-order':
          if (args['external-order-id'] !== undefined || args.ts !== undefined) {
            throw new Error(
              'Pre-order externalOrderId and timestamp are platform-managed; use --idempotency-key for safe retries',
            )
          }
          if (args['merchant-code'] !== undefined || args['merchant-name'] !== undefined) {
            throw new Error(
              'Pre-order merchant identity is derived from the platform Binance account; remove --merchant-code and --merchant-name',
            )
          }
          result = await createOrder({
            idempotencyKey: args['idempotency-key'],
            fiatCurrency: args.fiat,
            fiatAmount: parseNumberArg(args['fiat-amount'], 'fiat-amount'),
            cryptoCurrency: args.crypto,
            requestedAmount: parseNumberArg(args['requested-amount'], 'requested-amount'),
            amountType: parseAmountTypeArg(args['amount-type']),
            address: args.address,
            network: args.network,
            payMethodCode: args['pay-method-code'],
            payMethodSubCode: args['pay-method-sub-code'],
            redirectUrl: args['redirect-url'],
            failRedirectUrl: args['fail-redirect-url'],
            redirectDeepLink: args['redirect-deep-link'],
            failRedirectDeepLink: args['fail-redirect-deep-link'],
            contractAddress: args['contract-address'],
            customization: optionalJsonArg(args, 'customization-json', 'customization-file'),
            destContractAddress: args['dest-contract-address'],
            destContractABI: args['dest-contract-abi'],
            destContractParams: optionalJsonArg(
              args,
              'dest-contract-params-json',
              'dest-contract-params-file',
            ),
            affiliateCode: args['affiliate-code'],
            gtrTemplateCode: args['gtr-template-code'],
          })
          break
        case 'order':
          result = await queryOrder(requireArg(args, 'external-order-id'))
          break
        default:
          throw new Error(
            `Unknown binance-onchain-pay command: ${command}. Use: trading-pairs, crypto-network, p2p-trading-pairs, payment-method-list, estimated-quote, pre-order, order`,
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
        case 'tx':
          output = buildOpenSeaTransactionSteps({
            wallet: requireArg(args, 'wallet'),
            transaction: parseOpenSeaTransactionInput(args),
            chainId: args['chain-id'] ? parseChainId(args['chain-id']) : undefined,
            label: args.label,
          })
          break
        case 'actions':
          output = buildOpenSeaActionSteps({
            wallet: requireArg(args, 'wallet'),
            actions: parseOpenSeaActionsInput(args),
            chainId: args['chain-id'] ? parseChainId(args['chain-id']) : undefined,
          })
          break
        case 'sign-order': {
          const result = await signOpenSeaTypedData({
            wallet: requireArg(args, 'wallet'),
            typedData: parseOpenSeaTypedDataInput(args),
            purpose: 'order',
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'sign-payment': {
          const result = await signOpenSeaTypedData({
            wallet: requireArg(args, 'wallet'),
            typedData: parseOpenSeaPaymentInput(args),
            purpose: 'payment',
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        case 'sign-message': {
          const result = await signOpenSeaMessage({
            wallet: requireArg(args, 'wallet'),
            message: parseOpenSeaMessageInput(args),
            chainId: args['chain-id'] ? parseChainId(args['chain-id']) : undefined,
            chainType: args['chain-type'],
          })
          console.log(JSON.stringify(result, null, 2))
          return
        }
        default:
          throw new Error(
            `Unknown opensea command: ${command}. Use: buy, sell, tx, actions, sign-order, sign-message, sign-payment`,
          )
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

    case 'pieverse': {
      switch (command) {
        case 'card': {
          const [cardCommand, ...cardRest] = rest
          await pieverseCard(cardCommand, parseArgs(cardRest))
          return
        }
        case 'purrfect-yap': {
          const [purrfectYapCommand, ...purrfectYapRest] = rest
          await pieversePurrfectYap(purrfectYapCommand, parseArgs(purrfectYapRest))
          return
        }
        case 'staking': {
          const [stakingCommand, ...stakingRest] = rest
          const stakingArgs = parseArgs(stakingRest)

          if (
            stakingCommand === undefined ||
            stakingCommand === 'help' ||
            stakingCommand === '--help' ||
            stakingCommand === '-h'
          ) {
            console.log(`Usage: purr pieverse staking <command> [options]

Commands:
  contracts       List configured PIEVERSE token and staking contracts
  positions       Read the configured agent wallet's PIEVERSE balance and open stakes
  stake           Approve PIEVERSE when needed, then create a fixed-term stake
  withdraw        Withdraw one matured stake
  withdraw-batch  Atomically withdraw multiple matured stakes

Supported chains:
  1   Ethereum
  56  BNB Chain

Staking durations:
  90d | 180d | 365d

Stake amounts:
  At most 2 decimal places; minimum increment 0.01 PIEVERSE.
  Pass the exact 18-decimal value with --amount-wei.

Execution:
  Omit --execute to print portable steps JSON.
  Add --execute to submit the steps through the configured agent wallet.`)
            return
          }

          const allowedArgsByCommand: Record<string, readonly string[]> = {
            contracts: ['chain-id'],
            positions: ['chain-id'],
            stake: ['amount-wei', 'duration', 'chain-id', 'execute'],
            withdraw: ['stake-id', 'chain-id', 'execute'],
            'withdraw-batch': ['stake-ids', 'chain-id', 'execute'],
          }
          const allowedArgs = allowedArgsByCommand[stakingCommand]
          if (allowedArgs) {
            rejectUnsupportedArgs(
              stakingArgs,
              stakingRest,
              allowedArgs,
              `purr pieverse staking ${stakingCommand}`,
            )
          }

          if (stakingCommand === 'contracts') {
            const deployments = stakingArgs['chain-id']
              ? [getPieverseStakingDeployment(parseChainId(stakingArgs['chain-id']))]
              : listPieverseStakingDeployments()
            const result = deployments.map(({ chainId, pieverse, staking, durations }) => ({
              chainId,
              pieverse,
              staking,
              durations,
            }))
            console.log(JSON.stringify(result))
            return
          }

          const chainId = parseChainId(requireArg(stakingArgs, 'chain-id'))
          const deployment = getPieverseStakingDeployment(chainId)
          if (stakingCommand === 'positions') {
            const result = await readPieverseStakingPositions({ chainId: deployment.chainId })
            console.log(JSON.stringify(result))
            return
          }

          switch (stakingCommand) {
            case 'stake':
              stakingDisplayChainId = chainId
              output = buildPieverseStakeSteps({
                amountWei: requireArg(stakingArgs, 'amount-wei'),
                duration: requireArg(stakingArgs, 'duration'),
                chainId,
              })
              break
            case 'withdraw':
              stakingDisplayChainId = chainId
              output = buildPieverseWithdrawSteps({
                stakeId: requireArg(stakingArgs, 'stake-id'),
                chainId,
              })
              break
            case 'withdraw-batch':
              stakingDisplayChainId = chainId
              output = buildPieverseWithdrawBatchSteps({
                stakeIds: requireArg(stakingArgs, 'stake-ids'),
                chainId,
              })
              break
            default:
              throw new Error(
                `Unknown pieverse staking command: ${stakingCommand}. Use: contracts, positions, stake, withdraw, withdraw-batch`,
              )
          }
          break
        }
        default:
          throw new Error(`Unknown pieverse command: ${command}. Use: card, purrfect-yap, staking`)
      }
      break
    }

    case 'pns': {
      switch (command) {
        case 'resolve':
          if (rest.length !== 1 || rest[0].startsWith('--')) {
            throw new Error('Usage: purr pns resolve <handle>')
          }
          await pnsResolve(rest[0])
          return
        case 'by-account':
          await pnsByAccount(parseArgs(rest))
          return
        case 'accounts':
          if (rest.length !== 1 || rest[0].startsWith('--')) {
            throw new Error('Usage: purr pns accounts <handle>')
          }
          await pnsAccounts(rest[0])
          return
        case 'profile':
          if (rest.length !== 1 || rest[0].startsWith('--')) {
            throw new Error('Usage: purr pns profile <handle>')
          }
          await pnsProfile(rest[0])
          return
        default:
          throw new Error(
            `Unknown pns command: ${command}. Use: resolve, by-account, accounts, profile`,
          )
      }
    }

    case '.pie': {
      switch (command) {
        case 'transfer':
          await pieTransfer(args)
          return
        default:
          throw new Error(`Unknown .pie command: ${command}. Use: transfer`)
      }
    }

    case 'balancer': {
      await handleBalancerCommand(command, args)
      return
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
        case 'sign-okx-x402':
          await walletSignOkxX402(args)
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
        case 'uniswap':
          await walletUniswap(args)
          return
        case 'abi-call':
          await walletAbiCall(args)
          return
        default:
          throw new Error(
            `Unknown wallet command: ${command}. Use: address, balance, sign, sign-typed-data, sign-okx-x402, sign-transaction, transfer, abi-call, uniswap`,
          )
      }
    }

    case 'redpacket': {
      switch (command) {
        case 'send':
          await redpacketSend(args)
          return
        case 'pending':
          await redpacketPending(args)
          return
        case 'claim':
          await redpacketClaim(args)
          return
        case 'sent':
          await redpacketSent(args)
          return
        default:
          throw new Error(`Unknown redpacket command: ${command}. Use: send, pending, claim, sent`)
      }
    }

    case 'treasure-code': {
      switch (command) {
        case 'vault':
          await treasureCodeVault()
          return
        case 'attempt':
          await treasureCodeAttempt(args)
          return
        case 'final-unlock':
          await treasureCodeFinalUnlock(args)
          return
        default:
          throw new Error(
            `Unknown treasure-code command: ${command}. Use: vault, attempt, final-unlock`,
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
        `Unknown group: ${group}. Use: aster, binance-onchain-pay, ows-wallet, ows-execute, fourmeme, opensea, osero, predict-fun, pancake, lista, pieverse, pns, .pie, evm, wallet, redpacket, treasure-code, instance, hyperliquid, lighter, execute, config, version, store`,
      )
  }

  if (executeFlag) {
    if (
      group === 'opensea' &&
      command === 'actions' &&
      output &&
      'signatureRequests' in output &&
      Array.isArray(output.signatureRequests) &&
      output.signatureRequests.length > 0
    ) {
      throw new Error(
        'OpenSea actions include signature requests; refusing --execute to avoid partially executing only transaction steps. Sign the returned typed-data/message requests first.',
      )
    }
    if (group === 'opensea' && args.wallet && output && Array.isArray(output.steps)) {
      await ensureOpenSeaExecutionWalletMatches(args.wallet, output.steps)
    }
    const json = JSON.stringify(output)
    const result = await executeStepsFromJson(json, args['dedup-key'])
    const displayedResult =
      stakingDisplayChainId === undefined ? result : { ...result, chainId: stakingDisplayChainId }
    console.log(JSON.stringify(displayedResult, null, 2))
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
  if (err instanceof HyperliquidCliError) {
    const prefix = err.code ? `error [${err.code}]` : 'error'
    console.error(`${prefix}: ${err.message}`)
    if (err.data !== undefined) console.error(JSON.stringify(err.data, null, 2))
    process.exit(err.exitCode)
  }
  if (err instanceof LighterCliError) {
    const prefix = err.code ? `error [${err.code}]` : 'error'
    console.error(`${prefix}: ${err.message}`)
    if (err.data !== undefined) console.error(JSON.stringify(err.data, null, 2))
    process.exit(err.exitCode)
  }
  if (err instanceof OseroCliError) {
    const prefix = err.code ? `error [${err.code}]` : 'error'
    console.error(`${prefix}: ${err.message}`)
    if (err.data !== undefined) console.error(JSON.stringify(err.data, null, 2))
    process.exit(err.exitCode)
  }
  if (err instanceof PredictCliError) {
    const prefix = err.code ? `error [${err.code}]` : 'error'
    console.error(`${prefix}: ${err.message}`)
    if (err.data !== undefined) console.error(JSON.stringify(err.data, null, 2))
    process.exit(err.exitCode)
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
