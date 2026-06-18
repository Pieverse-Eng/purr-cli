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

Pin a version by setting `PURR_VERSION`, for example `v0.2.19`.

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
| `binance-connect` | Fiat on-ramp quotes, networks, orders, and order status |
| `fourmeme` | four.meme BSC login challenge, buy, sell, and token creation flows |
| `opensea` | OpenSea buy and sell execution helpers |
| `pancake` | PancakeSwap V2/V3 swap, LP, farm, syrup, mint, increase/decrease, collect, stake, unstake, and harvest builders |
| `lista` | Lista DAO vault listing, deposit, redeem, and withdraw builders |
| `pns` | Resolve Pie Name Service handles to instance wallet addresses |
| `wallet` | Platform managed-wallet address, balance, sign, sign-typed-data, sign-okx-x402, sign-transaction, transfer, and abi-call operations |
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

purr pancake swap --path <token-a>,<token-b> --amount-in-wei <amount-in-wei> --amount-out-min-wei <amount-out-min-wei> --wallet <wallet-address> --deadline <unix-timestamp> --chain-id <chain-id>
purr pancake swap --path <token-a>,<token-b> --amount-in-wei <amount-in-wei> --amount-out-min-wei <amount-out-min-wei> --wallet <wallet-address> --deadline <unix-timestamp> --chain-id <chain-id> --execute
purr fourmeme buy --token <token-address> --wallet <wallet-address> --funds <amount>
purr binance-connect quote --fiat <fiat-symbol> --crypto <crypto-symbol> --amount <amount>
purr opensea buy --wallet <wallet-address> --fulfillment-file <path-to-fulfillment-json>
purr lista list-vaults --zone <zone>
purr evm approve --token <token-address> --spender <spender-address> --amount <amount> --chain-id <chain-id>
purr evm abi-call --to <contract-address> --signature <function-signature> --args <json-args> --chain-id <chain-id>

purr execute --steps-file <path-to-steps-json> --dedup-key <dedup-key>
purr instance status
purr instance renew --chain-id <chain-id> --token-address <token-address> --yes
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
