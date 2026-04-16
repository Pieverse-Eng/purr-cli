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

export function extractArchive(archivePath: string, targetDir: string): void {
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return runCandidates([
      ['tar', ['-xzf', archivePath, '-C', targetDir]],
      ['python3', ['-c', 'import tarfile,sys;tarfile.open(sys.argv[1]).extractall(sys.argv[2])', archivePath, targetDir]],
    ])
  }
  return runCandidates([
    ['unzip', ['-o', archivePath, '-d', targetDir]],
    ['python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archivePath, targetDir]],
  ])
}
