import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SKILL_CLI_DEPS,
  installSkillCliDeps,
  parseOnlyList,
  selectDeps,
} from '../../packages/cli/src/deps.ts'

describe('purr deps catalog', () => {
  it('pins the same skill CLIs as the tenant Dockerfiles', () => {
    const versions = Object.fromEntries(SKILL_CLI_DEPS.map((dep) => [dep.id, dep.version]))
    expect(versions).toMatchObject({
      opensea: '1.10.0',
      baw: '1.2.1',
      ows: '1.4.2',
      'mantle-cli': '0.1.19',
      'bnbchain-mcp': '1.5.1',
      onchainos: 'v4.0.0',
      kraken: 'v0.3.2',
      surf: 'v1.0.9',
      caw: 'v0.2.84',
      'gate-cli': 'v0.7.7',
      'gate-dex': '1.0.6',
      websocat: 'v1.13.0',
    })
  })

  it('rejects unknown --only ids', () => {
    expect(() => selectDeps(parseOnlyList('surf,nope'))).toThrow(/Unknown skill CLI id: nope/)
  })
})

describe('purr deps install', () => {
  it('no-ops on hosted runtimes', async () => {
    const outcome = await installSkillCliDeps({
      env: { PURRFECT_RUNTIME: 'hosted' },
      only: ['surf'],
    })
    expect(outcome.skipped).toBe('hosted')
    expect(outcome.results).toEqual([])
  })

  it('installs an npm pin into the dest prefix', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'purr-deps-npm-'))
    const calls: string[][] = []
    const outcome = await installSkillCliDeps({
      destDir,
      only: ['baw'],
      env: {},
      run: (file, args) => {
        calls.push([file, ...args])
        return { status: 0, stdout: 'ok', stderr: '' }
      },
    })
    expect(outcome.results).toEqual([
      {
        id: 'baw',
        bin: 'baw',
        version: '1.2.1',
        status: 'installed',
        detail: '@binance/agentic-wallet@1.2.1',
      },
    ])
    expect(calls[0]?.[0]).toBe('npm')
    expect(calls[0]).toContain('@binance/agentic-wallet@1.2.1')
  })

  it('downloads a binary, checks sha256, and continues after a failure', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'purr-deps-bin-'))
    const body = Buffer.from('surf-bytes')
    const digest = '4f6f2e6c1f1d7d6f6d0f0c6e7f8a9b0c1d2e3f405162738495061728394a5b6c'
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('checksums.txt')) {
        return {
          ok: true,
          arrayBuffer: async () => Buffer.from(`${digest}  surf_linux_amd64`),
        }
      }
      return { ok: true, arrayBuffer: async () => body }
    }) as unknown as typeof fetch

    const outcome = await installSkillCliDeps({
      destDir,
      only: ['surf', 'gate-dex'],
      env: {},
      now: () => ({ os: 'linux', arch: 'amd64' }),
      fetch: fetchImpl,
      run: () => ({ status: 1, stdout: '', stderr: '' }),
    })
    const surf = outcome.results.find((row) => row.id === 'surf')
    const gateDex = outcome.results.find((row) => row.id === 'gate-dex')
    expect(surf?.status).toBe('failed')
    expect(surf?.detail).toMatch(/checksum mismatch/)
    expect(gateDex?.status).toBe('installed')
  })

  it('skips a matching already-installed binary', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'purr-deps-skip-'))
    const binPath = join(destDir, 'surf')
    writeFileSync(binPath, '#!/bin/sh\n')
    const outcome = await installSkillCliDeps({
      destDir,
      only: ['surf'],
      env: {},
      now: () => ({ os: 'linux', arch: 'amd64' }),
      run: (file) => {
        if (file === binPath) return { status: 0, stdout: 'surf 1.0.9\n', stderr: '' }
        return { status: 1, stdout: '', stderr: 'unused' }
      },
    })
    expect(outcome.results[0]).toMatchObject({ id: 'surf', status: 'skipped', detail: 'already installed' })
  })
})
