import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requireArgOrFile } from '@pieverseio/purr-core/file-input'

describe('requireArgOrFile', () => {
  it('prefers inline values when provided', () => {
    const value = requireArgOrFile(
      { 'login-signature': '0xinline', 'login-signature-file': '/tmp/ignored' },
      'login-signature',
      'login-signature-file',
    )
    expect(value).toBe('0xinline')
  })

  it('reads and trims values from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purr-file-input-'))
    const filePath = join(dir, 'sig.txt')
    writeFileSync(filePath, '0xfromfile\n', 'utf8')

    const value = requireArgOrFile(
      { 'login-signature-file': filePath },
      'login-signature',
      'login-signature-file',
    )
    expect(value).toBe('0xfromfile')
  })

  it('throws when neither inline nor file input is provided', () => {
    expect(() => requireArgOrFile({}, 'login-signature', 'login-signature-file')).toThrow(
      'Missing required argument: --login-signature or --login-signature-file',
    )
  })

  it('throws when the file cannot be read', () => {
    expect(() =>
      requireArgOrFile(
        { 'login-signature-file': '/tmp/does-not-exist.txt' },
        'login-signature',
        'login-signature-file',
      ),
    ).toThrow('Cannot read login-signature file')
  })

  it('throws when the file is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purr-file-input-empty-'))
    const filePath = join(dir, 'empty.txt')
    writeFileSync(filePath, '   \n', 'utf8')

    expect(() =>
      requireArgOrFile(
        { 'login-signature-file': filePath },
        'login-signature',
        'login-signature-file',
      ),
    ).toThrow('is empty')
  })
})
