import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runPurr(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy, ...cleanEnv } =
      process.env
    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...cleanEnv,
        NO_PROXY: '*',
        no_proxy: '*',
        ...envOverrides,
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

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local mock server'))
        return
      }
      resolve(address.port)
    })
  })
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

describe('Pieverse CLI routing', () => {
  it('lists the pieverse public campaign command group', async () => {
    const result = await runPurr(['--help'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('pieverse          Pieverse campaigns and PIEVERSE staking')
    expect(result.stdout).toContain(
      'pns               Pie Name Service and identity lookup helpers',
    )
    expect(result.stdout).toContain(
      '.pie              Resolve .pie identities and transfer to their wallets',
    )
    expect(result.stdout).toContain('redpacket         P2P XLayer USDT0 redpackets')
    expect(result.stdout).toContain('purr pieverse card purchase')
    expect(result.stdout).toContain('purr pieverse purrfect-yap purchase')
    expect(result.stdout).toContain('purr pieverse staking contracts')
    expect(result.stdout).toContain('purr pns resolve alice')
    expect(result.stdout).toContain('purr redpacket send --recipient alice.pie --amount 0.1')
    expect(result.stdout).toContain('purr .pie transfer --pie alice.pie')
  })

  it('routes redpacket commands through the redpacket handler', async () => {
    const result = await runPurr(['redpacket', 'unknown-command'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown redpacket command')
  })

  it('routes pieverse card commands through the card handler', async () => {
    const result = await runPurr(['pieverse', 'card', 'unknown-command'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown pieverse card command')
  })

  it('routes pieverse purrfect-yap commands through the PurrfectYap handler', async () => {
    const result = await runPurr(['pieverse', 'purrfect-yap', 'unknown-command'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown pieverse purrfect-yap command')
    expect(result.stderr).not.toContain('score')
  })

  it('rejects card-only campaign parameters for purrfect-yap commands', async () => {
    const result = await runPurr(['pieverse', 'purrfect-yap', 'purchase', '--channel', 'line'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('do not accept --channel')
  })

  it('does not keep the old meme-judge command name', async () => {
    const result = await runPurr(['pieverse', 'meme-judge', 'purchase'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      'Unknown pieverse command: meme-judge. Use: card, purrfect-yap, staking',
    )
  })

  it('lists both configured Pieverse staking networks', async () => {
    const result = await runPurr(['pieverse', 'staking', 'contracts'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const contracts = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(contracts.map((deployment) => deployment.chainId)).toEqual([1, 56])
    expect(Object.keys(contracts[0])).toEqual(['chainId', 'pieverse', 'staking', 'durations'])
    expect(contracts[0]).toMatchObject({
      pieverse: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
      staking: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
    })
    expect(contracts[1]).toMatchObject({
      pieverse: '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9',
      staking: '0xaE4c8Ca1dC8127C380099657774CB09ca8197e78',
    })
    expect(contracts[0]?.durations).toEqual(['90d', '180d', '365d'])
  })

  it('builds Pieverse staking steps from the nested command', async () => {
    const result = await runPurr([
      'pieverse',
      'staking',
      'stake',
      '--amount-wei',
      '1000000000000000000',
      '--duration',
      '90d',
      '--chain-id',
      '1',
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout) as { steps: unknown[] }
    expect(output.steps).toHaveLength(2)
  })

  it('rejects Pieverse staking amounts with more than two decimal places', async () => {
    const result = await runPurr([
      'pieverse',
      'staking',
      'stake',
      '--amount-wei',
      '1234000000000000000',
      '--duration',
      '90d',
      '--chain-id',
      '1',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('supports at most 2 decimal places')
  })

  it('reads Pieverse staking positions for the configured agent wallet', async () => {
    const agentWallet = '0x1111111111111111111111111111111111111111'
    const requests: Array<{ method: string | undefined; path: string | undefined }> = []
    let authorization: string | undefined
    const server = createServer(async (request, response) => {
      requests.push({ method: request.method, path: request.url })
      authorization = request.headers.authorization

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            chainId: 56,
            wallet: agentWallet,
            pieverseBalanceWei: '0',
            paused: false,
            stakes: [],
          },
        }),
      )
    })
    const port = await listen(server)

    try {
      const result = await runPurr(['pieverse', 'staking', 'positions', '--chain-id', '56'], {
        WALLET_API_URL: `http://127.0.0.1:${port}`,
        WALLET_API_TOKEN: 'test-token',
        INSTANCE_ID: 'inst-pieverse-staking-test',
      })

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        chainId: 56,
        wallet: agentWallet,
        pieverseBalanceWei: '0',
        paused: false,
        stakes: [],
      })
      expect(requests[0]).toEqual({
        method: 'GET',
        path: '/v1/instances/inst-pieverse-staking-test/wallet/staking/positions?chain_id=56',
      })
      expect(authorization).toBe('Bearer test-token')
      expect(requests).toHaveLength(1)
    } finally {
      await close(server)
    }
  })

  it('rejects unsupported Pieverse staking arguments', async () => {
    for (const unsupported of ['--not-supported', 'unexpected-positional', '-x']) {
      const result = await runPurr(['pieverse', 'staking', 'contracts', unsupported])

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(
        `Unsupported argument for purr pieverse staking contracts: ${unsupported}`,
      )
    }
  })

  it('does not expose dedup keys for Pieverse staking writes', async () => {
    const result = await runPurr([
      'pieverse',
      'staking',
      'withdraw',
      '--stake-id',
      '0',
      '--chain-id',
      '56',
      '--dedup-key',
      'user-supplied-key',
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      'Unsupported argument for purr pieverse staking withdraw: --dedup-key',
    )
  })

  it('executes Pieverse staking steps through the configured agent wallet', async () => {
    let executeBody: Record<string, unknown> | undefined
    let executePath: string | undefined
    let authorization: string | undefined
    const server = createServer(async (request, response) => {
      executePath = request.url
      authorization = request.headers.authorization
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      executeBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            results: [
              {
                stepIndex: 0,
                label: 'Approve PIEVERSE for Pieverse staking',
                hash: '',
                status: 'skipped',
              },
              {
                stepIndex: 1,
                label: 'Stake PIEVERSE for 180 days',
                hash: `0x${'1'.repeat(64)}`,
                status: 'success',
              },
            ],
            from: '0x1111111111111111111111111111111111111111',
            chainId: 56,
            chainType: 'ethereum',
          },
        }),
      )
    })
    const port = await listen(server)

    try {
      const result = await runPurr(
        [
          'pieverse',
          'staking',
          'stake',
          '--amount-wei',
          '2500000000000000000',
          '--duration',
          '180d',
          '--chain-id',
          '56',
          '--execute',
        ],
        {
          WALLET_API_URL: `http://127.0.0.1:${port}`,
          WALLET_API_TOKEN: 'test-token',
          INSTANCE_ID: 'inst-pieverse-staking-test',
        },
      )

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      const output = JSON.parse(result.stdout) as Record<string, unknown>
      expect(output).toMatchObject({ chainId: 56, chainType: 'ethereum' })
      expect(output).not.toHaveProperty('ok')
      expect(output).not.toHaveProperty('data')
      expect(executePath).toBe('/v1/instances/inst-pieverse-staking-test/wallet/execute')
      expect(authorization).toBe('Bearer test-token')
      expect(executeBody).not.toHaveProperty('dedupKey')
      const steps = executeBody?.steps as Array<Record<string, unknown>>
      expect(steps).toHaveLength(2)
      expect(steps.map((step) => step.chainId)).toEqual([56, 56])
      expect(steps[0]?.conditional).toMatchObject({
        type: 'allowance_lt',
        amount: '2500000000000000000',
      })
    } finally {
      await close(server)
    }
  })

  it('keeps pns resolve to one positional handle with no raw flag', async () => {
    const result = await runPurr(['pns', 'resolve', '--raw'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: purr pns resolve <handle>')
  })
})
