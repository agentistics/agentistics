import { describe, expect, test } from 'bun:test'
import {
  CODE_COMMANDS,
  CODE_WIDE_AT,
  COMPOSER_ROWS,
  EMPTY_VIEW,
  FOLLOW,
  PANEL_WIDTH,
  STREAM_CURSOR,
  cacheHit,
  cellWidth,
  codeHints,
  codeKeyIntent,
  codeLayout,
  coalesceEvents,
  columnRows,
  composerHint,
  composerLine,
  conversationLines,
  createCoalescer,
  fitSections,
  fullDiffLines,
  headerLine,
  hunkStart,
  inlineDiffLines,
  lineText,
  lineWidth,
  matchCommands,
  narrowStatusLine,
  optionLines,
  permissionCardLines,
  popupLines,
  reduceAll,
  reduceCode,
  scrollTail,
  sessionPanelLines,
  tailStart,
  toolRow,
  truncateCells,
  wrapText,
  type CodeHintState,
  type CodeKeyContext,
  type CodeView,
  type Line,
} from './code'
import { codeStrings } from './code-i18n'
import type { CodeAsk, CodeDiff, CodeEvent, CodeSessionFacts, CodeToolCall } from './code-types'

const t = codeStrings('en')
const pt = codeStrings('pt')

const FACTS: CodeSessionFacts = {
  sessionId: 'ses_3f5f0000',
  shortId: '3f5f',
  title: 'parser fix',
  task: { id: 'task-1', ref: 't-0539', title: 'Parser: off-by-one on the last byte' },
  subtask: { id: 'st-1', title: 'Patch and run the core tests' },
  cwd: '/home/someone/projects/agentistics/.claude/worktrees/parser-fix',
  workspaceRoot: '/home/someone/projects/agentistics',
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  mode: 'ask',
}

const DIFF: CodeDiff = {
  files: [{
    path: 'packages/core/src/tokens.ts',
    op: 'update',
    added: 3,
    removed: 1,
    hunks: [{
      header: '@@ -39,7 +39,9 @@ export function slice',
      lines: [
        { op: ' ', text: 'export function slice(buf, start, len) {' },
        { op: ' ', text: '  if (len <= 0) return []' },
        { op: ' ', text: '  const end = start + len' },
        { op: '-', text: '  if (end > buf.length - 1) return null' },
        { op: '+', text: '  if (end > buf.length) return null' },
        { op: '+', text: '  // end is exclusive: a slice ending on the last byte is valid' },
        { op: '+', text: '  // (regression: tokens.test.ts "last byte")' },
        { op: ' ', text: '  return buf.subarray(start, end)' },
      ],
    }],
  }],
}

const PATCH_ASK: CodeAsk = {
  id: 'q-1',
  kind: 'permission',
  toolId: 'tool-3',
  toolName: 'file.patch',
  title: 'Allow this patch to be applied?',
  why: ['mode ask and no allow rule covers file.patch'],
  diff: DIFF,
  checkpoint: false,
  options: [
    { label: 'Apply once' },
    { label: 'Apply, and allow patches under packages/core/ for this session', description: 'until the session ends' },
    { label: 'Reject' },
  ],
  denyIndex: 2,
}

const SHELL_ASK: CodeAsk = {
  id: 'q-2',
  kind: 'permission',
  toolId: 'tool-4',
  toolName: 'shell',
  title: 'Allow this command to run?',
  why: ['no allow rule matches "bun test"', 'shell always asks in mode ask'],
  command: { command: 'bun test packages/core --timeout 20000 --bail', cwd: '/home/someone/projects/agentistics' },
  checkpoint: false,
  options: [{ label: 'Allow once' }, { label: 'Allow bun test * for this session' }, { label: 'Deny' }],
  denyIndex: 2,
}

const call = (over: Partial<CodeToolCall> & { id: string }): CodeToolCall => ({
  name: 'file.read', verb: 'read', target: 'core/src/tokens.ts', state: 'done', ...over,
})

