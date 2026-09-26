/**
 * journal-plan.ts — the rejection taxonomy and the row mapping of the SQLite event journal. PURE.
 *
 * `journal.ts` inserts a batch inside one transaction, and a single malformed row inside that
 * transaction would abort a NOT NULL column for the whole batch — every good event beside the bad
 * one lost to one producer's bug. So every event a batch could ever contain is checked HERE first,
 * against every rule the table itself would enforce, and named with a `RejectionReason` before it
 * ever reaches SQLite. `types.ts` documents the reasoning in full; this module is the decision.
 *
 * Two things follow from that:
 *
 * 1. **`rejectionOf` treats its input defensively.** `events` arrive from JS producers — a hook, an
 *    adapter, a gateway payload — so a field the TYPE says is required can be absent, the wrong
 *    type, or malformed at runtime. Every access below goes through a loose, `unknown`-typed view
 *    of the event rather than trusting `AgentisticsEvent`'s own shape.
 * 2. **The FIRST failing check names the rejection.** An event can fail several rules at once (no
 *    id AND an unknown type), and reporting only the first keeps one event one reason — a batch
 *    summary that counted every rule an event broke would not add up to the batch size.
 *
 * `toRow` / `rowToEvent` are the other half: the column mapping, and the ONE normalisation the
 * table's ordering index needs (timestamps to UTC — see `toRow`'s own comment).
 */
import {
  CANONICAL_EVENT_SCHEMA, CONFIDENCES, isEventType,
  type AgentisticsEvent, type Confidence, type EventProvenance, type EventSource, type EventType,
  type ProvenanceMode, type SourceKind,
} from '@agentistics/core'
import type { Rejection, RejectionReason } from './types'

// ── The row shape ───────────────────────────────────────────────────────────────────────────────

/**
 * One row of the `events` table, exactly — see `types.ts`'s header comment for the DDL this
 * mirrors. Optional envelope fields are `string | null` because a SQLite column is never simply
 * absent: a row either carries a value or carries `NULL`, and `null` is what `toRow` / `rowToEvent`
 * treat as "this event had none".
 */
export interface JournalRow {
  event_id: string
  schema: number
  type: string
  occurred_at: string
  recorded_at: string
  session_id: string | null
  run_id: string | null
  agent_id: string | null
  task_id: string | null
  source_kind: string
  source_id: string
  source_version: string | null
  mode: string
  confidence: string
  adapter_version: string
  source_ref: string | null
  data: string
}

// ── Loose input ─────────────────────────────────────────────────────────────────────────────────

/**
 * `AgentisticsEvent`, but every field is `unknown`. This is the shape `rejectionOf` actually reads:
 * a producer's mistake is exactly a field that does not match its declared type, and a strict cast
 * would let TypeScript hide the very inputs this function exists to catch.
 */
interface LooseEvent {
  eventId?: unknown
  schema?: unknown
  type?: unknown
  occurredAt?: unknown
  recordedAt?: unknown
  source?: { kind?: unknown; id?: unknown; version?: unknown }
  provenance?: { mode?: unknown; confidence?: unknown; adapterVersion?: unknown; sourceRef?: unknown }
  data?: unknown
}

const asLoose = (e: AgentisticsEvent): LooseEvent => e as unknown as LooseEvent

const PROVENANCE_MODES: ReadonlySet<string> =
  new Set<ProvenanceMode>(['native', 'instrumented', 'observed', 'inferred', 'replayed'])
const CONFIDENCE_SET: ReadonlySet<string> = new Set<string>(CONFIDENCES)

// ── Timestamps ──────────────────────────────────────────────────────────────────────────────────

const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29
  return DAYS_IN_MONTH[month - 1] ?? 0
}

