#!/usr/bin/env node
import { handleCliError, runPurrCli } from './run.js'

const options = {
  disabledPlugins: {
    ows: 'OWS is not available in the Windows build. Use WSL, Linux, or macOS.',
  },
}

runPurrCli(options).catch((err) => handleCliError(err, options))
