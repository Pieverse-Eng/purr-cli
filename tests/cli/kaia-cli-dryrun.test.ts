import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const INSTANCE_ID = 'inst-kaia-e2e'
const API_TOKEN = 'test-token'
const EVM_ADDRESS = '0x3Be54a24B631301E42d907dc62a24F713147a2a9'
const SOLANA_ADDRESS = 'FuQPd1q11111111111111111111111111111111111'
const TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111'
const SPENDER_ADDRESS = '0x2222222222222222222222222222222222222222'
const RECIPIENT_ADDRESS = '0x3333333333333333333333333333333333333333'
const CONTRACT_ADDRESS = '0x4444444444444444444444444444444444444444'
const MOCK_HASH = `0x${'a'.repeat(64)}`
const MOCK_SIG = `0x${'b'.repeat(130)}`

type JsonObject = Record<string, unknown>

function readBody(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
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

async function runPurr(port: number, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('bun', ['packages/cli/src/linux-macos.ts', ...args], {
      cwd: join(process.cwd()),
      env: {
        ...process.env,
        WALLET_API_URL: `http://127.0.0.1:${port}`,
        WALLET_API_TOKEN: API_TOKEN,
        INSTANCE_ID,
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
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            [
              `Command failed: bun packages/cli/src/linux-macos.ts ${args.join(' ')}`,
              stdout ? `stdout:\n${stdout}` : '',
              stderr ? `stderr:\n${stderr}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        )
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function runJson<T>(port: number, args: string[]): Promise<T> {
  const stdout = await runPurr(port, args)
  return JSON.parse(stdout) as T
}

describe('Kaia CLI dry-run', () => {
  let port = 0
  let started = false
  let tmpRoot = ''
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      assert.equal(req.headers.authorization, `Bearer ${API_TOKEN}`)

      if (req.method === 'POST' && url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/ensure`) {
        const body = await readBody(req)
        if (body.chainType === 'solana') {
          writeJson(res, 200, {
            ok: true,
            data: {
              address: SOLANA_ADDRESS,
              chainId: 101,
              chainType: 'solana',
              createdNow: false,
            },
          })
          return
        }

        assert.equal(body.chainType, 'ethereum')
        assert.equal(body.chainId, 8217)
        writeJson(res, 200, {
          ok: true,
          data: {
            address: EVM_ADDRESS,
            chainId: 8217,
            chainType: 'ethereum',
            createdNow: false,
          },
        })
        return
      }

      if (req.method === 'GET' && url.pathname === `/v1/instances/${INSTANCE_ID}/wallet`) {
        assert.equal(url.searchParams.get('chain_id'), '8217')
        assert.equal(url.searchParams.get('balance'), 'true')
        const token = url.searchParams.get('token')
        if (token) {
          assert.equal(url.searchParams.get('chain_type'), 'ethereum')
          assert.equal(token.toLowerCase(), TOKEN_ADDRESS.toLowerCase())
          writeJson(res, 200, {
            ok: true,
            data: {
              address: EVM_ADDRESS,
              chainId: 8217,
              chainType: 'ethereum',
              tokenAddress: TOKEN_ADDRESS,
              balance: '1234500',
              balanceFormatted: '1.2345',
              symbol: 'MOCK',
              decimals: 6,
            },
          })
          return
        }

        writeJson(res, 200, {
          ok: true,
          data: {
            address: EVM_ADDRESS,
            chainId: 8217,
            chainType: 'ethereum',
            balance: '10000000000000000',
            balanceFormatted: '0.01',
            currency: 'KAIA',
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/sign`) {
        const body = await readBody(req)
        assert.equal(body.message, 'Kaia dryrun sign test')
        assert.equal(body.chainType, 'ethereum')
        writeJson(res, 200, {
          ok: true,
          data: {
            address: EVM_ADDRESS,
            signature: MOCK_SIG,
            chainType: 'ethereum',
            message: body.message,
          },
        })
        return
      }

      if (
        req.method === 'POST' &&
        url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/sign-typed-data`
      ) {
        const body = await readBody(req)
        assert.equal((body.domain as JsonObject)?.chainId, 8217)
        assert.equal(body.primaryType, 'Mail')
        writeJson(res, 200, {
          ok: true,
          data: {
            address: EVM_ADDRESS,
            signature: MOCK_SIG,
          },
        })
        return
      }

      if (
        req.method === 'POST' &&
        url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/sign-transaction`
      ) {
        const body = await readBody(req)
        assert.equal(body.chainId, 8217)
        const txs = body.txs as Array<JsonObject>
        assert.ok(Array.isArray(txs))
        assert.equal(txs[0]?.chainId, 8217)
        writeJson(res, 200, {
          ok: true,
          data: {
            address: EVM_ADDRESS,
            txs: txs.map((tx) => ({ ...tx, sig: MOCK_SIG })),
          },
        })
        return
      }

      if (
        req.method === 'POST' &&
        url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/transfer`
      ) {
        const body = await readBody(req)
        assert.equal(body.chainType, 'ethereum')
        assert.equal(body.chainId, 8217)
        assert.equal(String(body.to).toLowerCase(), RECIPIENT_ADDRESS.toLowerCase())
        if (body.assetType === 'erc20') {
          assert.equal(String(body.tokenAddress).toLowerCase(), TOKEN_ADDRESS.toLowerCase())
        } else {
          assert.equal(body.assetType, 'native')
        }
        writeJson(res, 200, {
          ok: true,
          data: {
            from: EVM_ADDRESS,
            to: body.to,
            amount: body.amount,
            hash: MOCK_HASH,
            chainId: 8217,
            chainType: 'ethereum',
            assetType: body.assetType,
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === `/v1/instances/${INSTANCE_ID}/wallet/execute`) {
        const body = await readBody(req)
        if (Array.isArray(body.steps)) {
          assert.equal(body.dedupKey, 'kaia-dryrun-001')
          for (const step of body.steps as Array<JsonObject>) {
            assert.equal(step.chainId, 8217)
          }
          writeJson(res, 200, {
            results: (body.steps as Array<JsonObject>).map((step, index) => ({
              stepIndex: index,
              label: step.label,
              hash: `0x${String(index + 1).padStart(64, '0')}`,
              status: 'success',
            })),
            from: EVM_ADDRESS,
            chainId: 8217,
            chainType: 'ethereum',
          })
          return
        }

        assert.equal(body.chainId, 8217)
        assert.equal(String(body.to).toLowerCase(), CONTRACT_ADDRESS.toLowerCase())
        assert.equal(body.functionName, 'register')
        assert.deepEqual(body.args, ['https://example.com/agent.json'])
        writeJson(res, 200, {
          ok: true,
          data: {
            hash: MOCK_HASH,
            from: EVM_ADDRESS,
            chainId: 8217,
            chainType: 'ethereum',
            transactionId: 'tx-kaia-dryrun',
          },
        })
        return
      }

      throw new Error(`Unhandled route: ${req.method} ${url.pathname}${url.search}`)
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'purr-kaia-dryrun-'))
    port = await listen(server)
    started = true
  })

  afterAll(async () => {
    if (started) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve(undefined)
        })
      })
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('supports Kaia wallet, evm builder, and execute dry-runs through the CLI entrypoint', async () => {
    const typedDataPath = join(tmpRoot, 'typed-data.json')
    writeFileSync(
      typedDataPath,
      JSON.stringify({
        domain: { name: 'Purr Kaia Dryrun', version: '1', chainId: 8217 },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
          ],
          Mail: [{ name: 'contents', type: 'string' }],
        },
        primaryType: 'Mail',
        message: { contents: 'Kaia typed-data dryrun' },
      }),
    )

    const ethAddress = await runJson<{ address: string; chainId: number; chainType: string }>(
      port,
      ['wallet', 'address', '--chain-type', 'ethereum', '--chain-id', '8217'],
    )
    expect(ethAddress).toMatchObject({
      address: EVM_ADDRESS,
      chainId: 8217,
      chainType: 'ethereum',
    })

    const solAddress = await runJson<{ address: string; chainType: string }>(port, [
      'wallet',
      'address',
      '--chain-type',
      'solana',
    ])
    expect(solAddress).toMatchObject({
      address: SOLANA_ADDRESS,
      chainType: 'solana',
    })

    const nativeBalance = await runJson<{ currency: string; chainId: number }>(port, [
      'wallet',
      'balance',
      '--chain-id',
      '8217',
    ])
    expect(nativeBalance).toMatchObject({ currency: 'KAIA', chainId: 8217 })

    const tokenBalance = await runJson<{ tokenAddress: string; symbol: string }>(port, [
      'wallet',
      'balance',
      '--chain-id',
      '8217',
      '--token',
      TOKEN_ADDRESS,
    ])
    expect(tokenBalance).toMatchObject({ tokenAddress: TOKEN_ADDRESS, symbol: 'MOCK' })

    const signResult = await runJson<{ address: string; chainType: string; message: string }>(
      port,
      [
        'wallet',
        'sign',
        '--address',
        EVM_ADDRESS,
        '--message',
        'Kaia dryrun sign test',
        '--chain-type',
        'ethereum',
      ],
    )
    expect(signResult).toMatchObject({
      address: EVM_ADDRESS,
      chainType: 'ethereum',
      message: 'Kaia dryrun sign test',
    })

    const typedResult = await runJson<{ address: string; signature: string }>(port, [
      'wallet',
      'sign-typed-data',
      '--address',
      EVM_ADDRESS,
      '--data',
      typedDataPath,
    ])
    expect(typedResult).toMatchObject({ address: EVM_ADDRESS, signature: MOCK_SIG })

    const signTxResult = await runJson<{ txs: Array<{ chainId: number; sig: string }> }>(port, [
      'wallet',
      'sign-transaction',
      '--chain-id',
      '8217',
      '--txs-json',
      JSON.stringify({
        txs: [
          {
            chainId: 8217,
            msgs: [{ signType: 'eth_sign', hash: `0x${'1'.repeat(64)}` }],
          },
        ],
      }),
    ])
    expect(signTxResult.txs[0]).toMatchObject({ chainId: 8217, sig: MOCK_SIG })

    const nativeTransfer = await runJson<{ chainId: number; assetType: string }>(port, [
      'wallet',
      'transfer',
      '--to',
      RECIPIENT_ADDRESS,
      '--amount',
      '0.01',
      '--chain-id',
      '8217',
    ])
    expect(nativeTransfer).toMatchObject({ chainId: 8217, assetType: 'native' })

    const tokenTransfer = await runJson<{ chainId: number; assetType: string }>(port, [
      'wallet',
      'transfer',
      '--to',
      RECIPIENT_ADDRESS,
      '--amount',
      '1000',
      '--chain-id',
      '8217',
      '--token',
      TOKEN_ADDRESS,
    ])
    expect(tokenTransfer).toMatchObject({ chainId: 8217, assetType: 'erc20' })

    const abiCall = await runJson<{ chainId: number; transactionId: string }>(port, [
      'wallet',
      'abi-call',
      '--to',
      CONTRACT_ADDRESS,
      '--signature',
      'register(string)',
      '--args',
      '["https://example.com/agent.json"]',
      '--chain-id',
      '8217',
    ])
    expect(abiCall).toMatchObject({ chainId: 8217, transactionId: 'tx-kaia-dryrun' })

    const approveSteps = await runJson<{ steps: Array<JsonObject> }>(port, [
      'evm',
      'approve',
      '--token',
      TOKEN_ADDRESS,
      '--spender',
      SPENDER_ADDRESS,
      '--amount',
      '1000000',
      '--chain-id',
      '8217',
    ])
    expect(approveSteps.steps[0]?.chainId).toBe(8217)

    const nativeTransferSteps = await runJson<{ steps: Array<JsonObject> }>(port, [
      'evm',
      'transfer',
      '--to',
      RECIPIENT_ADDRESS,
      '--amount-wei',
      '1000',
      '--chain-id',
      '8217',
    ])
    expect(nativeTransferSteps.steps[0]?.chainId).toBe(8217)

    const tokenTransferSteps = await runJson<{ steps: Array<JsonObject> }>(port, [
      'evm',
      'transfer',
      '--to',
      RECIPIENT_ADDRESS,
      '--amount-wei',
      '2000',
      '--chain-id',
      '8217',
      '--token',
      TOKEN_ADDRESS,
    ])
    expect(tokenTransferSteps.steps[0]?.chainId).toBe(8217)

    const rawSteps = await runJson<{ steps: Array<JsonObject> }>(port, [
      'evm',
      'raw',
      '--to',
      CONTRACT_ADDRESS,
      '--data',
      '0x1234',
      '--chain-id',
      '8217',
      '--value',
      '0',
      '--gas-limit',
      '21000',
    ])
    expect(rawSteps.steps[0]?.chainId).toBe(8217)

    const abiSteps = await runJson<{ steps: Array<JsonObject> }>(port, [
      'evm',
      'abi-call',
      '--to',
      CONTRACT_ADDRESS,
      '--signature',
      'register(string)',
      '--args',
      '["https://example.com/agent.json"]',
      '--chain-id',
      '8217',
      '--gas-limit',
      '500000',
    ])
    expect(abiSteps.steps[0]?.chainId).toBe(8217)

    const stepsFile = join(tmpRoot, 'kaia-steps.json')
    writeFileSync(
      stepsFile,
      JSON.stringify({
        steps: [
          ...approveSteps.steps,
          ...nativeTransferSteps.steps,
          ...tokenTransferSteps.steps,
          ...rawSteps.steps,
          ...abiSteps.steps,
        ],
      }),
    )

    const executeResult = await runJson<{ chainId: number; results: Array<{ status: string }> }>(
      port,
      ['execute', '--steps-file', stepsFile, '--dedup-key', 'kaia-dryrun-001'],
    )
    expect(executeResult.chainId).toBe(8217)
    expect(executeResult.results).toHaveLength(5)
    expect(executeResult.results.every((r) => r.status === 'success')).toBe(true)
  }, 20000)
})
