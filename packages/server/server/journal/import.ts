/**
 * journal/import.ts — `agentop journal import`, the IO half (P2 §4). Decisions live in
 * `import-plan.ts` (pure) and the store mapping in `import-store.ts` (pure); this file reads, calls
 * the replays, appends, and saves the state.
 *
 * ARTIFACTS FIRST, the consolidate store SECOND: a harness's own files are the fine-grained truth;
 * the store is the floor for conversations whose files are gone. The rules that shape the IO:
 *
 * - **Bounded.** Sources are processed in batches (`batchSize`), at most `concurrency` replays in
 *   flight, each source's events appended in slices of `flushEvents` — so memory is bounded by the
 *   few largest conversations in flight, never by the store (the shadow writer's P1 §9 rule). The
 *   store is listed as SUMMARIES first; each orphan's file is re-read only when its batch runs.
 * - **Interruptible.** `signal` is checked before every batch and before every source starts; a
 *   source already in flight finishes (its events are appended whole or not recorded), then the
 *   state file is saved and the run reports `interrupted`.
 * - **A record is written only for work the journal ACCEPTED** (its `dropped` counter did not move),
 *   so an interruption or a failed write leaves the source unrecorded and the next run re-does it —
 *   the journal's `UNIQUE(event_id)` absorbs the overlap.
 * - **Never silent.** A replay that throws, a discovered conversation that yields nothing, a store
 *   file that does not parse or has no start, an event the journal rejects: each is counted under
 *   its reason, with one example ref per reason.
 * - **`--dry-run` writes nothing** — no journal file, no state file. It reads a journal that exists,
 *   read-only, to say how many events would be new.
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CAPABILITY_STATES, normalizeSessionTimes, type AgentisticsEvent, type HarnessId, type SessionMeta } from '@agentistics/core'
import { CONSOLIDATED_DIR, JOURNAL_IMPORT_STATE_PATH, JOURNAL_PATH } from '../config'
import { INTEGRATIONS, hasReplay, type HarnessReplay } from '../integrations/types'
import * as claudeCore from '../integrations/claude/replay-core'
import * as codexCore from '../integrations/codex/replay-core'
import * as kimiCore from '../integrations/kimi/replay-core'
import * as geminiCore from '../integrations/gemini/replay-core'
import * as copilotCore from '../integrations/copilot/replay-core'
import * as antigravityCore from '../integrations/antigravity/replay-core'
import * as opencodeCore from '../integrations/opencode/replay-core'
import { createLimiter } from '../utils'
import { openJournal } from './journal'
import { openJournalIndex, type JournalIndex } from './import-journal-index'
import {
  batches, bump, emptyHalf, parseImportState, planArtifacts, planStore, selectedHarnesses, sourceKey,
  stampBytes, startsOnOrAfter,
  type ArtifactFailReason, type HarnessReport, type ImportReport, type ImportState, type StoreEntry,
  type StoreFailReason,
} from './import-plan'
import { storeSessionEvents, type HarnessEntityIds } from './import-store'
import { claudeStamps, type SourceStamp } from './shadow'
import type { Journal } from './types'

export const IMPORT_BATCH_SIZE = 32
export const IMPORT_CONCURRENCY = 4
export const IMPORT_FLUSH_EVENTS = 500

/**
 * The entity-id derivations the coarse store events share with each harness's replay. A harness
 * with no integration is `null` — its store entries are skipped (`no-replay`), see import-plan.ts.
 * A `Record<HarnessId, …>`, so adding a harness fails the build here until somebody decides.
 */
export const ENTITY_IDS: Record<HarnessId, HarnessEntityIds | null> = {
  claude: claudeCore,
  codex: codexCore,
  gemini: geminiCore,
  copilot: copilotCore,
  antigravity: antigravityCore,
  kimi: kimiCore,
  // No legacy adapter (CLAUDE.md step 4, skipped by scope), but discover().sessionId (opencode's own
  // session.id) equals the consolidate store's session_id would-be key — the entity ids still let a
  // gone-from-the-store-but-once-imported opencode conversation's coarse events be derived, per step 19.
  opencode: opencodeCore,
}

/**
 * Change detection per harness: a stamp per source, from `stat` alone. A harness without one is
 * replayed on every run (and the journal dedupes). Claude's is the shadow writer's own.
 *
 * opencode has none: its single SQLite file's own mtime changes on every session's every message,
 * so a whole-file stamp would invalidate on any OTHER session's activity, and a per-session stamp
 * needs a row read (a SELECT), which is not "from stat alone" — left absent rather than guessed at.
 */
export const IMPORT_STAMPS: Partial<Record<HarnessId, () => Promise<Map<string, SourceStamp>>>> = {
  claude: () => claudeStamps(),
}

