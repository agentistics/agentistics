/**
 * journal/import-plan.ts — the PURE half of `agentop journal import` (P2 §4).
 *
 * Everything the import DECIDES lives here and takes plain values: the flags, the cursor file's
 * shape and trust rule, which artifact sources are replayed or skipped and why, which store entries
 * are orphans, the batching, and the report with its words. `import.ts` does the IO around it.
 *
 * ## Resumability is a record per SOURCE, bound to one journal file
 *
 * The state file (`<journal>.import.json`) records, per replayed source, the cursor the integration
 * handed back and the STAMP (size + mtime of its files) that was ACCEPTED, and per imported store
 * entry the stamp of its file. A record is written only after every event of that source was
 * accepted by the journal (the journal's `dropped` counter did not move), so an interruption leaves
 * the unfinished sources unrecorded and the next run replays them — the journal's
 * `UNIQUE(event_id)` turns the overlap into `duplicates`, never into a second copy. The file is bound
 * to the journal's identity (inode + birth time, `shadow.ts`'s rule): a journal that was deleted or
 * replaced inherits no record and is re-imported whole, which is the rollback P2 §7 promises.
 *
 * A source is SKIPPED only when a stamp proves nothing changed AND it had settled when recorded
 * (`canSkip`, shared with the shadow writer — an integration emits a conversation's `*.ended`
 * events only once it is quiet). A harness with no stamp function is replayed every time, from the
 * recorded cursor; an integration that cannot trust a cursor across processes re-reads from the
 * start, and the journal dedupes. That costs time, never correctness.
 *
 * ## Orphans
 *
 * A store entry is an ORPHAN when its harness has a replay integration and that integration did not
 * discover the conversation — its artifacts are gone. Only orphans become coarse events, and an
 * orphan whose run already holds events from any OTHER source (an earlier replay, the shadow writer)
 * is skipped by name: laying a coarse total over a replayed conversation would count it twice. A
 * harness with NO replay contributes no orphans either: its artifacts are not gone, they are
 * unreplayable today, and a coarse copy imported now would sit under the replay that lands later.
 */
import type { HarnessId } from '@agentistics/core'
import { HARNESS_ORDER } from '@agentistics/core'
import type { ReplayCursor, ReplaySource } from '@agentistics/engine-api'
import { canSkip, type SourceStamp } from './shadow'
import type { RejectionReason } from './types'

// ─── Flags ──────────────────────────────────────────────────────────────────────────────────────

export interface ImportArgs {
  /** Empty = every harness, in `HARNESS_ORDER`. */
  harnesses: HarnessId[]
  /** UTC day `yyyy-MM-dd`: only conversations that STARTED on or after it. */
  from?: string
  dryRun: boolean
  json: boolean
  batchSize?: number
  concurrency?: number
  /**
   * The server's automatic first import (`backfill.ts`): small batches, one replay at a time, a pause
   * while the memory gate refuses, and a stop on SIGTERM. A person may pass it too.
   */
  background?: boolean
}

export type ParsedImportArgs = { ok: true; args: ImportArgs } | { ok: false; error: string }

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function positiveInt(v: string | undefined): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null
  const n = Number(v)
  return n >= 1 ? n : null
}

/** PURE. `--harness a,b` and `--harness a --harness b` both work; an unknown id is refused by name. */
export function parseImportArgs(argv: readonly string[]): ParsedImportArgs {
  const harnesses: HarnessId[] = []
  const args: ImportArgs = { harnesses, dryRun: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const value = (): string | undefined => inline ?? argv[++i]
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--background') args.background = true
    else if (flag === '--json') args.json = true
    else if (flag === '--harness') {
      const v = value()
      if (!v) return { ok: false, error: '--harness needs a harness id' }
      for (const id of v.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!(HARNESS_ORDER as string[]).includes(id)) {
          return { ok: false, error: `unknown harness "${id}" — one of: ${HARNESS_ORDER.join(', ')}` }
        }
        if (!harnesses.includes(id as HarnessId)) harnesses.push(id as HarnessId)
      }
    } else if (flag === '--from') {
      const v = value()
      if (!v || !DAY_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        return { ok: false, error: '--from needs a UTC day, yyyy-MM-dd' }
      }
      args.from = v
    } else if (flag === '--batch-size') {
      const n = positiveInt(value())
      if (n === null) return { ok: false, error: '--batch-size needs a positive integer' }
      args.batchSize = n
    } else if (flag === '--concurrency') {
      const n = positiveInt(value())
      if (n === null) return { ok: false, error: '--concurrency needs a positive integer' }
      args.concurrency = n
    } else {
      return { ok: false, error: `unknown argument "${a}"` }
    }
  }
  return { ok: true, args }
}

