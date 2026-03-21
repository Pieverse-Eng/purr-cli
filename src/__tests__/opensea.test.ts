import { decodeFunctionData, parseAbi } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENSEA_CONDUIT_ADDRESS,
  normalizeOpenSeaChain,
  OPENSEA_CONDUIT_KEY,
  OPENSEA_SEAPORT_V1_6,
  type OpenSeaFulfillmentResponse,
} from '../vendors/opensea-api.js'
import { buildOpenSeaBuySteps, buildOpenSeaSellSteps, OpenSeaCliError } from '../vendors/opensea.js'

const WALLET = '0x1234567890123456789012345678901234567890'
const NFT_CONTRACT = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const NATIVE = '0x0000000000000000000000000000000000000000'
const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ADDR_C = '0xcccccccccccccccccccccccccccccccccccccccc'

const BASIC_ORDER_ABI = parseAbi([
  'function fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
])

const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
])
const ERC721_APPROVE_ABI = parseAbi(['function approve(address to, uint256 tokenId)'])

const ERC1155_APPROVE_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
])
const ERC721_OWNER_OF_ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)'])
const MATCH_ADVANCED_ORDERS_ABI = parseAbi([
  'function matchAdvancedOrders(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)',
])

function makeBasicFulfillment(): OpenSeaFulfillmentResponse {
  return {
    protocol: 'seaport',
    fulfillment_data: {
      transaction: {
        function:
          'fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
        chain: 1,
        to: OPENSEA_SEAPORT_V1_6,
        value: '1000000000000000000',
        input_data: {
          parameters: {
            considerationToken: NATIVE,
            considerationIdentifier: '0',
            considerationAmount: '900000000000000000',
            offerer: ADDR_A,
            zone: NATIVE,
            offerToken: NFT_CONTRACT,
            offerIdentifier: '1234',
            offerAmount: '1',
            basicOrderType: 0,
            startTime: '0',
            endTime: '9999999999',
            zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
            salt: '12345',
            offererConduitKey: OPENSEA_CONDUIT_KEY,
            fulfillerConduitKey:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            totalOriginalAdditionalRecipients: '1',
            additionalRecipients: [
              {
                amount: '100000000000000000',
                recipient: ADDR_B,
              },
            ],
            signature: '0xdeadbeef',
          },
        },
      },
    },
  }
}

function makeSellFulfillment(): OpenSeaFulfillmentResponse {
  return {
    protocol: 'seaport',
    fulfillment_data: {
      transaction: {
        function:
          'fulfillAdvancedOrder(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData),(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[],bytes32,address)',
        chain: 1,
        to: OPENSEA_SEAPORT_V1_6,
        value: '0',
        input_data: {
          advancedOrder: {
            parameters: {
              offerer: ADDR_C,
              zone: NATIVE,
              offer: [
                {
                  itemType: 1,
                  token: WETH,
                  identifierOrCriteria: '0',
                  startAmount: '500000000000000000',
                  endAmount: '500000000000000000',
                },
              ],
              consideration: [
                {
                  itemType: 2,
                  token: NFT_CONTRACT,
                  identifierOrCriteria: '1234',
                  startAmount: '1',
                  endAmount: '1',
                  recipient: ADDR_C,
                },
              ],
              orderType: 0,
              startTime: '0',
              endTime: '9999999999',
              zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
              salt: '67890',
              conduitKey: OPENSEA_CONDUIT_KEY,
              totalOriginalConsiderationItems: '1',
            },
            numerator: 1,
            denominator: 1,
            signature: '0xdeadbeef',
            extraData: '0x',
          },
          fulfillerConduitKey: OPENSEA_CONDUIT_KEY,
          recipient: WALLET,
        },
      },
    },
  }
}

describe('normalizeOpenSeaChain', () => {
  it('normalizes supported chains and aliases', () => {
    expect(normalizeOpenSeaChain('ethereum')).toEqual({
      input: 'ethereum',
      apiName: 'ethereum',
      chainId: 1,
    })
    expect(normalizeOpenSeaChain('polygon')).toEqual({
      input: 'polygon',
      apiName: 'matic',
      chainId: 137,
    })
  })
})

