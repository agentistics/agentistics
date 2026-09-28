/**
 * usage.test.ts — `readGoogleUsage` (B5b.1). One test per row of the mapping table in `usage.ts`'s
 * module doc, plus the totality / no-confident-zero properties.
 */
import { describe, expect, test } from 'bun:test'
import { readGoogleUsage, googleBillableOutputTokens } from './usage.ts'

describe('readGoogleUsage — the §22.1 mapping, one row per test', () => {
  test('input = promptTokenCount − cachedContentTokenCount (Google INCLUDES the cache in the prompt)', () => {
    const r = readGoogleUsage({ promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 50 })
    expect(r.usage.input).toBe(200)
    expect(r.usage.cacheRead).toBe(800)
    // the pair reconstructs the prompt exactly: nothing lost, nothing counted twice
    expect(r.usage.input + r.usage.cacheRead).toBe(1000)
    expect(r.notes).not.toContain('input-may-include-cache')
  })

  test('output = candidatesTokenCount, and thoughts are NEVER folded into it', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 40, thoughtsTokenCount: 300 })
    expect(r.usage.output).toBe(40)
  })

  test('cacheRead = cachedContentTokenCount', () => {
    const r = readGoogleUsage({ promptTokenCount: 500, cachedContentTokenCount: 500, candidatesTokenCount: 1 })
    expect(r.usage.cacheRead).toBe(500)
    expect(r.usage.input).toBe(0) // a fully cached prompt is a real 0 of fresh input, stated on both sides
    expect(r.usage.missing).not.toContain('input')
    expect(r.usage.missing).not.toContain('cacheRead')
  })

  test('cacheWrite is ABSENT (D21): in `missing`, on every response, never a stated 0', () => {
    for (const raw of [
      { promptTokenCount: 5, candidatesTokenCount: 2, cachedContentTokenCount: 0 },
      { promptTokenCount: 5, candidatesTokenCount: 2 },
      { promptTokenCount: 5, candidatesTokenCount: 2, cachedContentTokenCount: 3, thoughtsTokenCount: 9 },
    ]) {
      expect(readGoogleUsage(raw).usage.missing).toContain('cacheWrite')
    }
  })

  test('thoughtsTokenCount is carried as reasoning with billing "additive" — never dropped, never in output', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 40, thoughtsTokenCount: 300, totalTokenCount: 350 })
    expect(r.usage.reasoning).toEqual({ tokens: 300, billing: 'additive' })
    expect(r.usage.output).toBe(40)
    expect(r.notes).not.toContain('total-mismatch') // 10 + 300 + 40 === 350: the documented total closes
  })

  test('no thoughtsTokenCount → no reasoning key at all (absent, not {tokens: 0})', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 4 })
    expect('reasoning' in r.usage).toBe(false)
  })

  test('the price applies to candidates + additive thoughts; the 4,8× trap in the other direction', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 40, thoughtsTokenCount: 300 })
    expect(googleBillableOutputTokens(r.usage)).toBe(340)
    // …and a non-additive reasoning figure is never added on top
    expect(googleBillableOutputTokens({ input: 0, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: { tokens: 300, billing: 'included-in-output' } })).toBe(40)
    expect(googleBillableOutputTokens({ input: 0, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: { tokens: 300, billing: 'unknown' } })).toBe(40)
  })

  test('toolUsePromptTokenCount is carried with billing "unknown" and never summed into any counter', () => {
    const r = readGoogleUsage({ promptTokenCount: 100, candidatesTokenCount: 20, toolUsePromptTokenCount: 77 })
    expect(r.toolUsePrompt).toEqual({ tokens: 77, billing: 'unknown' })
    expect(r.usage.input).toBe(100)
    expect(r.usage.output).toBe(20)
    expect(JSON.stringify(r.usage)).not.toContain('77')
  })

  test('no toolUsePromptTokenCount → no toolUsePrompt', () => {
    expect(readGoogleUsage({ promptTokenCount: 1, candidatesTokenCount: 1 }).toolUsePrompt).toBeUndefined()
  })

  test('contextTokens is the prompt count (the docs\' "total effective prompt size"), a gauge not a sum', () => {
    expect(readGoogleUsage({ promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 5 }).usage.contextTokens).toBe(1000)
    expect(readGoogleUsage({ candidatesTokenCount: 5 }).usage.contextTokens).toBeUndefined()
  })
})

