import { readFileSync } from 'node:fs'

export function requireArgOrFile(
  args: Record<string, string>,
  name: string,
  fileName: string,
): string {
  const direct = args[name]?.trim()
  if (direct) return direct

  const filePath = args[fileName]
  if (!filePath) {
    throw new Error(`Missing required argument: --${name} or --${fileName}`)
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    throw new Error(
      `Cannot read ${name} file "${filePath}" — write the value to a file first, then pass --${fileName} <path>`,
    )
  }

  const value = raw.trim()
  if (!value) {
    throw new Error(`${name} file "${filePath}" is empty`)
  }

  return value
}
