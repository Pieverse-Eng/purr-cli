import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export type CpuArch = 'amd64' | 'arm64'
export type HostOs = 'linux' | 'darwin' | 'windows' | 'other'

export type SkillCliDep = {
  id: string
  bin: string
  version: string
  skills: string[]
  kind: 'npm' | 'binary'
  npmPackage?: string
  resolve?: (host: HostInfo) => BinarySource | null
}

export type BinarySource = {
  url: string
  archive?: 'tar-gz'
  archiveMember?: string
  checksumUrl?: string
  checksumSha256?: string
}

export type HostInfo = { os: HostOs; arch: CpuArch }

export type DepInstallStatus = 'installed' | 'skipped' | 'failed'

export type DepInstallResult = {
  id: string
  bin: string
  version: string
  status: DepInstallStatus
  detail: string
}

export type DepsIo = {
  env?: NodeJS.ProcessEnv
  destDir?: string
  fetch?: typeof fetch
  run?: (
    file: string,
    args: string[],
    opts?: { cwd?: string },
  ) => { status: number; stdout: string; stderr: string }
  now?: () => HostInfo
}

const CAW_SHA256 = {
  amd64: 'ea7eb8a8c56632e390f7f3ecbf0f60dd52da538b958192143126c0f7659b5c5a',
  arm64: '18a8920febd9396f7e9800ddf75a78d811820be75952bb6ba047682dffc102ab',
} as const

function linuxGnuTarget(arch: CpuArch): string {
  return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
}

export const SKILL_CLI_DEPS: SkillCliDep[] = [
  {
    id: 'opensea',
    bin: 'opensea',
    version: '1.10.0',
    skills: ['opensea'],
    kind: 'npm',
    npmPackage: '@opensea/cli',
  },
  {
    id: 'baw',
    bin: 'baw',
    version: '1.2.1',
    skills: ['binance-agentic-wallet'],
    kind: 'npm',
    npmPackage: '@binance/agentic-wallet',
  },
  {
    id: 'ows',
    bin: 'ows',
    version: '1.4.2',
    skills: ['ows'],
    kind: 'npm',
    npmPackage: '@open-wallet-standard/core',
  },
  {
    id: 'mantle-cli',
    bin: 'mantle-cli',
    version: '0.1.19',
    skills: ['mantle'],
    kind: 'npm',
    npmPackage: '@mantleio/mantle-cli',
  },
  {
    id: 'bnbchain-mcp',
    bin: 'bnbchain-mcp',
    version: '1.5.1',
    skills: ['bnbchain-mcp'],
    kind: 'npm',
    npmPackage: '@bnb-chain/mcp',
  },
  {
    id: 'onchainos',
    bin: 'onchainos',
    version: 'v4.0.0',
    skills: ['okx'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux') return null
      const target = linuxGnuTarget(host.arch)
      const file = `onchainos-${target}`
      return {
        url: `https://github.com/okx/onchainos-skills/releases/download/v4.0.0/${file}`,
        checksumUrl:
          'https://github.com/okx/onchainos-skills/releases/download/v4.0.0/checksums.txt',
      }
    },
  },
  {
    id: 'kraken',
    bin: 'kraken',
    version: 'v0.3.2',
    skills: ['kraken'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux') return null
      const target = linuxGnuTarget(host.arch)
      const file = `kraken-cli-${target}.tar.gz`
      return {
        url: `https://github.com/krakenfx/kraken-cli/releases/download/v0.3.2/${file}`,
        checksumUrl: `https://github.com/krakenfx/kraken-cli/releases/download/v0.3.2/${file}.sha256`,
        archive: 'tar-gz',
        archiveMember: 'kraken',
      }
    },
  },
  {
    id: 'surf',
    bin: 'surf',
    version: 'v1.0.9',
    skills: ['surf'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux') return null
      const file = `surf_linux_${host.arch}`
      return {
        url: `https://downloads.asksurf.ai/cli/releases/v1.0.9/${file}`,
        checksumUrl: 'https://downloads.asksurf.ai/cli/releases/v1.0.9/checksums.txt',
      }
    },
  },
  {
    id: 'caw',
    bin: 'caw',
    version: 'v0.2.84',
    skills: ['cobo'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux') return null
      return {
        url: `https://download.agenticwallet.cobo.com/binary-release/v0.2.84/caw-linux-${host.arch}-v0.2.84.tar.gz`,
        checksumSha256: CAW_SHA256[host.arch],
        archive: 'tar-gz',
      }
    },
  },
  {
    id: 'gate-cli',
    bin: 'gate-cli',
    version: 'v0.7.7',
    skills: ['gate'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux') return null
      const file = `gate-cli_0.7.7_linux_${host.arch}.tar.gz`
      return {
        url: `https://github.com/gate/gate-cli/releases/download/v0.7.7/${file}`,
        checksumUrl: 'https://github.com/gate/gate-cli/releases/download/v0.7.7/checksums.txt',
        archive: 'tar-gz',
        archiveMember: 'gate-cli',
      }
    },
  },
  {
    id: 'gate-dex',
    bin: 'gate-dex',
    version: '1.0.6',
    skills: ['gate'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux' || host.arch !== 'amd64') return null
      return {
        url: 'https://gate-dex-cli.gateweb3.cc/v1.0.6/gate-dex-linux-x64',
      }
    },
  },
  {
    id: 'websocat',
    bin: 'websocat',
    version: 'v1.13.0',
    skills: ['opensea'],
    kind: 'binary',
    resolve: (host) => {
      if (host.os !== 'linux') return null
      const rustArch = host.arch === 'arm64' ? 'aarch64' : 'x86_64'
      return {
        url: `https://github.com/vi/websocat/releases/download/v1.13.0/websocat.${rustArch}-unknown-linux-musl`,
      }
    },
  },
]

