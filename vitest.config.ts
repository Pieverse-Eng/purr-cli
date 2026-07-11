import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pieverseio\/purr-core$/, replacement: fromRoot('./packages/core/src/index.ts') },
      {
        find: /^@pieverseio\/purr-core\/(.+)$/,
        replacement: fromRoot('./packages/core/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-balancer$/,
        replacement: fromRoot('./packages/plugins/balancer/src/index.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-evm\/(.+)$/,
        replacement: fromRoot('./packages/plugins/evm/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-pieverse-card\/(.+)$/,
        replacement: fromRoot('./packages/plugins/pieverse-card/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-pns\/(.+)$/,
        replacement: fromRoot('./packages/plugins/pns/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-ows$/,
        replacement: fromRoot('./packages/plugins/ows/src/index.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-ows\/(.+)$/,
        replacement: fromRoot('./packages/plugins/ows/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-store\/(.+)$/,
        replacement: fromRoot('./packages/plugins/store/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-vendors\/(.+)$/,
        replacement: fromRoot('./packages/plugins/vendors/src/$1.ts'),
      },
      {
        find: /^@pieverseio\/purr-plugin-wallet\/(.+)$/,
        replacement: fromRoot('./packages/plugins/wallet/src/$1.ts'),
      },
    ],
  },
})
