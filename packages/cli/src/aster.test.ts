import { describe, expect, it } from 'vitest'
import { resolveAsterUser } from './aster.js'

describe('resolveAsterUser', () => {
  it('prefers an explicit --user argument over the environment', () => {
    expect(resolveAsterUser({ user: '0xexplicit' }, { ASTER_USER_WALLET: '0xconfigured' })).toBe(
      '0xexplicit',
    )
  })

  it('falls back to ASTER_USER_WALLET', () => {
    expect(resolveAsterUser({}, { ASTER_USER_WALLET: '0xconfigured' })).toBe('0xconfigured')
  })

  it('rejects missing Aster user configuration', () => {
    expect(() => resolveAsterUser({}, {})).toThrow(
      'Missing required argument: --user or ASTER_USER_WALLET',
    )
  })
})
