import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EVENT_TYPES, type EventType, type SourceKind } from './event'
import {
  EVENT_ID_LENGTH,
  PROVIDER_KEYED_TYPES,
  deriveEventId,
  eventIdPreimage,
  sha256Hex,
  type EventIdInput,
} from './event-id'
import { CLAUDE_EVENT_ID_FIXTURES, type ClaudeLineShape, type EventIdFixture } from './event-id.fixtures'

/**
 * event-id.test.ts — `deriveEventId` is IDENTITY, not a random id (runtime P1 spec §4.1).
 *
 * The journal's idempotency is `UNIQUE(event_id)`, so everything rests on two directions: one fact
 * must always hash to one id (or replay doubles the journal), and two facts must never share one (or
 * the second is silently dropped as a "duplicate").
 *
 * Block E is the one that catches what nobody else would. Every other property here can be checked
 * against the function alone; E checks it against the WORLD — the same billed Claude response
 * reaching us from a transcript, a hook and a gateway under three unrelated source refs. Keyed on
 * the source, each would be a distinct, perfectly well-formed event and the journal would store the
 * response three times with no error anywhere: `usage-dedupe.ts`'s 60-90 % over-count, rebuilt one
 * layer down. Only keying on `message.id` makes them converge, and only a test that derives all
 * three from real record shapes can see that they do.
 */

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function nodeSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const base: EventIdInput = {
  sourceKind: 'harness',
  sourceId: 'claude',
  sourceRef: 'claude:conv-1:12',
  type: 'tool.completed',
}

const providerBase: EventIdInput = {
  sourceKind: 'harness',
  sourceId: 'claude',
  sourceRef: 'claude:conv-1:msg_01',
  type: 'model.completed',
  providerRequestId: 'msg_01',
}

function fixture(name: string): EventIdFixture {
  const f = CLAUDE_EVENT_ID_FIXTURES.find(x => x.name === name)
  if (!f) throw new Error(`fixture ${name} missing`)
  return f
}

function assistantLinesWithId(f: EventIdFixture): Array<ClaudeLineShape & { message: { id: string } }> {
  return f.lines.filter(
    (l): l is ClaudeLineShape & { message: { id: string } } =>
      l.type === 'assistant' && typeof l.message?.id === 'string' && l.message.id.length > 0,
  )
}

/** The three producers that can report one Claude response. */
function threeSources(conversationId: string, messageId: string, type: EventType = 'model.completed') {
  const transcript: EventIdInput = {
    sourceKind: 'harness', sourceId: 'claude',
    sourceRef: `claude:${conversationId}:${messageId}`, type, providerRequestId: messageId,
  }
  const hook: EventIdInput = {
    sourceKind: 'harness', sourceId: 'claude-hook',
    sourceRef: `hook:stop:${conversationId}:0007`, type, providerRequestId: messageId,
  }
  const gateway: EventIdInput = {
    sourceKind: 'gateway', sourceId: 'agentistics-gateway',
    sourceRef: 'req_9f2c1e', type, providerRequestId: messageId,
  }
  return { transcript, hook, gateway }
}

