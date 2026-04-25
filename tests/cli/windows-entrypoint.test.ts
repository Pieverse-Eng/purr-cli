import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const entrypoint = 'packages/cli/src/windows.ts'

describe('Windows CLI entrypoint', () => {
  it('runs non-OWS builders', async () => {
    const { stdout } = await execFileAsync('bun', [
      entrypoint,
      'evm',
      'raw',
      '--to',
      '0x0000000000000000000000000000000000000001',
      '--data',
      '0x',
      '--chain-id',
      '1',
    ])
    expect(JSON.parse(stdout).steps[0].to).toBe('0x0000000000000000000000000000000000000001')
  })

  it('disables OWS commands without loading the OWS plugin', async () => {
    await expect(
      execFileAsync('bun', [
        entrypoint,
        'ows-wallet',
        'sign-transaction',
        '--ows-wallet',
        'treasury',
        '--txs-json',
        '{"txs":[{}]}',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('OWS is not available in the Windows build'),
    })
  })
})