/**
 * A strict ISO-8601 date-time WITH a timezone designator — `Z` or `±HH:MM`. A string with no
 * designator (`'2026-09-25T10:00:00'`) is local time of an unstated zone, which would order
 * wrongly against every other row once normalised, so it is refused rather than guessed at.
 *
 * Three layers, all required: the shape (the regex), the calendar (days-in-month, hours <24,
 * minutes/seconds <60 — a regex alone accepts `2026-02-30`), and `Date.parse` being finite as a
 * last backstop for anything the first two miss.
 */
export function isIsoInstant(s: unknown): boolean {
  if (typeof s !== 'string') return false
  const m = ISO_INSTANT_RE.exec(s)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] === undefined ? 0 : Number(m[6])
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  if (hour > 23) return false
  if (minute > 59) return false
  if (second > 59) return false
  return Number.isFinite(Date.parse(s))
}

// ── Rejection ───────────────────────────────────────────────────────────────────────────────────

/**
 * The order the checks run in — see `types.ts` for what each reason means. An event can fail
 * several rules; the FIRST one in this order is the one it is reported under, so a batch's
 * rejection counts always sum to the number of rejected events, never more.
 */
export const REJECTION_ORDER: readonly RejectionReason[] = [
  'missing-event-id',
  'bad-schema',
  'schema-too-new',
  'missing-adapter-version',
  'unknown-type',
  'bad-timestamp',
  'missing-source',
  'bad-provenance',
  'bad-data',
]

/**
 * Whether `data` is something the `data` column (JSON TEXT, NOT NULL) can actually hold. `data ===
 * undefined` is caught before this runs; what is left is a value JSON cannot represent at all (a
 * cycle throws, a BigInt throws) or one that stringifies to nothing (`JSON.stringify` of a bare
 * function or symbol returns `undefined` without throwing).
 */
function isSerializable(data: unknown): boolean {
  try {
    return JSON.stringify(data) !== undefined
  } catch {
    return false
  }
}

/**
 * Why `e` would be refused, or `null` when the table could accept it as-is. See `REJECTION_ORDER`
 * for the sequence and `types.ts` for what each reason names.
 */
export function rejectionOf(e: AgentisticsEvent): RejectionReason | null {
  const ev = asLoose(e)

  if (typeof ev.eventId !== 'string' || ev.eventId.trim() === '') return 'missing-event-id'

  if (typeof ev.schema !== 'number' || !Number.isInteger(ev.schema) || ev.schema < 1) return 'bad-schema'

  if (ev.schema > CANONICAL_EVENT_SCHEMA) return 'schema-too-new'

  const provenance = ev.provenance
  if (
    !provenance ||
    typeof provenance.adapterVersion !== 'string' ||
    provenance.adapterVersion.trim() === ''
  ) return 'missing-adapter-version'

  if (typeof ev.type !== 'string' || !isEventType(ev.type)) return 'unknown-type'

  if (!isIsoInstant(ev.occurredAt) || !isIsoInstant(ev.recordedAt)) return 'bad-timestamp'

  const source = ev.source
  if (
    !source ||
    typeof source.kind !== 'string' || source.kind.trim() === '' ||
    typeof source.id !== 'string' || source.id.trim() === ''
  ) return 'missing-source'

  // `source.kind` is checked for being a non-empty string only — NOT against the `SourceKind`
  // union's members. Widening the vocabulary of `SourceKind` must never turn an already-valid
  // event into a rejection, and an unrecognised kind is still a real fact about where the event
  // came from; it is not the same defect as an absent one.
  if (
    typeof provenance.mode !== 'string' || !PROVENANCE_MODES.has(provenance.mode) ||
    typeof provenance.confidence !== 'string' || !CONFIDENCE_SET.has(provenance.confidence)
  ) return 'bad-provenance'

  if (ev.data === undefined || !isSerializable(ev.data)) return 'bad-data'

  return null
}

// ── Row mapping ─────────────────────────────────────────────────────────────────────────────────

