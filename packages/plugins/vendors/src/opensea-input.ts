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

export function parseOpenSeaTransactionInput(args: Record<string, string>): Record<string, unknown> {
  return parseJsonCliArg<Record<string, unknown>>(
    requireArgOrFile(args, 'tx-json', 'tx-file'),
    args['tx-file'] ? 'tx-file' : 'tx-json',
  )
}

export function parseOpenSeaActionsInput(args: Record<string, string>): Record<string, unknown> {
  return parseJsonCliArg<Record<string, unknown>>(
    requireArgOrFile(args, 'actions-json', 'actions-file'),
    args['actions-file'] ? 'actions-file' : 'actions-json',
  )
}

export function parseOpenSeaTypedDataInput(args: Record<string, string>): Record<string, unknown> {
  return parseJsonCliArg<Record<string, unknown>>(
    requireArgOrFile(args, 'typed-data-json', 'typed-data-file'),
    args['typed-data-file'] ? 'typed-data-file' : 'typed-data-json',
  )
}

export function parseOpenSeaPaymentInput(args: Record<string, string>): Record<string, unknown> {
  if (args['payment-json'] || args['payment-file']) {
    return parseJsonCliArg<Record<string, unknown>>(
      requireArgOrFile(args, 'payment-json', 'payment-file'),
      args['payment-file'] ? 'payment-file' : 'payment-json',
    )
  }
  return parseOpenSeaTypedDataInput(args)
}

export function parseOpenSeaMessageInput(args: Record<string, string>): string {
  return requireArgOrFile(args, 'message', 'message-file')
}
