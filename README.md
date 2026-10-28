# purr-cli

Calldata builder and managed-wallet CLI for Pieverse agent workflows. It can build portable `TxStep[]` JSON for EVM protocols, execute steps through a configured Purrfect Claw instance, operate managed wallets, and browse/install skills from the Pieverse and OKX skill stores.

## Install From GitHub Release

Linux/macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.ps1 | iex
```

Pin a version by setting `PURR_VERSION`, for example `v0.2.32`.

## Development Install

```bash
bun install
```

## Build

```bash
bun run build
```

## Usage

```bash
purr <group> <command> [options]
```

### Groups

| Group | Description |
|-------|-------------|
| `aster` | Aster DEX API signing and on-chain deposits |
| `bitget` | Bitget Wallet order, transfer, and EVM x402 execution through platform wallet signing |
| `binance-onchain-pay` | Binance Onchain Pay payment methods, quotes, networks, orders, and order status through the instance-scoped platform broker |
| `fourmeme` | four.meme BSC login, raised tokens, buy/sell, tax, agent, and token creation flows |
| `opensea` | OpenSea buy and sell execution helpers |
| `osero` | Osero USDS/sUSDS balances, yield reads, previews, plans, and execution |
| `predict-fun` | Predict.fun market discovery, account data, orders, approvals, position actions, and streaming through the platform TEE wallet |
| `pancake` | PancakeSwap API quotes/swaps and LP, farm, syrup, mint, increase/decrease, collect, stake, unstake, and harvest builders |
| `lista` | Lista DAO vault listing, deposit, redeem, and withdraw builders |
| `pieverse` | Pieverse campaign flows and PIEVERSE staking on Ethereum and BNB Chain |
| `hyperliquid` | Hyperliquid account, market data, orders, transfers, deposits, and withdrawals through the platform TEE wallet |
| `injective` | Injective market/account reads, native perpetual/Spot orders and RFQ through the platform backend |
| `pns` | Resolve Pie Name Service handles to instance wallet addresses |
| `wallet` | Platform managed-wallet address, balance, sign, sign-typed-data, sign-okx-x402, sign-transaction, transfer, abi-call, Robinhood/Arc/Soneium Uniswap, and Sui (transfer, Cetus swap, execute) operations |
| `ows-wallet` | OWS-backed local custody sign-transaction and build-transfer helpers; not available in the Windows build |
| `ows-execute` | OWS-backed local step execution; not available in the Windows build |
| `execute` | Execute `TxStep[]` JSON from a file through the configured instance wallet |
| `evm` | Local EVM primitive builders: approve, transfer, raw, and abi-call |
| `instance` | Instance billing status and trusted-wallet renewal |
| `agentkey` | Dynamic live-data tool discovery, schemas, single-call execution, and AI Credit receipts through the platform |
| `store` | Browse and install agent skills from Pieverse + OKX stores |
| `config` | Manage persistent `api-url`, `api-token`, and `instance-id` credentials |
| `version` | Print the CLI version |

### Examples

#### Injective reads

Run `purr injective --help` to check whether the installed CLI supports these
commands. Public market queries require `WALLET_API_URL` and `WALLET_API_TOKEN`
(or their `purr config` equivalents); owned account reads also require `INSTANCE_ID`.
Every request is a backend GET. Account identity comes from the instance's managed
wallet and default subaccount on Injective mainnet; addresses, subaccounts and
networks cannot be overridden. These GET commands need no INJ gas. The candidate
trading commands below use the same backend and require an enabled, qualified
backend; account read availability does not authorize trading.

```bash
purr injective status
purr injective account
purr injective balances
purr injective positions --limit 50
purr injective markets --market-type all
# Use the complete native hash returned by markets, with its exact product.
purr injective market --market-id "$MARKET_HASH" --market-type perp
purr injective order-book-depth --market-id "$MARKET_HASH" --market-type perp --limit 20
purr injective recent-trades --market-id "$MARKET_HASH" --market-type perp --limit 50
purr injective candles --market-id "$MARKET_HASH" --market-type perp --resolution 1h --start-at 2026-10-01T00:00:00Z --end-at 2026-10-02T00:00:00Z
purr injective orders --market-type perp --limit 50
purr injective order-history --market-type spot --limit 50
purr injective fills --market-type perp --cursor "$NEXT_CURSOR"
```

Native hashes and product identify markets; identical tickers never select a
market. Public depth, trades and candles first resolve this exact identity in the
backend catalog, then use its base and instrument ID. JSON preserves decimal
strings, denoms, null/unavailable components, freshness, source and coverage.
`market` returns the catalog envelope with only the exact matching row; `markets`
retains the full catalog envelope. Account replies unwrap only the outer
`{ok,data}` API envelope.

Limits are 1–100 (book defaults to 20; trades and account pages to 50). Positions
are perpetuals only. Orders, order history and fills require `--market-type` and
accept an optional native `--market-id`. Positions also accept these filters,
with `--market-type perp` optional. Pass `nextCursor` unchanged with the same
instance, wallet generation, product, market and time filters; the backend rejects
stale or mismatched cursors. History defaults to a fixed last seven days on the
backend; explicit `--start-at`/`--end-at` must be paired RFC3339 timestamps spanning
at most 31 days. Unknown flags, duplicate flags and positional extras fail before
network access.

Candles support `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, with at most 1500
timeframe buckets per command. The CLI derives a bounded backend `limit` and
exclusive `to`, then filters candle openings to `[start-at,end-at)`. Server source,
requested range, next cursor and history coverage metadata remain unchanged;
missing bars never prove that no trades occurred.

