import { encodeFunctionData, parseAbi } from 'viem'
import {
  buildApprovalStep,
  isNative,
  parseBigInt,
  requireAddress,
} from '@pieverseio/purr-core/shared'
import type { StepOutput, TxStep } from '@pieverseio/purr-core/types'

const PANCAKE_ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)',
])

const MASTER_CHEF_V2_ABI = parseAbi([
  'function deposit(uint256 _pid, uint256 _amount)',
  'function withdraw(uint256 _pid, uint256 _amount)',
])

const MASTER_CHEF_V2 = '0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652'
const BSC_WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

// --- V3 Farm ---

const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' // BSC
const MASTER_CHEF_V3 = '0x556B9306565093C855AEA9AE92A594704c2Cd59e' // BSC

const MASTER_CHEF_V3_ABI = parseAbi([
  'function withdraw(uint256 tokenId, address to)',
  'function harvest(uint256 tokenId, address to)',
])

const POSITION_MANAGER_ABI = parseAbi([
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] calldata data) payable returns (bytes[] memory results)',
  'function refundETH() payable',
])

// --- Syrup Pool ---

const SYRUP_POOL_ABI = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
])

/** Check if token is native BNB or its wrapped equivalent (WBNB on BSC) */
function isNativeOrWbnb(token: string): boolean {
  if (isNative(token)) return true
  return token.toLowerCase() === BSC_WBNB.toLowerCase()
}

/** Default deadline: 20 minutes from now */
const DEFAULT_DEADLINE_SECONDS = 1200

/**
 * Normalize a deadline value to an absolute Unix timestamp (as BigInt).
 *
 * If the value is below 1_000_000_000, it is treated as relative seconds from
 * now (e.g. 1200 → "20 minutes from now"). Values >= 1_000_000_000 are assumed
 * to already be absolute Unix timestamps. When no value is provided (`undefined`),
 * a default of 20 minutes from now is used.
 */
function resolveDeadline(raw: number | undefined): bigint {
  const now = Math.floor(Date.now() / 1000)
  if (raw == null) {
    return BigInt(now + DEFAULT_DEADLINE_SECONDS)
  }
  if (raw < 1_000_000_000) {
    return BigInt(now + raw)
  }
  return BigInt(raw)
}

export interface PancakeSwapArgs {
  router?: string // default PancakeSwap V2 router
  path: string[] // token addresses in swap path
  amountInWei: string
  amountOutMinWei: string
  wallet: string
  deadline?: number // unix timestamp or relative seconds; defaults to 20 min
  chainId: number
}

const DEFAULT_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'

export function buildPancakeSwapSteps(args: PancakeSwapArgs): StepOutput {
  if (args.path.length < 2) {
    throw new Error('Swap path must have at least 2 tokens')
  }

  const router = requireAddress(args.router ?? DEFAULT_ROUTER, 'router')
  const amountIn = parseBigInt(args.amountInWei, 'amount-in-wei')
  const amountOutMin = parseBigInt(args.amountOutMinWei, 'amount-out-min-wei')
  const path = args.path.map((t) => {
    const trimmed = t.trim()
    if (!isNative(trimmed)) requireAddress(trimmed, 'path token')
    return trimmed
  }) as `0x${string}`[]
  const wallet = requireAddress(args.wallet, 'wallet')
  const deadline = resolveDeadline(args.deadline)

  const fromToken = path[0]
  const toToken = path[path.length - 1]
  const fromIsNative = isNativeOrWbnb(fromToken)
  const toIsNative = isNativeOrWbnb(toToken)

  const steps: TxStep[] = []

  // Add conditional approval for ERC-20 input tokens (skip for native/WBNB — native BNB is sent as value)
  if (!fromIsNative) {
    steps.push(
      buildApprovalStep(
        fromToken,
        router,
        amountIn.toString(),
        args.chainId,
        'Approve token for PancakeSwap router',
      ),
    )
  }

  let swapData: `0x${string}`
  let value = '0x0'

  if (fromIsNative) {
    swapData = encodeFunctionData({
      abi: PANCAKE_ROUTER_ABI,
      functionName: 'swapExactETHForTokens',
      args: [amountOutMin, path, wallet, deadline],
    })
    value = `0x${amountIn.toString(16)}`
  } else if (toIsNative) {
    swapData = encodeFunctionData({
      abi: PANCAKE_ROUTER_ABI,
      functionName: 'swapExactTokensForETH',
      args: [amountIn, amountOutMin, path, wallet, deadline],
    })
  } else {
    swapData = encodeFunctionData({
      abi: PANCAKE_ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, amountOutMin, path, wallet, deadline],
    })
  }

  steps.push({
    to: router,
    data: swapData,
    value,
    chainId: args.chainId,
    label: 'PancakeSwap V2 swap',
  })

  return { steps }
}