describe('buildOpenSeaBuySteps', () => {
  it('builds native listing fulfillment into a single tx step', async () => {
    const result = await buildOpenSeaBuySteps({
      wallet: WALLET,
      fulfillment: makeBasicFulfillment(),
    })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].label).toBe('OpenSea buy NFT')
    expect(BigInt(result.steps[0].value)).toBe(1000000000000000000n)
    const decoded = decodeFunctionData({
      abi: BASIC_ORDER_ABI,
      data: result.steps[0].data as `0x${string}`,
    })
    expect(decoded.functionName).toBe('fulfillBasicOrder_efficient_6GL6yc')
  })

  it('adds an ERC20 approval step for token-priced listings', async () => {
    const fulfillment: OpenSeaFulfillmentResponse = {
      ...makeBasicFulfillment(),
      fulfillment_data: {
        transaction: {
          ...makeBasicFulfillment().fulfillment_data!.transaction!,
          value: '0',
          input_data: {
            parameters: {
              ...makeBasicFulfillment().fulfillment_data!.transaction!.input_data!.parameters,
              considerationToken: WETH,
            },
          },
        },
      },
    }

    const result = await buildOpenSeaBuySteps({ wallet: WALLET, fulfillment })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].label).toBe('Approve ERC20 payment token for OpenSea')
    const approval = decodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      data: result.steps[0].data as `0x${string}`,
    })
    expect(approval.functionName).toBe('approve')
    expect(result.steps[1].label).toBe('OpenSea buy NFT')
  })

  it('rejects fulfillment payloads that do not target the official Seaport contract', async () => {
    const fulfillment: OpenSeaFulfillmentResponse = {
      ...makeBasicFulfillment(),
      fulfillment_data: {
        transaction: {
          ...makeBasicFulfillment().fulfillment_data!.transaction!,
          to: NFT_CONTRACT,
        },
      },
    }

    await expect(buildOpenSeaBuySteps({ wallet: WALLET, fulfillment })).rejects.toThrow(
      'official Seaport contract',
    )
  })
})

