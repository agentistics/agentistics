/**
 * raw.fixtures.test.ts — `readAnthropicExchange` against the on-disk fixtures in
 * `packages/server/test/fixtures/provider/anthropic/` (spec §15 B1.5, §5.1). No network, no key.
 *
 * Two kinds of fixture share the directory, told apart by `meta.provenance`:
 *  - `documented-shape` — hand-built from the shapes research 12 documents; counters are ILLUSTRATIVE
 *    and pinned exactly below. They exist so the mapping is tested before anything is recorded.
 *  - `recorded` — a real response captured by the owner's recorder. Its numbers are whatever
 *    Anthropic returned that day, so nothing here pins them: every recorded fixture is checked
 *    against counters this file reads straight off the body's own JSON, independently of `raw.ts`.
 * Both kinds get the same independent check; the documented ones also get the pinned table.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allowlistHeaders, readAnthropicExchange, readSdkUsageCrossCheck } from './raw.ts'
import type { RawExchange } from '../client.ts'

const DIR = join(import.meta.dir, '../../../test/fixtures/provider/anthropic')

interface FixtureFile {
  meta: { provenance: 'documented-shape' | 'recorded'; scenario: string; source?: string }
  status: number
  headers: Record<string, string>
  body: string
}

const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
const fixtures = files.map(name => ({
  name,
  data: JSON.parse(readFileSync(join(DIR, name), 'utf8')) as FixtureFile,
}))

function exchangeOf(f: FixtureFile): RawExchange {
  return { status: f.status, headers: f.headers, body: f.body }
}

/** Counters read off the fixture's own body, with no help from the code under test. */
function rawUsage(f: FixtureFile) {
  const u = JSON.parse(f.body).usage as Record<string, any>
  return {
    input: u.input_tokens as number,
    output: u.output_tokens as number,
    cacheRead: u.cache_read_input_tokens as number,
    cacheWrite: u.cache_creation_input_tokens as number,
    nested: u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined,
  }
}

/** Pinned, for the documented-shape fixtures only. */
const DOCUMENTED: Record<string, {
  messageId: string
  requestId: string
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; contextTokens: number }
  cacheWriteByTtl?: { ephemeral5m: number; ephemeral1h: number }
  stop: { kind: string }
  content: unknown[]
}> = {
  plain: {
    messageId: 'msg_documented_plain_0001',
    requestId: 'req_documented_plain_0001',
    usage: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, contextTokens: 12 },
    stop: { kind: 'end-turn' },
    content: [{ type: 'text', text: 'Hello.' }],
  },
  'cache-write': {
    messageId: 'msg_documented_cache_write_0001',
    requestId: 'req_documented_cache_write_0001',
    usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 1500, contextTokens: 1520 },
    cacheWriteByTtl: { ephemeral5m: 1000, ephemeral1h: 500 },
    stop: { kind: 'end-turn' },
    content: [{ type: 'text', text: 'Noted.' }],
  },
  'cache-write-flat-only': {
    messageId: 'msg_documented_cache_write_flat_0001',
    requestId: 'req_documented_cache_write_flat_0001',
    usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 800, contextTokens: 820 },
    stop: { kind: 'end-turn' },
    content: [{ type: 'text', text: 'Noted.' }],
  },
  'cache-read': {
    messageId: 'msg_documented_cache_read_0001',
    requestId: 'req_documented_cache_read_0001',
    usage: { input: 15, output: 4, cacheRead: 1500, cacheWrite: 0, contextTokens: 1515 },
    stop: { kind: 'end-turn' },
    content: [{ type: 'text', text: 'Yes.' }],
  },
  'tool-use': {
    messageId: 'msg_documented_tool_use_0001',
    requestId: 'req_documented_tool_use_0001',
    usage: { input: 300, output: 45, cacheRead: 0, cacheWrite: 0, contextTokens: 300 },
    stop: { kind: 'tool-use' },
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_documented_0001', name: 'get_weather', input: { city: 'Lisbon' } },
    ],
  },
}

describe('fixtures directory', () => {
  test('non-vacuity: there are fixtures, each with meta naming its provenance and scenario', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const { name, data } of fixtures) {
      expect({ name, ok: ['documented-shape', 'recorded'].includes(data.meta?.provenance) }).toEqual({ name, ok: true })
      expect(typeof data.meta.scenario).toBe('string')
      expect(name).toBe(`${data.meta.scenario}.${data.meta.provenance === 'recorded' ? 'recorded' : 'documented'}.json`)
    }
  })

  test('every documented-shape fixture cites its source and has a pinned expectation (and vice versa)', () => {
    const documented = fixtures.filter(f => f.data.meta.provenance === 'documented-shape')
    for (const { name, data } of documented) {
      expect({ name, cited: (data.meta.source ?? '').includes('docs/superpowers/research/') }).toEqual({ name, cited: true })
    }
    expect(documented.map(f => f.data.meta.scenario).sort()).toEqual(Object.keys(DOCUMENTED).sort())
  })
})