/** The harnesses a run covers, in `HARNESS_ORDER` whatever order the flags named them. */
export function selectedHarnesses(requested: readonly HarnessId[]): HarnessId[] {
  return requested.length === 0 ? [...HARNESS_ORDER] : HARNESS_ORDER.filter(h => requested.includes(h))
}

/** The UTC day of an instant, the repo's aggregate day rule (`start_time.slice(0, 10)`). */
export function startsOnOrAfter(start: string | undefined, from: string | undefined): boolean {
  if (from === undefined) return true
  if (start === undefined) return true // unknown start: never filtered out on a guess
  return start.slice(0, 10) >= from
}

// ─── The state file ─────────────────────────────────────────────────────────────────────────────

export interface SourceRecord {
  cursor: ReplayCursor
  /** Absent when the harness has no stamp function. */
  stamp?: SourceStamp
  replayedAtMs: number
}

export interface StoreRecord {
  /** `size:mtime` of the store file that was imported. */
  stamp: string
  importedAtMs: number
}

export interface ImportState {
  v: 1
  /** The journal file's identity; a different file inherits nothing. */
  identity: string
  /** Keyed `<harness>:<sessionId>`. */
  sources: Record<string, SourceRecord>
  /** Keyed `<harness>:<sessionId>`. */
  store: Record<string, StoreRecord>
}

export function emptyState(identity: string): ImportState {
  return { v: 1, identity, sources: {}, store: {} }
}

export const sourceKey = (harness: HarnessId, sessionId: string): string => `${harness}:${sessionId}`

/** PURE. The recorded state, or an empty one when the text is unusable or names another journal. */
export function parseImportState(text: string | null, identity: string): ImportState {
  if (text === null) return emptyState(identity)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return emptyState(identity) }
  const r = raw as Partial<ImportState> | null
  if (!r || r.v !== 1 || r.identity !== identity || typeof r.sources !== 'object' || typeof r.store !== 'object' || !r.sources || !r.store) {
    return emptyState(identity)
  }
  const out = emptyState(identity)
  for (const [k, s] of Object.entries(r.sources)) {
    if (!s || typeof s.replayedAtMs !== 'number' || !(s.cursor === null || typeof s.cursor === 'string')) continue
    const rec: SourceRecord = { cursor: s.cursor, replayedAtMs: s.replayedAtMs }
    if (s.stamp && typeof s.stamp.key === 'string' && typeof s.stamp.mtimeMs === 'number') rec.stamp = { key: s.stamp.key, mtimeMs: s.stamp.mtimeMs }
    out.sources[k] = rec
  }
  for (const [k, s] of Object.entries(r.store)) {
    if (s && typeof s.stamp === 'string' && typeof s.importedAtMs === 'number') out.store[k] = { stamp: s.stamp, importedAtMs: s.importedAtMs }
  }
  return out
}

// ─── Planning ───────────────────────────────────────────────────────────────────────────────────

export type ArtifactSkipReason = 'unchanged' | 'before-from'
export type StoreSkipReason = 'not-orphan' | 'unchanged' | 'before-from' | 'already-in-journal' | 'no-replay' | 'no-entity-ids'
export type ArtifactFailReason = 'replay-threw' | 'no-events' | 'journal-dropped' | `rejected:${RejectionReason}`
export type StoreFailReason = 'corrupt' | 'no-session-id' | 'no-timestamps' | 'unreadable' | 'journal-dropped' | `rejected:${RejectionReason}`

export interface PlannedSource {
  source: ReplaySource
  cursor: ReplayCursor
  stamp?: SourceStamp
}

export interface ArtifactPlan {
  replay: PlannedSource[]
  skipped: Partial<Record<ArtifactSkipReason, number>>
}

/**
 * PURE. Which discovered sources to replay. `storeStart` is the store's own start time per session
 * — the only start date knowable without reading the transcript — so `--from` skips a known-older
 * conversation for free; one the store does not know is replayed and filtered by its events.
 */
export function planArtifacts(
  harness: HarnessId,
  discovered: readonly ReplaySource[],
  state: ImportState,
  stamps: ReadonlyMap<string, SourceStamp> | null,
  storeStart: ReadonlyMap<string, string>,
  from: string | undefined,
): ArtifactPlan {
  const plan: ArtifactPlan = { replay: [], skipped: {} }
  for (const source of discovered) {
    const known = storeStart.get(source.sessionId)
    if (!startsOnOrAfter(known, from)) { bump(plan.skipped, 'before-from'); continue }
    const rec = state.sources[sourceKey(harness, source.sessionId)]
    const stamp = stamps?.get(source.sessionId)
    if (rec?.stamp && canSkip({ ...rec.stamp, replayedAtMs: rec.replayedAtMs }, stamp)) { bump(plan.skipped, 'unchanged'); continue }
    const p: PlannedSource = { source, cursor: rec?.cursor ?? null }
    if (stamp) p.stamp = stamp
    plan.replay.push(p)
  }
  return plan
}

