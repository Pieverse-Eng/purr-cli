import { describe, expect, it } from 'vitest'
import * as opensea from '../vendors/opensea.js'
import * as openseaApi from '../vendors/opensea-api.js'

describe('opensea vendor scope', () => {
  it('only exposes buy/sell execution helpers, not submission or order creation flows', () => {
    expect(opensea).not.toHaveProperty('buildOpenSeaCancelOfferPreview')
    expect(opensea).not.toHaveProperty('buildOpenSeaCancelOfferSteps')
    expect(opensea).not.toHaveProperty('buildOpenSeaCancelListingPreview')
    expect(opensea).not.toHaveProperty('buildOpenSeaCancelListingSteps')
    expect(opensea).not.toHaveProperty('cancelOpenSeaOffer')
    expect(opensea).not.toHaveProperty('cancelOpenSeaListing')
    expect(opensea).not.toHaveProperty('buildOpenSeaOfferPreview')
    expect(opensea).not.toHaveProperty('buildOpenSeaListingPreview')
    expect(opensea).not.toHaveProperty('createOpenSeaOffer')
    expect(opensea).not.toHaveProperty('createOpenSeaListing')
    expect(opensea).not.toHaveProperty('buildOpenSeaSwapSteps')
    expect(opensea).not.toHaveProperty('submitOpenSeaOffer')
    expect(opensea).not.toHaveProperty('submitOpenSeaListing')
    expect(opensea).toHaveProperty('buildOpenSeaBuySteps')
    expect(opensea).toHaveProperty('buildOpenSeaSellSteps')
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
