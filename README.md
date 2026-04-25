# purr-cli

Calldata builder CLI for on-chain step construction with support for the Pieverse skill store. Encodes transaction steps for DeFi protocols (PancakeSwap, Bitget, four.meme, Lista DAO, Aster, Binance Connect) into a portable `TxStep[]` JSON format.

## Install From GitHub Release

Linux/macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.ps1 | iex
```

Pin a version by setting `PURR_VERSION`, for example `v0.2.3`.

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
| `aster` | Aster DEX registration + on-chain deposits |
| `binance-connect` | Fiat on-ramp via Binance Connect |
| `fourmeme` | four.meme BSC flows |
| `opensea` | OpenSea execution helpers |
| `pancake` | PancakeSwap V2/V3 swap, LP, farm, syrup |
| `lista` | Lista DAO vault operations |
| `wallet` | Managed wallet operations |
| `ows-wallet` | OWS local custody operations; not available in the Windows build |
| `ows-execute` | OWS local step execution; not available in the Windows build |
| `evm` | EVM primitives (approve, transfer, raw) |
| `store` | Browse and install agent skills from Pieverse + OKX stores |

### Examples

```bash
purr pancake swap --path 0xA,0xB --amount-in-wei 1000 --amount-out-min-wei 500 --wallet 0x... --deadline 1710000000 --chain-id 56
purr fourmeme buy --token 0x... --wallet 0x... --funds 0.1
purr evm approve --token 0x... --spender 0x... --amount 1000 --chain-id 56
purr store list --search <keyword> --limit 10
purr store info <slug>
purr store install <slug>
purr store remove <slug>
```

## Development

```bash
bun run typecheck    # TypeScript check
bun run test         # Run tests
```

## License

Private
