export const SERVICE_SLUG = 'agent-self-intro'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const EMPTY_BYTES = '0x'
export const ERC8183_SPONSORED_GAS_PRICE = '0x0'
export const BNB_CHAIN_ID = 56
export const RECEIPT_POLL_MS = 2_000
export const RECEIPT_TIMEOUT_MS = 120_000
export const SUBMITTED_POLL_MS = 2_000
export const SUBMITTED_TIMEOUT_MS = 120_000

export const DEFAULT_RPCS: Record<number, string> = {
  56: 'https://bsc-rpc.publicnode.com',
}

export const ERC8183_JOB_STATUS = {
  OPEN: 0,
  FUNDED: 1,
  SUBMITTED: 2,
  COMPLETED: 3,
  REJECTED: 4,
  EXPIRED: 5,
} as const