export interface ImportProgress {
  phase: 'artifacts' | 'store'
  harness: HarnessId
  done: number
  total: number
  events: number
  written: number
  /** Transcript bytes behind the sources done so far, when known. */
  bytes?: number
  ms: number
}

export interface ImportOptions {
  harnesses?: HarnessId[]
  from?: string
  dryRun?: boolean
  batchSize?: number
  concurrency?: number
  flushEvents?: number
  /** Default `JOURNAL_PATH`. */
  journalPath?: string
  /** Default `JOURNAL_IMPORT_STATE_PATH` for the default journal, else `<journalPath>.import.json`. */
  statePath?: string
  /** Default `CONSOLIDATED_DIR`. */
  storeDir?: string
  /** Default `INTEGRATIONS[h].replay`. `null` = the harness has no replay. */
  replays?: Partial<Record<HarnessId, HarnessReplay | null>>
  /** Default `ENTITY_IDS`. */
  entityIds?: Partial<Record<HarnessId, HarnessEntityIds | null>>
  /** Default `IMPORT_STAMPS`. */
  stamps?: Partial<Record<HarnessId, (() => Promise<Map<string, SourceStamp>>) | null>>
  open?: (path: string) => Promise<Journal>
  now?: () => number
  signal?: AbortSignal
  onProgress?: (p: ImportProgress) => void
}

export type ImportResult =
  | { ok: true; report: ImportReport }
  | { ok: false; error: string }

