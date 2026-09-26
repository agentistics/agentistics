/**
 * journal/shadow.ts — the shadow writer (P1 §1 item 5, §3, §5, §9, §11).
 *
 * While `AGENTISTICS_JOURNAL` is on, a build ADDITIONALLY feeds the journal with the canonical events
 * of the Claude transcripts it just read. The legacy path is untouched and keeps serving every
 * surface; nothing reads what is written here. Rules this file exists to hold:
 *
 * - **Flag off is not a code path.** `ingest` returns before touching anything — no journal opened,
 *   no file created, no directory scanned.
 * - **It can only log.** Every failure (an unopenable journal, a replay that throws, a status file
 *   that cannot be written) is caught here and becomes a counter or a warning; `ingest` never throws
 *   and `shadowIngest` (what `data.ts` calls) is not even awaited, so a shadow that is slow or
 *   broken costs the feature and never a build's latency.
 * - **Single flight.** Builds run every ~30 s while a dashboard is open; two overlapping ingests
 *   would each replay the same transcripts. A call that finds one running returns `skipped: 'busy'`
 *   — the next build catches up, because the journal is idempotent and a cursor only ever advances.
 * - **Batched and flushed, never collected** (P1 §9). Events go to the journal in slices of
 *   `FLUSH_EVENTS`; the buffer is emptied at every flush. The one unit a replay hands back whole is
 *   ONE conversation's events, and at most `CONCURRENCY` conversations are in flight — so memory is
 *   bounded by the largest few transcripts, not by the store.
 * - **A cursor advances only over events the journal ACCEPTED.** `AppendResult` cannot tell "all
 *   rejected" from "the write failed", so the journal's own `dropped` counter is read around each
 *   flush; a flush that dropped anything leaves that conversation's cursor where it was, and the
 *   next run re-reads it (the replay treats a cursor it does not recognise as "start over" and the
 *   journal dedupes by event id — a re-read costs time, never correctness).
 * - **An unchanged transcript is not replayed** — and that is the performance rule, measured rather
 *   than assumed. The Claude replay retains only `MAX_STATES` (32) walks, so on a store of 486
 *   transcripts every one whose walk was evicted is re-read from byte 0 by every build: 407 k events
 *   and 18 s per run when NOTHING had changed, 2.3 GB of reads every 30 s — the load that took this
 *   machine down twice (CLAUDE.md, "A LIVE transcript is read by what it has WRITTEN"). So each
 *   source gets a STAMP (main transcript + its subagent files: size and mtime) and a source whose
 *   stamp matches the one last ACCEPTED by the journal is skipped without being opened. Two guards:
 *   a source last replayed while it was still LIVE is replayed once more after it settles (the
 *   replay emits its `*.ended` events only for a settled transcript), and the stamps are persisted
 *   beside the journal, bound to that file's identity, so a restart does not re-read the store
 *   either. A journal that was replaced loses its stamps with it.
 * - **Cursors live in memory.** The Claude replay only trusts a cursor that matches the walk THIS
 *   process retained (see `integrations/claude/index.ts`), so a persisted cursor could never be
 *   resumed after a restart anyway. A restart therefore re-reads once and the journal counts the
 *   repeats as `duplicates` — visible, not silent.
 * - **Only counters, ids, names and summaries reach the journal** — that is the replay's contract
 *   (P1 §7, D5), not something this file adds or relaxes.
 *
 * It also owns the two seams A1.5 left open: it REGISTERS the journal's status with health.ts (so
 * `journal-unwritable` can fire in production) and it writes the SINCE-BOOT counters to a small
 * status file that `agentop journal status`, a different process, can read.
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { JOURNAL_ENABLED, JOURNAL_STATUS_PATH, PROJECTS_DIR } from '../config'
import { setJournalStatusSource } from '../health'
import { INTEGRATIONS } from '../integrations/types'
import type { HarnessReplay, ReplayCursor } from '../integrations/types'
import { createLimiter } from '../utils'
import { openJournal } from './journal'
import type { Journal, JournalCounters, RejectionReason } from './types'

/** Events per `append` call: one transaction each (journal.ts), so this is the batch P1 §9 budgets. */
export const FLUSH_EVENTS = 500
/** Conversations replayed at once. Bounds the memory of a build's worth of transcripts. */
export const CONCURRENCY = 4

