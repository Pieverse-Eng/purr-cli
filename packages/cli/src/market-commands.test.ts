import { describe, expect, it, vi } from 'vitest'
import { marketArgv, marketHelp } from './market'

describe('market command routing', () => {
  it.each(['read-pages', 'snapshot'])(
    'rejects retired %s without network calls',
    async (command) => {
      const fetcher = vi.spyOn(globalThis, 'fetch')
      try {
        await expect(marketArgv(command, [])).rejects.toThrow('Unknown market command')
        expect(fetcher).not.toHaveBeenCalled()
        expect(marketHelp).not.toContain(command)
      } finally {
        fetcher.mockRestore()
      }
    },
  )
  it('rejects invalid trending arguments', async () => {
    await expect(marketArgv('trending', ['--chain'])).rejects.toThrow('Missing')
    await expect(marketArgv('trending', ['--chain', 'bnb', '--chain', 'solana'])).rejects.toThrow(
      'Duplicate',
    )
    await expect(marketArgv('trending', ['--chain', 'bnb', 'extra'])).rejects.toThrow('positional')
  })
})
