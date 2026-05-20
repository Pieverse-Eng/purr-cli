import type { PieverseCardOptions } from './types.js'

export function parseCardOptions(args: Record<string, string>): PieverseCardOptions {
  return {
    purchaseId: args['purchase-id'],
    receiptTimeoutMs: parseOptionalPositiveInt(args['receipt-timeout-ms'], 'receipt-timeout-ms'),
    receiptPollMs: parseOptionalPositiveInt(args['receipt-poll-ms'], 'receipt-poll-ms'),
    submittedTimeoutMs: parseOptionalPositiveInt(
      args['submitted-timeout-ms'],
      'submitted-timeout-ms',
    ),
    submittedPollMs: parseOptionalPositiveInt(args['submitted-poll-ms'], 'submitted-poll-ms'),
    wait: parseOptionalBoolean(args.wait, 'wait'),
    createTxHash: parseOptionalTxHash(args['create-tx-hash'], 'create-tx-hash'),
    registerTxHash: parseOptionalTxHash(args['register-tx-hash'], 'register-tx-hash'),
    setBudgetTxHash: parseOptionalTxHash(args['set-budget-tx-hash'], 'set-budget-tx-hash'),
    approveTxHash:
      args['approve-tx-hash'] === undefined
        ? undefined
        : parseOptionalTxHash(args['approve-tx-hash'], 'approve-tx-hash'),
    fundTxHash: parseOptionalTxHash(args['fund-tx-hash'], 'fund-tx-hash'),
  }
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: "${value}"`)
  }
  return parsed
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new Error(`Invalid --${name}: "${value}"`)
}

function parseOptionalTxHash(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid --${name}: "${value}"`)
  return value
}
