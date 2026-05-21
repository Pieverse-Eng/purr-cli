/**
 * X402_TOKEN_DOMAINS fixture test — guards against EIP-712 domain drift.
 *
 * For each entry in the map we reconstruct DOMAIN_SEPARATOR locally using
 *   keccak256(abi.encode(
 *     EIP712Domain_TYPEHASH,
 *     keccak256(name),
 *     keccak256(version),
 *     chainId,
 *     verifyingContract
 *   ))
 *
 * and compare against an on-chain `DOMAIN_SEPARATOR()` return value recorded
 * from rpc.xlayer.tech. If any name/version/chainId is wrong in the registry,
 * the reconstructed hash diverges and this test breaks at CI time — before
 * a payment signature ever gets rejected by OKX's facilitator.
 *
 * To refresh fixtures (e.g. after a proxy upgrade), re-query:
 *   curl -s -X POST <RPC> -H 'Content-Type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"eth_call",
 *          "params":[{"to":"<TOKEN>","data":"0x3644e515"},"latest"]}'
 */

import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem'
import { X402_TOKEN_DOMAINS, getX402TokenDomain } from '@pieverseio/purr-core/x402-tokens'

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
)

function reconstructDomainSeparator(
  name: string,
  version: string,
  chainId: number,
  verifyingContract: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
      EIP712_DOMAIN_TYPEHASH,
      keccak256(toHex(name)),
      keccak256(toHex(version)),
      BigInt(chainId),
      verifyingContract,
    ]),
  )
}

// Recorded from `eth_call` selector 0x3644e515 against rpc.xlayer.tech.
// Block: latest at fixture capture time. Static — no network calls in test.
const ON_CHAIN_DOMAIN_SEPARATORS: Record<number, Record<string, `0x${string}`>> = {
  196: {
    '0x74b7f16337b8972027f6196a17a631ac6de26d22':
      '0xb1671065a2ea487729c4ff0e2f8beb2105e3ce63315ad07483374a3476b83972',
    '0x779ded0c9e1022225f8e0630b35a9b54be713736':
      '0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d',
    '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8':
      '0x415f0706e345fcaf25d5be24c4fd7830d0054fc5742c51a0db9319c759bd3743',
  },
}

describe('X402_TOKEN_DOMAINS — DOMAIN_SEPARATOR reconstruction', () => {
  for (const [chainIdStr, tokens] of Object.entries(X402_TOKEN_DOMAINS)) {
    const chainId = Number(chainIdStr)
    for (const [tokenAddress, domain] of Object.entries(tokens)) {
      const expectedFixture = ON_CHAIN_DOMAIN_SEPARATORS[chainId]?.[tokenAddress]

      it(`reconstructs DOMAIN_SEPARATOR for chain ${chainId} token ${tokenAddress}`, () => {
        if (!expectedFixture) {
          throw new Error(
            `Missing on-chain fixture for chain ${chainId} token ${tokenAddress}. ` +
              `Capture it via eth_call selector 0x3644e515 and add to ON_CHAIN_DOMAIN_SEPARATORS.`,
          )
        }
        const reconstructed = reconstructDomainSeparator(
          domain.name,
          domain.version,
          chainId,
          tokenAddress as `0x${string}`,
        )
        expect(reconstructed.toLowerCase()).toBe(expectedFixture.toLowerCase())
      })
    }
  }
})

describe('getX402TokenDomain', () => {
  it('returns domain for known token (case-insensitive address)', () => {
    const domain = getX402TokenDomain(196, '0x779DED0C9E1022225F8E0630B35A9B54BE713736')
    expect(domain).toEqual({ name: 'USD₮0', version: '1' })
  })

  it('returns undefined for unknown chain', () => {
    expect(getX402TokenDomain(1, '0x779ded0c9e1022225f8e0630b35a9b54be713736')).toBeUndefined()
  })

  it('returns undefined for unknown token on known chain', () => {
    expect(getX402TokenDomain(196, '0x0000000000000000000000000000000000000000')).toBeUndefined()
  })
})
