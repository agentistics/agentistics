import { describe, expect, test } from 'bun:test'
import { EMPTY_VIEW, lineText, lineWidth, reduceAll, type Line } from './code'
import { clampPanelTop, inspectorLines, panelWindow, policyWords, resolveTurn, timeTotals, timelineLines, timelineRows } from './code-panels'
import { codeStrings } from './code-i18n'
import type { CodeEvent, CodeSessionFacts, CodeToolCall } from './code-types'

const t = codeStrings('en')
const pt = codeStrings('pt')

const FACTS: CodeSessionFacts = {
  sessionId: 'ses_3f5f0000', shortId: '3f5f', title: 'parser fix', task: null,
  cwd: '/repo', workspaceRoot: '/repo', model: 'claude-sonnet-5', provider: 'anthropic', mode: 'default',
}

const T0 = Date.parse('2026-09-28T14:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const tool = (over: Partial<CodeToolCall> & { id: string }): CodeToolCall => ({
  name: 'file.read', verb: 'read', target: 'tokens.ts', state: 'done', ...over,
})

/**
 * One finished turn, measured end to end: two model calls with timing and per-counter costs, a read
 * the floor allowed, a patch a person was asked about (and answered), and a shell the policy denied.
 * The run spans 0s → 40s; the person was waited on from 10s to 30s.
 */
function events(): CodeEvent[] {
  return [
    { kind: 'user', text: 'fix it', at: at(0) },
    { kind: 'run-started', runId: 'r1', at: at(0) },
    { kind: 'usage', usage: { runId: 'r1', model: 'claude-sonnet-5', input: 1000, output: 400, cacheRead: 8000, cacheWrite: 600, costUSD: 0.02, costs: { input: 0.003, output: 0.006, cacheRead: 0.0024, cacheWrite: 0.0086 }, startedAt: at(0), endedAt: at(4), ttftMs: 1000, stopReason: 'tool_use', contextTokens: 60_000, contextWindow: 200_000 } },
    { kind: 'tool', call: tool({ id: 'a', requestedAt: at(4), endedAt: at(5), durationMs: 1000, result: '212 lines', policy: { decision: 'allowed', by: 'policy', rule: 'floor', asked: false } }) },
    { kind: 'ask', ask: { id: 'q1', kind: 'permission', toolId: 'b', title: 'Allow?', why: [], checkpoint: false, options: [{ label: 'Apply once' }, { label: 'Reject' }], denyIndex: 1 } },
    { kind: 'ask-closed', id: 'q1', outcome: 'answered', choiceLabel: 'Apply once' },
    { kind: 'tool', call: tool({ id: 'b', name: 'file.patch', verb: 'patch', target: 'core/src/tokens.ts', requestedAt: at(10), endedAt: at(31), durationMs: 1000, waited: { openedAt: at(10), closedAt: at(30) }, policy: { decision: 'allowed', by: 'user', rule: 'asked', asked: true } }) },
    { kind: 'tool', call: tool({ id: 'c', name: 'shell', verb: 'shell', target: 'rm -rf build', state: 'denied', requestedAt: at(31), endedAt: at(31), policy: { decision: 'denied', by: 'policy', rule: 'deny-list', asked: false, code: 'policy.denied.rule' } }) },
    { kind: 'tool', call: tool({ id: 'd', verb: 'grep', target: 'x', requestedAt: at(32) }) },
    { kind: 'usage', usage: { runId: 'r1', model: 'claude-sonnet-5', input: 200, output: 100, cacheRead: 9000, cacheWrite: 0, costUSD: 0.005, costs: { input: 0.0006, output: 0.0015, cacheRead: 0.0027, cacheWrite: 0 }, startedAt: at(34), endedAt: at(40), stopReason: 'end_turn', contextTokens: 64_000, contextWindow: 200_000 } },
    { kind: 'run-ended', runId: 'r1', status: 'completed', sentence: '', at: at(40) },
  ]
}

const view = () => reduceAll(EMPTY_VIEW, events())
const NOW = T0 + 60_000
const text = (lines: Line[]) => lines.map(lineText)

function assertFits(lines: Line[], width: number, label: string) {
  for (const l of lines) {
    const w = lineWidth(l)
    if (w > width) throw new Error(`${label} @${width}: "${lineText(l)}" is ${w} cells`)
  }
}