/** What one store file was read as — summarised, so the whole store is never held at once. */
export type StoreEntry =
  | { ok: true; harness: HarnessId; sessionId: string; file: string; stamp: string; start?: string }
  | { ok: false; harness: HarnessId; file: string; reason: 'corrupt' | 'no-session-id' | 'unreadable' }

export interface StorePlan {
  /** The entries to turn into coarse events. */
  import: Extract<StoreEntry, { ok: true }>[]
  skipped: Partial<Record<StoreSkipReason, number>>
}

/**
 * PURE. Which store entries become coarse events. `discovered` is this harness's discovered session
 * ids (`null` = the harness has no replay); `replayedRuns` are the run ids already holding events
 * from any source other than the import's store half.
 */
export function planStore(
  entries: readonly Extract<StoreEntry, { ok: true }>[],
  discovered: ReadonlySet<string> | null,
  runIdOf: ((conversationId: string) => string) | null,
  replayedRuns: ReadonlySet<string>,
  state: ImportState,
  from: string | undefined,
): StorePlan {
  const plan: StorePlan = { import: [], skipped: {} }
  for (const e of entries) {
    if (discovered === null) { bump(plan.skipped, 'no-replay'); continue }
    // A replay exists but the import was not told its entity-id derivations (the integration's `entityIds`): it
    // cannot ask the journal whether the run is already there, so it refuses rather than guess.
    if (runIdOf === null) { bump(plan.skipped, 'no-entity-ids'); continue }
    if (discovered.has(e.sessionId)) { bump(plan.skipped, 'not-orphan'); continue }
    if (!startsOnOrAfter(e.start, from)) { bump(plan.skipped, 'before-from'); continue }
    if (replayedRuns.has(runIdOf(e.sessionId))) { bump(plan.skipped, 'already-in-journal'); continue }
    const rec = state.store[sourceKey(e.harness, e.sessionId)]
    if (rec && rec.stamp === e.stamp) { bump(plan.skipped, 'unchanged'); continue }
    plan.import.push(e)
  }
  return plan
}

/** PURE. `items` in consecutive slices of `size` (≥ 1). */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

/** Bytes behind a stamp key (`size:mtime|file:size:mtime…`), or `undefined` when it is not that shape. */
export function stampBytes(stamp: SourceStamp | undefined): number | undefined {
  if (!stamp) return undefined
  let total = 0
  for (const part of stamp.key.split('|')) {
    const bits = part.split(':')
    const size = Number(bits.length === 2 ? bits[0] : bits[bits.length - 2])
    if (!Number.isFinite(size)) return undefined
    total += size
  }
  return total
}

// ─── The report ─────────────────────────────────────────────────────────────────────────────────

export interface HalfStat<Skip extends string, Fail extends string> {
  /** Sources / entries this half looked at. */
  considered: number
  /** Replayed / mapped this run. */
  processed: number
  events: number
  /** Rows inserted — or, on `--dry-run`, rows that WOULD be new. */
  written: number
  duplicates: number
  skipped: Partial<Record<Skip, number>>
  failed: Partial<Record<Fail, number>>
}

export interface HarnessReport {
  harness: HarnessId
  /** `null` when the harness has a replay; otherwise the integration's own sentence. */
  replayAbsent: string | null
  artifacts: HalfStat<ArtifactSkipReason, ArtifactFailReason>
  /** Transcript bytes behind the replayed sources, when a stamp function knows them. */
  bytes?: number
  store: HalfStat<StoreSkipReason, StoreFailReason>
}

export interface ImportReport {
  dryRun: boolean
  journalPath: string
  from?: string
  harnesses: HarnessReport[]
  /** SIGINT (or an abort) stopped the run between batches; the state was saved. */
  interrupted: boolean
  /** Runs holding BOTH coarse store events and events from another source — each counts twice.
   *  `null` = not checked (dry run with no journal, or the journal could not be read). */
  conflicts: number | null
  /** One example source ref per failure reason, so a person can go and look. */
  examples: Record<string, string>
  ms: number
}

export function emptyHalf<S extends string, F extends string>(): HalfStat<S, F> {
  return { considered: 0, processed: 0, events: 0, written: 0, duplicates: 0, skipped: {}, failed: {} }
}

export function bump<K extends string>(rec: Partial<Record<K, number>>, key: K, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by
}

