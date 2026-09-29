import { describe, expect, test } from 'bun:test'
import {
  batches, emptyHalf, emptyState, parseImportArgs, parseImportState, planArtifacts, planStore,
  renderImportReport, selectedHarnesses, stampBytes, startsOnOrAfter, type ImportReport, type StoreEntry,
} from './import-plan'
import { runJournalImport } from '../cli-journal'

describe('parseImportArgs', () => {
  test('defaults', () => {
    expect(parseImportArgs([])).toEqual({ ok: true, args: { harnesses: [], dryRun: false, json: false } })
  })
  test('--harness repeated, comma-separated, deduped; --from; --dry-run; --json; sizes', () => {
    const r = parseImportArgs(['--harness', 'codex,claude', '--harness=codex', '--from', '2026-01-01', '--dry-run', '--json', '--batch-size', '8', '--concurrency=2'])
    expect(r).toEqual({ ok: true, args: { harnesses: ['codex', 'claude'], from: '2026-01-01', dryRun: true, json: true, batchSize: 8, concurrency: 2 } })
  })
  test('refusals are named', () => {
    expect(parseImportArgs(['--harness', 'nope'])).toMatchObject({ ok: false, error: expect.stringContaining('unknown harness "nope"') })
    expect(parseImportArgs(['--from', '01/02/2026'])).toMatchObject({ ok: false })
    expect(parseImportArgs(['--batch-size', '0'])).toMatchObject({ ok: false })
    expect(parseImportArgs(['--what'])).toMatchObject({ ok: false, error: 'unknown argument "--what"' })
    expect(parseImportArgs(['--harness'])).toMatchObject({ ok: false })
  })
  test('selectedHarnesses keeps HARNESS_ORDER', () => {
    expect(selectedHarnesses(['kimi', 'claude'])).toEqual(['claude', 'kimi'])
    expect(selectedHarnesses([])).toContain('antigravity')
  })
})

describe('the state file', () => {
  test('a state naming another journal inherits nothing', () => {
    const s = { v: 1, identity: 'A', sources: { 'claude:x': { cursor: null, replayedAtMs: 1 } }, store: {} }
    expect(parseImportState(JSON.stringify(s), 'B')).toEqual(emptyState('B'))
    expect(parseImportState(JSON.stringify(s), 'A').sources['claude:x']).toEqual({ cursor: null, replayedAtMs: 1 })
  })
  test('garbage and malformed records are dropped, never trusted', () => {
    expect(parseImportState('{', 'A')).toEqual(emptyState('A'))
    expect(parseImportState(null, 'A')).toEqual(emptyState('A'))
    const s = { v: 1, identity: 'A', sources: { bad: { cursor: 3 }, ok: { cursor: 'c', replayedAtMs: 2, stamp: { key: 'k', mtimeMs: 1 } } }, store: { a: { stamp: 1 }, b: { stamp: 's', importedAtMs: 1 } } }
    const p = parseImportState(JSON.stringify(s), 'A')
    expect(Object.keys(p.sources)).toEqual(['ok'])
    expect(Object.keys(p.store)).toEqual(['b'])
  })
})

