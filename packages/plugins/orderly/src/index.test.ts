import { describe, expect, it } from 'vitest'
import { orderlyCanonicalMessage, orderlyHelp, toBase64Url } from './index.js'

describe('Orderly request authentication', () => {
  it('keeps the exact query string and body in the canonical signed message', () => {
    expect(
      orderlyCanonicalMessage(
        '1700000000000',
        'POST',
        '/v1/order?symbol=PERP_BTC_USDC',
        '{"symbol":"PERP_BTC_USDC","side":"BUY"}',
      ),
    ).toBe(
      '1700000000000POST/v1/order?symbol=PERP_BTC_USDC{"symbol":"PERP_BTC_USDC","side":"BUY"}',
    )
  })

  it('converts TEE base64 signatures to Orderly unpadded base64url', () => {
    expect(toBase64Url('++//aA==')).toBe('--__aA')
  })
})

describe('Orderly CLI help', () => {
  it('documents preview-first writes and dynamic network discovery', () => {
    expect(orderlyHelp()).toContain('networks')
    expect(orderlyHelp()).toContain('--execute true')
    expect(orderlyHelp()).toContain('ORDERLY_BROKER_ID')
  })
})
