// Experimental plugin contract — see PR description for rationale.
// A PurrPlugin owns a top-level command group ("erc8183", "fourmeme", ...) and
// mounts an incur sub-CLI onto the root. Discovery is compile-time only: the
// CLI binary is built with esbuild + bun, so plugins must be statically
// importable. The contract leaves room for a future runtime discovery layer
// (e.g. scanning installed packages with `keywords: ['purr-plugin']`) without
// changing what each plugin has to export.

import type { Cli } from 'incur'

// biome-ignore lint/suspicious/noExplicitAny: parent CLI shape is irrelevant to the plugin
type ParentCli = Cli.Cli<any, any, any>

export interface PurrPlugin {
  name: string
  version: string
  mount(cli: ParentCli): void
}
