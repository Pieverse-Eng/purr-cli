import { requireArgOrFile } from '@pieverseio/purr-core/file-input'
import { parseJsonCliArg } from '@pieverseio/purr-core/json-input'
import type { OpenSeaFulfillmentResponse } from './opensea-api.js'

export function parseOpenSeaFulfillmentInput(
  args: Record<string, string>,
): OpenSeaFulfillmentResponse {
  return parseJsonCliArg<OpenSeaFulfillmentResponse>(
    requireArgOrFile(args, 'fulfillment-json', 'fulfillment-file'),
    args['fulfillment-file'] ? 'fulfillment-file' : 'fulfillment-json',
  )
}