Failures exit nonzero with `error [CODE]: message` on stderr and JSON details when
provided. HTTP 429 preserves `retryAfter` and backend retry metadata without
automatic retries. A missing route on an older backend reports
`INJECTIVE_CAPABILITY_UNAVAILABLE` with upgrade guidance. Upstream failures and
unknown markets are errors rather than empty collections. The status/account
commands validate the capability field types and preserve the backend values.
#### Injective native trading candidate

This source candidate collects Phase3–6 commands for one later PURR release,
with later Spot commands behind their separate backend capability.
It does not publish a binary, update a version/tag or activate a backend. Native
execution remains disabled until backend acceptance. The existing Agent wallet
pays INJ gas; the CLI never uses a sponsored Gateway or directly signs/broadcasts.

Use `purr injective --help` for exact flags. `order`, `cancel`, `close`,
`protection`, `replace`, `cancel-batch`, `margin`, `rfq setup`, `rfq revoke` and
`rfq accept` produce local business drafts by default. They perform no HTTP.
Only explicit `--execute true`, `--wallet-generation` from the current Agent
identity and an original `--idempotency-key` submit a business POST. No key,
sequence, price, size, fee or quote is silently replaced or increased.

`spot readiness` reads native Spot capability and spendable asset facts for an
exact market. `spot order` and `spot cancel` use the same local-draft/explicit
execution flow and original-request recovery. Spot quantity is in base units;
market-order price is the worst acceptable limit (buy ceiling, sell floor).
The group rejects margin, leverage, reduce-only and perpetual review flags.
It does not assume a Spot sale closes a perpetual position. Buy, sell, frozen
balances and native asset receipts still need later funded acceptance; Spot
does not block Phase3–6. Existing `orders`, `order-history` and `fills` use
`--market-type spot` for those records.

`management --market-id ...` returns the complete native review. A review file
contains only `stateHash` and an explicitly chosen `cancelOrderHashes` array;
the CLI does not invent cancellation scope. `rfq authorization` returns actual
fixed-contract grants and configuration with `authorizationStateHash`. Setup
requires explicit type URLs, finite Unix-seconds expiry and broad-authority
acknowledgement. This is GenericAuthorization, not a token allowance or gas grant.
Existing wallet policy may refuse it and is never loosened by the CLI.

