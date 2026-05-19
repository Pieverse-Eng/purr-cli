import { getAddress, parseEventLogs } from 'viem'
import { ERC8183_ABI, ERC8183_ROUTER_ABI } from './abi.js'
import { ZERO_ADDRESS } from './constants.js'
import { requireIntent } from './guards.js'
import type { AgentSelfIntroPurchase, RpcReceipt } from './types.js'

export function parseCreatedJobId(
  receipt: RpcReceipt,
  purchase: AgentSelfIntroPurchase,
): string {
  if (receipt.status !== '0x1') {
    throw new Error(`createJob transaction failed: ${receipt.transactionHash}`)
  }
  const intent = requireIntent(purchase)
  if (receipt.to && getAddress(receipt.to) !== getAddress(intent.commerceAddress)) {
    throw new Error('createJob transaction target does not match the ERC-8183 contract')
  }

  const events = parseEventLogs({ abi: ERC8183_ABI, logs: receipt.logs })
  const created = events.find((event) => event.eventName === 'JobCreated')
  if (!created) throw new Error('JobCreated event not found in createJob receipt')

  const args = created.args as {
    jobId?: bigint
    client?: string
    provider?: string
    evaluator?: string
    hook?: string
  }
  if (typeof args.jobId !== 'bigint') throw new Error('JobCreated event is missing jobId')
  assertSameAddress(args.client, intent.clientWalletAddress, 'JobCreated.client')
  assertSameAddress(args.provider, intent.providerWalletAddress, 'JobCreated.provider')
  assertSameAddress(args.evaluator, intent.evaluatorWalletAddress, 'JobCreated.evaluator')
  assertSameAddress(args.hook, intent.hookAddress || ZERO_ADDRESS, 'JobCreated.hook')
  return args.jobId.toString()
}

export function assertRegisteredJob(
  receipt: RpcReceipt,
  purchase: AgentSelfIntroPurchase,
  onChainJobId: string,
): void {
  if (receipt.status !== '0x1') {
    throw new Error(`registerJob transaction failed: ${receipt.transactionHash}`)
  }
  const intent = requireIntent(purchase)
  if (receipt.to && getAddress(receipt.to) !== getAddress(intent.routerAddress)) {
    throw new Error('registerJob transaction target does not match the ERC-8183 router')
  }

  const events = parseEventLogs({ abi: ERC8183_ROUTER_ABI, logs: receipt.logs })
  const registered = events.find((event) => event.eventName === 'JobRegistered')
  if (!registered) throw new Error('JobRegistered event not found in registerJob receipt')

  const args = registered.args as {
    jobId?: bigint
    policy?: string
    client?: string
  }
  if (args.jobId?.toString() !== onChainJobId) {
    throw new Error('JobRegistered.jobId does not match the created job')
  }
  assertSameAddress(args.policy, intent.policyAddress, 'JobRegistered.policy')
  assertSameAddress(args.client, intent.clientWalletAddress, 'JobRegistered.client')
}

function assertSameAddress(actual: string | undefined, expected: string, field: string): void {
  if (!actual || getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${field} does not match the purchase intent`)
  }
}
