import { isAddress } from 'viem'
import { NATIVE_EVM } from './shared.js'

const DEFAULT_CHAIN_ID = 56

/** Sentinel chain ID used to route Solana token resolution (not a real EVM chain ID). */
export const SOLANA_CHAIN_ID = -1
const NATIVE = NATIVE_EVM as `0x${string}`

const REGISTRY: Record<number, Record<string, `0x${string}`>> = {
  // BNB Chain
  56: {
    BNB: NATIVE,
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    FDUSD: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    BTCB: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    ETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    LISTA: '0xFceB31A79F71AC9CBDCF853519c1b12D379EdC46',
    XRP: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE',
    DOGE: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
    LINK: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
  },
  // Ethereum
  1: {
    ETH: NATIVE,
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    SHIB: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    PEPE: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
  },
  // Base
  8453: {
    ETH: NATIVE,
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    CBETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    BRETT: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
    AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  },
  // Arbitrum
  42161: {
    ETH: NATIVE,
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    'USDC.E': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    GMX: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    LINK: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
  },
  // Polygon
  137: {
    MATIC: NATIVE,
    POL: NATIVE,
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    'USDC.E': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    WBTC: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    LINK: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    AAVE: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
  },
  // Optimism
  10: {
    ETH: NATIVE,
    WETH: '0x4200000000000000000000000000000000000006',
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    'USDC.E': '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    WBTC: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    OP: '0x4200000000000000000000000000000000000042',
    LINK: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6',
  },
}

// Solana uses base58 mint addresses, not 0x. Separate type.
const SOLANA_REGISTRY: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  WETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
}

const CHAIN_NAME_TO_ID: Record<string, number> = {
  bnb: 56,
  bsc: 56,
  eth: 1,
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  matic: 137,
  polygon: 137,
  optimism: 10,
  solana: SOLANA_CHAIN_ID,
  sol: SOLANA_CHAIN_ID,
}

export function inferChainId(args: Record<string, string>): number {
  if (args['chain-id']) {
    const n = Number.parseInt(args['chain-id'], 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  if (args.chain) {
    const id = CHAIN_NAME_TO_ID[args.chain.toLowerCase()]
    if (id) return id
  }
  return DEFAULT_CHAIN_ID
}

export function resolveToken(input: string, chainId: number): string {
  if (chainId === SOLANA_CHAIN_ID) return resolveSolanaToken(input)
  if (isAddress(input)) return input

  const ticker = input.toUpperCase()
  const chain = REGISTRY[chainId]
  if (!chain) {
    const supported = Object.keys(REGISTRY).join(', ')
    throw new Error(
      `No token registry for chain ${chainId}. Supported chains: ${supported}. Pass a raw address instead.`,
    )
  }

  const address = chain[ticker]
  if (!address) {
    const available = Object.keys(chain).sort().join(', ')
    throw new Error(`Unknown token "${input}" on chain ${chainId}. Available tickers: ${available}`)
  }

  return address
}

function resolveSolanaToken(input: string): string {
  // Solana addresses are base58, 32-44 chars — if it looks like one, pass through
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return input

  const ticker = input.toUpperCase()
  const address = SOLANA_REGISTRY[ticker]
  if (!address) {
    const available = Object.keys(SOLANA_REGISTRY).sort().join(', ')
    throw new Error(`Unknown Solana token "${input}". Available tickers: ${available}`)
  }
  return address
}
