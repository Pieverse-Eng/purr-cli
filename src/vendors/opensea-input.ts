import { requireArgOrFile } from '../file-input.js'
import { parseJsonCliArg } from '../json-input.js'
import type { OpenSeaFulfillmentResponse } from './opensea-api.js'

export function parseOpenSeaFulfillmentInput(
  args: Record<string, string>,
): OpenSeaFulfillmentResponse {
  return parseJsonCliArg<OpenSeaFulfillmentResponse>(
    requireArgOrFile(args, 'fulfillment-json', 'fulfillment-file'),
    args['fulfillment-file'] ? 'fulfillment-file' : 'fulfillment-json',
  )
}