/** The slice of a session the shadow needs. `harness` absent means a legacy row: claude. */
export interface ShadowSession {
  session_id: string
  harness?: string
}

export interface ShadowSinceBoot {
  counters: JournalCounters
  rejectedByReason: Partial<Record<RejectionReason, number>>
}

/** The file another process reads. `pid` + `updatedAt` let a reader say when it is stale. */
export interface ShadowStatusFile {
  v: 1
  pid: number
  bootedAt: string
  updatedAt: string
  runs: number
  skippedBusy: number
  /** The last completed run — what the ingest cost, so the ≤10 % budget can be read off a live machine. */
  lastRun: ShadowRun | null
  sinceBoot: ShadowSinceBoot
}

export interface ShadowRun {
  /** Conversations replayed this run. */
  sources: number
  /** Conversations left alone because nothing had changed since the journal last accepted them. */
  skipped: number
  events: number
  written: number
  duplicates: number
  rejected: number
  dropped: number
  ms: number
}

export type ShadowResult = ({ status: 'ran' } & ShadowRun) | { status: 'off' | 'busy' | 'failed' }

export interface ShadowDeps {
  /** Default `JOURNAL_ENABLED`. */
  enabled?: boolean
  /** Default `openJournal()`. Injected so a test can hand over a failing or in-memory-path journal. */
  open?: () => Promise<Journal>
  /** Default `INTEGRATIONS.claude.replay`. */
  replay?: HarnessReplay
  /** Default `JOURNAL_STATUS_PATH`; `null` writes no file. */
  statusPath?: string | null
  /** Change detection. Default: `claudeStamps()` over the real projects dir — or none at all when a
   *  `replay` is injected, since a stamp of the real filesystem says nothing about a fake one. */
  stamps?: (() => Promise<Map<string, SourceStamp>>) | null
  /** Where the accepted stamps are kept between runs. Default `<journal path>.stamps.json`, beside whichever journal was opened; `null` = memory only. */
  stampsPath?: string | null
  /** Default `setJournalStatusSource` (health.ts). */
  registerStatus?: typeof setJournalStatusSource
  now?: () => number
  flushEvents?: number
  concurrency?: number
  /** Default `console.warn`. */
  warn?: (msg: string) => void
}

export interface Shadow {
  ingest(sessions: readonly ShadowSession[]): Promise<ShadowResult>
  /** Counters since this shadow was created — what the status file carries. */
  sinceBoot(): ShadowSinceBoot
  /** Closes the journal (checkpointing the WAL) and unregisters the health source. */
  close(): void
}

/** What the shadow remembers about one source: enough to say "nothing new here". */
export interface SourceStamp {
  /** size + mtime of the main transcript and of every subagent file — changes when any of them does. */
  key: string
  /** The newest mtime among them: whether the source was still LIVE when it was last replayed. */
  mtimeMs: number
}
interface CommittedStamp extends SourceStamp {
  /** When it was last replayed (accepted by the journal). */
  replayedAtMs: number
}

/**
 * The replay emits a transcript's `*.ended` events only once it has been quiet for its settle window
 * (60 s in `integrations/claude`). A source replayed sooner than this after its last write is replayed
 * again — once — after it settles. Deliberately larger than the window: a redundant replay costs one
 * read of one file, a missing one costs a conversation that never ends in the journal.
 */
export const SETTLE_MARGIN_MS = 2 * 60_000

/**
 * The stamp of every Claude conversation under `projectsDir`, one `readdir` per project plus a `stat`
 * per file: no transcript is opened. Never throws — an unreadable directory contributes nothing, and a
 * source with no stamp is simply replayed.
 */
export async function claudeStamps(projectsDir: string = PROJECTS_DIR): Promise<Map<string, SourceStamp>> {
  const out = new Map<string, SourceStamp>()
  let projects: string[]
  try { projects = await readdir(projectsDir) } catch { return out }
  await Promise.all(projects.map(async project => {
    const dir = join(projectsDir, project)
    let files: string[]
    try { files = await readdir(dir) } catch { return }
    await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(async file => {
      const id = file.slice(0, -'.jsonl'.length)
      try {
        const main = await stat(join(dir, file))
        let key = `${main.size}:${Math.floor(main.mtimeMs)}`
        let newest = main.mtimeMs
        let subs: string[] = []
        try { subs = await readdir(join(dir, id, 'subagents')) } catch { /* no subagents */ }
        for (const f of subs.sort()) {
          try {
            const st = await stat(join(dir, id, 'subagents', f))
            key += `|${f}:${st.size}:${Math.floor(st.mtimeMs)}`
            if (st.mtimeMs > newest) newest = st.mtimeMs
          } catch { /* vanished between readdir and stat */ }
        }
        out.set(id, { key, mtimeMs: newest })
      } catch { /* the transcript vanished: nothing to stamp */ }
    }))
  }))
  return out
}