describe('inspector (CD-13)', () => {
  test('turn, duration, model, stop reason, ttft and rate', () => {
    const L = text(inspectorLines(view(), null, FACTS, t, 60, NOW))
    expect(L[0]).toMatch(/^TURN 1 · \d\d:\d\d:\d\d +40\.0s$/)
    expect(L.find(l => l.startsWith('model'))).toContain('claude-sonnet-5')
    expect(L.find(l => l.startsWith('stop'))).toContain('end_turn')
    // 400 output tokens over (4s − 1s ttft) = 133 tok/s.
    expect(L.find(l => l.startsWith('ttft · rate'))).toContain('1.0s · 133 tok/s')
  })

  test('each counter with its OWN cost, summed over the turn’s calls, then the total', () => {
    const L = text(inspectorLines(view(), null, FACTS, t, 60, NOW))
    expect(L.find(l => l.startsWith('input'))).toMatch(/^input +1\.2K +<USD 0\.01$/)
    expect(L.find(l => l.startsWith('cache read'))).toMatch(/17\.0K/)
    expect(L.find(l => l.startsWith('total'))).toMatch(/USD 0\.03$/)
  })

  test('a counter or a cost a call did not report is N/A, never a smaller sum', () => {
    const v = reduceAll(EMPTY_VIEW, [
      { kind: 'user', text: 'q', at: at(0) },
      { kind: 'run-started', runId: 'r', at: at(0) },
      { kind: 'usage', usage: { runId: 'r', model: 'm', input: 10, output: 5 } },
    ])
    const L = text(inspectorLines(v, null, FACTS, t, 60, NOW))
    expect(L.find(l => l.startsWith('input'))).toMatch(/10 +N\/A$/)
    expect(L.find(l => l.startsWith('cache read'))).toMatch(/N\/A +N\/A$/)
    expect(L.find(l => l.startsWith('total'))).toMatch(/N\/A +N\/A$/)
    expect(L.find(l => l.startsWith('ttft · rate'))).toContain('N/A · N/A')
    expect(L.find(l => l.startsWith('stop'))).toContain('N/A')
    expect(L.join('\n')).toContain('no reading yet')
  })

  test('context after, tools with latency and outcome, and the policy on each call in words', () => {
    const L = text(inspectorLines(view(), null, FACTS, t, 60, NOW))
    expect(L.join('\n')).toContain('CONTEXT AFTER')
    expect(L.join('\n')).toContain('32%')
    expect(L.find(l => l.startsWith('read') && l.includes('212 lines'))).toContain('1.0s')
    const pol = L.slice(L.indexOf('POLICY'))
    expect(pol.find(l => l.startsWith('read'))).toContain('allowed · floor')
    expect(pol.find(l => l.startsWith('patch'))).toContain('asked → you: Apply once')
    expect(pol.find(l => l.startsWith('shell'))).toContain('denied by policy (policy.denied.rule)')
    expect(pol.find(l => l.startsWith('grep'))).toContain('no decision recorded')
  })

  test('policy words: waiting while asked; denied by you', () => {
    expect(policyWords(tool({ id: 'x', state: 'asking' }), undefined, t).text).toBe('asked · waiting')
    expect(policyWords(tool({ id: 'x', state: 'denied', policy: { decision: 'denied', by: 'user', rule: 'r', asked: true, code: 'policy.denied.by-person' } }), 'Reject', t).text)
      .toBe('denied by you (policy.denied.by-person)')
    expect(policyWords(tool({ id: 'x', policy: { decision: 'allowed', by: 'user', rule: 'r', asked: true } }), undefined, pt).text).toBe('perguntou → você')
  })

  test('↑↓ picks the turn: resolveTurn clamps, and null follows the newest', () => {
    const v = reduceAll(view(), [{ kind: 'user', text: 'again', at: at(50) }])
    expect(resolveTurn(v, null)).toBe(1)
    expect(resolveTurn(v, 9)).toBe(1)
    expect(resolveTurn(v, -3)).toBe(0)
    expect(resolveTurn(EMPTY_VIEW, null)).toBeNull()
    expect(text(inspectorLines(v, 0, FACTS, t, 60, NOW))[1]).toMatch(/^TURN 1/)
    expect(text(inspectorLines(v, 0, FACTS, t, 60, NOW))[0]).toBe('↑↓ picks the turn')
  })

  test('nothing to inspect is said in one sentence; a historic turn says what was not recorded', () => {
    expect(text(inspectorLines(EMPTY_VIEW, null, FACTS, t, 60, NOW)).join(' ')).toContain('Nothing to inspect yet')
    const h = reduceAll(EMPTY_VIEW, [{ kind: 'history', turns: [{ role: 'user', text: 'q', tools: [] }, { role: 'assistant', text: 'a', tools: [{ name: 'file.read', verb: 'read', target: 'a.ts' }] }] }])
    const L = text(inspectorLines(h, null, FACTS, t, 60, NOW)).join('\n')
    expect(L).toContain('stored history')
    expect(L).not.toContain('REQUEST')
    expect(L).toContain('a.ts')
  })
})

