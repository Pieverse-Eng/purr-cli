import { execFileSync } from 'node:child_process'

const EXTRACT_TIMEOUT = 60000

const SAFE_EXTRACT_SCRIPT = String.raw`
import os
import shutil
import stat
import sys
import tarfile
import zipfile

archive_path, target_dir, kind = sys.argv[1:4]
target_real = os.path.realpath(target_dir)

def fail(message):
    raise Exception(message)

def safe_dest(name):
    normalized = name.replace("\\", "/")
    if not normalized or normalized == ".":
        return target_real
    if normalized.startswith("/") or normalized.startswith("//"):
        fail(f"Unsafe archive entry path: {name}")
    if len(normalized) > 1 and normalized[1] == ":":
        fail(f"Unsafe archive entry path: {name}")
    parts = [part for part in normalized.split("/") if part and part != "."]
    if any(part == ".." for part in parts):
        fail(f"Unsafe archive entry path: {name}")
    dest = os.path.realpath(os.path.join(target_real, *parts))
    if dest != target_real and not dest.startswith(target_real + os.sep):
        fail(f"Unsafe archive entry path: {name}")
    return dest

def write_file(src, dest, mode=None):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as out:
        shutil.copyfileobj(src, out)
    if mode is not None:
        os.chmod(dest, mode & 0o777)

if kind == "tar":
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            safe_dest(member.name)
            if member.issym() or member.islnk():
                fail(f"Archive links are not allowed: {member.name}")
            if not (member.isfile() or member.isdir()):
                fail(f"Unsupported archive entry type: {member.name}")
        for member in archive.getmembers():
            dest = safe_dest(member.name)
            if member.isdir():
                os.makedirs(dest, exist_ok=True)
            else:
                src = archive.extractfile(member)
                if src is None:
                    fail(f"Could not read archive entry: {member.name}")
                with src:
                    write_file(src, dest, member.mode)
elif kind == "zip":
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            safe_dest(info.filename)
            file_type = (info.external_attr >> 16) & 0o170000
            if stat.S_ISLNK(file_type):
                fail(f"Archive links are not allowed: {info.filename}")
        for info in archive.infolist():
            dest = safe_dest(info.filename)
            if info.is_dir():
                os.makedirs(dest, exist_ok=True)
            else:
                mode = (info.external_attr >> 16) & 0o777
                with archive.open(info) as src:
                    write_file(src, dest, mode or None)
else:
    fail(f"Unsupported archive kind: {kind}")
`

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
    runCandidates([['python3', ['-c', SAFE_EXTRACT_SCRIPT, archivePath, targetDir, 'tar']]])
    return
  }
  runCandidates([['python3', ['-c', SAFE_EXTRACT_SCRIPT, archivePath, targetDir, 'zip']]])
}