// --- LP ---

export interface PancakeAddLiquidityArgs {
  tokenA: string
  tokenB: string
  amountAWei: string
  amountBWei: string
  wallet: string
  deadline?: number // unix timestamp or relative seconds; defaults to 20 min
  chainId: number
  router?: string
}

export function buildPancakeAddLiquiditySteps(args: PancakeAddLiquidityArgs): StepOutput {
  const router = requireAddress(args.router ?? DEFAULT_ROUTER, 'router')
  const wallet = requireAddress(args.wallet, 'wallet')
  const deadline = resolveDeadline(args.deadline)
  const amountA = parseBigInt(args.amountAWei, 'amount-a-wei')
  const amountB = parseBigInt(args.amountBWei, 'amount-b-wei')

  const tokenANative = isNativeOrWbnb(args.tokenA)
  const tokenBNative = isNativeOrWbnb(args.tokenB)
  if (tokenANative && tokenBNative) {
    throw new Error('tokenA and tokenB cannot both be native')
  }

  const steps: TxStep[] = []

  if (tokenANative || tokenBNative) {
    const erc20Token = requireAddress(tokenANative ? args.tokenB : args.tokenA, 'erc20 token')
    const erc20Amount = tokenANative ? amountB : amountA
    const nativeAmount = tokenANative ? amountA : amountB

    steps.push(
      buildApprovalStep(
        erc20Token,
        router,
        erc20Amount.toString(),
        args.chainId,
        'Approve token for PancakeSwap router',
      ),
    )

    steps.push({
      to: router,
      data: encodeFunctionData({
        abi: PANCAKE_ROUTER_ABI,
        functionName: 'addLiquidityETH',
        args: [erc20Token, erc20Amount, 0n, 0n, wallet, deadline],
      }),
      value: `0x${nativeAmount.toString(16)}`,
      chainId: args.chainId,
      label: 'PancakeSwap V2 addLiquidityETH',
    })
  } else {
    const tokenA = requireAddress(args.tokenA, 'tokenA')
    const tokenB = requireAddress(args.tokenB, 'tokenB')

    steps.push(
      buildApprovalStep(tokenA, router, amountA.toString(), args.chainId, 'Approve tokenA'),
    )
    steps.push(
      buildApprovalStep(tokenB, router, amountB.toString(), args.chainId, 'Approve tokenB'),
    )

    steps.push({
      to: router,
      data: encodeFunctionData({
        abi: PANCAKE_ROUTER_ABI,
        functionName: 'addLiquidity',
        args: [tokenA, tokenB, amountA, amountB, 0n, 0n, wallet, deadline],
      }),
      value: '0x0',
      chainId: args.chainId,
      label: 'PancakeSwap V2 addLiquidity',
    })
  }

  return { steps }
}

export interface PancakeRemoveLiquidityArgs {
  pairAddress: string
  token0: string
  token1: string
  lpAmountWei: string
  wallet: string
  deadline?: number // unix timestamp or relative seconds; defaults to 20 min
  chainId: number
  router?: string
}

