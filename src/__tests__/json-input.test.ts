import { describe, expect, it } from 'vitest'
import { parseJsonCliArg } from '../json-input.js'

describe('parseJsonCliArg', () => {
  it('parses inline JSON objects', () => {
    expect(parseJsonCliArg('{"ok":true}', 'fulfillment-json')).toEqual({ ok: true })
  })

  it('rejects stdin marker inputs', () => {
    expect(() => parseJsonCliArg('-', 'fulfillment-json')).toThrow(
      'Invalid --fulfillment-json: pass a JSON string on the command line',
    )
  })

  it('rejects non-object JSON', () => {
    expect(() => parseJsonCliArg('"text"', 'fulfillment-json')).toThrow(
      'Invalid --fulfillment-json: expected a JSON object',
    )
  })
})