describe('planning', () => {
  const src = (id: string) => ({ sessionId: id, sourceRef: `claude:${id}` })
  test('planArtifacts: a settled, unchanged stamp is skipped; a changed one replays from its cursor', () => {
    const state = emptyState('A')
    state.sources['claude:a'] = { cursor: 'ca', replayedAtMs: 10_000_000, stamp: { key: 'k1', mtimeMs: 1 } }
    state.sources['claude:b'] = { cursor: 'cb', replayedAtMs: 10_000_000, stamp: { key: 'k1', mtimeMs: 1 } }
    const stamps = new Map([['a', { key: 'k1', mtimeMs: 1 }], ['b', { key: 'k2', mtimeMs: 2 }]])
    const p = planArtifacts('claude', [src('a'), src('b'), src('c')], state, stamps, new Map(), undefined)
    expect(p.skipped).toEqual({ unchanged: 1 })
    expect(p.replay.map(x => [x.source.sessionId, x.cursor])).toEqual([['b', 'cb'], ['c', null]])
  })
  test('planArtifacts: a source recorded while live is replayed again (settle margin)', () => {
    const state = emptyState('A')
    state.sources['claude:a'] = { cursor: 'ca', replayedAtMs: 1000, stamp: { key: 'k', mtimeMs: 900 } }
    const p = planArtifacts('claude', [src('a')], state, new Map([['a', { key: 'k', mtimeMs: 900 }]]), new Map(), undefined)
    expect(p.replay).toHaveLength(1)
  })
  test('planArtifacts: --from uses the store start when known', () => {
    const p = planArtifacts('claude', [src('a'), src('b')], emptyState('A'), null, new Map([['a', '2025-01-01T00:00:00Z']]), '2026-01-01')
    expect(p.skipped).toEqual({ 'before-from': 1 })
    expect(p.replay.map(x => x.source.sessionId)).toEqual(['b'])
  })
  test('planStore: orphans only, in the order the reasons are checked', () => {
    const e = (id: string, start?: string): Extract<StoreEntry, { ok: true }> => ({ ok: true, harness: 'claude', sessionId: id, file: `claude/${id}.json`, stamp: 's', ...(start ? { start } : {}) })
    const state = emptyState('A')
    state.store['claude:done'] = { stamp: 's', importedAtMs: 1 }
    const runIdOf = (id: string) => `run_${id}`
    const p = planStore(
      [e('live'), e('old', '2020-01-01T00:00:00Z'), e('replayed'), e('done'), e('new')],
      new Set(['live']), runIdOf, new Set(['run_replayed']), state, '2021-01-01',
    )
    expect(p.skipped).toEqual({ 'not-orphan': 1, 'before-from': 1, 'already-in-journal': 1, unchanged: 1 })
    expect(p.import.map(x => x.sessionId)).toEqual(['new'])
    expect(planStore([e('x')], null, runIdOf, new Set(), state, undefined).skipped).toEqual({ 'no-replay': 1 })
    expect(planStore([e('x')], new Set(), null, new Set(), state, undefined).skipped).toEqual({ 'no-entity-ids': 1 })
  })
  test('batches, stampBytes, startsOnOrAfter', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(batches([], 3)).toEqual([])
    expect(stampBytes({ key: '100:5|agent-a.jsonl:20:6|agent-a.meta.json:3:7', mtimeMs: 7 })).toBe(123)
    expect(stampBytes(undefined)).toBeUndefined()
    expect(startsOnOrAfter(undefined, '2026-01-01')).toBe(true)
    expect(startsOnOrAfter('2026-01-01T23:00:00Z', '2026-01-01')).toBe(true)
    expect(startsOnOrAfter('2025-12-31T23:59:59Z', '2026-01-01')).toBe(false)
  })
})

describe('renderImportReport', () => {
  test('every non-zero reason is said, and a dry run says so', () => {
    const h = { harness: 'claude' as const, replayAbsent: null, artifacts: emptyHalf(), store: emptyHalf() }
    h.artifacts.failed = { 'no-events': 2, 'rejected:bad-timestamp': 1 }
    h.store.skipped = { 'not-orphan': 3 }
    const r: ImportReport = { dryRun: true, journalPath: '/j.db', harnesses: [h as never], interrupted: true, conflicts: 2, examples: { 'no-events': 'claude:x' }, ms: 1500 }
    const text = renderImportReport(r)
    expect(text).toContain('Dry run')
    expect(text).toContain('INTERRUPTED')
    expect(text).toContain('2 could not read: discovered, but the replay produced no events')
    expect(text).toContain('1 could not read: rejected by the journal: bad-timestamp')
    expect(text).toContain('3 skipped: artifacts still present')
    expect(text).toContain('WARNING: 2 run(s)')
    expect(text).toContain('no-events: claude:x')
  })
})

describe('agentop journal import (the verb)', () => {
  test('a usage error exits 1 and never runs', async () => {
    let ran = false
    const code = await runJournalImport(['--harness', 'nope'], { run: async () => { ran = true; throw new Error('x') } })
    expect(code).toBe(1)
    expect(ran).toBe(false)
  })
  test('flags reach the engine; interrupted exits 130', async () => {
    let seen: unknown
    const code = await runJournalImport(['--harness', 'codex', '--from', '2026-02-03', '--dry-run', '--json'], {
      run: async o => { seen = o; return { ok: true, report: { dryRun: true, journalPath: 'j', harnesses: [], interrupted: true, conflicts: null, examples: {}, ms: 0 } } },
    })
    expect(code).toBe(130)
    expect(seen).toMatchObject({ harnesses: ['codex'], from: '2026-02-03', dryRun: true })
  })
})
