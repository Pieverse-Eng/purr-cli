import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

it('uses platform quote by default and execute only explicitly, without client-side routing', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  let fail = false
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    expect(req.headers.authorization).toBe('Bearer fixture-token')
    requests.push({ url: req.url!, body: JSON.parse(body) })
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify(
        fail
          ? { ok: false, error: 'No quotes available' }
          : {
              ok: true,
              data: {
                route: { protocol: 'v3', fees: [2500] },
                estimatedToAmount: '123',
                minimumToAmount: '122',
              },
            },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const run = (extra: string[] = [], command = 'swap') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        'bun',
        [
          'packages/cli/src/linux-macos.ts',
          'pancake',
          command,
          '--from',
          'USDT',
          '--to',
          'CAKE',
          '--amount',
          '100',
          '--slippage',
          '0.5',
          ...extra,
        ],
        {
          env: {
            ...process.env,
            WALLET_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            WALLET_API_TOKEN: 'fixture-token',
            INSTANCE_ID: 'fixture',
          },
        },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (data) => {
        stdout += data
      })
      child.stderr.on('data', (data) => {
        stderr += data
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  try {
    const quote = await run()
    expect(quote.code, quote.stderr).toBe(0)
    expect(JSON.parse(quote.stdout).route.protocol).toBe('v3')
    expect(requests[0]).toEqual({
      url: '/v1/instances/fixture/wallet/pancake/quote',
      body: {
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        fromAmount: '100',
        chainId: 56,
        slippageTolerance: 0.5,
      },
    })
    expect((await run(['--execute', '--min-amount-out', '122'])).code).toBe(0)
    expect(requests[1].url).toBe('/v1/instances/fixture/wallet/pancake/execute')
    expect(requests[1].body.minAmountOut).toBe('122')
    for (const flag of [
      'fees',
      'router',
      'path',
      'wallet',
      'deadline',
      'amount-in-wei',
      'recipient',
      'chain',
    ]) {
      expect((await run([`--${flag}`, '1'])).code).not.toBe(0)
    }
    expect((await run(['--execute'], 'quote')).code).not.toBe(0)
    expect(requests).toHaveLength(2)
    fail = true
    const failed = await run()
    expect(failed.code).not.toBe(0)
    expect(failed.stderr).toContain('No quotes available')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
