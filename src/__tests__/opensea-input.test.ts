import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseOpenSeaFulfillmentInput } from '../vendors/opensea-input.js'

describe('parseOpenSeaFulfillmentInput', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts inline fulfillment json', () => {
    const result = parseOpenSeaFulfillmentInput({
      'fulfillment-json': '{"fulfillment_data":{"transaction":{"to":"0xabc"}}}',
    })

    expect(result).toEqual({
      fulfillment_data: {
        transaction: {
          to: '0xabc',
        },
      },
    })
  })

  it('accepts fulfillment json from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purr-opensea-'))
    tempDirs.push(dir)
    const file = join(dir, 'fulfillment.json')
    writeFileSync(file, '{"fulfillment_data":{"transaction":{"to":"0xdef"}}}\n', 'utf8')

    const result = parseOpenSeaFulfillmentInput({
      'fulfillment-file': file,
    })

    expect(result).toEqual({
      fulfillment_data: {
        transaction: {
          to: '0xdef',
        },
      },
    })
  })
})
