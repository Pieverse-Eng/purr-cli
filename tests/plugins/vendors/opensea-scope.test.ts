import { describe, expect, it } from 'vitest'
import * as opensea from '@pieverseio/purr-plugin-vendors/opensea'
import * as openseaApi from '@pieverseio/purr-plugin-vendors/opensea-api'

describe('opensea vendor scope', () => {
  it('only exposes custody adapter helpers, not OpenSea API lookup or submission flows', () => {
    expect(opensea).not.toHaveProperty('buildOpenSeaCancelOfferPreview')
    expect(opensea).not.toHaveProperty('submitOpenSeaCancelOffer')
    expect(opensea).not.toHaveProperty('buildOpenSeaCancelListingPreview')
    expect(opensea).not.toHaveProperty('cancelOpenSeaOffer')
    expect(opensea).not.toHaveProperty('cancelOpenSeaListing')
    expect(opensea).not.toHaveProperty('buildOpenSeaOfferPreview')
    expect(opensea).not.toHaveProperty('buildOpenSeaListingPreview')
    expect(opensea).not.toHaveProperty('createOpenSeaOffer')
    expect(opensea).not.toHaveProperty('createOpenSeaListing')
    expect(opensea).not.toHaveProperty('submitOpenSeaOffer')
    expect(opensea).not.toHaveProperty('submitOpenSeaListing')
    expect(opensea).toHaveProperty('buildOpenSeaBuySteps')
    expect(opensea).toHaveProperty('buildOpenSeaSellSteps')
    expect(opensea).toHaveProperty('buildOpenSeaTransactionSteps')
    expect(opensea).toHaveProperty('buildOpenSeaActionSteps')
    expect(opensea).toHaveProperty('signOpenSeaTypedData')
    expect(opensea).toHaveProperty('signOpenSeaMessage')
  })
})

describe('opensea api scope', () => {
  it('does not expose duplicate marketplace lookup, submission, or swap helpers', () => {
    expect(openseaApi).not.toHaveProperty('getOrder')
    expect(openseaApi).not.toHaveProperty('cancelOrder')
    expect(openseaApi).not.toHaveProperty('submitOrder')
    expect(openseaApi).not.toHaveProperty('getBestListing')
    expect(openseaApi).not.toHaveProperty('getBestOffer')
    expect(openseaApi).not.toHaveProperty('getCollection')
    expect(openseaApi).not.toHaveProperty('getNft')
    expect(openseaApi).not.toHaveProperty('getListingFulfillmentData')
    expect(openseaApi).not.toHaveProperty('getOfferFulfillmentData')
    expect(openseaApi).not.toHaveProperty('getSwapQuote')
    expect(openseaApi).toHaveProperty('normalizeOpenSeaChain')
  })
})
