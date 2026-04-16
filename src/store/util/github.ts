import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix as posixPath } from 'node:path'
import { extractArchive } from './archive.js'

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024
const SAFE_REF_RE = /^[a-zA-Z0-9._/-]+$/
const SHA_RE = /^[a-f0-9]{7,40}$/i

function isSafeRef(ref: string): boolean {
  if (!SAFE_REF_RE.test(ref)) return false
  if (ref.startsWith('/') || ref.startsWith('.') || ref.endsWith('/')) return false
  return !ref.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
}

export async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json() as Promise<T>
}

export async function fetchBuffer(
  url: string,
  { maxSize = MAX_ARCHIVE_SIZE, timeoutMs = 180000 } = {},
): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10)
  if (contentLength > maxSize) {
    throw new Error(`Archive is ${contentLength} bytes, exceeds ${maxSize} byte limit`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxSize) {
    throw new Error(`Downloaded ${buf.length} bytes, exceeds ${maxSize} byte limit`)
  }
  return buf
}

export function assertNoPathEscape(baseDir: string): void {
  const real = realpathSync(baseDir)
  const stack = [real]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = realpathSync(join(dir, entry.name))
      if (full !== real && !full.startsWith(`${real}/`)) {
        throw new Error(`Path traversal detected: ${full} escapes ${real}`)
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
}

function assertSafeSubpath(subpath: string): void {
  if (!subpath || subpath === '.' || subpath === '') return
  if (subpath.startsWith('/')) throw new Error(`Subpath must be relative: ${subpath}`)
  const parts = posixPath.normalize(subpath).split('/')
  if (parts.some((p) => p === '..')) throw new Error(`Subpath escapes repo root: ${subpath}`)
}

export async function resolveCommitSha({
  owner,
  repo,
  ref = 'main',
}: {
  owner: string
  repo: string
  ref?: string
}): Promise<string> {
  if (SHA_RE.test(ref)) return ref
  if (!isSafeRef(ref)) throw new Error(`Unsafe ref: ${ref}`)
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${ref}`
  const data = await fetchJson<{ sha?: string }>(url)
  if (!data?.sha || typeof data.sha !== 'string') {
    throw new Error(`Could not resolve ${owner}/${repo}@${ref}`)
  }
  return data.sha
}

function encodeRefForUrl(ref: string): string {
  if (!isSafeRef(ref)) throw new Error(`Unsafe ref: ${ref}`)
  return ref.split('/').map(encodeURIComponent).join('/')
}

export async function fetchRepoSubpath({
  owner,
  repo,
  ref = 'main',
  subpath = '.',
}: {
  owner: string
  repo: string
  ref?: string
  subpath?: string
}): Promise<{ dir: string; cleanup: () => void }> {
  assertSafeSubpath(subpath)
  const safeRef = encodeRefForUrl(ref)
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${safeRef}`
  const buf = await fetchBuffer(url)
  const tmp = mkdtempSync(join(tmpdir(), `purr-gh-${repo}-`))
  try {
    const tarPath = join(tmp, 'repo.tar.gz')
    const extractDir = join(tmp, 'out')
    mkdirSync(extractDir)
    writeFileSync(tarPath, buf)
    extractArchive(tarPath, extractDir)
    assertNoPathEscape(extractDir)

    const entries = readdirSync(extractDir)
    const rootName = entries.find(
      (name) => name.startsWith(`${repo}-`) && statSync(join(extractDir, name)).isDirectory(),
    )
    if (!rootName) throw new Error(`Expected a ${repo}-* directory in the tarball; got: ${entries.join(', ')}`)
    const repoRoot = realpathSync(join(extractDir, rootName))

    const candidate = subpath === '.' || subpath === '' ? repoRoot : join(repoRoot, subpath)
    if (!existsSync(candidate)) throw new Error(`Subpath not found in repo: ${subpath}`)
    const src = realpathSync(candidate)
    if (src !== repoRoot && !src.startsWith(`${repoRoot}/`)) {
      throw new Error(`Subpath ${subpath} resolved outside repo root: ${src}`)
    }

    const staging = mkdtempSync(join(tmpdir(), `purr-skill-`))
    cpSync(src, staging, { recursive: true })
    return {
      dir: staging,
      cleanup: () => rmSync(staging, { recursive: true, force: true }),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