export function buildPancakeRemoveLiquiditySteps(args: PancakeRemoveLiquidityArgs): StepOutput {
  const router = requireAddress(args.router ?? DEFAULT_ROUTER, 'router')
  const wallet = requireAddress(args.wallet, 'wallet')
  const pair = requireAddress(args.pairAddress, 'pair-address')
  const token0 = requireAddress(args.token0, 'token0')
  const token1 = requireAddress(args.token1, 'token1')
  const lpAmount = parseBigInt(args.lpAmountWei, 'lp-amount-wei')
  const deadline = resolveDeadline(args.deadline)

  const steps: TxStep[] = []

  steps.push(
    buildApprovalStep(
      pair,
      router,
      lpAmount.toString(),
      args.chainId,
      'Approve LP token for PancakeSwap router',
    ),
  )

  const token0Native = isNativeOrWbnb(args.token0)
  const token1Native = isNativeOrWbnb(args.token1)

  if (token0Native || token1Native) {
    const token = token0Native ? token1 : token0
    steps.push({
      to: router,
      data: encodeFunctionData({
        abi: PANCAKE_ROUTER_ABI,
        functionName: 'removeLiquidityETH',
        args: [token, lpAmount, 0n, 0n, wallet, deadline],
      }),
      value: '0x0',
      chainId: args.chainId,
      label: 'PancakeSwap V2 removeLiquidityETH',
    })
  } else {
    steps.push({
      to: router,
      data: encodeFunctionData({
        abi: PANCAKE_ROUTER_ABI,
        functionName: 'removeLiquidity',
        args: [token0, token1, lpAmount, 0n, 0n, wallet, deadline],
      }),
      value: '0x0',
      chainId: args.chainId,
      label: 'PancakeSwap V2 removeLiquidity',
    })
  }

  return { steps }
}

// --- Farm ---

export interface PancakeFarmArgs {
  action: 'stake' | 'unstake' | 'harvest'
  pid: number
  amountWei: string // "0" for harvest
  lpToken: string
  chainId: number
  masterChef?: string
}

export function buildPancakeFarmSteps(args: PancakeFarmArgs): StepOutput {
  if (args.pid < 0 || !Number.isInteger(args.pid)) {
    throw new Error('pid must be a non-negative integer')
  }

  const masterChef = requireAddress(args.masterChef ?? MASTER_CHEF_V2, 'master-chef')
  const lpToken = requireAddress(args.lpToken, 'lp-token')
  const pid = BigInt(args.pid)
  const amount = BigInt(args.amountWei)

  const steps: TxStep[] = []

  if (args.action === 'stake' && amount > 0n) {
    steps.push(
      buildApprovalStep(
        lpToken,
        masterChef,
        amount.toString(),
        args.chainId,
        'Approve LP token for MasterChef',
      ),
    )
  }

  const fn = args.action === 'unstake' ? 'withdraw' : 'deposit'
  steps.push({
    to: masterChef,
    data: encodeFunctionData({
      abi: MASTER_CHEF_V2_ABI,
      functionName: fn,
      args: [pid, amount],
    }),
    value: '0x0',
    chainId: args.chainId,
    label: `PancakeSwap MasterChef ${args.action}`,
  })

  return { steps }
}

// --- V3 Farm ---

export interface PancakeV3FarmArgs {
  action: 'stake' | 'unstake' | 'harvest'
  tokenId: string
  wallet: string
  chainId: number
}