export function detectHost(env: NodeJS.ProcessEnv = process.env): HostInfo {
  const rawOs = env.PURR_DEPS_OS ?? process.platform
  const rawArch = env.PURR_DEPS_ARCH ?? process.arch
  const os: HostOs =
    rawOs === 'linux' || rawOs === 'darwin' || rawOs === 'win32' || rawOs === 'windows'
      ? rawOs === 'win32'
        ? 'windows'
        : rawOs
      : 'other'
  const arch: CpuArch = rawArch === 'arm64' ? 'arm64' : 'amd64'
  return { os, arch }
}

export function defaultDestDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PURR_BIN_DIR || join(homedir(), '.purrfectclaw', 'bin')
}

export function parseOnlyList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return ids.length > 0 ? ids : undefined
}

export function selectDeps(only?: string[]): SkillCliDep[] {
  if (!only) return SKILL_CLI_DEPS
  const unknown = only.filter((id) => !SKILL_CLI_DEPS.some((dep) => dep.id === id))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown skill CLI id: ${unknown.join(', ')}. Use: ${SKILL_CLI_DEPS.map((dep) => dep.id).join(', ')}`,
    )
  }
  return SKILL_CLI_DEPS.filter((dep) => only.includes(dep.id))
}

function defaultRun(
  file: string,
  args: string[],
  opts?: { cwd?: string },
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd: opts?.cwd,
    timeout: 180_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function parseChecksum(listing: string, filename: string): string | undefined {
  for (const line of listing.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/)
    if (!match) continue
    const name = match[2].split('/').pop()
    if (name === filename || line.includes(filename)) return match[1].toLowerCase()
  }
  const only = listing.trim().match(/^([a-fA-F0-9]{64})\b/)
  return only ? only[1].toLowerCase() : undefined
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function extractMember(
  archive: Buffer,
  member: string | undefined,
  destFile: string,
  run: NonNullable<DepsIo['run']>,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'purr-deps-'))
  try {
    const tarPath = join(dir, 'pkg.tar.gz')
    writeFileSync(tarPath, archive)
    const unpacked = run('tar', ['-xzf', tarPath, '-C', dir])
    if (unpacked.status !== 0) {
      throw new Error(unpacked.stderr.trim() || 'tar extract failed')
    }
    const find = run('find', [
      dir,
      '-type',
      'f',
      '(',
      '-name',
      member ?? '*',
      '-o',
      '-name',
      `${member ?? '*'}*`,
      ')',
    ])
    const candidates = find.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('.tar.gz') && !line.endsWith('.sha256'))
    const hit =
      candidates.find((line) => line.endsWith(`/${member}`) || line.endsWith(`\\${member}`)) ??
      candidates.find((line) => !member || line.includes(member)) ??
      candidates[0]
    if (!hit) throw new Error(`archive did not contain ${member ?? 'a binary'}`)
    const copy = run('install', ['-m', '0755', hit, destFile])
    if (copy.status !== 0) {
      writeFileSync(destFile, readFileSync(hit))
      chmodSync(destFile, 0o755)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function versionLooksInstalled(output: string, version: string): boolean {
  const needle = version.replace(/^v/, '')
  return output.includes(version) || output.includes(needle)
}

function localVersion(binPath: string, run: NonNullable<DepsIo['run']>): string {
  for (const args of [['--version'], ['version'], ['-v']]) {
    const result = run(binPath, args)
    if (result.status === 0 && result.stdout.trim())
      return `${result.stdout}\n${result.stderr}`.trim()
  }
  return ''
}

export async function installSkillCliDeps(
  options: DepsIo & { only?: string[] } = {},
): Promise<{ skipped?: string; results: DepInstallResult[] }> {
  const env = options.env ?? process.env
  if (env.PURRFECT_RUNTIME === 'hosted') {
    return { skipped: 'hosted', results: [] }
  }

  const destDir = options.destDir ?? defaultDestDir(env)
  const fetchImpl = options.fetch ?? fetch
  const run = options.run ?? defaultRun
  const host = options.now ? options.now() : detectHost(env)
  const selected = selectDeps(options.only)
  mkdirSync(destDir, { recursive: true })
  const npmPrefix = dirname(destDir)
  const results: DepInstallResult[] = []

  for (const dep of selected) {
    const destFile = join(destDir, dep.bin)
    try {
      if (existsSync(destFile)) {
        const current = localVersion(destFile, run)
        if (current && versionLooksInstalled(current, dep.version)) {
          results.push({
            id: dep.id,
            bin: dep.bin,
            version: dep.version,
            status: 'skipped',
            detail: 'already installed',
          })
          continue
        }
      }

      if (dep.kind === 'npm') {
        if (!dep.npmPackage) throw new Error('npm package missing')
        const spec = `${dep.npmPackage}@${dep.version}`
        const installed = run('npm', ['install', '-g', '--prefix', npmPrefix, spec])
        if (installed.status !== 0) {
          throw new Error(
            installed.stderr.trim() || installed.stdout.trim() || `npm install ${spec} failed`,
          )
        }
        results.push({
          id: dep.id,
          bin: dep.bin,
          version: dep.version,
          status: 'installed',
          detail: spec,
        })
        continue
      }

      const source = dep.resolve?.(host)
      if (!source) {
        throw new Error(`no download for ${host.os}/${host.arch}`)
      }
      const body = await download(source.url, fetchImpl)
      if (source.checksumSha256) {
        const actual = sha256Hex(body)
        if (actual !== source.checksumSha256) {
          throw new Error(`checksum mismatch: expected ${source.checksumSha256}, got ${actual}`)
        }
      } else if (source.checksumUrl) {
        const listing = (await download(source.checksumUrl, fetchImpl)).toString('utf8')
        const filename = source.url.split('/').pop() ?? dep.bin
        const expected = parseChecksum(listing, filename)
        if (!expected) throw new Error(`checksum not found for ${filename}`)
        const actual = sha256Hex(body)
        if (actual !== expected) {
          throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`)
        }
      }

      if (source.archive === 'tar-gz') {
        extractMember(body, source.archiveMember ?? dep.bin, destFile, run)
      } else {
        writeFileSync(destFile, body)
        chmodSync(destFile, 0o755)
      }
      results.push({
        id: dep.id,
        bin: dep.bin,
        version: dep.version,
        status: 'installed',
        detail: source.url,
      })
    } catch (error) {
      results.push({
        id: dep.id,
        bin: dep.bin,
        version: dep.version,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { results }
}

export function depsHelp(): string {
  return `Usage: purr deps <command> [options]

Commands:
  install [--only <id,id,...>]   Install pinned skill CLIs into ~/.purrfectclaw/bin
  list                           Show the pinned catalog

Hosted images already contain these binaries. Remote onboard should run install once.
`
}

export async function handleDepsCommand(
  command: string | undefined,
  rest: string[],
): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(depsHelp())
    return
  }
  const args = Object.fromEntries(
    rest.flatMap((token, index, all) => {
      if (!token.startsWith('--')) return []
      const name = token.slice(2)
      const next = all[index + 1]
      if (next && !next.startsWith('--')) return [[name, next]] as Array<[string, string]>
      return [[name, 'true']] as Array<[string, string]>
    }),
  ) as Record<string, string>

  if (command === 'list') {
    console.log(
      JSON.stringify(
        SKILL_CLI_DEPS.map((dep) => ({
          id: dep.id,
          bin: dep.bin,
          version: dep.version,
          kind: dep.kind,
          skills: dep.skills,
        })),
        null,
        2,
      ),
    )
    return
  }

  if (command !== 'install') {
    throw new Error(`Unknown deps command: ${command}. Use: install, list`)
  }

  const outcome = await installSkillCliDeps({ only: parseOnlyList(args.only) })
  if (outcome.skipped) {
    console.log(JSON.stringify({ skipped: true, reason: outcome.skipped }, null, 2))
    return
  }
  console.log(JSON.stringify({ results: outcome.results }, null, 2))
  if (outcome.results.some((row) => row.status === 'failed')) {
    process.exitCode = 1
  }
}
