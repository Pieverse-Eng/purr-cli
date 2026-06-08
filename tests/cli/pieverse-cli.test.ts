import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runPurr(args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy, ...cleanEnv } =
      process.env
    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...cleanEnv,
        NO_PROXY: '*',
        no_proxy: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

describe('Pieverse CLI routing', () => {
  it('lists the pieverse public campaign command group', async () => {
    const result = await runPurr(['--help'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('pieverse          Pieverse campaign card flow')
    expect(result.stdout).toContain('pns               Pie Name Service lookup helpers')
    expect(result.stdout).toContain('purr pieverse card purchase')
    expect(result.stdout).toContain('purr pieverse meme-judge purchase')
    expect(result.stdout).toContain('purr pns resolve alice')
  })

  it('routes pieverse card commands through the card handler', async () => {
    const result = await runPurr(['pieverse', 'card', 'unknown-command'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown pieverse card command')
  })

  it('routes pieverse meme-judge commands through the meme judge handler', async () => {
    const result = await runPurr(['pieverse', 'meme-judge', 'unknown-command'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown pieverse meme-judge command')
  })

  it('rejects card-only campaign parameters for meme-judge commands', async () => {
    const result = await runPurr(['pieverse', 'meme-judge', 'purchase', '--channel', 'line'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('do not accept --channel')
  })

  it('keeps pns resolve to one positional handle with no raw flag', async () => {
    const result = await runPurr(['pns', 'resolve', '--raw'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: purr pns resolve <handle>')
  })
})
