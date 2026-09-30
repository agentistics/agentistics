/**
 * usage.fixtures.test.ts — `readOpenAICompatibleUsage` against the on-disk fixtures in
 * `packages/runtime/test/fixtures/provider/openai-compatible/`. No network, no key.
 *
 * Every fixture here is `documented-shape` (there is no `recorded` counterpart yet, unlike the
 * Anthropic fixtures — nothing has driven a live openai-compatible endpoint for this item): built
 * from the shapes research 12 and the task's own brief document, or deliberately adversarial. Each
 * carries its own `_source` string (a doc path + section, a fetched URL + date, or the word
 * "adversarial" plus what it exercises) rather than a `meta.provenance` discriminator — this reader
 * has no request/response envelope to carry a `status`/`headers` pair the way the Anthropic exchange
 * fixtures do (D4 takes the parsed BODY directly), so the fixture shape here is `{_source, kind,
 * body}` rather than `{meta, status, headers, body}`.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readOpenAICompatibleUsage, type OpenAICompatibleEndpointKind } from './usage.ts'

const DIR = join(import.meta.dir, '../../../test/fixtures/provider/openai-compatible')

interface FixtureFile {
  _source: string
  kind: OpenAICompatibleEndpointKind
  body: unknown
}

const files = readdirSync(DIR).filter(f => f.endsWith('.documented.json')).sort()
const fixtures = files.map(name => ({
  name,
  data: JSON.parse(readFileSync(join(DIR, name), 'utf8')) as FixtureFile,
}))

describe('fixtures directory', () => {
  test('non-vacuity: there are fixtures, each citing its source and a valid kind', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const { name, data } of fixtures) {
      expect({ name, sourced: typeof data._source === 'string' && data._source.length > 0 }).toEqual({ name, sourced: true })
      expect({ name, kind: ['direct', 'router', 'local'].includes(data.kind) }).toEqual({ name, kind: true })
    }
  })
})

describe.each(fixtures)('$name', ({ data }) => {
  test('never throws, and every result shape is internally consistent', () => {
    const result = readOpenAICompatibleUsage(data.body, data.kind)

    // certainty matches kind, except 'absent' which can only come from an unreadable usage object.
    if (result.certainty === 'absent') {
      expect(result.anomalies).toContain('usage-not-an-object')
      expect(result.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    } else if (data.kind === 'direct') {
      expect(result.certainty).toBe('provider-stated')
    } else if (data.kind === 'router') {
      expect(result.certainty).toBe('router-stated')
    } else {
      expect(result.certainty).toBe('local-unbilled')
    }

    // cost.kind is governed exactly by the rules in the module doc.
    if (data.kind === 'local') {
      expect(result.cost).toEqual({ kind: 'unavailable', reason: 'local-unbilled' })
    } else if (result.cost.kind === 'unavailable' && result.cost.reason === 'counters-missing') {
      expect(result.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    } else if (result.cost.kind === 'router-reported') {
      expect(data.kind).toBe('router')
      expect(Number.isFinite(result.cost.usd)).toBe(true)
      expect(result.cost.usd).toBeGreaterThanOrEqual(0)
    }

    // no counter is ever negative, missing or not — the type only carries non-negative numbers.
    expect(result.usage.input).toBeGreaterThanOrEqual(0)
    expect(result.usage.output).toBeGreaterThanOrEqual(0)
    expect(result.usage.cacheRead).toBeGreaterThanOrEqual(0)
    expect(result.usage.cacheWrite).toBeGreaterThanOrEqual(0)

    // contextTokens, when present, is never drawn while input or cacheRead are missing.
    if (result.usage.contextTokens !== undefined) {
      expect(result.usage.missing?.includes('input')).not.toBe(true)
      expect(result.usage.missing?.includes('cacheRead')).not.toBe(true)
    }
  })
})

/** Pinned expectations for the scenarios this item's own report names as load-bearing. */
describe('pinned scenarios', () => {
  function readOf(name: string) {
    const f = fixtures.find(x => x.name === name)
    if (!f) throw new Error(`missing fixture ${name}`)
    return readOpenAICompatibleUsage(f.data.body, f.data.kind)
  }

  test('openai-plain: exact subtraction, no cache activity; OpenAI states no cache-write counter (D21)', () => {
    const r = readOf('openai-plain.documented.json')
    // OpenAI's Chat Completions usage has no cache-write field, so `cacheWrite` is ABSENT (missing),
    // never a confident 0; a stated `reasoning_tokens: 0` IS a statement and is carried as such.
    expect(r.usage).toEqual({
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 100,
      missing: ['cacheWrite'],
      reasoning: { tokens: 0, billing: 'included-in-output' },
    })
    expect(r.notes).toEqual(['context-gauge-cache-write-unstated'])
    expect(r.certainty).toBe('provider-stated')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'no-verified-price' })
  })

  test('openai-cached: input excludes the cached sub-count (140 − 40 = 100)', () => {
    const r = readOf('openai-cached.documented.json')
    expect(r.usage.input).toBe(100)
    expect(r.usage.cacheRead).toBe(40)
    expect(r.usage.output).toBe(30)
    expect(r.usage.contextTokens).toBe(140)
  })

  test('openai-reasoning: reasoning is a kept sub-count, billed included-in-output, never folded into output', () => {
    const r = readOf('openai-reasoning.documented.json')
    expect(r.usage.output).toBe(80)
    expect(r.usage.reasoning).toEqual({ tokens: 30, billing: 'included-in-output' })
    expect(r.notes).not.toContain('reasoning-exceeds-completion')
  })

  test('openai-cached-mismatch: cached > prompt never yields a negative input', () => {
    const r = readOf('openai-cached-mismatch.documented.json')
    expect(r.usage.missing).toContain('input')
    expect(r.usage.input).toBe(0) // placeholder, not a real value — caller must check `missing` first
    expect(r.usage.cacheRead).toBe(200) // the directly-stated counter is kept as-is
    expect(r.notes).toContain('cached-exceeds-prompt')
    expect(r.usage.contextTokens).toBeUndefined()
  })

  test('openrouter-plain: no cache breakdown stated → input=prompt_tokens with a note, cost from usage.cost', () => {
    const r = readOf('openrouter-plain.documented.json')
    expect(r.usage.input).toBe(194)
    expect(r.usage.missing).toContain('cacheRead')
    expect(r.notes).toContain('input-may-include-cache')
    expect(r.certainty).toBe('router-stated')
    expect(r.cost).toEqual({ kind: 'router-reported', usd: 0.95, field: 'usage.cost' })
  })

  test('openrouter-cache: full gauge, reasoning included-in-output, router cost relayed', () => {
    const r = readOf('openrouter-cache.documented.json')
    expect(r.usage).toEqual({
      input: 170,
      output: 90,
      cacheRead: 50,
      cacheWrite: 20,
      contextTokens: 240,
      reasoning: { tokens: 10, billing: 'included-in-output' },
    })
    expect(r.notes).not.toContain('context-gauge-cache-write-unstated')
    expect(r.cost).toEqual({ kind: 'router-reported', usd: 0.014, field: 'usage.cost' })
  })

  test('openrouter-cost-missing: counters present, no usable cost → no-verified-price', () => {
    const r = readOf('openrouter-cost-missing.documented.json')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'no-verified-price' })
  })

  test('openrouter-cost-string: a string cost is refused, never coerced', () => {
    const r = readOf('openrouter-cost-string.documented.json')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'no-verified-price' })
  })

  test('deepseek-cache: hit/miss mapped directly, no subtraction, no mismatch note', () => {
    const r = readOf('deepseek-cache.documented.json')
    expect(r.usage.input).toBe(36)
    expect(r.usage.cacheRead).toBe(64)
    expect(r.notes).not.toContain('deepseek-hit-miss-mismatch')
    expect(r.usage.contextTokens).toBe(100)
  })

  test('deepseek-reasoner: DeepSeek shape gets reasoning billing "unknown", not "included-in-output"', () => {
    const r = readOf('deepseek-reasoner.documented.json')
    expect(r.usage.input).toBe(90)
    expect(r.usage.cacheRead).toBe(10)
    expect(r.usage.reasoning).toEqual({ tokens: 150, billing: 'unknown' })
  })

  test('deepseek-mismatch: hit+miss ≠ prompt_tokens is noted, counters unchanged', () => {
    const r = readOf('deepseek-mismatch.documented.json')
    expect(r.usage.input).toBe(50)
    expect(r.usage.cacheRead).toBe(10)
    expect(r.notes).toContain('deepseek-hit-miss-mismatch')
  })

  test('ollama: local certainty and local-unbilled cost regardless of stated counters', () => {
    const r = readOf('ollama-openai-compat.documented.json')
    expect(r.usage.input).toBe(12)
    expect(r.usage.output).toBe(6)
    expect(r.certainty).toBe('local-unbilled')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'local-unbilled' })
  })

  test('adversarial-usage-missing: absent usage → certainty "absent", all four missing', () => {
    const r = readOf('adversarial-usage-missing.documented.json')
    expect(r.certainty).toBe('absent')
    expect(r.anomalies).toEqual(['usage-not-an-object'])
    expect(r.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'counters-missing' })
  })

  test('adversarial-usage-null: usage:null reads the same as usage absent', () => {
    const r = readOf('adversarial-usage-null.documented.json')
    expect(r.certainty).toBe('absent')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'counters-missing' })
  })

  test('adversarial-string-counters: string-typed counters are never coerced, all four missing', () => {
    const r = readOf('adversarial-string-counters.documented.json')
    expect(r.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(r.usage.input).toBe(0)
    expect(r.usage.output).toBe(0)
  })

  test('adversarial-negative: a negative counter is refused, not clamped to 0-and-trusted', () => {
    const r = readOf('adversarial-negative.documented.json')
    expect(r.usage.missing).toContain('output')
    expect(r.usage.output).toBe(0)
    // prompt_tokens (10) is a valid positive counter and IS trusted on its own.
    expect(r.usage.input).toBe(10)
    expect(r.usage.missing).not.toContain('input')
  })
})