/** A session mid-answer: a finished turn, then a streaming one with tools and an applied patch. */
function fixtureView(): CodeView {
  const events: CodeEvent[] = [
    { kind: 'user', text: 'why does the parser drop the last byte of a buffer?', at: '2026-09-28T14:00:00Z' },
    { kind: 'run-started', runId: 'r1', at: '2026-09-28T14:00:01Z' },
    { kind: 'delta', runId: 'r1', text: 'sliceEnd treats the end as inclusive, so a slice ' },
    { kind: 'delta', runId: 'r1', text: 'that ends on the last byte is rejected.' },
    { kind: 'tool', call: call({ id: 'tool-1', durationMs: 40, result: '212 lines' }) },
    { kind: 'usage', usage: { runId: 'r1', model: 'claude-sonnet-5', input: 900, output: 200, cacheRead: 6900, cacheWrite: 200, costUSD: 0.011, contextTokens: 72_000, contextWindow: 200_000 } },
    { kind: 'run-ended', runId: 'r1', status: 'completed', sentence: 'done', at: '2026-09-28T14:00:05Z' },
    { kind: 'user', text: 'now fix it and run the core tests', at: '2026-09-28T14:02:00Z' },
    { kind: 'run-started', runId: 'r2', at: '2026-09-28T14:02:01Z' },
    { kind: 'delta', runId: 'r2', text: "I'll read the parser, patch the boundary check, then run the core tests." },
    { kind: 'tool', call: call({ id: 'tool-2', verb: 'grep', name: 'grep', target: '"sliceEnd" in core', durationMs: 18, result: '3 matches' }) },
    { kind: 'tool', call: call({ id: 'tool-3', name: 'file.patch', verb: 'patch', target: 'core/src/tokens.ts', state: 'done', durationMs: 12, diff: DIFF }) },
    { kind: 'tool', call: call({ id: 'tool-4', name: 'shell', verb: 'shell', target: 'bun test packages/core', state: 'failed', durationMs: 2400, failure: 'exit 1 — 1 test failed: tokens.test.ts "slice ending on the last byte"' }) },
    { kind: 'delta', runId: 'r2', text: 'One test still fails; looking at it now' },
    { kind: 'usage', usage: { runId: 'r2', model: 'claude-sonnet-5', input: 1000, output: 400, cacheRead: 8400, cacheWrite: 300, costUSD: 0.016, contextTokens: 78_000, contextWindow: 200_000 } },
    { kind: 'plan', items: [{ text: 'locate the boundary check', status: 'done' }, { text: 'patch the parser', status: 'done' }, { text: 'run the core tests', status: 'active' }, { text: 'summarize', status: 'todo' }] },
  ]
  return reduceAll(EMPTY_VIEW, events)
}

const WIDTHS = [40, 80, 108, 140]