/** The journal file's identity (inode + birth time): a replaced file inherits no state. */
function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.ino}:${Math.floor(st.birthtimeMs)}`
  } catch { return null }
}

async function saveState(path: string, state: ImportState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state))
  await rename(tmp, path)
}

/** Every store file of the selected harnesses, as summaries. Subdir first, legacy flat files (claude)
 *  after; the first file per (harness, id) wins — `loadConsolidated`'s rule. */
async function listStore(storeDir: string, harnesses: readonly HarnessId[]): Promise<StoreEntry[]> {
  const out: StoreEntry[] = []
  const seen = new Set<string>()
  const roots: { harness: HarnessId; dir: string; rel: string }[] = harnesses.map(h => ({ harness: h, dir: join(storeDir, h), rel: `${h}/` }))
  if (harnesses.includes('claude')) roots.push({ harness: 'claude', dir: storeDir, rel: '' })
  for (const root of roots) {
    let files: string[]
    try { files = (await readdir(root.dir)).filter(f => f.endsWith('.json')).sort() } catch { continue }
    const limit = createLimiter(32)
    const entries = await Promise.all(files.map(f => limit(async (): Promise<StoreEntry | null> => {
      const file = `${root.rel}${f}`
      let text: string
      let st
      try {
        st = await stat(join(root.dir, f))
        if (!st.isFile()) return null
        text = await readFile(join(root.dir, f), 'utf8')
      } catch { return { ok: false, harness: root.harness, file, reason: 'unreadable' } }
      let meta: Partial<SessionMeta> & { harness?: string }
      try { meta = JSON.parse(text) } catch { return { ok: false, harness: root.harness, file, reason: 'corrupt' } }
      if (!meta || typeof meta !== 'object') return { ok: false, harness: root.harness, file, reason: 'corrupt' }
      if (typeof meta.session_id !== 'string' || meta.session_id === '') return { ok: false, harness: root.harness, file, reason: 'no-session-id' }
      // A legacy flat file carries its own harness; only a claude one belongs to this root.
      if (root.rel === '' && meta.harness !== undefined && meta.harness !== 'claude') return null
      const e: StoreEntry = { ok: true, harness: root.harness, sessionId: meta.session_id, file, stamp: `${st.size}:${Math.floor(st.mtimeMs)}` }
      if (typeof meta.start_time === 'string' && meta.start_time !== '') e.start = meta.start_time
      else if (typeof meta.start_time === 'number') e.start = new Date(meta.start_time).toISOString()
      return e
    })))
    for (const e of entries) {
      if (!e) continue
      if (e.ok) {
        const key = sourceKey(e.harness, e.sessionId)
        if (seen.has(key)) continue
        seen.add(key)
      }
      out.push(e)
    }
  }
  return out
}

/** The earliest `occurredAt` among a replay's lifecycle events — the conversation's start. */
function replayStart(events: readonly AgentisticsEvent[]): string | undefined {
  let min: string | undefined
  for (const e of events) {
    if (e.type !== 'run.started' && e.type !== 'session.started') continue
    if (min === undefined || e.occurredAt < min) min = e.occurredAt
  }
  return min
}

export async function runImport(opts: ImportOptions = {}): Promise<ImportResult> {
  const t0 = (opts.now ?? Date.now)()
  const now = opts.now ?? Date.now
  const dryRun = opts.dryRun ?? false
  const journalPath = opts.journalPath ?? JOURNAL_PATH
  // Beside whichever journal was opened; the default journal's is the literal config path, so the
  // backup coverage lint can see it (backup-plan.ts excludes it as regenerable).
  const statePath = opts.statePath
    ?? (opts.journalPath === undefined ? JOURNAL_IMPORT_STATE_PATH : `${journalPath}.import.json`)
  const storeDir = opts.storeDir ?? CONSOLIDATED_DIR
  const batchSize = Math.max(1, opts.batchSize ?? IMPORT_BATCH_SIZE)
  const concurrency = Math.max(1, opts.concurrency ?? IMPORT_CONCURRENCY)
  const flushEvents = Math.max(1, opts.flushEvents ?? IMPORT_FLUSH_EVENTS)
  const harnesses = selectedHarnesses(opts.harnesses ?? [])
  const aborted = () => opts.signal?.aborted === true

  // The journal: opened for writing unless this is a dry run, which only ever reads one that exists.
  let journal: Journal | null = null
  if (!dryRun) {
    journal = await (opts.open ?? ((p: string) => openJournal({ path: p })))(journalPath)
    const st = journal.status()
    if (st.state !== 'open') {
      journal.close()
      return { ok: false, error: `the journal at ${journalPath} could not be opened for writing (${st.reason ?? st.state})` }
    }
  }
  const identity = fileIdentity(journalPath)
  let stateText: string | null = null
  if (identity !== null) { try { stateText = readFileSync(statePath, 'utf8') } catch { /* no state yet */ } }
  const state = parseImportState(stateText, identity ?? '')
  const persist = async () => { if (!dryRun && identity !== null) await saveState(statePath, state) }

  let index: JournalIndex | null = await openJournalIndex(journalPath)
  const report: ImportReport = {
    dryRun, journalPath, harnesses: [], interrupted: false, conflicts: null, examples: {}, ms: 0,
  }
  if (opts.from !== undefined) report.from = opts.from

  const example = (reason: string, ref: string) => { if (!(reason in report.examples)) report.examples[reason] = ref }

  /** Appends one source's events; answers whether EVERY event was accepted (or, dry, would be offered). */
  async function append(events: AgentisticsEvent[], half: HarnessReport['artifacts'] | HarnessReport['store'], ref: string): Promise<boolean> {
    half.events += events.length
    if (dryRun) {
      const present = index?.countPresent(events.map(e => e.eventId)) ?? 0
      half.duplicates += present
      half.written += events.length - present
      return true
    }
    const j = journal!
    const droppedBefore = j.status().counters.dropped
    for (let i = 0; i < events.length; i += flushEvents) {
      const res = await j.append(events.slice(i, i + flushEvents))
      half.written += res.written
      half.duplicates += res.duplicates
      for (const r of res.rejected) {
        const reason = `rejected:${r.reason}` as ArtifactFailReason & StoreFailReason
        bump(half.failed as Record<string, number>, reason)
        example(reason, ref)
      }
    }
    if (j.status().counters.dropped !== droppedBefore) {
      bump(half.failed as Record<string, number>, 'journal-dropped')
      example('journal-dropped', ref)
      return false
    }
    return true
  }

  try {
    // ── Store summaries (small) — needed first for `--from` and for orphan detection. ──
    const storeEntries = await listStore(storeDir, harnesses)
    const discoveredBy = new Map<HarnessId, Set<string> | null>()

    // ── Half 1: artifacts ──
    for (const harness of harnesses) {
      const h: HarnessReport = { harness, replayAbsent: null, artifacts: emptyHalf(), store: emptyHalf() }
      report.harnesses.push(h)
      const integration = INTEGRATIONS[harness]
      const replay = opts.replays && harness in opts.replays ? opts.replays[harness] ?? null : (hasReplay(integration) ? integration.replay : null)
      if (!replay) {
        h.replayAbsent = hasReplay(integration) ? 'disabled for this run' : integration.replayAbsent
        discoveredBy.set(harness, null)
        continue
      }
      if (aborted()) { report.interrupted = true; discoveredBy.set(harness, new Set()); continue }
      let discovered
      try { discovered = await replay.discover() } catch {
        bump(h.artifacts.failed, 'replay-threw')
        example('replay-threw', `${harness}:discover`)
        discoveredBy.set(harness, null) // cannot tell orphans apart from unread sources
        continue
      }
      discoveredBy.set(harness, new Set(discovered.map(s => s.sessionId)))
      h.artifacts.considered = discovered.length
      const stampFn = opts.stamps && harness in opts.stamps ? opts.stamps[harness] ?? null : IMPORT_STAMPS[harness] ?? null
      let stamps: Map<string, SourceStamp> | null = null
      if (stampFn) { try { stamps = await stampFn() } catch { stamps = null } }
      const storeStart = new Map<string, string>()
      for (const e of storeEntries) if (e.ok && e.harness === harness && e.start) storeStart.set(e.sessionId, e.start)
      const plan = planArtifacts(harness, discovered, state, stamps, storeStart, opts.from)
      for (const [k, n] of Object.entries(plan.skipped)) bump(h.artifacts.skipped, k as keyof typeof plan.skipped, n)

      const limit = createLimiter(concurrency)
      let done = 0
      for (const batch of batches(plan.replay, batchSize)) {
        if (aborted()) { report.interrupted = true; break }
        await Promise.all(batch.map(p => limit(async () => {
          if (aborted()) { report.interrupted = true; return }
          const key = sourceKey(harness, p.source.sessionId)
          let result
          try { result = await replay.replay(p.source, p.cursor) } catch {
            bump(h.artifacts.failed, 'replay-threw')
            example('replay-threw', p.source.sourceRef)
            return
          }
          if (result.events.length === 0 && p.cursor === null) {
            bump(h.artifacts.failed, 'no-events')
            example('no-events', p.source.sourceRef)
            return
          }
          if (opts.from !== undefined && !storeStart.has(p.source.sessionId) && !startsOnOrAfter(replayStart(result.events), opts.from)) {
            bump(h.artifacts.skipped, 'before-from')
            return
          }
          h.artifacts.processed++
          const b = stampBytes(p.stamp)
          if (b !== undefined) h.bytes = (h.bytes ?? 0) + b
          const accepted = await append(result.events, h.artifacts, p.source.sourceRef)
          if (accepted && !dryRun) {
            const rec: ImportState['sources'][string] = { cursor: result.cursor, replayedAtMs: now() }
            if (p.stamp) rec.stamp = p.stamp
            state.sources[key] = rec
          }
        })))
        done += batch.length
        await persist()
        opts.onProgress?.({ phase: 'artifacts', harness, done, total: plan.replay.length, events: h.artifacts.events, written: h.artifacts.written, ...(h.bytes !== undefined ? { bytes: h.bytes } : {}), ms: now() - t0 })
      }
    }

    // ── Half 2: the consolidate store, orphans only ──
    // Re-open the index so it sees what half 1 just wrote (a fresh read-only connection on a file
    // created by this run, which may not have existed when the first one was attempted).
    index?.close()
    index = await openJournalIndex(journalPath)
    const replayedRuns = index?.replayedRunIds() ?? new Set<string>()
    const recordedAt = new Date(now()).toISOString()
    for (const h of report.harnesses) {
      const harness = h.harness
      const entries = storeEntries.filter(e => e.harness === harness)
      h.store.considered = entries.length
      for (const e of entries) if (!e.ok) { bump(h.store.failed, e.reason); example(e.reason, `consolidate:${e.file}`) }
      const ids = (opts.entityIds && harness in opts.entityIds ? opts.entityIds[harness] : ENTITY_IDS[harness]) ?? null
      const plan = planStore(
        entries.filter((e): e is Extract<StoreEntry, { ok: true }> => e.ok),
        discoveredBy.get(harness) ?? null,
        ids ? ids.runIdOf : null,
        replayedRuns, state, opts.from,
      )
      for (const [k, n] of Object.entries(plan.skipped)) bump(h.store.skipped, k as keyof typeof plan.skipped, n)
      if (!ids) continue
      let done = 0
      for (const batch of batches(plan.import, batchSize)) {
        if (aborted()) { report.interrupted = true; break }
        for (const e of batch) {
          if (aborted()) { report.interrupted = true; break }
          const ref = `consolidate:${e.file}`
          let meta: SessionMeta
          try { meta = JSON.parse(await readFile(join(storeDir, e.file), 'utf8')) as SessionMeta } catch {
            bump(h.store.failed, 'unreadable'); example('unreadable', ref); continue
          }
          normalizeSessionTimes(meta)
          const mapped = storeSessionEvents(meta, { harness, ids, tokens: CAPABILITY_STATES[harness].tokens, sourceRef: ref, recordedAt })
          if (!mapped.ok) { bump(h.store.failed, mapped.reason); example(mapped.reason, ref); continue }
          h.store.processed++
          const accepted = await append(mapped.events, h.store, ref)
          if (accepted && !dryRun) state.store[sourceKey(harness, e.sessionId)] = { stamp: e.stamp, importedAtMs: now() }
        }
        done += batch.length
        await persist()
        opts.onProgress?.({ phase: 'store', harness, done, total: plan.import.length, events: h.store.events, written: h.store.written, ms: now() - t0 })
      }
    }

    index?.close()
    index = await openJournalIndex(journalPath)
    report.conflicts = index ? index.conflicts() : null
    await persist()
  } finally {
    index?.close()
    journal?.close()
  }
  report.ms = now() - t0
  return { ok: true, report }
}
