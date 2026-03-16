# purr-cli

Calldata builder CLI for on-chain step construction. Encodes transaction steps for DeFi protocols (PancakeSwap, Bitget, four.meme, Lista DAO, Aster, Binance Connect) into a portable `TxStep[]` JSON format.

## Install

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
| `bitget` | Bitget multi-chain swap |
| `binance-connect` | Fiat on-ramp via Binance Connect |
| `fourmeme` | four.meme BSC flows |
| `pancake` | PancakeSwap V2/V3 swap, LP, farm, syrup |
| `lista` | Lista DAO vault operations |
| `evm` | EVM primitives (approve, transfer, raw) |

### Examples

```bash
purr bitget swap --from-token 0x... --to-token 0x... --from-amount 0.05 --chain bnb --wallet 0x...
purr pancake swap --path 0xA,0xB --amount-in-wei 1000 --amount-out-min-wei 500 --wallet 0x... --deadline 1710000000 --chain-id 56
purr fourmeme buy --token 0x... --wallet 0x... --funds 0.1
purr evm approve --token 0x... --spender 0x... --amount 1000 --chain-id 56
```

## Development

```bash
bun run typecheck    # TypeScript check
bun run test         # Run tests
```

## License

Private