`rfq preview` is a bounded quote-only POST with the current wallet generation,
without an execution idempotency key. Save its `settlement` object unchanged as
the bundle file for `rfq accept`; signed decimal spelling and large uint64 strings
are preserved. Open/reduce intent, current native review, authorization hash,
maximum settlement-fee allowance and INJ ceiling are explicit. The backend
revalidates all signatures, expiry, fee and current-position facts. Partial fills
and native records remain authoritative; a submitted transaction is not a fill.

Policy202 output remains the original `POLICY_DEFERRED` object. Lost responses or
unknown receipts must be investigated with
`purr injective request --request-id ORIGINAL_KEY --by idempotency-key`.
The CLI never retries a POST or automatically accepts a new quote. `funding`
provides bounded perpetual funding history; `--view accounting-v1` on positions,
orders, history and fills preserves unknown coverage/PnL as returned by backend.

The actual CLI routing/binary tests include explicit execution, a deferred policy
hold and original-request recovery against a disposable local HTTP fixture.
They do not call a real signer, exchange, chain or wallet. Historical normal check run40665219369 and the native Linux x64/macOS ARM64 candidate
binary checks in run40669935166 passed for source998aedd. Other candidate targets
prove compilation only; see [candidate evidence](docs/injective-candidate-qualification.md). Release, checksums, skills pins and Hermes promotion
remain one later coordinated batch after acceptance.
The later Spot source changes require their own ordinary CI and rebuilt candidate
checks; the earlier binaries do not qualify those new commands.

For relevant source, package and workflow changes, PR CI builds a Linux candidate
and runs Injective and AgentKey contracts through the actual binary. Ordinary CI
does not upload candidate artifacts. Use the manual Release workflow with
`skip_release=true` to build downloadable candidates and run native binary checks
without publishing a release or rolling tenants. Native binary checks are
separate from cross-platform compilation.

#### Wallet and venue examples

Hosted research can use `purr wallet uniswap` quotes with
`FX_PLATFORM_UNISWAP_QUOTE_URL` and `FX_PLATFORM_QUOTE_TOKEN`, supplied by the
research plugin. This context never falls back to wallet credentials and rejects
`--execute`; ordinary wallet commands keep their existing instance authentication.

Uniswap supports Robinhood (`4663`, default), Arc (`5042`), and Soneium (`1868`). On Arc,
`--from USDC` / `--to USDC` selects the 6-decimal ERC-20 interface at
`0x3600000000000000000000000000000000000000`; native sentinels are rejected
for swaps. Wallet balances and transfers still use native USDC with 18 decimals.
Both views share funds, including gas. Arc execution through runtime-guarded
on-demand routes remains unsupported; normal execution uses platform broadcasting.

On Soneium, select `--chain soneium` or `--chain-id 1868`. `ETH` is native gas
currency; `WETH` resolves to `0x4200000000000000000000000000000000000006`.
`USDC.e` resolves to Soneium's bridged USDC at
`0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369` (6 decimals).
Other ERC-20s use their exact Soneium contract address. Balance and transfer
commands accept the same chain flags. Ordinary execution uses TEE digest signing
and Platform RPC broadcasting, as on Arc; native TEE Soneium broadcasting is
not required. Runtime-guarded on-demand execution still requires provider-native
send/replay support and remains unavailable without it. Preserve that rejection;
a successful quote does not establish that the guarded path is enabled.

```bash
purr wallet balance --chain soneium
purr wallet balance --chain soneium --token USDC.e
purr wallet transfer --chain soneium --to <RECIPIENT> --amount 0.001
purr wallet transfer --chain soneium --to <RECIPIENT> --amount 1 --token USDC.e
purr wallet uniswap --chain soneium --from ETH --to <TOKEN_CA> --amount 0.001
```

`purr wallet uniswap --execute` automatically checks the receipt after submission,
with a 60-second budget. The hash is written to stderr immediately; stdout remains
one compact JSON object: `status`, `chainId`, `hash`, `explorerUrl`, and, when
available, actual `input` / `output` and `gas`. Execution no longer echoes the
quote payload or raw receipt details. Quote-only output is unchanged; no extra
flag is required.

