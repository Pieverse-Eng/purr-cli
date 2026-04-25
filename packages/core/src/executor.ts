import { readFileSync } from 'node:fs'
import { apiPost, resolveCredentials } from './api-client.js'

export interface ExecuteResult {
  results: Array<{
    stepIndex: number
    label?: string
    hash: string
    status: 'success' | 'skipped'
  }>
  from: string
  chainId: number
  chainType: string
}

/**
 * Execute steps from a file path. Reads the JSON file, validates it
 * contains a steps array, and POSTs to the wallet execute endpoint.
 */
export async function executeStepsFromFile(
  stepsFile: string,
  dedupKey?: string,
): Promise<ExecuteResult> {
  let raw: string
  try {
    raw = readFileSync(stepsFile, 'utf-8')
  } catch {
    throw new Error(
      `Cannot read steps file "${stepsFile}" — ensure the file exists and purr output was redirected correctly`,
    )
  }

  return executeStepsFromJson(raw, dedupKey)
}

/**
 * Execute steps from a raw JSON string. Validates the steps array
 * and POSTs to the wallet execute endpoint.
 */
export async function executeStepsFromJson(
  json: string,
  dedupKey?: string,
): Promise<ExecuteResult> {
  let parsed: { steps?: unknown[] }
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Steps JSON is not valid. Check that purr completed successfully.')
  }

  const steps = parsed.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('No steps found in JSON. Check purr output for errors.')
  }

  const body: Record<string, unknown> = { steps }
  if (dedupKey) {
    body.dedupKey = dedupKey
  }

  const { instanceId } = resolveCredentials()
  return apiPost(`/v1/instances/${instanceId}/wallet/execute`, body) as Promise<ExecuteResult>
}
