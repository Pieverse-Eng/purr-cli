import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type TransactionReceipt,
} from 'viem'

const ARC_USDC = '0x3600000000000000000000000000000000000000'
const NATIVE = '0x0000000000000000000000000000000000000000'
const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const CHAINS = {
  4663: {
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    env: 'ROBINHOOD_RPC_URL',
    explorer: 'https://robinhoodchain.blockscout.com',
    symbol: 'ETH',
  },
  5042: {
    rpc: 'https://rpc.mainnet.arc.io',
    env: 'ARC_RPC_URL',
    explorer: 'https://arc.etherscan.io',
    symbol: 'USDC',
  },
} as const

type Transfer = { token: string; from: string; to: string; amount: bigint }

function canonicalToken(token: string, chainId: number): string {
  return chainId === 5042 && token.toLowerCase() === ARC_USDC ? NATIVE : token.toLowerCase()
}

function transfers(receipt: TransactionReceipt, chainId: number) {
  const events = receipt.logs.flatMap((log) => {
    const [, from, to] = log.topics
    // ERC-721 shares the event signature, but has four topics instead of three.
    if (
      log.topics.length !== 3 ||
      log.topics[0]?.toLowerCase() !== TRANSFER ||
      !/^0x[0-9a-f]{64}$/i.test(log.data) ||
      !from ||
      !to ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(from) ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(to)
    )
      return []
    return [
      {
        token: log.address.toLowerCase(),
        from: `0x${from.slice(-40)}`.toLowerCase(),
        to: `0x${to.slice(-40)}`.toLowerCase(),
        amount: BigInt(log.data),
      },
    ]
  })
  // Arc mirrors the same USDC transfer through native (18) and ERC-20 (6) logs.
  // Pair by sender, recipient, and scaled amount; retain unmatched transfers.
  const mirrors = new Map<string, number>()
  const key = (t: Transfer, amount = t.amount) => `${t.from}:${t.to}:${amount}`
  for (const t of events) {
    if (t.token === SYSTEM) mirrors.set(key(t), (mirrors.get(key(t)) ?? 0) + 1)
  }
  const nativeLogs = mirrors.size > 0
  const normalized = events.flatMap((t) => {
    if (chainId === 5042 && t.token === ARC_USDC) {
      const amount = t.amount * 10n ** 12n
      const k = key(t, amount)
      const count = mirrors.get(k) ?? 0
      if (count) {
        mirrors.set(k, count - 1)
        return []
      }
      return [{ ...t, token: NATIVE, amount }]
    }
    return [{ ...t, token: t.token === SYSTEM ? NATIVE : t.token }]
  })
  return { events: normalized, nativeLogs }
}

/** Adds receipt evidence to an accepted swap; never sends or retries a transaction. */
export async function confirmUniswapSwap(
  data: Record<string, unknown>,
  chainId: number,
  recipient?: string,
) {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  const identity = {
    hash: data.hash,
    chainId,
    explorerUrl: chain ? `${chain.explorer}/tx/${data.hash}` : undefined,
    ...(recipient ? { recipient } : {}),
  }
  const unavailable = (reason: string) => ({ ...identity, status: 'unknown', reason })
  if (!chain || typeof data.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(data.hash)) {
    return unavailable(
      'Submission returned no usable transaction hash. Do not resubmit automatically.',
    )
  }
  // One deadline covers chain validation, receipt polling, and token metadata.
  const deadline = Date.now() + 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const client = createPublicClient({
      transport: http(process.env[`EVM_RPC_${chainId}`] || process.env[chain.env] || chain.rpc, {
        timeout: 10_000,
        retryCount: 0,
        fetchFn: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
          }),
      }),
    })
    if ((await client.getChainId()) !== chainId)
      return unavailable('RPC chain ID mismatch; transaction status was not checked.')
    let receipt: TransactionReceipt | undefined
    while (Date.now() < deadline) {
      try {
        receipt = await client.getTransactionReceipt({ hash: data.hash as Hash })
        break
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error
      }
      const delay = Math.min(2_000, deadline - Date.now())
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    }
    if (!receipt)
      return {
        ...identity,
        status: 'pending',
        reason: 'No receipt within 60 seconds. The transaction may still confirm; do not resubmit.',
      }
    if (receipt.status !== 'success' && receipt.status !== 'reverted')
      return unavailable('RPC returned an invalid receipt status.')
    if (
      receipt.transactionHash.toLowerCase() !== data.hash.toLowerCase() ||
      (typeof data.from === 'string' && receipt.from.toLowerCase() !== data.from.toLowerCase())
    ) {
      return unavailable('RPC receipt does not match the submitted transaction.')
    }
    const fee = receipt.gasUsed * receipt.effectiveGasPrice
    const result = {
      ...identity,
      status: receipt.status,
      gas: {
        amount: formatUnits(fee, 18),
        symbol: chain.symbol,
      },
    }
    if (receipt.status === 'reverted') return result
    const { events, nativeLogs } = transfers(receipt, chainId)
    const blockNumber = receipt.blockNumber
    const warnings: string[] = []
    async function actualAmount(token: unknown, owner: string, direction: 'sent' | 'received') {
      if (typeof token !== 'string' || !isAddress(token) || !isAddress(owner)) return null
      const asset = canonicalToken(token, chainId)
      // tx.value is gross funding, not a net fill: routers may refund native funds.
      if (asset === NATIVE && !nativeLogs) return null
      const relevant = events.filter(
        (t) =>
          t.token === asset && (t.from === owner.toLowerCase() || t.to === owner.toLowerCase()),
      )
      if (!relevant.length) return null
      const net = relevant.reduce(
        (n, t) =>
          n +
          (t.to === owner.toLowerCase() ? t.amount : 0n) -
          (t.from === owner.toLowerCase() ? t.amount : 0n),
        0n,
      )
      const amount = direction === 'sent' ? -net : net
      if (amount < 0n) {
        warnings.push(
          `Unexpected transfer direction for ${token}; actual ${direction} amount unavailable.`,
        )
        return null
      }
      let decimals: number | null = asset === NATIVE ? 18 : null
      if (decimals === null) {
        try {
          decimals = await client.readContract({
            address: asset as Address,
            abi: erc20Abi,
            functionName: 'decimals',
            blockNumber,
          })
        } catch {
          return null
        }
      }
      return {
        tokenAddress: asset === NATIVE ? 'native' : asset,
        ...(asset === NATIVE ? { symbol: chain.symbol } : {}),
        amount: formatUnits(amount, decimals),
      }
    }
    const [input, output] = await Promise.all([
      actualAmount(data.fromToken, receipt.from, 'sent'),
      actualAmount(data.toToken, recipient ?? receipt.from, 'received'),
    ])
    return {
      ...result,
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
      ...(warnings.length ? { warnings } : {}),
    }
  } catch {
    // Never leak RPC URLs/credentials or turn a read failure into a failed submission.
    return unavailable(
      'Receipt lookup unavailable. Submission hash is retained; do not resubmit automatically.',
    )
  } finally {
    clearTimeout(timer)
  }
}
