import { describe, expect, it } from 'vitest'

describe('pieverse source', () => {
  it('defaults to the platform-hosted app API skill store', async () => {
    const { DEFAULT_SKILL_STORE_URL } = await import('@pieverseio/purr-plugin-store/sources/pieverse')

    expect(DEFAULT_SKILL_STORE_URL).toBe('https://purr.pieverse.io/api/app/skill-store/cli')
  })
})