describe('buildOpenSeaSellSteps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds NFT approval plus sell fulfillment steps', async () => {
    const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {}
        if (body.method === 'eth_call') {
          return {
            ok: true,
            json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: ownerResult }),
          }
        }
        return { ok: true, json: () => Promise.resolve({}) }
      }),
    )

    const result = await buildOpenSeaSellSteps({
      wallet: WALLET,
      fulfillment: makeSellFulfillment(),
    })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].label).toMatch(/Approve NFT/)
    expect(result.steps[1].label).toBe('OpenSea sell NFT')
  })

  it('uses setApprovalForAll for ERC1155 sell fulfillments', async () => {
    const balanceResult = `0x${'0'.repeat(63)}1`
    const fulfillment: OpenSeaFulfillmentResponse = {
      ...makeSellFulfillment(),
      fulfillment_data: {
        transaction: {
          ...makeSellFulfillment().fulfillment_data!.transaction!,
          input_data: {
            ...makeSellFulfillment().fulfillment_data!.transaction!.input_data!,
            advancedOrder: {
              ...makeSellFulfillment().fulfillment_data!.transaction!.input_data!.advancedOrder!,
              parameters: {
                ...makeSellFulfillment().fulfillment_data!.transaction!.input_data!.advancedOrder!
                  .parameters,
                consideration: [
                  {
                    itemType: 3,
                    token: NFT_CONTRACT,
                    identifierOrCriteria: '1234',
                    startAmount: '1',
                    endAmount: '1',
                    recipient: ADDR_C,
                  },
                ],
              },
            },
          },
        },
      },
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {}
        if (body.method === 'eth_call') {
          return {
            ok: true,
            json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: balanceResult }),
          }
        }
        return { ok: true, json: () => Promise.resolve({}) }
      }),
    )

    const result = await buildOpenSeaSellSteps({ wallet: WALLET, fulfillment })

    const approval = decodeFunctionData({
      abi: ERC1155_APPROVE_ABI,
      data: result.steps[0].data as `0x${string}`,
    })
    expect(approval.functionName).toBe('setApprovalForAll')
  })

  it('rejects offer fulfillments when no seller order matches the requested wallet', async () => {
    const ownerResult = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {}
        if (body.method === 'eth_call') {
          return {
            ok: true,
            json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: ownerResult }),
          }
        }
        return { ok: true, json: () => Promise.resolve({}) }
      }),
    )

    const fulfillment: OpenSeaFulfillmentResponse = {
      protocol: 'seaport',
      fulfillment_data: {
        transaction: {
          function:
            'matchAdvancedOrders(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)',
          chain: 1,
          to: OPENSEA_SEAPORT_V1_6,
          value: '0',
          input_data: {
            orders: [
              {
                parameters: {
                  offerer: ADDR_A,
                  zone: NATIVE,
                  offer: [
                    {
                      itemType: 1,
                      token: WETH,
                      identifierOrCriteria: '0',
                      startAmount: '500000000000000000',
                      endAmount: '500000000000000000',
                    },
                  ],
                  consideration: [
                    {
                      itemType: 2,
                      token: NFT_CONTRACT,
                      identifierOrCriteria: '1234',
                      startAmount: '1',
                      endAmount: '1',
                      recipient: ADDR_A,
                    },
                  ],
                  orderType: 0,
                  startTime: '0',
                  endTime: '9999999999',
                  zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
                  salt: '123',
                  conduitKey: OPENSEA_CONDUIT_KEY,
                  totalOriginalConsiderationItems: '1',
                },
                numerator: '1',
                denominator: '1',
                signature: '0x12',
                extraData: '0x',
              },
              {
                parameters: {
                  offerer: ADDR_B,
                  zone: NATIVE,
                  offer: [
                    {
                      itemType: 2,
                      token: NFT_CONTRACT,
                      identifierOrCriteria: '1234',
                      startAmount: '1',
                      endAmount: '1',
                    },
                  ],
                  consideration: [
                    {
                      itemType: 1,
                      token: WETH,
                      identifierOrCriteria: '0',
                      startAmount: '500000000000000000',
                      endAmount: '500000000000000000',
                      recipient: ADDR_B,
                    },
                  ],
                  orderType: 0,
                  startTime: '0',
                  endTime: '9999999999',
                  zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
                  salt: '456',
                  conduitKey: OPENSEA_CONDUIT_KEY,
                  totalOriginalConsiderationItems: '1',
                },
                numerator: '1',
                denominator: '1',
                signature: '0x34',
                extraData: '0x',
              },
            ],
            criteriaResolvers: [],
            fulfillments: [],
            recipient: WALLET,
          },
        },
      },
    }

    await expect(buildOpenSeaSellSteps({ wallet: WALLET, fulfillment })).rejects.toThrow(
      'did not include a seller order',
    )
  })

  it('uses the matching criteria resolver for criteria-based NFT offers', async () => {
    const ownerByTokenId = new Map([
      ['1234', WALLET],
      ['9999', ADDR_A],
    ])

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {}
        if (body.method !== 'eth_call') {
          return { ok: true, json: () => Promise.resolve({}) }
        }

        const [{ data }] = body.params as [{ data: `0x${string}` }]
        const decoded = decodeFunctionData({
          abi: ERC721_OWNER_OF_ABI,
          data,
        })
        const tokenId = decoded.args[0].toString()
        const owner = ownerByTokenId.get(tokenId) ?? ADDR_A
        const result = `0x000000000000000000000000${owner.slice(2).toLowerCase()}`
        return { ok: true, json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }) }
      }),
    )

    const fulfillment: OpenSeaFulfillmentResponse = {
      protocol: 'seaport',
      fulfillment_data: {
        transaction: {
          function:
            'matchAdvancedOrders(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)',
          chain: 1,
          to: OPENSEA_SEAPORT_V1_6,
          value: '0',
          input_data: {
            orders: [
              {
                parameters: {
                  offerer: WALLET,
                  zone: NATIVE,
                  offer: [
                    {
                      itemType: 4,
                      token: NFT_CONTRACT,
                      identifierOrCriteria: '0',
                      startAmount: '1',
                      endAmount: '1',
                    },
                  ],
                  consideration: [
                    {
                      itemType: 1,
                      token: WETH,
                      identifierOrCriteria: '0',
                      startAmount: '500000000000000000',
                      endAmount: '500000000000000000',
                      recipient: WALLET,
                    },
                  ],
                  orderType: 0,
                  startTime: '0',
                  endTime: '9999999999',
                  zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
                  salt: '789',
                  conduitKey: OPENSEA_CONDUIT_KEY,
                  totalOriginalConsiderationItems: '1',
                },
                numerator: '1',
                denominator: '1',
                signature: '0x56',
                extraData: '0x',
              },
            ],
            criteriaResolvers: [
              {
                orderIndex: 0,
                side: 1,
                index: 0,
                identifier: '9999',
                criteriaProof: [],
              },
              {
                orderIndex: 0,
                side: 0,
                index: 0,
                identifier: '1234',
                criteriaProof: [],
              },
            ],
            fulfillments: [],
            recipient: WALLET,
          },
        },
      },
    }

    const result = await buildOpenSeaSellSteps({ wallet: WALLET, fulfillment })

    expect(result.steps).toHaveLength(2)
    const encodedMatch = decodeFunctionData({
      abi: MATCH_ADVANCED_ORDERS_ABI,
      data: result.steps[1].data as `0x${string}`,
    })
    expect(encodedMatch.functionName).toBe('matchAdvancedOrders')

    const approval = decodeFunctionData({
      abi: ERC721_APPROVE_ABI,
      data: result.steps[0].data as `0x${string}`,
    })
    expect(approval.args).toEqual([OPENSEA_CONDUIT_ADDRESS, 1234n])
  })
})

describe('OpenSeaCliError', () => {
  it('has code and details', () => {
    const error = new OpenSeaCliError('test message', 'TEST_CODE', { key: 'value' })
    expect(error.code).toBe('TEST_CODE')
    expect(error.details).toEqual({ key: 'value' })
  })
})