describe('timeline (CD-14)', () => {
  test('one row per model call, per tool execution and per wait on you, in the order they happened', () => {
    const rows = timelineRows(view(), 0, t, NOW)
    expect(rows.map(r => `${r.kind}:${r.label}`)).toEqual([
      'model:model 1', 'tool:read', 'you:you · patch', 'tool:patch', 'model:model 2', 'tool:grep',
    ])
    // A denied call that never executed has no execution row; a call with no end has no span.
    expect(rows.find(r => r.label === 'grep')!.start).toBeUndefined()
  })

  test('where the time went: each total, and N/A for a kind with an untimed row', () => {
    const totals = timeTotals(timelineRows(view(), 0, t, NOW))
    expect(totals.model).toBe(10_000)
    expect(totals.you).toBe(20_000)
    expect(totals.tool).toBeNull()
    const L = text(timelineLines(view(), null, t, 60, NOW))
    expect(L.find(l => l.startsWith('model') && l.includes('%'))).toMatch(/10\.0s 25%$/)
    expect(L.find(l => l.startsWith('waiting on you'))).toMatch(/20\.0s 50%$/)
    expect(L.find(l => l.startsWith('tools'))).toMatch(/N\/A$/)
  })

  test('bars are placed on one axis over the run; an untimed row says N/A instead of a bar at 0', () => {
    const L = text(timelineLines(view(), null, t, 60, NOW))
    expect(L[0]).toMatch(/^RUN 1 +40\.0s · ended$/)
    const you = L.find(l => l.startsWith('you · pa'))!
    expect(you).toContain('░')
    expect(you.indexOf('░')).toBeGreaterThan(15)
    const grep = L.find(l => l.startsWith('grep'))!
    expect(grep).not.toContain('█')
    expect(grep.trimEnd().endsWith('N/A')).toBe(true)
    expect(L.join('\n')).toContain('█ model  █ tool  ░ you')
  })

  test('money: this run, the model calls, the cache hit — N/A when unpriced', () => {
    const L = text(timelineLines(view(), null, t, 60, NOW))
    expect(L.find(l => l.startsWith('this run'))).toMatch(/USD 0\.03$/)
    expect(L.find(l => l.startsWith('model calls'))).toMatch(/2$/)
    expect(L.find(l => l.startsWith('cache hit'))).toMatch(/\d+%$/)
    const unpriced = reduceAll(EMPTY_VIEW, [
      { kind: 'user', text: 'q', at: at(0) }, { kind: 'run-started', runId: 'r', at: at(0) },
      { kind: 'usage', usage: { runId: 'r', model: 'm', input: 1 } },
    ])
    expect(text(timelineLines(unpriced, null, t, 60, NOW)).find(l => l.startsWith('this run'))).toMatch(/N\/A$/)
  })

  test('an open wait runs to NOW, and a live run is said to be live', () => {
    const live = reduceAll(EMPTY_VIEW, [
      { kind: 'user', text: 'q', at: at(0) },
      { kind: 'run-started', runId: 'r', at: at(0) },
      { kind: 'tool', call: tool({ id: 'w', verb: 'shell', state: 'asking', requestedAt: at(5), waited: { openedAt: at(5) } }) },
    ])
    const rows = timelineRows(live, 0, t, T0 + 25_000)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.open).toBe(true)
    expect(rows[0]!.end! - rows[0]!.start!).toBe(20_000)
    const L = text(timelineLines(live, null, t, 60, T0 + 25_000))
    expect(L[0]).toContain('● live')
    expect(L.find(l => l.startsWith('you'))).toContain('20.0s▸')
  })

  test('no run recorded, and no turn at all, are each a sentence', () => {
    expect(text(timelineLines(EMPTY_VIEW, null, t, 60, NOW)).join(' ')).toContain('No run to draw yet')
    const q = reduceAll(EMPTY_VIEW, [{ kind: 'user', text: 'q', at: at(0) }])
    expect(text(timelineLines(q, null, t, 60, NOW)).join(' ')).toContain('No run was recorded')
  })
})

describe('the panel sides fit every width they are given', () => {
  for (const w of [30, 34, 76, 106]) {
    test(`at ${w}`, () => {
      for (const lang of [t, pt]) {
        assertFits(inspectorLines(view(), null, FACTS, lang, w, NOW), w, 'inspector')
        assertFits(timelineLines(view(), null, lang, w, NOW), w, 'timeline')
        assertFits(inspectorLines(EMPTY_VIEW, null, FACTS, lang, w, NOW), w, 'inspector empty')
        assertFits(timelineLines(EMPTY_VIEW, null, lang, w, NOW), w, 'timeline empty')
      }
    })
  }
})

describe('the panel scrolls, and says what it cut', () => {
  const lines: Line[] = Array.from({ length: 20 }, (_, i) => [{ text: `row ${i}` }])
  test('fits: nothing added', () => {
    expect(panelWindow(lines.slice(0, 5), 10, 0, t, 30, false)).toHaveLength(5)
  })
  test('overflowing: the last row names what is below, and the first what is above once scrolled', () => {
    const top = text(panelWindow(lines, 8, 0, t, 34, false))
    expect(top).toHaveLength(8)
    expect(top[0]).toBe('row 0')
    expect(top[7]).toBe('▼ 13 more below · shift+↓')
    const mid = text(panelWindow(lines, 8, 5, t, 34, true))
    expect(mid[0]).toBe('▲ 6 more above · shift+↑')
    expect(mid[7]).toBe('▼ 8 more below · pgdn')
    const end = text(panelWindow(lines, 8, 99, t, 34, false))
    expect(end[7]).toBe('row 19')
    expect(clampPanelTop(20, 8, 99)).toBe(12)
    expect(clampPanelTop(5, 8, 3)).toBe(0)
  })
})
