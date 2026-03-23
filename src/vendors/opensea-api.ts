export const OPENSEA_SEAPORT_V1_6 = '0x0000000000000068f116a894984e2db1123eb395'
export const OPENSEA_CONDUIT_KEY =
  '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000'
export const OPENSEA_CONDUIT_ADDRESS = '0x1E0049783F008A0085193E00003D00cd54003c71'

const OPEN_SEA_CHAIN_CONFIG = {
  ethereum: { apiName: 'ethereum', chainId: 1 },
  matic: { apiName: 'matic', chainId: 137 },
  polygon: { apiName: 'matic', chainId: 137 },
  arbitrum: { apiName: 'arbitrum', chainId: 42161 },
  optimism: { apiName: 'optimism', chainId: 10 },
  base: { apiName: 'base', chainId: 8453 },
  avalanche: { apiName: 'avalanche', chainId: 43114 },
  klaytn: { apiName: 'klaytn', chainId: 8217 },
  zora: { apiName: 'zora', chainId: 7777777 },
  blast: { apiName: 'blast', chainId: 81457 },
  sepolia: { apiName: 'sepolia', chainId: 11155111 },
} as const

type OpenSeaChainAlias = keyof typeof OPEN_SEA_CHAIN_CONFIG

export function normalizeOpenSeaChain(chain: string): {
  input: string
  apiName: string
  chainId: number
} {
  const normalized = chain.trim().toLowerCase() as OpenSeaChainAlias
  const config = OPEN_SEA_CHAIN_CONFIG[normalized]
  if (!config) {
    throw new Error(
      `Unsupported OpenSea chain: "${chain}". Supported: ${Object.keys(OPEN_SEA_CHAIN_CONFIG).join(', ')}`,
    )
  }

  return {
    input: normalized,
    apiName: config.apiName,
    chainId: config.chainId,
  }
}

export interface OpenSeaAdditionalRecipient {
  amount: string
  recipient: string
}

export interface OpenSeaOfferItem {
  itemType: number
  token: string
  identifierOrCriteria: string
  startAmount: string
  endAmount: string
}

export interface OpenSeaConsiderationItem {
  itemType: number
  token: string
  identifierOrCriteria: string
  startAmount: string
  endAmount: string
  recipient: string
}

export interface OpenSeaBasicOrderParameters {
  considerationToken: string
  considerationIdentifier: string
  considerationAmount: string
  offerer: string
  zone: string
  offerToken: string
  offerIdentifier: string
  offerAmount: string
  basicOrderType: number
  startTime: string
  endTime: string
  zoneHash: string
  salt: string
  offererConduitKey: string
  fulfillerConduitKey: string
  totalOriginalAdditionalRecipients: string
  additionalRecipients: OpenSeaAdditionalRecipient[]
  signature: string
}

export interface OpenSeaOrderParameters {
  offerer: string
  zone: string
  offer: OpenSeaOfferItem[]
  consideration: OpenSeaConsiderationItem[]
  orderType: number
  startTime: string
  endTime: string
  zoneHash: string
  salt: string
  conduitKey: string
  totalOriginalConsiderationItems: string
}

export interface OpenSeaAdvancedOrder {
  parameters: OpenSeaOrderParameters
  numerator: number | string
  denominator: number | string
  signature: string
  extraData: string
}

export interface OpenSeaCriteriaResolver {
  orderIndex: number | string
  side: number | string
  index: number | string
  identifier: string
  criteriaProof: string[]
}

export interface OpenSeaFulfillmentComponent {
  orderIndex: number | string
  itemIndex: number | string
}

export interface OpenSeaFulfillmentMatch {
  offerComponents: OpenSeaFulfillmentComponent[]
  considerationComponents: OpenSeaFulfillmentComponent[]
}

export interface OpenSeaFulfillmentResponse {
  protocol?: string
  fulfillment_data?: {
    transaction?: {
      function?: string
      chain?: number
      to: string
      value: string
      data?: string
      input_data?: {
        parameters?: OpenSeaBasicOrderParameters
        data?: string
        advancedOrder?: OpenSeaAdvancedOrder
        orders?: OpenSeaAdvancedOrder[]
        criteriaResolvers?: OpenSeaCriteriaResolver[]
        fulfillments?: OpenSeaFulfillmentMatch[]
        fulfillerConduitKey?: string
        recipient?: string
      }
    }
  }
}