export function buildPancakeV3FarmSteps(args: PancakeV3FarmArgs): StepOutput {
  const wallet = requireAddress(args.wallet, 'wallet')
  const tokenId = parseBigInt(args.tokenId, 'token-id')

  if (args.action === 'stake') {
    return {
      steps: [
        {
          to: POSITION_MANAGER,
          data: encodeFunctionData({
            abi: POSITION_MANAGER_ABI,
            functionName: 'safeTransferFrom',
            args: [wallet, MASTER_CHEF_V3 as `0x${string}`, tokenId],
          }),
          value: '0x0',
          chainId: args.chainId,
          label: 'PancakeSwap V3 farm stake (transfer NFT to MasterChef)',
        },
      ],
    }
  }

  const fn = args.action === 'unstake' ? 'withdraw' : 'harvest'
  return {
    steps: [
      {
        to: MASTER_CHEF_V3,
        data: encodeFunctionData({
          abi: MASTER_CHEF_V3_ABI,
          functionName: fn,
          args: [tokenId, wallet],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: `PancakeSwap V3 farm ${args.action}`,
      },
    ],
  }
}

// --- Syrup Pool ---

const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'

export interface SyrupPoolArgs {
  poolAddress: string
  amountWei: string
  chainId: number
}

/** Stake CAKE into a Syrup Pool (approve + deposit) */
export function buildSyrupStakeSteps(args: SyrupPoolArgs): StepOutput {
  const pool = requireAddress(args.poolAddress, 'pool-address')
  const amount = parseBigInt(args.amountWei, 'amount-wei')

  return {
    steps: [
      buildApprovalStep(CAKE, pool, amount.toString(), args.chainId, 'Approve CAKE for Syrup Pool'),
      {
        to: pool,
        data: encodeFunctionData({
          abi: SYRUP_POOL_ABI,
          functionName: 'deposit',
          args: [amount],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: 'Syrup Pool deposit',
      },
    ],
  }
}

/** Unstake from a Syrup Pool */
export function buildSyrupUnstakeSteps(args: SyrupPoolArgs): StepOutput {
  const pool = requireAddress(args.poolAddress, 'pool-address')
  const amount = parseBigInt(args.amountWei, 'amount-wei')

  return {
    steps: [
      {
        to: pool,
        data: encodeFunctionData({
          abi: SYRUP_POOL_ABI,
          functionName: 'withdraw',
          args: [amount],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: 'Syrup Pool withdraw',
      },
    ],
  }
}

// --- V3 LP ---

export interface V3MintArgs {
  token0: string
  token1: string
  fee: number // 100 | 500 | 2500 | 10000
  tickLower: number
  tickUpper: number
  amount0Wei: string
  amount1Wei: string
  wallet: string
  deadline?: number
  chainId: number
}

export function buildV3MintSteps(args: V3MintArgs): StepOutput {
  const wallet = requireAddress(args.wallet, 'wallet')
  const amount0 = parseBigInt(args.amount0Wei, 'amount0-wei')
  const amount1 = parseBigInt(args.amount1Wei, 'amount1-wei')
  const deadline = resolveDeadline(args.deadline)

  const token0Native = isNativeOrWbnb(args.token0)
  const token1Native = isNativeOrWbnb(args.token1)
  if (token0Native && token1Native) {
    throw new Error('token0 and token1 cannot both be native/WBNB')
  }

  // For on-chain calls, always use WBNB address (not native zero address)
  const token0Addr = requireAddress(token0Native ? BSC_WBNB : args.token0, 'token0')
  const token1Addr = requireAddress(token1Native ? BSC_WBNB : args.token1, 'token1')

  const steps: TxStep[] = []
  const hasNative = token0Native || token1Native
  const nativeAmount = token0Native ? amount0 : token1Native ? amount1 : 0n

  if (!token0Native) {
    steps.push(
      buildApprovalStep(
        token0Addr,
        POSITION_MANAGER,
        amount0.toString(),
        args.chainId,
        'Approve token0 for V3 PositionManager',
      ),
    )
  }
  if (!token1Native) {
    steps.push(
      buildApprovalStep(
        token1Addr,
        POSITION_MANAGER,
        amount1.toString(),
        args.chainId,
        'Approve token1 for V3 PositionManager',
      ),
    )
  }

  const mintParams = {
    token0: token0Addr,
    token1: token1Addr,
    fee: args.fee,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: wallet,
    deadline,
  }

  if (hasNative) {
    const mintCalldata = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'mint',
      args: [mintParams],
    })
    const refundCalldata = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'refundETH',
    })

    steps.push({
      to: POSITION_MANAGER,
      data: encodeFunctionData({
        abi: POSITION_MANAGER_ABI,
        functionName: 'multicall',
        args: [[mintCalldata, refundCalldata]],
      }),
      value: `0x${nativeAmount.toString(16)}`,
      chainId: args.chainId,
      label: 'PancakeSwap V3 mint (multicall with refundETH)',
    })
  } else {
    steps.push({
      to: POSITION_MANAGER,
      data: encodeFunctionData({
        abi: POSITION_MANAGER_ABI,
        functionName: 'mint',
        args: [mintParams],
      }),
      value: '0x0',
      chainId: args.chainId,
      label: 'PancakeSwap V3 mint',
    })
  }

  return { steps }
}

export interface V3IncreaseLiquidityArgs {
  tokenId: string
  amount0Wei: string
  amount1Wei: string
  deadline?: number
  chainId: number
}

export function buildV3IncreaseLiquiditySteps(args: V3IncreaseLiquidityArgs): StepOutput {
  const tokenId = parseBigInt(args.tokenId, 'token-id')
  const amount0 = parseBigInt(args.amount0Wei, 'amount0-wei')
  const amount1 = parseBigInt(args.amount1Wei, 'amount1-wei')
  const deadline = resolveDeadline(args.deadline)

  return {
    steps: [
      {
        to: POSITION_MANAGER,
        data: encodeFunctionData({
          abi: POSITION_MANAGER_ABI,
          functionName: 'increaseLiquidity',
          args: [
            {
              tokenId,
              amount0Desired: amount0,
              amount1Desired: amount1,
              amount0Min: 0n,
              amount1Min: 0n,
              deadline,
            },
          ],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: 'PancakeSwap V3 increaseLiquidity',
      },
    ],
  }
}

export interface V3DecreaseLiquidityArgs {
  tokenId: string
  liquidity: string
  amount0MinWei: string
  amount1MinWei: string
  deadline?: number
  chainId: number
}

export function buildV3DecreaseLiquiditySteps(args: V3DecreaseLiquidityArgs): StepOutput {
  const tokenId = parseBigInt(args.tokenId, 'token-id')
  const liquidity = parseBigInt(args.liquidity, 'liquidity')
  const amount0Min = BigInt(args.amount0MinWei)
  const amount1Min = BigInt(args.amount1MinWei)
  const deadline = resolveDeadline(args.deadline)

  return {
    steps: [
      {
        to: POSITION_MANAGER,
        data: encodeFunctionData({
          abi: POSITION_MANAGER_ABI,
          functionName: 'decreaseLiquidity',
          args: [{ tokenId, liquidity, amount0Min, amount1Min, deadline }],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: 'PancakeSwap V3 decreaseLiquidity',
      },
    ],
  }
}

export interface V3CollectArgs {
  tokenId: string
  wallet: string
  chainId: number
}

const MAX_UINT128 = (1n << 128n) - 1n

export function buildV3CollectSteps(args: V3CollectArgs): StepOutput {
  const wallet = requireAddress(args.wallet, 'wallet')
  const tokenId = parseBigInt(args.tokenId, 'token-id')

  return {
    steps: [
      {
        to: POSITION_MANAGER,
        data: encodeFunctionData({
          abi: POSITION_MANAGER_ABI,
          functionName: 'collect',
          args: [{ tokenId, recipient: wallet, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        }),
        value: '0x0',
        chainId: args.chainId,
        label: 'PancakeSwap V3 collect fees',
      },
    ],
  }
}
