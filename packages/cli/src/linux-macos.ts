#!/usr/bin/env node
import { handleCliError, runPurrCli } from './run.js'

runPurrCli().catch((err) => handleCliError(err))
