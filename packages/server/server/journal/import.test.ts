/**
 * import.test.ts — `agentop journal import` against a REAL journal (bun:sqlite on a temp dir), the
 * REAL Claude and Codex replays over the committed fixtures, and a disposable consolidate store.
 * Only the failure cases inject a stub replay.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId, SessionMeta } from '@agentistics/core'
import { createClaudeReplay } from '../integrations/claude'
import { createCodexReplay } from '../integrations/codex'
import { INTEGRATIONS, type HarnessReplay } from '../integrations/types'
import { openJournal } from './journal'
import { runImport, type ImportOptions } from './import'
import type { ImportReport } from './import-plan'
import { claudeStamps } from './shadow'

const FIX = join(import.meta.dir, '..', '..', 'test', 'fixtures')
const CLAUDE_PROJECTS = join(FIX, 'claude-replay')
const CODEX_SESSIONS = join(FIX, 'codex-replay', 'sessions')
const CLAUDE_CONV = '00000000-0000-4000-8000-000000000001'

let root = ''
let seq = 0
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-import-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function meta(id: string, harness: HarnessId, extra: Partial<SessionMeta> = {}): Partial<SessionMeta> {
  return {
    session_id: id, harness, project_path: '/work/p', start_time: '2026-01-02T03:04:05Z',
    end_time: '2026-01-02T04:00:00.000Z', model: 'claude-opus-5',
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    ...extra,
  }
}

/** A private world: a journal path, and a store with a non-orphan, two orphans and two bad files. */
async function world() {
  const dir = join(root, `w${++seq}`)
  const store = join(dir, 'sessions')
  await mkdir(join(store, 'claude'), { recursive: true })
  await mkdir(join(store, 'codex'), { recursive: true })
  const put = (rel: string, v: unknown) => writeFile(join(store, rel), typeof v === 'string' ? v : JSON.stringify(v))
  await put(`claude/${CLAUDE_CONV}.json`, meta(CLAUDE_CONV, 'claude'))         // artifacts present
  await put('claude/orphan-claude-1.json', meta('orphan-claude-1', 'claude'))  // artifacts gone
  await put('claude/broken.json', '{not json')                                  // corrupt
  await put('claude/no-start.json', meta('no-start-1', 'claude', { start_time: '' }))
  await put('codex/orphan-codex-1.json', meta('orphan-codex-1', 'codex', { model: 'gpt-5.3-codex' }))
  return { dir, store, journalPath: join(dir, 'journal.db') }
}

function opts(w: { store: string; journalPath: string }, extra: Partial<ImportOptions> = {}): ImportOptions {
  return {
    harnesses: ['claude', 'codex'],
    journalPath: w.journalPath,
    storeDir: w.store,
    // The registry is the ENGINE's and is handed in; the journal imports none. The replays below
    // override it with fixture-rooted ones, and it supplies the store half's entity ids.
    integrations: INTEGRATIONS,
    replays: {
      claude: createClaudeReplay({ projectsDir: CLAUDE_PROJECTS, settledMs: 0 }),
      codex: createCodexReplay({ sessionsDir: CODEX_SESSIONS, settledMs: 0 }),
    },
    stamps: { claude: () => claudeStamps(CLAUDE_PROJECTS), codex: null },
    ...extra,
  }
}

async function rows(path: string): Promise<number> {
  const j = await openJournal({ path })
  try { return (await j.stats()).rows } finally { j.close() }
}

function total(r: ImportReport, k: 'written' | 'events' | 'duplicates'): number {
  return r.harnesses.reduce((n, h) => n + h.artifacts[k] + h.store[k], 0)
}

async function ok(o: ImportOptions): Promise<ImportReport> {
  const res = await runImport(o)
  if (!res.ok) throw new Error(res.error)
  return res.report
}

