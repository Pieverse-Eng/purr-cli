// erc8183 plugin — experimental incur + PurrPlugin shape.
//
// Exposes the ERC-8183 contract primitives as atomic CLI commands. Each
// command wraps a single contract call via /wallet/execute. No state
// machine, no on-chain reads, no campaign awareness — those concerns
// belong to the caller (an agent skill, a marketplace UI, an operator
// script). The card-generation campaign is one composition of these
// primitives; future ERC-8183 service offerings reuse them as-is.
//
// Caller orchestrates by following CTAs.

import type { Hex } from 'viem'
import { Cli, z } from 'incur'
import type { PurrPlugin } from '@pieverseio/purr-core/plugin'
import {
  encodeClaimRefund,
  encodeComplete,
  encodeCreateJob,
  encodeFund,
  encodeSetBudget,
} from './calldata.js'
import { executeOne, firstHash } from './execute.js'

const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-hex-char EVM address')
const bytes32Hex = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte hex')
const optionalHex = z
  .string()
  .regex(/^0x[a-fA-F0-9]*$/)
  .optional()
const wei = z.string().regex(/^\d+$/, 'must be a base-10 wei amount')
const jobId = z.string().regex(/^\d+$/, 'must be a base-10 unsigned integer')
const chainId = z.coerce.number().int().positive()

const contractOpts = z.object({
  contract: evmAddress.describe('ERC-8183 contract address'),
  chainId: chainId.describe('EVM chain id'),
})

const group = Cli.create('erc8183', {
  description: 'ERC-8183 job primitives — atomic on-chain calls via /wallet/execute',
})
  .command('create-job', {
    description: 'Wrap createJob(provider, evaluator, expiredAt, description, hook)',
    options: contractOpts.extend({
      provider: evmAddress.describe('Provider wallet'),
      evaluator: evmAddress.describe('Evaluator wallet'),
      expiredAt: z.coerce.number().int().positive().describe('Job expiry as unix seconds'),
      description: z.string().describe('Job description (typically a URI to the spec)'),
      hook: evmAddress.optional().describe('Optional hook contract address'),
    }),
    output: z.object({ txHash: z.string(), chainId: z.number() }),
    async run(c) {
      const result = await executeOne({
        to: c.options.contract,
        data: encodeCreateJob({
          provider: c.options.provider,
          evaluator: c.options.evaluator,
          expiredAt: c.options.expiredAt,
          description: c.options.description,
          hook: c.options.hook,
        }),
        value: '0x0',
        chainId: c.options.chainId,
        label: 'ERC-8183 createJob',
      })
      return c.ok(
        { txHash: firstHash(result), chainId: c.options.chainId },
        {
          cta: {
            description:
              'After the createJob tx confirms, decode the JobCreated event for the jobId, then:',
            commands: [
              {
                command: 'erc8183 set-budget',
                options: { contract: c.options.contract, chainId: c.options.chainId },
                description: 'Set the budget for the new job',
              },
            ],
          },
        },
      )
    },
  })
  .command('set-budget', {
    description: 'Wrap setBudget(jobId, amount, optParams)',
    options: contractOpts.extend({
      jobId: jobId.describe('On-chain ERC-8183 job id'),
      amountWei: wei.describe('Budget amount in wei of the payment token'),
      optParams: optionalHex.describe('Optional ABI-encoded params (0x-prefixed hex)'),
    }),
    output: z.object({ txHash: z.string(), chainId: z.number() }),
    async run(c) {
      const result = await executeOne({
        to: c.options.contract,
        data: encodeSetBudget({
          jobId: c.options.jobId,
          amountWei: c.options.amountWei,
          optParams: c.options.optParams as Hex | undefined,
        }),
        value: '0x0',
        chainId: c.options.chainId,
        label: 'ERC-8183 setBudget',
      })
      return c.ok(
        { txHash: firstHash(result), chainId: c.options.chainId },
        {
          cta: {
            description:
              'Approve the payment token to the ERC-8183 contract if needed, then fund the job:',
            commands: [
              {
                command: 'evm approve',
                description: 'For ERC-20 budgets: approve the contract as spender',
              },
              {
                command: 'erc8183 fund',
                options: {
                  contract: c.options.contract,
                  chainId: c.options.chainId,
                  jobId: c.options.jobId,
                  amountWei: c.options.amountWei,
                },
                description: 'Fund the job',
              },
            ],
          },
        },
      )
    },
  })
  .command('fund', {
    description: 'Wrap fund(jobId, expectedBudget, optParams)',
    options: contractOpts.extend({
      jobId: jobId.describe('On-chain ERC-8183 job id'),
      amountWei: wei.describe('Expected budget amount in wei (must match setBudget)'),
      optParams: optionalHex.describe('Optional ABI-encoded params (0x-prefixed hex)'),
    }),
    output: z.object({ txHash: z.string(), chainId: z.number() }),
    async run(c) {
      const result = await executeOne({
        to: c.options.contract,
        data: encodeFund({
          jobId: c.options.jobId,
          amountWei: c.options.amountWei,
          optParams: c.options.optParams as Hex | undefined,
        }),
        value: '0x0',
        chainId: c.options.chainId,
        label: 'ERC-8183 fund',
      })
      return c.ok(
        { txHash: firstHash(result), chainId: c.options.chainId },
        {
          cta: {
            description: 'After the provider submits the deliverable on-chain, complete the job:',
            commands: [
              {
                command: 'erc8183 complete',
                options: {
                  contract: c.options.contract,
                  chainId: c.options.chainId,
                  jobId: c.options.jobId,
                },
                description: 'Settle escrow as the evaluator',
              },
            ],
          },
        },
      )
    },
  })
  .command('complete', {
    description: 'Wrap complete(jobId, reason, optParams) — settles escrow as the evaluator',
    options: contractOpts.extend({
      jobId: jobId.describe('On-chain ERC-8183 job id'),
      reason: bytes32Hex.describe('Reason hash (bytes32) — caller-defined'),
      optParams: optionalHex.describe('Optional ABI-encoded params (0x-prefixed hex)'),
    }),
    output: z.object({ txHash: z.string(), chainId: z.number() }),
    async run(c) {
      const result = await executeOne({
        to: c.options.contract,
        data: encodeComplete({
          jobId: c.options.jobId,
          reason: c.options.reason as Hex,
          optParams: c.options.optParams as Hex | undefined,
        }),
        value: '0x0',
        chainId: c.options.chainId,
        label: 'ERC-8183 complete',
      })
      return c.ok({ txHash: firstHash(result), chainId: c.options.chainId })
    },
  })
  .command('claim-refund', {
    description: 'Wrap claimRefund(jobId) — recovers escrow on expired or rejected jobs',
    options: contractOpts.extend({
      jobId: jobId.describe('On-chain ERC-8183 job id'),
    }),
    output: z.object({ txHash: z.string(), chainId: z.number() }),
    async run(c) {
      const result = await executeOne({
        to: c.options.contract,
        data: encodeClaimRefund({ jobId: c.options.jobId }),
        value: '0x0',
        chainId: c.options.chainId,
        label: 'ERC-8183 claimRefund',
      })
      return c.ok({ txHash: firstHash(result), chainId: c.options.chainId })
    },
  })

const plugin: PurrPlugin = {
  name: 'erc8183',
  version: '0.2.5',
  mount(parent) {
    parent.command(group)
  },
}

export default plugin