function assertFits(lines: Line[], width: number, label: string) {
  for (const l of lines) {
    const w = lineWidth(l)
    if (w > width) throw new Error(`${label} @${width}: "${lineText(l)}" is ${w} cells`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('text measurement', () => {
  test('wide characters count two cells, combining marks none', () => {
    expect(cellWidth('abc')).toBe(3)
    expect(cellWidth('漢字')).toBe(4)
    expect(cellWidth('é')).toBe(1)
    expect(cellWidth('＋')).toBe(2)
  })

  test('truncateCells never splits a wide character across the edge', () => {
    expect(cellWidth(truncateCells('漢字漢字', 5))).toBeLessThanOrEqual(5)
    expect(truncateCells('abcdef', 4)).toBe('abc…')
  })

  test('wrapText keeps every row within the width, including one word longer than the row', () => {
    const rows = wrapText('a supercalifragilisticexpialidocious word\n\nnext paragraph', 10)
    for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(10)
    expect(rows).toContain('')
  })

  test('control characters and escapes never reach a cell', () => {
    const rows = wrapText('red \u001b[31mtext\u001b[0m\r and a bell\u0007', 80)
    expect(rows.join('')).not.toMatch(/[\u0000-\u001f]/)
  })
})

describe('reduceCode — the fold', () => {
  test('streaming deltas concatenate into ONE text part of the current answer', () => {
    const v = reduceAll(EMPTY_VIEW, [
      { kind: 'user', text: 'hi', at: 'x' },
      { kind: 'run-started', runId: 'r1', at: 'x' },
      { kind: 'delta', runId: 'r1', text: 'Hel' },
      { kind: 'delta', runId: 'r1', text: 'lo' },
    ])
    const last = v.entries[v.entries.length - 1]!
    expect(last.kind).toBe('assistant')
    if (last.kind !== 'assistant') return
    expect(last.parts).toEqual([{ kind: 'text', text: 'Hello' }])
    expect(v.runId).toBe('r1')
  })

  test('a delta after a user turn opens a NEW answer instead of appending above the question', () => {
    const v = reduceAll(EMPTY_VIEW, [
      { kind: 'delta', runId: 'r1', text: 'first' },
      { kind: 'user', text: 'again', at: 'x' },
      { kind: 'delta', runId: 'r2', text: 'second' },
    ])
    expect(v.entries.map(e => e.kind)).toEqual(['assistant', 'user', 'assistant'])
  })

  test('a tool is upserted by id through its whole life: running → asking → done, one row', () => {
    let v = reduceCode(EMPTY_VIEW, { kind: 'run-started', runId: 'r1', at: 'x' })
    v = reduceCode(v, { kind: 'tool', call: call({ id: 'a', state: 'running' }) })
    v = reduceCode(v, { kind: 'tool', call: call({ id: 'a', state: 'asking' }) })
    v = reduceCode(v, { kind: 'tool', call: call({ id: 'a', state: 'done', durationMs: 5 }) })
    const parts = v.entries.flatMap(e => (e.kind === 'assistant' ? e.parts : []))
    expect(parts.filter(p => p.kind === 'tool')).toHaveLength(1)
    expect(v.tools.a!.state).toBe('done')
  })

  test('asking → denied keeps the failure in words', () => {
    let v = reduceCode(EMPTY_VIEW, { kind: 'tool', call: call({ id: 'a', state: 'asking' }) })
    v = reduceCode(v, { kind: 'tool', call: call({ id: 'a', state: 'denied', failure: 'denied by you' }) })
    expect(v.tools.a!.state).toBe('denied')
    const rows = toolRow(v.tools.a!, t, 80).map(lineText).join('\n')
    expect(rows).toContain('denied by you')
  })

  test('usage sums the session and resets the run on run-started; the context is a gauge, not a sum', () => {
    const v = fixtureView()
    expect(v.session.input).toBe(1900)
    expect(v.session.cacheRead).toBe(15_300)
    expect(v.session.costUSD).toBeCloseTo(0.027)
    expect(v.run.input).toBe(1000)
    expect(v.context).toEqual({ tokens: 78_000, window: 200_000 })
  })

  test('a counter never reported stays ABSENT — N/A, never 0', () => {
    const v = reduceCode(EMPTY_VIEW, { kind: 'usage', usage: { model: 'm', input: 10, output: 5 } })
    expect(v.session.cacheRead).toBeUndefined()
    expect(v.session.cacheWrite).toBeUndefined()
    expect(v.session.costUSD).toBeUndefined()
    expect(v.session.unpriced).toBe(1)
    const panel = sessionPanelLines(v, FACTS, t, 34).map(lineText).join('\n')
    expect(panel).toContain('N/A')
    expect(panel).not.toMatch(/cache read 0\b/)
  })

  test('ask opens and closes; the close is recorded in words', () => {
    let v = reduceCode(EMPTY_VIEW, { kind: 'ask', ask: PATCH_ASK })
    expect(v.ask?.id).toBe('q-1')
    v = reduceCode(v, { kind: 'ask-closed', id: 'q-1', outcome: 'answered', choiceLabel: 'Apply once' })
    expect(v.ask).toBeNull()
    expect(conversationLines(v, FACTS, t, 80).map(lineText).join('\n')).toContain('answered: Apply once')
  })

  test('an applied patch counts its files ONCE however often the call is upserted', () => {
    let v = EMPTY_VIEW
    for (let i = 0; i < 3; i++) v = reduceCode(v, { kind: 'tool', call: call({ id: 'p', state: 'done', diff: DIFF }) })
    expect(v.files).toEqual([{ path: 'packages/core/src/tokens.ts', added: 3, removed: 1 }])
  })

  test('a run that did not complete leaves the host sentence where it happened', () => {
    const v = reduceAll(EMPTY_VIEW, [
      { kind: 'run-started', runId: 'r1', at: 'x' },
      { kind: 'run-ended', runId: 'r1', status: 'failed', sentence: 'The provider refused the request.', at: 'x' },
    ])
    expect(v.runId).toBeNull()
    expect(conversationLines(v, FACTS, t, 80).map(lineText).join('\n')).toContain('The provider refused the request.')
  })

  test('history REPLACES the view, with its tools as done rows and no invented duration', () => {
    const v = reduceCode(fixtureView(), { kind: 'history', turns: [
      { role: 'user', text: 'old question', tools: [] },
      { role: 'assistant', text: 'old answer', tools: [{ name: 'file.read', verb: 'read', target: 'a.ts' }] },
    ] })
    expect(v.entries).toHaveLength(2)
    expect(v.turns).toBe(1)
    expect(v.session).toEqual(EMPTY_VIEW.session)
    const tool = Object.values(v.tools)[0]!
    expect(tool.durationMs).toBeUndefined()
  })

  test('closed locks the composer with the host sentence', () => {
    const v = reduceCode(fixtureView(), { kind: 'closed', sentence: 'The session was ended elsewhere.' })
    expect(v.closed).toBe('The session was ended elsewhere.')
    expect(lineText(composerLine({ draft: '', ask: null, closed: v.closed, sessionOpen: true }, t, 80))).toContain('The session was ended elsewhere.')
  })
})

describe('coalescing a stream (CD-02)', () => {
  test('adjacent deltas of one run merge; other events keep their order', () => {
    const out = coalesceEvents([
      { kind: 'delta', runId: 'r', text: 'a' },
      { kind: 'delta', runId: 'r', text: 'b' },
      { kind: 'tool', call: call({ id: 'x' }) },
      { kind: 'delta', runId: 'r', text: 'c' },
    ])
    expect(out.map(e => e.kind)).toEqual(['delta', 'tool', 'delta'])
    expect((out[0] as { text: string }).text).toBe('ab')
  })

  test('a burst is delivered once, after one interval, never per token', () => {
    const timers: Array<() => void> = []
    const delivered: CodeEvent[][] = []
    const c = createCoalescer({
      intervalMs: 50,
      deliver: e => delivered.push(e),
      schedule: fn => { timers.push(fn); return timers.length },
      cancel: () => {},
    })
    for (let i = 0; i < 40; i++) c.push({ kind: 'delta', runId: 'r', text: 'x' })
    expect(delivered).toHaveLength(0)
    expect(timers).toHaveLength(1)
    timers[0]!()
    expect(delivered).toHaveLength(1)
    expect((delivered[0]![0] as { text: string }).text).toBe('x'.repeat(40))
  })

  test('dispose drops what was buffered — it belonged to a session that is gone', () => {
    const delivered: CodeEvent[][] = []
    const c = createCoalescer({ intervalMs: 50, deliver: e => delivered.push(e), schedule: () => 1, cancel: () => {} })
    c.push({ kind: 'delta', text: 'x' })
    c.dispose()
    c.flush()
    expect(delivered).toHaveLength(0)
  })
})

describe('headerLine (CD-01)', () => {
  test('the no-sandbox warning survives every width down to its own length', () => {
    for (let w = 14; w <= 160; w++) {
      const text = lineText(headerLine(FACTS, t, w))
      expect(text).toContain('▲ no sandbox')
      expect(lineWidth(headerLine(FACTS, t, w))).toBeLessThanOrEqual(w)
    }
  })

  test('at 40 columns: the warning and the task handle, the folder gone', () => {
    const text = lineText(headerLine(FACTS, t, 40))
    expect(text).toContain('▲ no sandbox')
    expect(text).not.toContain('/home/')
  })

  test('the folder is dropped before the task title, the task title before the session title', () => {
    const wide = lineText(headerLine(FACTS, t, 200))
    expect(wide).toContain('/home/someone')
    const mid = lineText(headerLine(FACTS, t, 110))
    expect(mid).not.toContain('/home/someone')
    expect(mid).toContain('Parser: off-by-one')
    const narrow = lineText(headerLine(FACTS, t, 60))
    expect(narrow).not.toContain('Parser: off-by-one')
    expect(narrow).toContain('parser fix')
  })

  test('with no session it still carries the warning', () => {
    expect(lineText(headerLine(null, t, 80))).toContain('▲ no sandbox')
    expect(lineText(headerLine(null, pt, 80))).toContain('▲ sem sandbox')
  })
})

describe('no line wider than its width — every builder, every width', () => {
  const v = reduceCode(fixtureView(), { kind: 'ask', ask: PATCH_ASK })
  for (const w of WIDTHS) {
    test(`at ${w}`, () => {
      assertFits([headerLine(FACTS, t, w)], w, 'header')
      assertFits(conversationLines(v, FACTS, t, w), w, 'conversation')
      assertFits(permissionCardLines(PATCH_ASK, t, w), w, 'card patch')
      assertFits(permissionCardLines(SHELL_ASK, t, w), w, 'card shell')
      const d = fullDiffLines(PATCH_ASK, t, w)
      assertFits([...d.head, ...d.body, ...d.options], w, 'full diff')
      assertFits([composerLine({ draft: 'x'.repeat(300), ask: null, closed: null, sessionOpen: true }, t, w)], w, 'composer')
      assertFits([composerLine({ draft: '', ask: PATCH_ASK, closed: null, sessionOpen: true }, t, w)], w, 'composer locked')
      assertFits(popupLines(matchCommands('/'), 0, t, w), w, 'popup')
      assertFits(sessionPanelLines(v, FACTS, t, w), w, 'panel')
      assertFits([narrowStatusLine(v, FACTS, t, w)], w, 'status')
      for (const lang of [t, pt]) assertFits([composerHint('!ls @foo', lang, w)!], w, 'hint')
    })
  }
})

describe('conversation (CD-02 / CD-03 / CD-04)', () => {
  test('the live cursor sits at the end of the streaming text, and only while the run is live', () => {
    const v = fixtureView()
    const lines = conversationLines(v, FACTS, t, 80).map(lineText)
    expect(lines.join('\n')).toContain(STREAM_CURSOR)
    expect(lines.filter(l => l.includes(STREAM_CURSOR))).toHaveLength(1)
    const ended = reduceCode(v, { kind: 'run-ended', runId: 'r2', status: 'completed', sentence: '', at: 'x' })
    expect(conversationLines(ended, FACTS, t, 80).map(lineText).join('\n')).not.toContain(STREAM_CURSOR)
  })

  test('tool rows carry a glyph, a verb, a target and a right-aligned outcome', () => {
    const row = lineText(toolRow(call({ id: 'a', durationMs: 40, result: '212 lines' }), t, 80)[0]!)
    expect(row.startsWith('✓ read')).toBe(true)
    expect(row.endsWith('212 lines · 40ms')).toBe(true)
    expect(lineText(toolRow(call({ id: 'b', state: 'asking' }), t, 80)[0]!)).toContain('needs you')
  })

  test('a failure is said in words on its own line, not truncated beside the target', () => {
    const rows = toolRow(call({ id: 'a', state: 'failed', failure: 'exit 1 — 1 test failed' }), t, 60).map(lineText)
    expect(rows[0]).toContain('failed')
    expect(rows[1]).toContain('exit 1 — 1 test failed')
  })

  test('an applied patch shows its changed lines, then how many more', () => {
    const lines = inlineDiffLines(DIFF, t, 80, 2).map(lineText)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('- ')
    expect(lines[2]).toContain('+ 2 more changed lines')
  })
})

describe('permission card (CD-07)', () => {
  test('options are numbered 1..n in the POLICY order, labels verbatim', () => {
    const opts = optionLines(PATCH_ASK, 200).map(lineText)
    expect(opts).toEqual([
      '1 Apply once',
      '2 Apply, and allow patches under packages/core/ for this session  until the session ends',
      '3 Reject',
    ])
  })

  test('`d full diff` appears only when the ask carries a diff', () => {
    expect(permissionCardLines(PATCH_ASK, t, 100).map(lineText).join('\n')).toContain('d full diff')
    expect(permissionCardLines(SHELL_ASK, t, 100).map(lineText).join('\n')).not.toContain('full diff')
  })

  test('a shell call shows the WHOLE command and where it runs, as you, with no sandbox', () => {
    const text = permissionCardLines(SHELL_ASK, t, 100).map(lineText).join('\n')
    expect(text).toContain('bun test packages/core --timeout 20000 --bail')
    expect(text).toContain('cwd /home/someone/projects/agentistics · runs as you · no sandbox')
    expect(text).toContain('asked because: no allow rule matches "bun test"')
    expect(text).toContain('shell always asks in mode ask')
  })

  test('the checkpoint note appears ONLY when the runtime really takes one', () => {
    expect(permissionCardLines(PATCH_ASK, t, 100).map(lineText).join('\n')).not.toContain('checkpoint')
    expect(permissionCardLines({ ...PATCH_ASK, checkpoint: true }, t, 100).map(lineText).join('\n')).toContain('checkpoint')
    expect(fullDiffLines(PATCH_ASK, t, 100).head.map(lineText).join('\n')).not.toContain('checkpoint')
  })

  test('under a short budget the diff preview goes first and the options never go', () => {
    const full = permissionCardLines(PATCH_ASK, t, 100)
    const short = permissionCardLines(PATCH_ASK, t, 100, full.length - 3)
    expect(short).toHaveLength(full.length - 3)
    const text = short.map(lineText)
    expect(text.slice(-3)).toEqual(['1 Apply once', expect.stringContaining('2 Apply'), '3 Reject'])
    expect(text.join('\n')).toContain('packages/core/src/tokens.ts')
  })

  test('a preview cut by the height budget is COUNTED in "+ K more", never cut in silence', () => {
    // Regression (code-tab.e2e.test.ts, 80x24): the count was taken before the budget trimmed the
    // preview, so the card showed one removed line, none of the added ones, and no word of it.
    const changed = (PATCH_ASK.diff?.files ?? []).reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.filter(l => l.op !== ' ').length, 0), 0)
    const full = permissionCardLines(PATCH_ASK, t, 100)
    for (let rows = full.length; rows >= full.length - 4; rows--) {
      const text = permissionCardLines(PATCH_ASK, t, 100, rows).map(lineText)
      const shown = text.filter(l => /^[+-] /.test(l) && !/^\+ \d+ more/.test(l)).length
      const more = text.map(l => /^\+ (\d+) more/.exec(l)).find(Boolean)
      expect(shown + (more ? Number(more[1]) : 0)).toBe(changed)
    }
  })

  test('fitSections shrinks lowest `drop` first, down to each section min', () => {
    const l = (s: string): Line => [{ text: s }]
    const out = fitSections([
      { lines: [l('a1'), l('a2')], min: 1, drop: 5 },
      { lines: [l('b1'), l('b2'), l('b3')], min: 0, drop: 1 },
      { lines: [l('c')], min: 1, drop: 100 },
    ], 3).map(lineText)
    expect(out).toEqual(['a1', 'a2', 'c'])
  })
})

describe('full diff (CD-09)', () => {
  test('every hunk line, with the old number on a removal and the new one otherwise', () => {
    const body = fullDiffLines(PATCH_ASK, t, 120).body.map(lineText)
    expect(body.some(l => l.startsWith('-  42 │'))).toBe(true)
    expect(body.some(l => l.startsWith('+  42 │'))).toBe(true)
    expect(body.some(l => l.startsWith('+  44 │'))).toBe(true)
    expect(body.filter(l => /│/.test(l))).toHaveLength(8)
  })

  test('the same numbered options sit under it', () => {
    expect(fullDiffLines(PATCH_ASK, t, 120).options.map(lineText)[0]).toBe('1 Apply once')
  })

  test('hunkStart reads the header, and says nothing when there is none', () => {
    expect(hunkStart('@@ -39,7 +40,9 @@')).toEqual({ old: 39, new: 40 })
    expect(hunkStart(undefined)).toBeNull()
  })
})

describe('session panel (CD-12, P1)', () => {
  test('context total only, spend api-equivalent, four counters, cache hit, files, plan', () => {
    const text = sessionPanelLines(fixtureView(), FACTS, t, 34).map(lineText).join('\n')
    expect(text).toContain('CONTEXT')
    expect(text).toContain('39%')
    expect(text).toContain('api-equivalent')
    expect(text).toContain('this turn')
    expect(text).toContain('cache hit')
    expect(text).toContain('tokens.ts')
    expect(text).toContain('PLAN')
    expect(text).not.toMatch(/today|ALSO OPEN|sys |tools \d/)
  })

  test('cache hit uses core’s denominator, and is N/A without the counters it needs', () => {
    expect(cacheHit({ input: 100, cacheRead: 300, cacheWrite: 100, calls: 1, unpriced: 0 })).toBeCloseTo(0.6)
    expect(cacheHit({ input: 100, calls: 1, unpriced: 0 })).toBeNull()
  })

  test('no context reading and no window are each said in words', () => {
    expect(sessionPanelLines(EMPTY_VIEW, FACTS, t, 60).map(lineText).join('\n')).toContain('no reading yet')
    const v = reduceCode(EMPTY_VIEW, { kind: 'usage', usage: { model: 'm', contextTokens: 5000 } })
    expect(sessionPanelLines(v, FACTS, t, 60).map(lineText).join('\n')).toContain('no window stated')
  })
})

describe('layout (D-TUI-10)', () => {
  test('wide: conversation + a 38-column panel; ctrl+b hides it', () => {
    const l = codeLayout(108, 30, { panelOpen: true })
    expect(l.panel).toBe('side')
    expect(l.mainWidth + l.panelWidth).toBe(108)
    expect(l.panelWidth).toBe(PANEL_WIDTH)
    expect(codeLayout(108, 30, { panelOpen: false }).mainWidth).toBe(108)
  })

  test('narrow: one pane — the conversation with a one-line status, or the panel over the body', () => {
    const l = codeLayout(80, 18, { panelOpen: false })
    expect(l.narrow).toBe(true)
    expect(l.statusRows).toBe(1)
    expect(codeLayout(80, 18, { panelOpen: true }).panel).toBe('full')
    expect(codeLayout(CODE_WIDE_AT - 1, 30, { panelOpen: false }).narrow).toBe(true)
  })

  test('the composer and the card keep their rows; the conversation gives up rows first', () => {
    const r = columnRows(16, { card: 10, popup: 0, hint: 1 })
    expect(r.composer).toBe(COMPOSER_ROWS)
    expect(r.card).toBe(10)
    expect(r.hint).toBe(1)
    expect(r.conversation).toBe(2)
    const tiny = columnRows(5, { card: 10, popup: 4, hint: 1 })
    expect(tiny.conversation + tiny.card + tiny.composer + tiny.popup + tiny.hint).toBe(5)
    expect(tiny.conversation).toBe(0)
  })

  test('the tail view follows the live edge, pages back clamped, and resumes following at the bottom', () => {
    expect(tailStart(100, 10, FOLLOW)).toBe(90)
    const back = scrollTail(100, 10, FOLLOW, -1)
    expect(back.follow).toBe(false)
    expect(tailStart(100, 10, back)).toBe(81)
    let s = back
    for (let i = 0; i < 50; i++) s = scrollTail(100, 10, s, -1)
    expect(tailStart(100, 10, s)).toBe(0)
    for (let i = 0; i < 50; i++) s = scrollTail(100, 10, s, 1)
    expect(s.follow).toBe(true)
  })
})

describe('composer and commands (CD-11)', () => {
  test('ONE command table, every entry with an id, a label, keys and an intent', () => {
    for (const c of CODE_COMMANDS) {
      expect(c.label.startsWith('/')).toBe(true)
      expect(c.keys.length).toBeGreaterThan(0)
      expect(c.intent.kind).not.toBe('none')
      expect(t.commandDescriptions[c.id]).toBeTruthy()
      expect(pt.commandDescriptions[c.id]).toBeTruthy()
    }
    expect(matchCommands('/').length).toBe(CODE_COMMANDS.length)
    expect(matchCommands('/ne').map(c => c.id)).toEqual(['new'])
    expect(matchCommands('/new now')).toEqual([])
  })

  test('the locked composer names the options and that esc denies', () => {
    expect(lineText(composerLine({ draft: 'x', ask: PATCH_ASK, closed: null, sessionOpen: true }, t, 80))).toContain('(1–3) · esc denies it')
  })

  test('@ and ! earn their one-line hints', () => {
    expect(lineText(composerHint('look at @src/a.ts', t, 200)!)).toContain('as text')
    expect(lineText(composerHint('!ls', t, 200)!)).toContain('permission card')
    expect(composerHint('plain', t, 80)).toBeNull()
  })
})

const ctx = (over: Partial<CodeKeyContext> = {}): CodeKeyContext => ({
  draft: '', sessionOpen: true, closed: false, ask: null, diffOpen: false, panelFull: false, running: false, popup: null, ...over,
})

describe('keys → intents', () => {
  test('with an ask open: digits answer in policy order, d opens the diff only when there is one, esc denies', () => {
    expect(codeKeyIntent(ctx({ ask: PATCH_ASK }), { input: '2' })).toEqual({ kind: 'answer', choice: 1 })
    expect(codeKeyIntent(ctx({ ask: PATCH_ASK }), { input: '4' })).toEqual({ kind: 'say', code: 'answer-first' })
    expect(codeKeyIntent(ctx({ ask: PATCH_ASK }), { input: 'd' })).toEqual({ kind: 'open-diff' })
    expect(codeKeyIntent(ctx({ ask: SHELL_ASK }), { input: 'd' })).toEqual({ kind: 'say', code: 'no-diff' })
    expect(codeKeyIntent(ctx({ ask: PATCH_ASK }), { input: '', escape: true })).toEqual({ kind: 'deny' })
  })

  test('esc clears a draft before it cancels a run', () => {
    expect(codeKeyIntent(ctx({ draft: 'x', running: true }), { input: '', escape: true })).toEqual({ kind: 'draft', draft: '' })
    expect(codeKeyIntent(ctx({ running: true }), { input: '', escape: true })).toEqual({ kind: 'cancel-run' })
  })

  test('[ and ] change tab only while the draft is empty', () => {
    expect(codeKeyIntent(ctx(), { input: ']' })).toEqual({ kind: 'tab', step: 1 })
    expect(codeKeyIntent(ctx({ draft: 'a' }), { input: ']' })).toEqual({ kind: 'draft', draft: 'a]' })
  })

  test('n opens the wizard only with no session and an empty draft; otherwise it is typed', () => {
    expect(codeKeyIntent(ctx({ sessionOpen: false }), { input: 'n' })).toEqual({ kind: 'open-wizard' })
    expect(codeKeyIntent(ctx(), { input: 'n' })).toEqual({ kind: 'draft', draft: 'n' })
  })

  test('enter: sends, runs a command, refuses an unknown one, or starts a session with the draft', () => {
    expect(codeKeyIntent(ctx({ draft: 'hello' }), { input: '', return: true })).toEqual({ kind: 'send', text: 'hello' })
    expect(codeKeyIntent(ctx({ draft: '/panel' }), { input: '', return: true })).toEqual({ kind: 'toggle-panel' })
    expect(codeKeyIntent(ctx({ draft: '/nope' }), { input: '', return: true })).toEqual({ kind: 'unknown-command', text: '/nope' })
    expect(codeKeyIntent(ctx({ draft: 'fix it', sessionOpen: false }), { input: '', return: true })).toEqual({ kind: 'open-wizard', firstMessage: 'fix it' })
    expect(codeKeyIntent(ctx({ draft: '/', popup: 1 }), { input: '', return: true })).toEqual(CODE_COMMANDS[1]!.intent)
  })

  test('ctrl+b always toggles the panel; in the full panel esc goes back', () => {
    expect(codeKeyIntent(ctx({ ask: PATCH_ASK }), { input: 'b', ctrl: true })).toEqual({ kind: 'toggle-panel' })
    expect(codeKeyIntent(ctx({ panelFull: true }), { input: '', escape: true })).toEqual({ kind: 'toggle-panel' })
  })

  test('a paste keeps printable text and turns line breaks into spaces', () => {
    expect(codeKeyIntent(ctx({ draft: 'a' }), { input: 'b\nc\u0007' })).toEqual({ kind: 'draft', draft: 'ab c' })
  })
})

const hs = (over: Partial<CodeHintState> = {}): CodeHintState => ({ ...ctx(), canScroll: false, narrow: false, ...over })

describe('codeHints (GL-05) — exactly the keys that work now', () => {
  test('ask open: answer, full diff only with a diff, deny', () => {
    expect(codeHints(hs({ ask: PATCH_ASK }), t).slice(0, 3)).toEqual(['1-3 answer', 'd full diff', 'esc deny'])
    expect(codeHints(hs({ ask: SHELL_ASK }), t)).not.toContain('d full diff')
    expect(codeHints(hs({ ask: { ...SHELL_ASK, denyIndex: null } }), t)).toContain('esc dismiss')
  })

  test('full diff open: scroll, answer, back — nothing else', () => {
    expect(codeHints(hs({ ask: PATCH_ASK, diffOpen: true }), t)).toEqual(['1-3 answer', '↑↓/pg scroll', 'esc back'])
  })

  test('idle composer: send first; [ ] tabs only while the draft is empty; history only when there is some', () => {
    const empty = codeHints(hs({ canScroll: true }), t)
    expect(empty).toContain('[ ] tabs')
    expect(empty).toContain('pgup history')
    expect(empty).not.toContain('n new session')
    const typing = codeHints(hs({ draft: 'x' }), t)
    expect(typing[0]).toBe('enter send')
    expect(typing).not.toContain('[ ] tabs')
    expect(typing).not.toContain('pgup history')
  })

  test('no session: n new session leads, and enter on a draft starts one', () => {
    expect(codeHints(hs({ sessionOpen: false }), t)[0]).toBe('n new session')
    expect(codeHints(hs({ sessionOpen: false, draft: 'x' }), t)[0]).toBe('enter start a session with this')
  })

  test('a running run names esc as cancel; the popup names its own three keys', () => {
    expect(codeHints(hs({ running: true }), t)).toContain('esc cancel run')
    expect(codeHints(hs({ draft: '/', popup: 0 }), t)).toEqual(['enter run', '↑↓ choose', 'esc clear'])
  })

  test('every hint names a key codeKeyIntent answers in that same state', () => {
    // A light cross-check: the hint's KEY must produce a non-`none` intent in the same context.
    const probe: Record<string, Parameters<typeof codeKeyIntent>[1]> = {
      'enter send': { input: '', return: true },
      'esc cancel run': { input: '', escape: true },
      'esc clear': { input: '', escape: true },
      'esc deny': { input: '', escape: true },
      'd full diff': { input: 'd' },
      '[ ] tabs': { input: ']' },
      'ctrl+b panel': { input: 'b', ctrl: true },
      'pgup history': { input: '', pageUp: true },
      'n new session': { input: 'n' },
    }
    const states: CodeHintState[] = [
      hs({ canScroll: true }), hs({ draft: 'x' }), hs({ running: true }), hs({ ask: PATCH_ASK, canScroll: true }), hs({ sessionOpen: false }),
    ]
    for (const st of states) {
      for (const h of codeHints(st, t)) {
        const key = probe[h]
        if (!key) continue
        expect(codeKeyIntent(st, key).kind).not.toBe('none')
      }
    }
  })
})

describe('the no-sandbox words are never the ones cut', () => {
  test('a long cwd moves to its own line instead of pushing `no sandbox` off the card', () => {
    const ask: CodeAsk = { ...SHELL_ASK, command: { command: 'ls', cwd: '/home/someone/a/very/long/path/that/goes/on/.claude/worktrees/parser-fix' } }
    for (const w of [40, 64, 80]) {
      const text = permissionCardLines(ask, t, w).map(lineText)
      expect(text.some(l => l.includes('runs as you · no sandbox'))).toBe(true)
    }
  })

  test('with no session the panel says so in one sentence, not a column of N/A', () => {
    const lines = sessionPanelLines(EMPTY_VIEW, null, t, 34).map(lineText)
    expect(lines.join(' ')).toContain('no session is open')
    expect(lines.join(' ')).not.toContain('N/A')
  })
})