function sum(rec: Partial<Record<string, number>>): number {
  let n = 0
  for (const v of Object.values(rec)) n += v ?? 0
  return n
}

const SKIP_TEXT: Record<ArtifactSkipReason | StoreSkipReason, string> = {
  'unchanged': 'unchanged since the last import',
  'before-from': 'started before --from',
  'not-orphan': 'artifacts still present (replayed from them instead)',
  'already-in-journal': 'its run already holds replayed events',
  'no-replay': 'harness has no replay integration yet',
  'no-entity-ids': 'harness has a replay, but the import has no entity-id mapping for it (the integration declares no entityIds)',
}

const FAIL_TEXT: Record<string, string> = {
  'replay-threw': 'the replay threw while reading it',
  'no-events': 'discovered, but the replay produced no events (empty, unreadable, corrupt or locked — the integration does not say which)',
  'journal-dropped': 'the journal dropped the write; not recorded, retried next run',
  'corrupt': 'not valid JSON',
  'no-session-id': 'no session_id',
  'no-timestamps': 'no parseable start_time',
  'unreadable': 'could not be read',
}

function failText(reason: string): string {
  if (reason.startsWith('rejected:')) return `rejected by the journal: ${reason.slice('rejected:'.length)}`
  return FAIL_TEXT[reason] ?? reason
}

function fmtN(n: number): string { return n.toLocaleString('en-US') }

function reasons(rec: Partial<Record<string, number>>, text: (k: string) => string, indent: string): string[] {
  return Object.entries(rec)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${indent}${fmtN(n ?? 0)} ${text(k)}`)
}

/** PURE. Human text, English. Every count that is not zero is said, with its reason. */
export function renderImportReport(r: ImportReport): string {
  const lines: string[] = []
  const verb = r.dryRun ? 'would write' : 'written'
  lines.push(`${r.dryRun ? 'Dry run — nothing was written. ' : ''}Journal: ${r.journalPath}${r.from ? ` (from ${r.from})` : ''}`)
  if (r.interrupted) lines.push('INTERRUPTED — stopped between batches; progress is saved and a re-run continues from it.')
  let tEvents = 0, tWritten = 0, tDup = 0, tFailed = 0
  for (const h of r.harnesses) {
    lines.push('')
    lines.push(`${h.harness}:`)
    if (h.replayAbsent !== null) lines.push(`  no replay integration — ${h.replayAbsent}`)
    else {
      const a = h.artifacts
      const mb = h.bytes !== undefined ? ` · ${(h.bytes / 1e6).toFixed(1)} MB` : ''
      lines.push(`  artifacts: ${fmtN(a.considered)} found, ${fmtN(a.processed)} replayed${mb} · ${fmtN(a.events)} events · ${fmtN(a.written)} ${verb} · ${fmtN(a.duplicates)} already present`)
      lines.push(...reasons(a.skipped, k => `skipped: ${SKIP_TEXT[k as ArtifactSkipReason]}`, '    '))
      lines.push(...reasons(a.failed, k => `could not read: ${failText(k)}`, '    '))
    }
    const s = h.store
    lines.push(`  store: ${fmtN(s.considered)} entries, ${fmtN(s.processed)} orphans imported · ${fmtN(s.events)} events · ${fmtN(s.written)} ${verb} · ${fmtN(s.duplicates)} already present`)
    lines.push(...reasons(s.skipped, k => `skipped: ${SKIP_TEXT[k as StoreSkipReason]}`, '    '))
    lines.push(...reasons(s.failed, k => `could not read: ${failText(k)}`, '    '))
    tEvents += h.artifacts.events + s.events
    tWritten += h.artifacts.written + s.written
    tDup += h.artifacts.duplicates + s.duplicates
    tFailed += sum(h.artifacts.failed) + sum(s.failed)
  }
  lines.push('')
  lines.push(`Total: ${fmtN(tEvents)} events · ${fmtN(tWritten)} ${verb} · ${fmtN(tDup)} already present · ${fmtN(tFailed)} could not be read · ${(r.ms / 1000).toFixed(1)} s`)
  if (r.conflicts === null) lines.push('Double-count check: not run.')
  else if (r.conflicts > 0) lines.push(`WARNING: ${fmtN(r.conflicts)} run(s) hold both coarse store events and replayed events — those count twice.`)
  else lines.push('Double-count check: no run holds both coarse store events and replayed events.')
  const ex = Object.entries(r.examples)
  if (ex.length > 0) {
    lines.push('Examples (one per failure reason):')
    for (const [k, ref] of ex.sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${k}: ${ref}`)
  }
  return lines.join('\n')
}
