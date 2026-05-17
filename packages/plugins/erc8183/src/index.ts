// erc8183 plugin entry — experimental incur-based shape.

import { Cli, z } from 'incur'
import type { PurrPlugin } from '@pieverseio/purr-core/plugin'
import { buyErc8183Card } from './buy-card.js'

const group = Cli.create('erc8183', {
  description: 'Pieverse ERC-8183 campaign card purchase',
}).command('buy-card', {
  description: 'Purchase an agent-self-intro card; api-server drives the ERC-8183 job flow',
  output: z.object({
    purchaseId: z.string(),
    status: z.string(),
    imageUrl: z.string().nullable(),
    shareUrl: z.string().nullable(),
    suggestedTweetText: z.string().nullable(),
    xIntentUrl: z.string().nullable(),
    raw: z.unknown(),
  }),
  async run() {
    return await buyErc8183Card()
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