describe.each(fixtures)('$name', ({ data }) => {
  test('headers are already exactly the allowlist — nothing else was ever written', () => {
    expect(data.headers).toEqual(allowlistHeaders(data.headers))
  })

  test('maps to the four counters the body itself states, the identity and the request id', () => {
    const result = readAnthropicExchange(exchangeOf(data))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')

    const raw = rawUsage(data)
    expect(result.usage.input).toBe(raw.input)
    expect(result.usage.output).toBe(raw.output)
    expect(result.usage.cacheRead).toBe(raw.cacheRead)
    expect(result.usage.cacheWrite).toBe(raw.cacheWrite)
    expect(result.usage.missing).toBeUndefined()
    expect(result.usageAnomalies).toEqual([])
    // the gauge is input + both cache counters of THIS response (spec §5.1)
    expect(result.usage.contextTokens).toBe(raw.input + raw.cacheRead + raw.cacheWrite)

    const body = JSON.parse(data.body)
    expect(result.messageId).toBe(body.id)
    expect(result.servedModel).toBe(body.model)
    expect(result.requestId).toBe(data.headers['request-id'])
  })

  test('TTL buckets: adopted exactly when both are stated and sum to the flat figure, else absent', () => {
    const result = readAnthropicExchange(exchangeOf(data))
    if (!result.ok) throw new Error('expected ok')
    const raw = rawUsage(data)
    const five = raw.nested?.ephemeral_5m_input_tokens
    const one = raw.nested?.ephemeral_1h_input_tokens
    if (five !== undefined && one !== undefined) {
      expect(five + one).toBe(raw.cacheWrite) // both a real Anthropic invariant and the adoption rule
      expect(result.usage.cacheWriteByTtl).toEqual({ ephemeral5m: five, ephemeral1h: one })
    } else {
      expect(result.usage.cacheWriteByTtl).toBeUndefined()
    }
  })

  test('the SDK-shaped cross-check of the mapped counters never reports a divergence', () => {
    const result = readAnthropicExchange(exchangeOf(data))
    if (!result.ok) throw new Error('expected ok')
    const u = result.usage
    const sdk = { inputTokens: { noCache: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }, outputTokens: { total: u.output } }
    expect(readSdkUsageCrossCheck(sdk, u)).toEqual({ divergent: false, fields: [] })
  })
})

describe('documented-shape fixtures — pinned', () => {
  for (const { name, data } of fixtures.filter(f => f.data.meta.provenance === 'documented-shape')) {
    test(name, () => {
      const want = DOCUMENTED[data.meta.scenario]!
      const result = readAnthropicExchange(exchangeOf(data))
      if (!result.ok) throw new Error('expected ok')
      expect(result.messageId).toBe(want.messageId)
      expect(result.requestId).toBe(want.requestId)
      expect(result.usage).toEqual({ ...want.usage, ...(want.cacheWriteByTtl ? { cacheWriteByTtl: want.cacheWriteByTtl } : {}) })
      expect(result.stopReason).toEqual(want.stop as never)
      expect(result.content).toEqual(want.content as never)
    })
  }
})

/**
 * B1.5's acceptance asks for a RECORDED plain call and a RECORDED cache write. Until the owner runs
 * the recorder these are `todo`, not green: a passing test would claim a recording that does not exist.
 */
describe('recorded fixtures (owner-run recorder)', () => {
  const has = (scenario: string) => fixtures.some(f => f.data.meta.provenance === 'recorded' && f.data.meta.scenario === scenario)

  for (const scenario of ['plain', 'cache-write']) {
    const run = has(scenario) ? test : test.todo
    run(`a recorded "${scenario}" fixture exists and states what its scenario claims`, () => {
      const f = fixtures.find(x => x.data.meta.provenance === 'recorded' && x.data.meta.scenario === scenario)!.data
      const raw = rawUsage(f)
      if (scenario === 'plain') expect([raw.cacheRead, raw.cacheWrite]).toEqual([0, 0])
      else expect(raw.cacheWrite).toBeGreaterThan(0)
    })
  }
})