describe('readGoogleUsage — what is unstated is never read as zero', () => {
  test('cached figure unstated: input stays the prompt count, cacheRead is `missing`, and the note says why', () => {
    const r = readGoogleUsage({ promptTokenCount: 90, candidatesTokenCount: 10 })
    expect(r.usage.input).toBe(90)
    expect(r.usage.missing).toContain('cacheRead')
    expect(r.notes).toContain('input-may-include-cache')
  })

  test('cached > prompt: no negative input; input is `missing`, cacheRead stays as stated, and it is noted', () => {
    const r = readGoogleUsage({ promptTokenCount: 5, cachedContentTokenCount: 9, candidatesTokenCount: 1 })
    expect(r.usage.input).toBe(0)
    expect(r.usage.missing).toContain('input')
    expect(r.usage.cacheRead).toBe(9)
    expect(r.notes).toContain('cached-exceeds-prompt')
  })

  test('candidates unstated → output is `missing`', () => {
    const r = readGoogleUsage({ promptTokenCount: 5, cachedContentTokenCount: 0 })
    expect(r.usage.missing).toContain('output')
  })

  test('non-numeric / negative / NaN counters are unstated, not coerced', () => {
    const r = readGoogleUsage({ promptTokenCount: '12', candidatesTokenCount: -1, cachedContentTokenCount: Number.NaN, thoughtsTokenCount: null })
    expect(r.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(r.usage.input + r.usage.output + r.usage.cacheRead).toBe(0)
    expect('reasoning' in r.usage).toBe(false)
  })

  // each case wrapped in its own array: `test.each` would otherwise spread an array case as arguments
  test.each([[undefined], [null], [5], ['x'], [[]], [[{ promptTokenCount: 1 }]]])('%p → every counter `missing`, certainty absent, never a throw', (bad) => {
    const r = readGoogleUsage(bad)
    expect(r.anomalies).toContain('usage-not-an-object')
    expect(r.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(r.certainty).toBe('absent')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'counters-missing' })
  })

  test('cost is never a table price: Google states none in-band', () => {
    const r = readGoogleUsage({ promptTokenCount: 1, cachedContentTokenCount: 0, candidatesTokenCount: 1 })
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'no-verified-price' })
    expect(r.certainty).toBe('provider-stated')
  })
})

describe('readGoogleUsage — the documented total is a cross-check, and only ever a note', () => {
  test('total = prompt + thoughts + candidates closes → no mismatch', () => {
    expect(readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 20 }).notes)
      .not.toContain('total-mismatch')
  })

  test('total that closes only WITH the tool-use prompt is recorded as evidence, billing stays unknown', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 4, toolUsePromptTokenCount: 6, totalTokenCount: 20 })
    expect(r.notes).toContain('total-includes-tool-use-prompt')
    expect(r.toolUsePrompt?.billing).toBe('unknown')
  })

  test('total that closes WITHOUT the tool-use prompt is recorded the other way', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 4, toolUsePromptTokenCount: 6, totalTokenCount: 14 })
    expect(r.notes).toContain('total-excludes-tool-use-prompt')
    expect(r.toolUsePrompt?.billing).toBe('unknown')
  })

  test('a total that closes under neither reading is a mismatch — and no counter is altered to fit it', () => {
    const r = readGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 999 })
    expect(r.notes).toContain('total-mismatch')
    expect(r.usage.input).toBe(10)
    expect(r.usage.output).toBe(4)
  })
})