- `status`: `success` (included onchain), `reverted`, `pending` (no receipt
  before the deadline), or `unknown` (RPC unavailable/mismatched). Inclusion is
  not a finality guarantee. A pending/unknown result retains the submitted hash;
  never repeat `--execute` merely to query its status.
- `input` / `output`: actual net transfers as `{ tokenAddress, amount }`, with
  `amount` an exact human-readable decimal string. Native assets also include
  `symbol`. Missing transfer evidence or decimals silently omits that entire
  `input` / `output` field. Reverted transactions omit both fields.
  `warnings` reports unexpected transfer directions, and
  `reason` explains pending/unknown status. An explicit `recipient` is retained.
- Arc USDC native system logs (18 decimals) and matching ERC-20 interface logs
  (6 decimals) are counted once. Actual native USDC is labeled `tokenAddress:
  "native"`; precision conversion stays inside the CLI. Same-symbol tokens
  retain their contract addresses.
  Native fills require system transfer logs; on Robinhood or Soneium, an unavailable native
  ETH amount is omitted, without substituting a quote or gross `tx.value`.
- `gas: { amount, symbol }` reports `gasUsed * effectiveGasPrice` separately in
  native units, excluding separate rollup fees and approval gas.

Receipt reads use `EVM_RPC_4663` / `EVM_RPC_5042` / `EVM_RPC_1868`, then
`ROBINHOOD_RPC_URL` / `ARC_RPC_URL` / `SONEIUM_RPC_URL`, then the chains' mainnet
RPC defaults (Soneium: `https://rpc.soneium.org`). The RPC chain ID is verified
and wallet API credentials are never forwarded. Permissioned Arc access may
require a reachable RPC override. Hosted agents need a released CLI and an updated
tenant image before this behavior is available.

Sui transfers and `sui-swap --execute` send an `Idempotency-Key` (a fresh one
unless `--idempotency-key` is given) and report it as `operationId`. If a send
returns `SUI_SUBMISSION_UNKNOWN`, retry the same command with
`--idempotency-key <operationId>` so the platform reconciles it instead of
sending again. A policy deferral (`POLICY_DEFERRED`) reports its approval
`requestId` and the `idempotencyKey` it used; once approved, rerun the same
command with `--idempotency-key <idempotencyKey>`. Recipients must be full
32-byte addresses (`0x` + 64 hex). Hosted agents need a released CLI and an
updated tenant image before these commands are available.

AgentKey uses the same discover → describe → execute interaction as its MCP
tools, through the platform's shared account. See [AgentKey commands and agent
workflow](docs/agentkey.md). No provider catalog or upstream credential is stored
in the CLI.

