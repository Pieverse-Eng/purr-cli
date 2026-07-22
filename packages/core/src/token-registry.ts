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
  // Kairos
  1001: {
    KAIA: NATIVE,
    // Legacy Klaytn alias: accept on input, prefer KAIA in output.
    KLAY: NATIVE,
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
  // Morph
  2818: {
    ETH: NATIVE,
    WETH: '0x5300000000000000000000000000000000000011',
    USDT: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
    'USDT.E': '0xc7D67A9cBB121b3b0b9c053DD9f469523243379A',
    USDC: '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B',
    'USDC.E': '0xe34c91815d7fc18A9e2148bcD4241d0a5848b693',
    BGB: '0x389C08Bc23A7317000a1FD76c7c5B0cb0b4640b5',
  },
  // Kaia
  8217: {
    KAIA: NATIVE,
    // Legacy Klaytn alias: accept on input, prefer KAIA in output.
    KLAY: NATIVE,
  },
  // X Layer (OKX zkEVM L2)
  //
  // The Tether-family asset on X Layer is `USD₮0` at
  // `0x779ded0c9e1022225f8e0630b35a9b54be713736` (~12x the supply of the
  // legacy bridged Tether and the contract OKX x402 + our merchant flow
  // settle against). The legacy bridged Tether
  // (`0x1E4a5963aBFD975d8c9021ce480b42188849D41d`) is considered deprecated
  // and is intentionally NOT exposed under any ticker — callers needing it
  // must pass the raw address.
  196: {
    OKB: NATIVE,
    USDC: '0x74b7F16337b8972027F6196A17a631aC6dE26d22',
    USDT0: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
    USDG: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8',
    XETH: '0xe7B000003a45145dECF8a28FC755aD5EC5Ea025A',
    XBTC: '0xb7c00000bcDEEf966B20B3D884b98e64d2b06b4f',
  },
  // Monad
  143: {
    MON: NATIVE,
    USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  },
  // Monad Testnet
  10143: {
    MON: NATIVE,
  },
  // Robinhood Chain
  4663: {
    ETH: NATIVE,
    WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
    AMD: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC',
    AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
    BABA: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4',
    BE: '0x822CC93fFD030293E9842c30BBD678F530701867',
    COIN: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b',
    CRCL: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5',
    CRWV: '0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3',
    GOOGL: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
    INTC: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681',
    META: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
    MSFT: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
    MU: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD',
    NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    ORCL: '0xb0992820E760d836549ba69BC7598b4af75dEE03',
    PLTR: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A',
    SNDK: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400',
    SPCX: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',
    TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
    USAR: '0xd917B029C761D264c6A312BBbcDA868658eF86a6',
    QQQ: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
    SGOV: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5',
    SLV: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f',
    SPY: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
    USO: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344',
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
  morph: 2818,
  kaia: 8217,
  kairos: 1001,
  xlayer: 196,
  'x-layer': 196,
  okx: 196,
  monad: 143,
  mon: 143,
  'monad-testnet': 10143,
  unichain: 130,
  uni: 130,
  robinhood: 4663,
  'robinhood-chain': 4663,
  rhc: 4663,
  solana: SOLANA_CHAIN_ID,
  sol: SOLANA_CHAIN_ID,
}

export function chainNameToId(input: string): number | undefined {
  return CHAIN_NAME_TO_ID[input.toLowerCase()]
}

export function inferChainId(args: Record<string, string>): number {
  if (args['chain-id']) {
    const n = Number.parseInt(args['chain-id'], 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  if (args.chain) {
    const id = chainNameToId(args.chain)
    if (id !== undefined) return id
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
