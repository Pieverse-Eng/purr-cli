#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const targets = {
  'linux-macos': {
    entrypoint: 'packages/cli/src/linux-macos.ts',
    outfile: 'dist/purr',
    args: [],
  },
  windows: {
    entrypoint: 'packages/cli/src/windows.ts',
    outfile: 'dist/purr-windows-x64.exe',
    args: ['--target=bun-windows-x64-baseline', '--external', '@pieverseio/purr-plugin-ows'],
  },
}

const targetName = process.argv[2]
const target = targets[targetName]

if (!target) {
  console.error(`Usage: bun scripts/build-binary.js <${Object.keys(targets).join('|')}>`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = process.env.PURR_VERSION ?? `v${pkg.version}`

mkdirSync(dirname(resolve(target.outfile)), { recursive: true })

const result = spawnSync(
  'bun',
  [
    'build',
    target.entrypoint,
    '--compile',
    ...target.args,
    '--outfile',
    target.outfile,
    '--define',
    `PURR_VERSION='${version}'`,
  ],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