```bash
purr wallet address --chain-type ethereum
purr wallet balance --chain-type ethereum --chain-id <chain-id>
purr wallet sign --address <wallet-address> --message <message>
purr wallet transfer --to <recipient-address> --amount <amount> --chain-id <chain-id>
purr wallet transfer --to <solana-recipient-address> --amount <amount> --chain-type solana
purr wallet uniswap --from ETH --to SPCX --amount 0.003 --chain robinhood
purr wallet uniswap --from ETH --to SPCX --amount 0.003 --chain robinhood --execute
purr wallet uniswap --from USDC --to 0xeCe5cA8bf9220718E5727754026757512212cb3c --amount 1 --chain arc

# Sui (mainnet): the platform builds and policy-checks each send; the TEE signs
# and broadcasts it. Coins are SUI, USDC, or a full coin type (0x…::module::NAME).
purr wallet address --chain-type sui
purr wallet balance --chain-type sui --token USDC
purr wallet sign --chain-type sui --address <sui-address> --message <message>
purr wallet transfer --chain-type sui --to <full-64-hex-sui-address> --amount 0.1 --token USDC
purr wallet sui-swap --from SUI --to USDC --amount 0.1                       # Cetus quote
purr wallet sui-swap --from SUI --to USDC --amount 0.1 --slippage 0.5 --execute   # re-quotes; floor = quote less slippage
purr wallet sui-execute --tx-file ./tx.b64                                    # caller-built TransactionData

# Balancer pool discovery and swap
purr balancer pools --chain base --tokens WETH,USDC --protocol-version 3
purr balancer quote --chain base --from ETH --to USDC --amount 0.001 --kind exact-in
purr balancer swap --chain base --from ETH --to USDC --amount 0.001 --min-amount-out <raw> --execute

# Balancer liquidity quotes (replace add-quote/remove-quote with add/remove and
# include quote limits and --execute to broadcast)
purr balancer add-quote --chain base --pool-id 0x... --protocol-version 3 --kind unbalanced --amounts-in ETH:0.001
purr balancer remove-quote --chain base --pool-id 0x... --protocol-version 3 --kind proportional --bpt-amount-in 0.001

purr pancake quote --from USDT --to <token-address> --amount 100 --slippage 0.5
purr pancake swap --from USDT --to <token-address> --amount 100 --slippage 0.5
# An identical execution (same wallet, tokens and amount) is refused for 60s;
# pass --dedup-key <key> to choose the key instead.
purr pancake swap --from USDT --to <token-address> --amount 100 --slippage 0.5 --execute
purr fourmeme raised-tokens
purr fourmeme buy --token <token-address> --wallet <wallet-address> --funds <amount>
purr fourmeme buy-with-bnb --token <token-address> --wallet <wallet-address> --funds <bnb-amount> --min-amount <min-token-amount>
purr fourmeme sell-for-bnb --token <token-address> --wallet <wallet-address> --amount <token-amount> --min-funds <min-bnb-amount>
purr fourmeme agent-wallet --wallet <wallet-address>
purr fourmeme tax-rewards --token <token-address> --wallet <wallet-address>
purr fourmeme tax-claim --token <token-address> --wallet <wallet-address>
purr bitget order-execute --order-id <order-id> --from-chain bnb --from-contract <token-address> --from-symbol USDT --from-address <wallet-address> --to-chain bnb --to-contract "" --to-symbol BNB --to-address <wallet-address> --from-amount <amount> --slippage <slippage> --market <market-id> --protocol <protocol-id>
purr bitget transfer-execute --chain base --contract <token-address> --from-address <wallet-address> --to-address <recipient-address> --amount <amount> --gasless true
purr bitget x402-pay --url <paid-resource-url> --method POST --data <json-body>
purr binance-onchain-pay payment-method-list --fiat <fiat-symbol> --crypto <crypto-symbol> --total-amount <amount> --amount-type <1|2> --network <network>
purr binance-onchain-pay p2p-trading-pairs --fiat <fiat-symbol>
purr binance-onchain-pay estimated-quote --fiat <fiat-symbol> --crypto <crypto-symbol> --requested-amount <amount> --amount-type <1|2> --pay-method-code <pay-method-code>
purr binance-onchain-pay pre-order --fiat <fiat-symbol> --crypto <crypto-symbol> --requested-amount <amount> --amount-type <1|2> --network <network> --address <wallet-address> --pay-method-code <pay-method-code>
purr opensea buy --wallet <wallet-address> --fulfillment-file <path-to-fulfillment-json>
purr lista list-vaults --zone <zone>
purr pieverse staking contracts
purr pieverse staking positions --chain-id 1
purr pieverse staking stake --amount-wei <amount> --duration 90d --chain-id 1 --execute
purr pieverse staking withdraw --stake-id 0 --chain-id 1 --execute
purr osero balances --chain base
purr osero apy --chain base
purr osero preview --action mint-susds --chain base --amount 1000000
purr osero execute --action redeem-susds --chain base --amount <raw-susds-amount>
purr predict-fun markets --status OPEN --first 20
purr predict-fun market-quote --market-id <market-id>
purr predict-fun order-preview --market-id <market-id> --outcome YES --side BUY --strategy MARKET --spend 1
purr predict-fun order-execute --preview-id <preview-id>
purr predict-fun approval-preview --operation TRADE --market-id <market-id> --side BUY --amount 1
purr predict-fun position-preview --action SPLIT --market-id <market-id> --amount 1
purr predict-fun stream --topics orderbook:<market-id>,wallet --max-events 10

# Predict idempotency is platform-managed; callers do not provide idempotency keys.
purr evm approve --token <token-address> --spender <spender-address> --amount <amount> --chain-id <chain-id>
purr evm abi-call --to <contract-address> --signature <function-signature> --args <json-args> --chain-id <chain-id>
ASTER_USER_WALLET=<main-aster-wallet> purr aster api --endpoint /fapi/v3/balance
purr aster deposit --token <token-address> --amount-wei <amount-wei> --wallet <wallet-address> --chain-id <chain-id>
purr hyperliquid account
purr hyperliquid status
purr hyperliquid enable
purr hyperliquid snapshot
purr hyperliquid search --query "SK Hynix"
purr hyperliquid symbol --coin CXMT
purr hyperliquid markets --kind perp --dex xyz
purr hyperliquid builder-fee-status
purr hyperliquid approve-builder-fee
purr hyperliquid limit-order --asset 0 --side buy --size 0.01 --price 3000 --tif Gtc --reduce-only false
purr hyperliquid bracket-order --asset 0 --side buy --size 0.01 --entry-price 3000 --entry-tif Gtc --take-profit-price 3300 --take-profit-worst-price 3260 --stop-loss-price 2900 --stop-loss-worst-price 2850 --execution market
purr hyperliquid stop-loss --asset 0 --position-side long --size 0.01 --trigger-price 2900 --worst-price 2850 --execution market
purr hyperliquid take-profit --asset 0 --position-side long --size 0.01 --trigger-price 3300 --worst-price 3260 --execution market
purr hyperliquid protect-position --asset 0 --position-side long --size 0.01 --take-profit-price 3300 --take-profit-worst-price 3260 --stop-loss-price 2900 --stop-loss-worst-price 2850 --execution market
purr hyperliquid orders --kind frontend
purr hyperliquid modify-limit-order --oid 123 --asset 0 --side buy --size 0.01 --price 3050 --tif Gtc --reduce-only false
purr hyperliquid modify-take-profit --oid 124 --asset 0 --position-side long --size 0.01 --trigger-price 3350 --worst-price 3310 --execution market --always-place true
purr hyperliquid modify-stop-loss --oid 125 --asset 0 --position-side long --size 0.01 --trigger-price 2950 --worst-price 2900 --execution market --always-place true
purr hyperliquid cancel --asset 0 --oid 123
purr hyperliquid cancel-by-cloid --asset 0 --cloid 0x1234567890abcdef1234567890abcdef
purr hyperliquid deposit --amount 5
purr hyperliquid withdraw --amount 5
purr hyperliquid withdraw-status --nonce <nonce>

purr execute --steps-file <path-to-steps-json> --dedup-key <dedup-key>
purr instance status
purr instance payment-methods
purr instance renew --token <token-id-or-alias> --yes
purr instance topup --credits <integer> --token <token-id-or-alias> --yes
purr pns resolve <handle>
purr store list --search <keyword> --limit <limit>
purr store info <slug>
purr store install <slug>
purr store install <source>:<slug>
purr store remove <slug>
```