// ── A. sha256Hex ────────────────────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  test('FIPS 180-2 known answer for "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('empty string matches the known answer', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('agrees with node:crypto at every padding boundary (55/56/63/64/65/119/120 bytes)', () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120]) {
      const s = 'a'.repeat(n)
      expect(sha256Hex(s)).toBe(nodeSha(s))
    }
  })

  test('hashes the UTF-8 bytes of multibyte text (accents, emoji)', () => {
    for (const s of ['ção', '😀', 'ação 🚀 日本語', 'Z̤͔ͧ̑']) {
      expect(sha256Hex(s)).toBe(nodeSha(s))
    }
  })

  test('agrees with node:crypto on a 10k-char string', () => {
    let s = ''
    for (let i = 0; i < 10_000; i++) s += String.fromCharCode(32 + (i * 7) % 95)
    expect(sha256Hex(s)).toBe(nodeSha(s))
  })

  test('returns 64 lowercase hex chars', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── B. Shape ────────────────────────────────────────────────────────────────────────────────────

describe('deriveEventId shape', () => {
  test('EVENT_ID_LENGTH is 32', () => {
    expect(EVENT_ID_LENGTH).toBe(32)
  })

  test('is 32 lowercase hex chars on both paths', () => {
    expect(deriveEventId(base)).toMatch(/^[0-9a-f]{32}$/)
    expect(deriveEventId(providerBase)).toMatch(/^[0-9a-f]{32}$/)
  })

  test('equals the first 32 chars of sha256Hex(eventIdPreimage(input))', () => {
    for (const x of [base, providerBase, { ...base, ordinal: 3 }, { ...providerBase, providerRequestId: '' }]) {
      expect(deriveEventId(x)).toBe(sha256Hex(eventIdPreimage(x)).slice(0, 32))
    }
  })

  test('PROVIDER_KEYED_TYPES is exactly the five model.* types, all in EVENT_TYPES', () => {
    expect([...PROVIDER_KEYED_TYPES].sort()).toEqual(
      ['model.completed', 'model.delta', 'model.failed', 'model.invoked', 'model.started'],
    )
    for (const t of PROVIDER_KEYED_TYPES) expect(EVENT_TYPES as readonly string[]).toContain(t)
  })
})

// ── C. Stability ────────────────────────────────────────────────────────────────────────────────

describe('deriveEventId stability', () => {
  test('the same input twice yields the same id', () => {
    expect(deriveEventId(base)).toBe(deriveEventId({ ...base }))
    expect(deriveEventId(providerBase)).toBe(deriveEventId({ ...providerBase }))
  })

  test('the key order of the input object is irrelevant', () => {
    const reordered: EventIdInput = {
      type: base.type, sourceRef: base.sourceRef, ordinal: 2, sourceId: base.sourceId, sourceKind: base.sourceKind,
    }
    expect(deriveEventId(reordered)).toBe(deriveEventId({ ...base, ordinal: 2 }))
    const p: EventIdInput = {
      providerRequestId: 'msg_01', type: 'model.completed', sourceRef: 'x', sourceId: 'y', sourceKind: 'gateway',
    }
    expect(deriveEventId(p)).toBe(deriveEventId(providerBase))
  })

  /**
   * GOLDEN values. A change to the preimage encoding changes every id, and every journal written
   * before it then splits in two on the next replay. If one of these fails, the encoding moved —
   * that is a schema migration, not a test to update.
   */
  test('golden: source path', () => {
    expect(deriveEventId({
      sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:conv-1:12', type: 'tool.completed',
    })).toBe('8055217782612cbe2ea6920dc928bd69')
  })

  test('golden: source path with ordinal', () => {
    expect(deriveEventId({
      sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:conv-1:12', type: 'tool.requested', ordinal: 2,
    })).toBe('1e9154f3ac9376b072696e1c0aed55ce')
  })

  test('golden: provider path', () => {
    expect(deriveEventId({
      sourceKind: 'gateway', sourceId: 'agentistics-gateway', sourceRef: 'req_1',
      type: 'model.completed', providerRequestId: 'msg_01ABC',
    })).toBe('3b1fc5134c1669aed80633fef4fe8d43')
  })
})

// ── D. Distinctness ─────────────────────────────────────────────────────────────────────────────

describe('deriveEventId distinctness', () => {
  test('source path: changing any one keyed field changes the id', () => {
    const id = deriveEventId(base)
    const kinds: SourceKind[] = ['provider', 'gateway', 'runtime', 'alm', 'adapter']
    for (const k of kinds) expect(deriveEventId({ ...base, sourceKind: k })).not.toBe(id)
    expect(deriveEventId({ ...base, sourceId: 'claude2' })).not.toBe(id)
    expect(deriveEventId({ ...base, sourceRef: 'claude:conv-1:13' })).not.toBe(id)
    expect(deriveEventId({ ...base, type: 'tool.failed' })).not.toBe(id)
    expect(deriveEventId({ ...base, ordinal: 1 })).not.toBe(id)
  })

  test('provider path: changing providerRequestId, type or ordinal changes the id', () => {
    const id = deriveEventId(providerBase)
    expect(deriveEventId({ ...providerBase, providerRequestId: 'msg_02' })).not.toBe(id)
    expect(deriveEventId({ ...providerBase, type: 'model.failed' })).not.toBe(id)
    expect(deriveEventId({ ...providerBase, ordinal: 1 })).not.toBe(id)
  })

  test('provider path: sourceKind, sourceId and sourceRef are NOT part of the key', () => {
    const id = deriveEventId(providerBase)
    expect(deriveEventId({ ...providerBase, sourceKind: 'provider' })).toBe(id)
    expect(deriveEventId({ ...providerBase, sourceId: 'other' })).toBe(id)
    expect(deriveEventId({ ...providerBase, sourceRef: 'other' })).toBe(id)
  })

  test('source path: providerRequestId on a non-model type is ignored', () => {
    expect(deriveEventId({ ...base, providerRequestId: 'msg_01' })).toBe(deriveEventId(base))
    expect(deriveEventId({ ...base, providerRequestId: 'msg_02' })).toBe(deriveEventId(base))
  })

  test('concatenation is unambiguous: a:b|c differs from a|b:c', () => {
    expect(deriveEventId({ ...base, sourceId: 'a:b', sourceRef: 'c' }))
      .not.toBe(deriveEventId({ ...base, sourceId: 'a', sourceRef: 'b:c' }))
  })

  test('strings holding quotes, commas and brackets cannot shift a field boundary', () => {
    const pairs: Array<[Partial<EventIdInput>, Partial<EventIdInput>]> = [
      [{ sourceId: 'a",', sourceRef: 'b' }, { sourceId: 'a', sourceRef: '",b' }],
      [{ sourceId: 'a","b', sourceRef: 'c' }, { sourceId: 'a', sourceRef: 'b","c' }],
      [{ sourceId: '[1]', sourceRef: '' }, { sourceId: '', sourceRef: '[1]' }],
      [{ sourceId: 'x\\', sourceRef: '"y' }, { sourceId: 'x', sourceRef: '\\"y' }],
      [{ sourceId: 'a\u0000b', sourceRef: 'c' }, { sourceId: 'a', sourceRef: 'b\u0000c' }],
    ]
    for (const [l, r] of pairs) {
      expect(deriveEventId({ ...base, ...l })).not.toBe(deriveEventId({ ...base, ...r }))
      expect(eventIdPreimage({ ...base, ...l })).not.toBe(eventIdPreimage({ ...base, ...r }))
    }
  })

  test('domain separation: a source-path input spelling the provider components does not collide', () => {
    const provider: EventIdInput = { ...providerBase, providerRequestId: 'msg_01', ordinal: 0 }
    const providerId = deriveEventId(provider)
    // The same strings, pushed into every source-path slot, on a model type with no provider id
    // (source path) and on a non-model type (source path by type).
    const crafted: EventIdInput[] = [
      { sourceKind: 'harness', sourceId: 'model.completed', sourceRef: 'msg_01', type: 'model.completed' },
      { sourceKind: 'harness', sourceId: 'msg_01', sourceRef: '0', type: 'model.completed', providerRequestId: '' },
      { sourceKind: 'provider', sourceId: 'model.completed', sourceRef: 'msg_01', type: 'model.completed', ordinal: 0 },
      { sourceKind: 'harness', sourceId: 'provider', sourceRef: 'msg_01', type: 'model.completed' },
      { sourceKind: 'harness', sourceId: 'model.completed', sourceRef: 'msg_01', type: 'tool.completed', providerRequestId: 'msg_01' },
    ]
    for (const c of crafted) {
      expect(deriveEventId(c)).not.toBe(providerId)
      expect(eventIdPreimage(c)).not.toBe(eventIdPreimage(provider))
    }
    // And the reverse: a providerRequestId spelling a whole source key.
    const sourceId = deriveEventId(base)
    expect(deriveEventId({ ...providerBase, providerRequestId: eventIdPreimage(base) })).not.toBe(sourceId)
  })

  test('no collisions over EVENT_TYPES × refs × ordinals × both paths', () => {
    const ids = new Set<string>()
    let n = 0
    for (const type of EVENT_TYPES) {
      for (const ref of ['claude:c:1', 'claude:c:2', 'claude:d:1', '']) {
        for (const ordinal of [0, 1]) {
          ids.add(deriveEventId({ sourceKind: 'harness', sourceId: 'claude', sourceRef: ref, type, ordinal }))
          n++
        }
      }
    }
    for (const type of PROVIDER_KEYED_TYPES) {
      for (const pid of ['msg_a', 'msg_b', 'claude:c:1']) {
        for (const ordinal of [0, 1]) {
          ids.add(deriveEventId({ ...providerBase, type, providerRequestId: pid, ordinal }))
          n++
        }
      }
    }
    expect(ids.size).toBe(n)
  })
})

// ── E. Same id from three sources ───────────────────────────────────────────────────────────────

describe('one billed response, three producers, ONE id', () => {
  test('every fixture assistant line with a message.id: transcript = hook = gateway', () => {
    let checked = 0
    for (const f of CLAUDE_EVENT_ID_FIXTURES) {
      for (const line of assistantLinesWithId(f)) {
        const { transcript, hook, gateway } = threeSources(f.conversationId, line.message.id)
        const t = deriveEventId(transcript)
        expect(deriveEventId(hook)).toBe(t)
        expect(deriveEventId(gateway)).toBe(t)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('split-assistant-turn: every line sharing a message.id yields ONE id (usage-dedupe rule)', () => {
    const f = fixture('split-assistant-turn')
    const lines = assistantLinesWithId(f)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const ids = new Set(lines.map(l => deriveEventId({
      // each LINE has its own ref — the key must still be the response
      sourceKind: 'harness', sourceId: 'claude', sourceRef: `claude:${f.conversationId}:${l.lineNo}`,
      type: 'model.completed', providerRequestId: l.message.id,
    })))
    const messageIds = new Set(lines.map(l => l.message.id))
    expect(ids.size).toBe(messageIds.size)
    expect(ids.size).toBe(1)
  })

  test('distinct-responses: as many ids as distinct message.ids', () => {
    const f = fixture('distinct-responses')
    const lines = assistantLinesWithId(f)
    const messageIds = new Set(lines.map(l => l.message.id))
    expect(messageIds.size).toBeGreaterThanOrEqual(2)
    const ids = new Set(lines.map(l => deriveEventId(threeSources(f.conversationId, l.message.id).transcript)))
    expect(ids.size).toBe(messageIds.size)
  })

  test('subagent-transcript: a subagent response converges across producers too', () => {
    const f = fixture('subagent-transcript')
    expect(f.file).toBe('subagent')
    for (const line of assistantLinesWithId(f)) {
      const { transcript, gateway } = threeSources(f.conversationId, line.message.id)
      expect(deriveEventId(transcript)).toBe(deriveEventId(gateway))
    }
  })

  test('model.invoked and model.completed for the same response are different ids', () => {
    const inv = threeSources('conv-1', 'msg_01', 'model.invoked')
    const done = threeSources('conv-1', 'msg_01', 'model.completed')
    expect(deriveEventId(inv.transcript)).not.toBe(deriveEventId(done.transcript))
    expect(deriveEventId(inv.gateway)).toBe(deriveEventId(inv.transcript))
  })

  /**
   * An event that cannot be paired stays DISTINCT — it is never merged by a guess. Same rule as
   * `countUsage`: a record with no id is always counted.
   */
  test('a model event with no providerRequestId falls back to the source path: transcript ≠ gateway', () => {
    // A real Claude assistant line always carries `message.id`, so the id-less record is taken from
    // the fixture's own id-less lines; the event built on it is the case a source that exposes no
    // provider id would produce.
    const f = fixture('no-message-id')
    const line = f.lines.find(l => !l.message?.id)
    expect(line).toBeDefined()
    const transcript: EventIdInput = {
      sourceKind: 'harness', sourceId: 'claude', sourceRef: `claude:${f.conversationId}:${line!.lineNo}`,
      type: 'model.completed',
    }
    const gateway: EventIdInput = {
      sourceKind: 'gateway', sourceId: 'agentistics-gateway', sourceRef: 'req_9f2c1e', type: 'model.completed',
    }
    expect(deriveEventId(transcript)).not.toBe(deriveEventId(gateway))
    // An EMPTY providerRequestId is absent, not a shared key everyone would collapse into.
    expect(deriveEventId({ ...transcript, providerRequestId: '' }))
      .not.toBe(deriveEventId({ ...gateway, providerRequestId: '' }))
    expect(deriveEventId({ ...transcript, providerRequestId: '' })).toBe(deriveEventId(transcript))
  })

  test('tool-result-user-line: a user line is keyed by its source, never merged across sources', () => {
    const f = fixture('tool-result-user-line')
    const line = f.lines.find(l => l.type === 'user')
    expect(line).toBeDefined()
    const ref = `claude:${f.conversationId}:${line!.lineNo}`
    const a = deriveEventId({ sourceKind: 'harness', sourceId: 'claude', sourceRef: ref, type: 'tool.completed' })
    const b = deriveEventId({ sourceKind: 'harness', sourceId: 'claude-hook', sourceRef: ref, type: 'tool.completed' })
    expect(a).not.toBe(b)
  })
})

// ── F. Ordinal ──────────────────────────────────────────────────────────────────────────────────

describe('ordinal', () => {
  /**
   * Claude writes ONE `tool_use` block per transcript line, so the parallel tool calls of one
   * response are spread over the lines sharing its `message.id` (measured on the fixture). Keyed on
   * that response as ONE record, they are told apart by ordinal alone.
   */
  test('parallel-tool-uses: n tool.requested events from one record → n distinct ids', () => {
    const f = fixture('parallel-tool-uses')
    const messageId = f.lines.find(l => l.message?.id)?.message?.id
    expect(messageId).toBeDefined()
    const toolUseIds = f.lines
      .filter(l => l.message?.id === messageId)
      .flatMap(l => l.message?.toolUseIds ?? [])
    expect(toolUseIds.length).toBeGreaterThanOrEqual(2)
    const n = toolUseIds.length
    const ref = `claude:${f.conversationId}:${messageId}`
    const ids = new Set<string>()
    for (let i = 0; i < n; i++) {
      ids.add(deriveEventId({ sourceKind: 'harness', sourceId: 'claude', sourceRef: ref, type: 'tool.requested', ordinal: i }))
    }
    expect(ids.size).toBe(n)
  })

  test('ordinal undefined is the same as ordinal 0, on both paths', () => {
    expect(deriveEventId(base)).toBe(deriveEventId({ ...base, ordinal: 0 }))
    expect(deriveEventId(providerBase)).toBe(deriveEventId({ ...providerBase, ordinal: 0 }))
  })
})

// ── G. Totality ─────────────────────────────────────────────────────────────────────────────────

describe('totality', () => {
  test('never throws for empty strings, odd ordinals or lone surrogates', () => {
    const odd: EventIdInput[] = [
      { sourceKind: 'harness', sourceId: '', sourceRef: '', type: 'session.started' },
      { ...base, ordinal: Number.NaN },
      { ...base, ordinal: -1 },
      { ...base, ordinal: 1.5 },
      { ...base, ordinal: Number.POSITIVE_INFINITY },
      { ...base, ordinal: Number.NEGATIVE_INFINITY },
      { ...base, sourceRef: '\uD800' },
      { ...base, sourceId: '\uDFFFx' },
      { ...providerBase, providerRequestId: '\uD83D' },
      { ...providerBase, ordinal: Number.NaN },
    ]
    for (const x of odd) {
      expect(() => deriveEventId(x)).not.toThrow()
      expect(() => eventIdPreimage(x)).not.toThrow()
      expect(deriveEventId(x)).toMatch(/^[0-9a-f]{32}$/)
    }
    expect(() => sha256Hex('\uD800')).not.toThrow()
  })

  test('NaN and Infinity ordinals are distinct from each other and from 0', () => {
    const nan = deriveEventId({ ...base, ordinal: Number.NaN })
    const inf = deriveEventId({ ...base, ordinal: Number.POSITIVE_INFINITY })
    const zero = deriveEventId({ ...base, ordinal: 0 })
    expect(nan).not.toBe(inf)
    expect(nan).not.toBe(zero)
    expect(inf).not.toBe(zero)
  })
})

// ── H. Fixture privacy ──────────────────────────────────────────────────────────────────────────

describe('fixtures carry record SHAPES, never content', () => {
  const FIXTURE_KEYS = new Set(['name', 'why', 'conversationId', 'file', 'lines'])
  const LINE_KEYS = new Set(['lineNo', 'type', 'subtype', 'uuid', 'timestamp', 'sessionId', 'isSidechain', 'isMeta', 'message'])
  const MESSAGE_KEYS = new Set(['id', 'model', 'role', 'contentTypes', 'toolUseIds', 'toolNames', 'usage'])
  const USAGE_KEYS = new Set(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])

  const REQUIRED_NAMES = [
    'split-assistant-turn', 'parallel-tool-uses', 'distinct-responses',
    'no-message-id', 'subagent-transcript', 'tool-result-user-line',
  ]

  test('every required fixture name is present', () => {
    const names = CLAUDE_EVENT_ID_FIXTURES.map(f => f.name)
    for (const n of REQUIRED_NAMES) expect(names).toContain(n)
  })

  test('only the keys the interface declares appear, at every level', () => {
    for (const f of CLAUDE_EVENT_ID_FIXTURES) {
      for (const k of Object.keys(f)) expect(FIXTURE_KEYS.has(k)).toBe(true)
      for (const l of f.lines) {
        for (const k of Object.keys(l)) expect(LINE_KEYS.has(k)).toBe(true)
        if (l.message) {
          for (const k of Object.keys(l.message)) expect(MESSAGE_KEYS.has(k)).toBe(true)
          if (l.message.usage) for (const k of Object.keys(l.message.usage)) expect(USAGE_KEYS.has(k)).toBe(true)
        }
      }
    }
  })

  /** `why` is authored prose explaining the case, so it is exempt from the LENGTH cap only. */
  test('no string names a home directory, a user, an email or runs long enough to be pasted content', () => {
    const walk = (v: unknown, key: string, path: string): void => {
      if (typeof v === 'string') {
        expect(v.includes('/home/'), path).toBe(false)
        expect(v.includes('\\Users\\'), path).toBe(false)
        expect(v.toLowerCase().includes('mithrandir'), path).toBe(false)
        expect(v.includes('@'), path).toBe(false)
        if (key !== 'why') expect(v.length, path).toBeLessThanOrEqual(120)
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, key, `${path}[${i}]`))
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, k, `${path}.${k}`)
      }
    }
    CLAUDE_EVENT_ID_FIXTURES.forEach((f, i) => walk(f, '', `fixtures[${i}]`))
  })

  test('tool names are bare identifiers', () => {
    for (const f of CLAUDE_EVENT_ID_FIXTURES) {
      for (const l of f.lines) {
        for (const n of l.message?.toolNames ?? []) expect(n).toMatch(/^[A-Za-z0-9_:.-]+$/)
      }
    }
  })

  test('split-assistant-turn really repeats one message.id with deep-equal usage', () => {
    const lines = assistantLinesWithId(fixture('split-assistant-turn'))
    const byId = new Map<string, typeof lines>()
    for (const l of lines) byId.set(l.message.id, [...(byId.get(l.message.id) ?? []), l])
    const repeated = [...byId.values()].find(g => g.length >= 2)
    expect(repeated).toBeDefined()
    const first = (repeated![0] as ClaudeLineShape).message?.usage
    expect(first).toBeDefined()
    for (const l of repeated!) expect((l as ClaudeLineShape).message?.usage).toEqual(first!)
  })
})
