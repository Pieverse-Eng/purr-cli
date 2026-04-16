import { execFileSync } from 'node:child_process'

const EXTRACT_TIMEOUT = 60000

function runCandidates(candidates: [string, string[]][]): void {
  let lastErr: Error | undefined
  for (const [cmd, args] of candidates) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe', timeout: EXTRACT_TIMEOUT })
      return
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw new Error(`All extractors failed: ${lastErr?.message || 'unknown'}`)
}

function lines(output: Buffer): string[] {
  return output.toString('utf8').split(/\r?\n/).filter(Boolean)
}

function assertSafeEntryPath(name: string): void {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized === '.') return
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe archive entry path: ${name}`)
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) {
    throw new Error(`Unsafe archive entry path: ${name}`)
  }
}

function validateTar(archivePath: string): void {
  const names = lines(execFileSync('tar', ['-tf', archivePath], { timeout: EXTRACT_TIMEOUT }))
  const details = lines(execFileSync('tar', ['-tvf', archivePath], { timeout: EXTRACT_TIMEOUT }))
  if (names.length !== details.length) {
    throw new Error('Could not validate tar archive entries')
  }
  names.forEach((name, index) => {
    assertSafeEntryPath(name)
    const type = details[index][0]
    if (type !== '-' && type !== 'd') {
      throw new Error(`Unsupported archive entry type: ${name}`)
    }
  })
}

function validateZip(archivePath: string): void {
  const names = lines(execFileSync('zipinfo', ['-1', archivePath], { timeout: EXTRACT_TIMEOUT }))
  const details = lines(
    execFileSync('zipinfo', ['-l', archivePath], { timeout: EXTRACT_TIMEOUT }),
  ).filter((line) => /^[?dl-][rwx-]{2}/.test(line))
  if (names.length !== details.length) {
    throw new Error('Could not validate zip archive entries')
  }
  names.forEach((name, index) => {
    assertSafeEntryPath(name)
    const type = details[index][0]
    if (type !== '?' && type !== '-' && type !== 'd') {
      throw new Error(`Unsupported archive entry type: ${name}`)
    }
  })
}

export function extractArchive(archivePath: string, targetDir: string): void {
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    validateTar(archivePath)
    runCandidates([
      ['tar', ['-xzf', archivePath, '-C', targetDir]],
      [
        'python3',
        [
          '-c',
          'import tarfile,sys;tarfile.open(sys.argv[1]).extractall(sys.argv[2])',
          archivePath,
          targetDir,
        ],
      ],
    ])
    return
  }
  validateZip(archivePath)
  runCandidates([
    ['unzip', ['-o', archivePath, '-d', targetDir]],
    [
      'python3',
      [
        '-c',
        'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
        archivePath,
        targetDir,
      ],
    ],
  ])
}