### Arc Mainnet wallets

Arc Mainnet uses chain ID `5042` (`--chain arc` / `--chain arc-mainnet` for wallet
balance and transfer commands). Native USDC uses **18 decimals** and pays gas from
the same balance. Omit `--token` or use `--token USDC` for native USDC:

```bash
purr wallet balance --chain-type ethereum --chain-id 5042
purr wallet balance --chain arc --token USDC
purr wallet transfer --to <evm-address> --amount 1.25 --chain arc --token USDC
purr .pie transfer --pie alice.pie --amount 1.25 --chain-id 5042
purr evm transfer --to <evm-address> --amount-wei 1250000000000000000 --chain-id 5042 --token USDC
```

`wallet transfer` and `.pie transfer` submit through the platform wallet API;
`evm transfer` builds transaction steps. An explicit `--token <contract-address>`
uses the ERC-20 path, with decimals resolved by the platform or supplied using
`--decimals`. No Arc ERC-20 contract addresses are preconfigured. The USDC ERC-20
view uses 6 decimals and shares the native balance; do not add both when reporting
holdings.

The platform must support Arc; it owns RPC selection and broadcasting. Its default
RPC is `https://rpc.mainnet.arc.io`, with `ARC_RPC_URL` as a platform override;
the explorer is `https://arc.etherscan.io`. The [official endpoint documentation](https://docs.arc.io/arc/references/rpc-endpoints)
currently marks mainnet access as permissioned. Existing runtime-guarded on-demand
sends that require provider-native idempotent broadcasting remain unsupported.

### Solana raw-signature encoding

`POST /wallet/sign` with `chainType=solana` and `scheme=raw` returns a base58-encoded 64-byte Ed25519 signature. Consumers must decode base58 before applying any venue-specific encoding; this value is not base64.

Use the parameterized order commands for limit, stop-loss, take-profit, position protection, and
order modification workflows. Hyperliquid commands reject missing, duplicate, unknown,
conflicting, or invalid options before sending a platform request. Raw order and modify payloads
are not exposed by the CLI; cancellation commands accept a single asset and order id instead of a
raw or batch payload.

Trigger orders with `--execution market` require an explicit worst acceptable execution boundary.
Use `--worst-price` for one trigger, or the separate `--take-profit-worst-price` and
`--stop-loss-worst-price` options for paired protection. The worst price must be below the trigger
when closing a long position and above the trigger when closing a short position. Limit trigger
orders use `--limit-price` instead and reject market worst-price options.

`bracket-order` submits an entry order with attached reduce-only TP/SL children in one request.
Modify the entry price with `modify-limit-order`; modify each attached TP/SL child with
`modify-take-profit` or `modify-stop-loss` using that child order's oid. Use
`orders --kind frontend` to find the entry and child order ids. If a position does not have
protection orders yet, use `protect-position` to add TP and SL orders.

Hyperliquid trigger modifications require `--always-place true`. The same flag is required when
`modify-limit-order` uses `Ioc`, `FrontendMarket`, or an executable `Gtc`; it means the replacement
is placed even if the target cancel does not succeed, so callers must verify the target and accept
that risk. The CLI cannot determine locally whether a `Gtc` price is executable.

Pieverse staking commands print portable transaction steps by default. Add `--execute` to
submit them through the configured agent wallet. Supported durations are `90d`, `180d`, and
`365d`; supported chain IDs are Ethereum `1` and BNB Chain `56`. The `positions` command
automatically reads the configured agent wallet. Stake amounts support at most two decimal
places and use increments of `0.01 PIEVERSE`; pass the exact 18-decimal wei value through
`--amount-wei`.

| Mainnet | PIEVERSE token | Staking proxy |
| --- | --- | --- |
| Ethereum | `0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9` | `0xaE4c8Ca1dC8127C380099657774CB09ca8197e78` |
| BNB Chain | `0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9` | `0xaE4c8Ca1dC8127C380099657774CB09ca8197e78` |

## Development

```bash
bun run typecheck    # TypeScript check
bun run test         # Run tests
```

## License

Private

### Public trending tokens

```bash
purr market trending --chain robinhood
purr market trending --chain bnb
purr market trending --chain solana
```

Returns JSON with `chain` and up to **five** `candidates`, each containing
`token` (CA), `name`, `symbol`, `pool_names` (at most one entry), `website`, and `social`. There is no
`--top` option. `bnb`/`bnb-chain` normalize to `bsc`; `robinhood-chain` is also accepted.
No wallet, API key, or Python runtime is required.

BNB/Robinhood discovery uses DexPaprika's first 100 pools ordered by 24-hour
volume; Solana uses GeckoTerminal's trending pool page and retains its ranking.
Discovery pools must match DEXScreener's chain, pool and token addresses, have
at least $100k current liquidity and trades in the last six hours, and have
nonzero discovery liquidity within 10x of DEXScreener. BNB/Robinhood candidates
rank by summed accepted-pool volume. Duplicate pool addresses are counted once.

The address exclusions in `packages/cli/src/market-exclusions.json` preserve the
curated exclusions from the discovery prototype (stablecoins, wrapped assets,
and other unwanted candidates). Robinhood additionally refreshes its official
[stock/ETF deployment catalog](https://docs.robinhood.com/chain/stock-token-apis/)
and excludes all chain-4663 addresses, including inactive assets. Failure to
retrieve or parse that catalog stops discovery; it does not silently skip stock
filtering. Provider names containing `Robinhood Token` are also excluded.
These filters are not a comprehensive meme classification or a safety guarantee,
and the official catalog does not classify unknown third-party stock wrappers.

After ranking, each candidate is queried independently through DEXScreener's
`/token-pairs/v1/{chain}/{CA}` endpoint. `pool_names` selects the highest USD
liquidity among the returned pools with at least $100k liquidity and recent
six-hour activity, checking either side for the exact CA. It is **not** limited
to the discovery page. Names preserve provider base/quote order (for example,
`SPCXB / MarsCoin`); a stock may remain as the counterasset of a meme candidate.
If no eligible pool is returned, `pool_names` is empty. Provider failures fail
the command rather than returning an apparently complete result. Each request
has a 10-second timeout within a 70-second overall retrieval budget.

Project links reuse the same per-token DEXScreener response: `website` and
`social` each contain the first valid URL string, or `null` when absent. Only profiles whose base token
matches the requested CA and chain are used; quote-side profiles belong to the
counterasset and are ignored. Links are deduplicated by URL before selecting the first. These are provider-listed project links, not independently
verified endorsements. No additional requests are made for links.

### Pancake V2 quotes

Pancake V2 quotes use an explicit path and raw token units. `--slippage-bps` defaults
to 100 (1%). Optional `--router` selects the V2 router. RPC selection uses
`--rpc-url`, then `EVM_RPC_56`, `BNB_RPC_URL`, `EVM_RPC_URL`, and finally
`https://bsc-rpc.publicnode.com`; callers normally need no RPC argument.
The response includes `amountOutWei`, `amountOutMinWei`, `path`, and `blockNumber`.
Use the quoted minimum with the same swap inputs when requesting confirmation.
Quotes do not include gas or transfer taxes, discover routes, or support V3/Infinity.
A failed path quote does not mean the token has no market.

### Market research

Use `purr agentkey discover`, `describe`, and `execute` to retrieve project content
and current market data through available research tools.

For an explicitly supplied CA, use `purr market token --chain <chain> <ca>`.
It returns the same `{chain, candidates}` shape as trending, with at most one
candidate. Exact identity can match either pool side; project links are taken
only from matching base-token profiles. Discovery ranking and exclusion lists
are not applied. A known token without an eligible active pool has empty
`pool_names`; no matching token returns `candidates: []`. Provider errors fail
the command rather than being reported as an unknown token.

### Hyperliquid balances across DEXs

`purr hyperliquid state --all-dexs` discovers all perpetual DEXs and queries
account state through the configured platform, plus spot once. Use
`--kind perp` to omit spot; `--dex` and `--all-dexs` are mutually exclusive.
The result contains `complete`, `perps: [{ dex, state }]`, `spot`, and `errors`.
Failed ledgers are listed in `errors`, not reported as zero. Discovery failure
fails the command. Per-ledger API payloads are preserved; no cross-currency
or account-mode-dependent total is inferred. Existing `state` and `snapshot`
behavior is unchanged.
