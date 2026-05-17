// erc8183 plugin — experimental incur + PurrPlugin shape.
//
// Each command wraps a single ERC-8183 contract call via /wallet/execute.
// State (campaign purchase row, on-chain job status) lives in api-server
// and on the chain. The plugin owns no state machine; CTAs guide the
// caller (agent / operator) through the happy path.

import { Cli, z } from 'incur'
import type { PurrPlugin } from '@pieverseio/purr-core/plugin'
import { buyCard } from './buy-card.js'
import { completeCard } from './complete-card.js'
import { fundCard } from './fund-card.js'

const purchaseIdOption = z.object({
  purchaseId: z.string().uuid().describe('Campaign purchase id returned by buy-card'),
})

const group = Cli.create('erc8183', {
  description: 'Pieverse ERC-8183 campaign card — atomic on-chain calls, chained by CTAs',
})
  .command('buy-card', {
    description: 'Create the campaign purchase and submit createJob via /wallet/execute',
    output: z.object({
      purchaseId: z.string(),
      status: z.string(),
      createTxHash: z.string(),
      onChainJobId: z.string().nullable(),
    }),
    async run(c) {
      const result = await buyCard()
      return c.ok(result, {
        cta: {
          description: 'Next:',
          commands: [
            {
              command: 'erc8183 fund-card',
              options: { purchaseId: result.purchaseId },
              description: 'Set budget, approve payment token, and fund the job',
            },
          ],
        },
      })
    },
  })
  .command('fund-card', {
    description:
      'Submit setBudget + approve + fund as a single /wallet/execute (caller must run buy-card first and wait for the server to observe the createJob receipt)',
    options: purchaseIdOption,
    output: z.object({
      purchaseId: z.string(),
      status: z.string(),
      setBudgetTxHash: z.string(),
      approveTxHash: z.string().nullable(),
      fundTxHash: z.string(),
    }),
    async run(c) {
      const result = await fundCard(c.options.purchaseId)
      return c.ok(result, {
        cta: {
          description:
            'Wait for the Pieverse provider to submit the deliverable on-chain (purchase status becomes `submitted`), then:',
          commands: [
            {
              command: 'erc8183 complete-card',
              options: { purchaseId: result.purchaseId },
              description: 'Settle escrow and reveal the card',
            },
          ],
        },
      })
    },
  })
  .command('complete-card', {
    description: 'Submit complete via /wallet/execute to settle escrow and reveal the card',
    options: purchaseIdOption,
    output: z.object({
      purchaseId: z.string(),
      status: z.string(),
      completeTxHash: z.string(),
      imageUrl: z.string().nullable(),
      shareUrl: z.string().nullable(),
      suggestedTweetText: z.string().nullable(),
      xIntentUrl: z.string().nullable(),
    }),
    async run(c) {
      const result = await completeCard(c.options.purchaseId)
      return c.ok(result, {
        cta: result.xIntentUrl
          ? {
              description: 'Share the card on X to qualify for the campaign reward:',
              commands: [{ command: result.xIntentUrl, description: 'Open the prefilled tweet' }],
            }
          : undefined,
      })
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