describe('journal import — artifacts then the store', () => {
  test('first run writes both halves and reports every refusal by reason', async () => {
    const w = await world()
    const r = await ok(opts(w))
    const claude = r.harnesses.find(h => h.harness === 'claude')!
    const codex = r.harnesses.find(h => h.harness === 'codex')!
    expect(claude.artifacts.considered).toBe(1)
    expect(claude.artifacts.processed).toBe(1)
    expect(claude.artifacts.written).toBeGreaterThan(0)
    expect(claude.bytes).toBeGreaterThan(0)
    expect(codex.artifacts.processed).toBe(5)
    // store: the discovered conversation is not an orphan; one orphan per harness is imported
    expect(claude.store.skipped['not-orphan']).toBe(1)
    expect(claude.store.processed).toBe(1)
    expect(codex.store.processed).toBe(1)
    expect(claude.store.failed.corrupt).toBe(1)
    expect(claude.store.failed['no-timestamps']).toBe(1)
    expect(r.examples.corrupt).toBe('consolidate:claude/broken.json')
    expect(r.conflicts).toBe(0)
    expect(await rows(w.journalPath)).toBe(total(r, 'written'))
    expect(existsSync(`${w.journalPath}.import.json`)).toBe(true)
  })

  test('IDEMPOTENT: a second run adds zero rows', async () => {
    const w = await world()
    const first = await ok(opts(w))
    const before = await rows(w.journalPath)
    const second = await ok(opts(w))
    expect(total(second, 'written')).toBe(0)
    expect(await rows(w.journalPath)).toBe(before)
    expect(before).toBe(total(first, 'written'))
    // the store half recognises its own work without re-reading it
    const claude = second.harnesses.find(h => h.harness === 'claude')!
    expect(claude.store.skipped.unchanged).toBe(1)
    // codex has no stamp function: it is replayed again and every event dedupes
    const codex = second.harnesses.find(h => h.harness === 'codex')!
    expect(codex.artifacts.processed).toBe(5)
    expect(codex.artifacts.duplicates).toBe(codex.artifacts.events)
  })

  test('RESUMABLE: interrupted after the first batch, re-run, same rows as one uninterrupted import', async () => {
    const ref = await world()
    await ok(opts(ref))
    const expected = await rows(ref.journalPath)

    const w = await world()
    const ac = new AbortController()
    const first = await ok(opts(w, { batchSize: 1, concurrency: 1, signal: ac.signal, onProgress: () => ac.abort() }))
    expect(first.interrupted).toBe(true)
    const partial = await rows(w.journalPath)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(expected)
    const second = await ok(opts(w, { batchSize: 1, concurrency: 1 }))
    expect(second.interrupted).toBe(false)
    expect(await rows(w.journalPath)).toBe(expected)
    expect(total(first, 'written') + total(second, 'written')).toBe(expected)
  })

  test('--dry-run writes nothing, and predicts exactly what a real run writes', async () => {
    const w = await world()
    const dry = await ok(opts(w, { dryRun: true }))
    expect(existsSync(w.journalPath)).toBe(false)
    expect(existsSync(`${w.journalPath}.import.json`)).toBe(false)
    expect(dry.conflicts).toBeNull()
    const real = await ok(opts(w))
    expect(total(dry, 'written')).toBe(total(real, 'written'))
    const dryAgain = await ok(opts(w, { dryRun: true }))
    expect(total(dryAgain, 'written')).toBe(0)
  })

  test('an orphan whose run already holds replayed events is skipped, never laid over them', async () => {
    const w = await world()
    await ok(opts(w))
    const before = await rows(w.journalPath)
    // The Claude artifacts are "gone" now: discover finds nothing.
    const gone: HarnessReplay = { discover: async () => [], replay: async () => ({ events: [], cursor: null }) }
    const r = await ok(opts(w, { replays: { claude: gone, codex: null }, statePath: join(w.dir, 'other-state.json') }))
    const claude = r.harnesses.find(h => h.harness === 'claude')!
    expect(claude.store.skipped['already-in-journal']).toBe(1)
    expect(await rows(w.journalPath)).toBe(before)
    expect(r.conflicts).toBe(0)
  })

  test('--from filters by conversation start, on both halves', async () => {
    const w = await world()
    const r = await ok(opts(w, { from: '2099-01-01' }))
    expect(total(r, 'written')).toBe(0)
    const claude = r.harnesses.find(h => h.harness === 'claude')!
    const codex = r.harnesses.find(h => h.harness === 'codex')!
    expect(claude.artifacts.skipped['before-from']).toBe(1)  // known from the store, not read
    expect(codex.artifacts.skipped['before-from']).toBe(5)   // unknown to the store: read, then filtered
    expect(claude.store.skipped['before-from']).toBe(1)
  })

  test('a replay that throws, and one that yields nothing, are counted by reason', async () => {
    const w = await world()
    const bad: HarnessReplay = {
      discover: async () => [{ sessionId: 'a', sourceRef: 'x:a' }, { sessionId: 'b', sourceRef: 'x:b' }],
      replay: async src => { if (src.sessionId === 'a') throw new Error('boom'); return { events: [], cursor: null } },
    }
    const r = await ok(opts(w, { harnesses: ['codex'], replays: { codex: bad } }))
    const codex = r.harnesses[0]!
    expect(codex.artifacts.failed['replay-threw']).toBe(1)
    expect(codex.artifacts.failed['no-events']).toBe(1)
    expect(r.examples['replay-threw']).toBe('x:a')
  })

  test('a harness with no replay imports no store orphans (its artifacts are not gone)', async () => {
    const w = await world()
    const r = await ok(opts(w, { harnesses: ['codex'], replays: { codex: null } }))
    expect(r.harnesses[0]!.replayAbsent).not.toBeNull()
    expect(r.harnesses[0]!.store.skipped['no-replay']).toBe(1)
    expect(total(r, 'written')).toBe(0)
  })

  test('a journal replaced under the state file inherits nothing and is re-imported whole', async () => {
    const w = await world()
    await ok(opts(w))
    const n = await rows(w.journalPath)
    rmSync(w.journalPath, { force: true })
    rmSync(`${w.journalPath}-wal`, { force: true })
    rmSync(`${w.journalPath}-shm`, { force: true })
    const r = await ok(opts(w))
    expect(total(r, 'written')).toBe(n)
  })
})