/**
 * `e` → its row. Assumes `rejectionOf(e) === null` — every field this reads was already checked
 * there.
 *
 * **Timestamps are normalised to UTC** (`new Date(x).toISOString()`): the table's `(run_id,
 * occurred_at)` index orders lexicographically, and a column mixing `+00:00`/`-03:00`/`Z` would
 * sort by the literal text, not by the instant. The normalised string drops sub-millisecond
 * digits, so `toRow` is not perfectly invertible on the timestamp TEXT — identity is `eventId`,
 * never the timestamp string, and `rowToEvent(toRow(e))` reproduces the normalised instant rather
 * than whatever `e` originally spelled it as.
 */
export function toRow(e: AgentisticsEvent): JournalRow {
  return {
    event_id: e.eventId,
    schema: e.schema,
    type: e.type,
    occurred_at: new Date(e.occurredAt).toISOString(),
    recorded_at: new Date(e.recordedAt).toISOString(),
    session_id: e.sessionId ?? null,
    run_id: e.runId ?? null,
    agent_id: e.agentId ?? null,
    task_id: e.taskId ?? null,
    source_kind: e.source.kind,
    source_id: e.source.id,
    source_version: e.source.version ?? null,
    mode: e.provenance.mode,
    confidence: e.provenance.confidence,
    adapter_version: e.provenance.adapterVersion,
    source_ref: e.provenance.sourceRef ?? null,
    data: JSON.stringify(e.data),
  }
}

/**
 * `r` → the event it came from. The inverse of `toRow`: an optional envelope field is OMITTED
 * (never present as an `undefined`-valued key) whenever its column is `null`, so a caller testing
 * `'sessionId' in event` sees exactly what the producer sent, not every field the type happens to
 * declare.
 */
export function rowToEvent(r: JournalRow): AgentisticsEvent {
  const source: EventSource = { kind: r.source_kind as SourceKind, id: r.source_id }
  if (r.source_version !== null) source.version = r.source_version

  const provenance: EventProvenance = {
    mode: r.mode as ProvenanceMode,
    confidence: r.confidence as Confidence,
    adapterVersion: r.adapter_version,
  }
  if (r.source_ref !== null) provenance.sourceRef = r.source_ref

  const event: AgentisticsEvent = {
    eventId: r.event_id,
    schema: r.schema,
    type: r.type as EventType,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    source,
    provenance,
    data: JSON.parse(r.data),
  }
  if (r.session_id !== null) event.sessionId = r.session_id
  if (r.run_id !== null) event.runId = r.run_id
  if (r.agent_id !== null) event.agentId = r.agent_id
  if (r.task_id !== null) event.taskId = r.task_id
  return event
}

// ── Batch planning ──────────────────────────────────────────────────────────────────────────────

export interface AppendPlan {
  rows: { index: number; row: JournalRow }[]
  rejected: Rejection[]
}

/**
 * Every event of a batch goes to exactly one of `rows` / `rejected`, at its position (`index`) in
 * `events`.
 *
 * **A duplicate `eventId` WITHIN the batch is not this plan's business.** Two events sharing one
 * id both come out as rows here — the table's `event_id TEXT NOT NULL UNIQUE` plus
 * `INSERT OR IGNORE` is what turns the second into a counted duplicate, at insert time, where the
 * durable state actually lives. Refusing it here would need this pure function to remember every
 * id it has already seen across calls, which is exactly the statefulness `journal.ts` exists to
 * own.
 */
export function planAppend(events: readonly AgentisticsEvent[]): AppendPlan {
  const rows: { index: number; row: JournalRow }[] = []
  const rejected: Rejection[] = []
  events.forEach((e, index) => {
    const reason = rejectionOf(e)
    if (reason === null) {
      rows.push({ index, row: toRow(e) })
      return
    }
    const rejection: Rejection = { index, reason }
    const loose = asLoose(e)
    if (typeof loose.eventId === 'string' && loose.eventId.trim() !== '') rejection.eventId = loose.eventId
    rejected.push(rejection)
  })
  return { rows, rejected }
}
