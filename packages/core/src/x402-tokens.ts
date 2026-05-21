/**
 * EIP-712 domain metadata for OKX-x402 supported tokens.
 *
 * Separated from the main token registry because (a) only x402-using tokens
 * need these fields, (b) the values aren't always derivable on-chain (USDT0
 * reverts on `version()`), and (c) any drift here breaks signing in a way
 * that only surfaces as opaque "okx_invalid" from OKX's facilitator — so we
 * pair this map with a fixture test that reconstructs DOMAIN_SEPARATOR and
 * compares to recorded on-chain values.
 *
 * Address keys are lowercased so callers can `.toLowerCase()` on lookup and
 * dodge checksum-comparison bugs.
 *
 * Reference: purrfectclaw-platform/packages/api-server/src/services/merchant-okx-x402.ts
 */

export interface X402TokenDomain {
  name: string
  version: string
}

export const X402_TOKEN_DOMAINS: Record<number, Record<string, X402TokenDomain>> = {
  196: {
    // USDC (FiatTokenV2) — version() callable on-chain, returns "2"
    '0x74b7f16337b8972027f6196a17a631ac6de26d22': { name: 'USD Coin', version: '2' },
    // USDT0 — version() reverts; must be hardcoded. U+20AE in name (USD₮0).
    '0x779ded0c9e1022225f8e0630b35a9b54be713736': { name: 'USD₮0', version: '1' },
    // USDG (Global Dollar)
    '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8': { name: 'Global Dollar', version: '1' },
  },
}

/**
 * Look up the EIP-712 domain (name, version) for a given x402 token. Both
 * `chainId` and `tokenAddress` accepted in any case. Returns undefined when
 * the token isn't in the x402 registry.
 */
export function getX402TokenDomain(
  chainId: number,
  tokenAddress: string,
): X402TokenDomain | undefined {
  return X402_TOKEN_DOMAINS[chainId]?.[tokenAddress.toLowerCase()]
}