/** PURE. Whether a source may be skipped: unchanged since it was last accepted, and settled then. */
export function canSkip(prior: CommittedStamp | undefined, current: SourceStamp | undefined): boolean {
  if (!prior || !current) return false
  return prior.key === current.key && prior.replayedAtMs - current.mtimeMs >= SETTLE_MARGIN_MS
}

/** The journal file's identity: a replaced file is a different journal and inherits nothing. */
function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.ino}:${Math.floor(st.birthtimeMs)}`
  } catch { return null }
}

function loadStamps(path: string, identity: string | null): Map<string, CommittedStamp> {
  const out = new Map<string, CommittedStamp>()
  if (identity === null) return out
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; identity?: unknown; stamps?: Record<string, CommittedStamp> }
    if (raw.v !== 1 || raw.identity !== identity || !raw.stamps) return out
    for (const [id, s] of Object.entries(raw.stamps)) {
      if (s && typeof s.key === 'string' && typeof s.mtimeMs === 'number' && typeof s.replayedAtMs === 'number') out.set(id, s)
    }
  } catch { /* absent or unreadable: start from nothing, which only costs one full read */ }
  return out
}

function isClaude(s: ShadowSession): boolean {
  return s.harness === undefined || s.harness === 'claude'
}

export function createShadow(deps: ShadowDeps = {}): Shadow {
  const enabled = deps.enabled ?? JOURNAL_ENABLED
  const open = deps.open ?? (() => openJournal())
  const statusPath = deps.statusPath === undefined ? JOURNAL_STATUS_PATH : deps.statusPath
  const readStamps = deps.stamps === undefined ? (deps.replay ? null : () => claudeStamps()) : deps.stamps
  const register = deps.registerStatus ?? setJournalStatusSource
  const now = deps.now ?? Date.now
  const flushEvents = Math.max(1, deps.flushEvents ?? FLUSH_EVENTS)
  const concurrency = Math.max(1, deps.concurrency ?? CONCURRENCY)
  const warn = deps.warn ?? ((m: string) => console.warn(m))

  const bootedAt = new Date(now()).toISOString()
  let journalPromise: Promise<Journal> | null = null
  let journal: Journal | null = null
  let running = false
  let runs = 0
  let skippedBusy = 0
  let lastRun: ShadowRun | null = null
  const rejectedByReason: Partial<Record<RejectionReason, number>> = {}
  const cursors = new Map<string, ReplayCursor>()
  let committed: Map<string, CommittedStamp> | null = null // loaded once the journal is open

  function getJournal(): Promise<Journal> {
    if (!journalPromise) {
      journalPromise = open().then(j => {
        journal = j
        // The seam A1.5 left: until a process opens the journal, `journal-unwritable` cannot fire.
        register(() => j.status())
        return j
      }, e => {
        journalPromise = null // an open that threw is retried by the next run, not cached forever
        throw e
      })
    }
    return journalPromise
  }

  function sinceBoot(): ShadowSinceBoot {
    const c = journal?.status().counters
    return {
      counters: c
        ? { ...c }
        : { written: 0, duplicates: 0, rejected: 0, dropped: 0, failedAppends: 0, failedReads: 0 },
      rejectedByReason: { ...rejectedByReason },
    }
  }

  async function writeStatus(): Promise<void> {
    if (statusPath === null) return
    const file: ShadowStatusFile = {
      v: 1, pid: process.pid, bootedAt, updatedAt: new Date(now()).toISOString(),
      runs, skippedBusy, lastRun, sinceBoot: sinceBoot(),
    }
    try {
      await mkdir(dirname(statusPath), { recursive: true })
      const tmp = `${statusPath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(file))
      await rename(tmp, statusPath)
    } catch (e) {
      warn(`[journal] could not write the shadow status file: ${String(e)}`)
    }
  }

  async function writeStamps(stampsPath: string | null, identity: string | null): Promise<void> {
    if (stampsPath === null || identity === null || committed === null) return
    try {
      await mkdir(dirname(stampsPath), { recursive: true })
      const tmp = `${stampsPath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ v: 1, identity, stamps: Object.fromEntries(committed) }))
      await rename(tmp, stampsPath)
    } catch (e) {
      warn(`[journal] could not write the shadow stamps file: ${String(e)}`)
    }
  }

  async function run(sessions: readonly ShadowSession[]): Promise<ShadowResult> {
    const started = now()
    const j = await getJournal()
    const replay = deps.replay ?? INTEGRATIONS.claude.replay
    if (!replay) return { status: 'failed' }

    const identity = fileIdentity(j.status().path)
    const stampsPath = deps.stampsPath === undefined ? `${j.status().path}.stamps.json` : deps.stampsPath
    committed ??= stampsPath === null ? new Map() : loadStamps(stampsPath, identity)
    const known = committed
    const current = readStamps ? await readStamps() : new Map<string, SourceStamp>()

    const wanted = new Set(sessions.filter(isClaude).map(s => s.session_id))
    const found = (await replay.discover()).filter(src => wanted.has(src.sessionId))
    const sources = found.filter(src => !canSkip(known.get(src.sessionId), current.get(src.sessionId)))
    const skipped = found.length - sources.length
    // A transcript that is gone from disk has nothing left to replay; forget its cursor and stamp.
    for (const id of cursors.keys()) if (!wanted.has(id)) cursors.delete(id)
    for (const id of known.keys()) if (!wanted.has(id)) known.delete(id)

    const before = j.status().counters
    let events = 0
    let written = 0
    let duplicates = 0
    let rejected = 0

    const limit = createLimiter(concurrency)
    await Promise.all(sources.map(src => limit(async () => {
      try {
        const batch = await replay.replay(src, cursors.get(src.sessionId) ?? null)
        const droppedBefore = j.status().counters.dropped
        for (let i = 0; i < batch.events.length; i += flushEvents) {
          const slice: AgentisticsEvent[] = batch.events.slice(i, i + flushEvents)
          const res = await j.append(slice)
          events += slice.length
          written += res.written
          duplicates += res.duplicates
          rejected += res.rejected.length
          for (const r of res.rejected) rejectedByReason[r.reason] = (rejectedByReason[r.reason] ?? 0) + 1
        }
        // Advance only over events the journal took (see the header).
        if (j.status().counters.dropped === droppedBefore) {
          cursors.set(src.sessionId, batch.cursor)
          const stamp = current.get(src.sessionId)
          if (stamp) known.set(src.sessionId, { ...stamp, replayedAtMs: now() })
        }
      } catch (e) {
        // One conversation's failure costs that conversation, never the run.
        warn(`[journal] shadow replay failed for ${src.sourceRef}: ${String(e)}`)
      }
    })))

    const after = j.status().counters
    runs++
    const result: ShadowResult = {
      status: 'ran', sources: sources.length, skipped, events, written, duplicates, rejected,
      dropped: after.dropped - before.dropped, ms: now() - started,
    }
    const { status: _s, ...ran } = result as { status: 'ran' } & ShadowRun
    lastRun = ran
    await writeStamps(stampsPath, identity)
    await writeStatus()
    return result
  }

  return {
    async ingest(sessions) {
      if (!enabled) return { status: 'off' }
      if (running) { skippedBusy++; return { status: 'busy' } }
      running = true
      try {
        return await run(sessions)
      } catch (e) {
        warn(`[journal] shadow ingest failed: ${String(e)}`)
        return { status: 'failed' }
      } finally {
        running = false
      }
    },
    sinceBoot,
    close() {
      register(null)
      journal?.close()
      journal = null
      journalPromise = null
    },
  }
}

let shared: Shadow | null = null

/**
 * The one call `data.ts` makes. **Not awaited by the caller**: it returns a promise that always
 * resolves (never rejects), so the build's latency never includes the shadow. With the flag off the
 * default shadow is not even created.
 */
export function shadowIngest(sessions: readonly ShadowSession[]): Promise<ShadowResult> {
  if (!JOURNAL_ENABLED) return Promise.resolve({ status: 'off' })
  shared ??= createShadow()
  return shared.ingest(sessions).catch(() => ({ status: 'failed' as const }))
}
