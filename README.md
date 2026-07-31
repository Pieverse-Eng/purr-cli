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
| `pancake` | PancakeSwap V2/V3 swap, LP, farm, syrup, mint, increase/decrease, collect, stake, unstake, and harvest builders |
| `lista` | Lista DAO vault listing, deposit, redeem, and withdraw builders |
| `hyperliquid` | Hyperliquid account, market data, orders, transfers, deposits, and withdrawals through the platform TEE wallet |
| `pns` | Resolve Pie Name Service handles to instance wallet addresses |
| `wallet` | Platform managed-wallet address, balance, sign, sign-typed-data, sign-okx-x402, sign-transaction, transfer, abi-call, and Robinhood Uniswap operations |
| `ows-wallet` | OWS-backed local custody sign-transaction and build-transfer helpers; not available in the Windows build |
| `ows-execute` | OWS-backed local step execution; not available in the Windows build |
| `execute` | Execute `TxStep[]` JSON from a file through the configured instance wallet |
| `evm` | Local EVM primitive builders: approve, transfer, raw, and abi-call |
| `instance` | Instance billing status and trusted-wallet renewal |
| `store` | Browse and install agent skills from Pieverse + OKX stores |
| `config` | Manage persistent `api-url`, `api-token`, and `instance-id` credentials |
| `version` | Print the CLI version |

### Examples

```bash
purr wallet address --chain-type ethereum
purr wallet balance --chain-type ethereum --chain-id <chain-id>
purr wallet sign --address <wallet-address> --message <message>
purr wallet transfer --to <recipient-address> --amount <amount> --chain-id <chain-id>
purr wallet transfer --to <solana-recipient-address> --amount <amount> --chain-type solana
purr wallet uniswap --from ETH --to SPCX --amount 0.003 --chain robinhood
purr wallet uniswap --from ETH --to SPCX --amount 0.003 --chain robinhood --execute

# Balancer pool discovery and swap
purr balancer pools --chain base --tokens WETH,USDC --protocol-version 3
purr balancer quote --chain base --from ETH --to USDC --amount 0.001 --kind exact-in
purr balancer swap --chain base --from ETH --to USDC --amount 0.001 --min-amount-out <raw> --execute

# Balancer liquidity quotes (replace add-quote/remove-quote with add/remove and
# include quote limits and --execute to broadcast)
purr balancer add-quote --chain base --pool-id 0x... --protocol-version 3 --kind unbalanced --amounts-in ETH:0.001
purr balancer remove-quote --chain base --pool-id 0x... --protocol-version 3 --kind proportional --bpt-amount-in 0.001

purr pancake swap --path <token-a>,<token-b> --amount-in-wei <amount-in-wei> --amount-out-min-wei <amount-out-min-wei> --wallet <wallet-address> --deadline <unix-timestamp> --chain-id <chain-id>
purr pancake swap --path <token-a>,<token-b> --amount-in-wei <amount-in-wei> --amount-out-min-wei <amount-out-min-wei> --wallet <wallet-address> --deadline <unix-timestamp> --chain-id <chain-id> --execute
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
purr binance-onchain-pay pre-order --merchant-code <code> --merchant-name <name> --fiat <fiat-symbol> --crypto <crypto-symbol> --requested-amount <amount> --amount-type <1|2> --network <network> --address <wallet-address> --pay-method-code <pay-method-code>
purr opensea buy --wallet <wallet-address> --fulfillment-file <path-to-fulfillment-json>
purr lista list-vaults --zone <zone>
purr osero balances --chain base
purr osero apy --chain base
purr osero preview --action mint-susds --chain base --amount 1000000
purr osero execute --action redeem-susds --chain base --amount <raw-susds-amount>
purr evm approve --token <token-address> --spender <spender-address> --amount <amount> --chain-id <chain-id>
purr evm abi-call --to <contract-address> --signature <function-signature> --args <json-args> --chain-id <chain-id>
purr aster api --endpoint /fapi/v3/balance --user <main-aster-wallet>
purr aster deposit --token <token-address> --amount-wei <amount-wei> --wallet <wallet-address> --chain-id <chain-id>
purr hyperliquid account
purr hyperliquid status
purr hyperliquid enable
purr hyperliquid snapshot
purr hyperliquid symbol --coin CXMT
purr hyperliquid markets --kind perp --dex xyz
purr hyperliquid builder-fee-status
purr hyperliquid approve-builder-fee
purr hyperliquid order --body-file <path-to-order-json>
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

## Development

```bash
bun run typecheck    # TypeScript check
bun run test         # Run tests
```

## License

Private
