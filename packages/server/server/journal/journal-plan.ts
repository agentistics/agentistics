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
 * table's ordering index needs (timestamps to UTC — see `toRow`'s own comment). `encodeRow` /
 * `decodeRow` are the storage encoding under them (schema v2), lossless by construction.
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

/** Exactly the shape `Date.prototype.toISOString()` produces for a four-digit year. */
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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
  // The exact `toISOString` shape (a `Z` and three fraction digits) is the ECMAScript date-time
  // format itself, which `Date.parse` is REQUIRED to accept for any calendar-valid four-digit year —
  // so for it the backstop can only answer yes, and is skipped (most events carry this shape; the
  // parse was about a third of this function's cost). Every other spelling still gets the backstop.
  if (CANONICAL_UTC_RE.test(s)) return true
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
 * `data` as the `data` column (JSON TEXT, NOT NULL) will hold it, or `undefined` when it cannot hold
 * it at all: a value JSON cannot represent (a cycle throws, a BigInt throws) or one that stringifies
 * to nothing (`JSON.stringify` of a bare function or symbol returns `undefined` without throwing).
 * `data === undefined` is caught before this runs.
 *
 * It RETURNS the text rather than answering yes/no because the check and the row need the very same
 * string: stringifying once to validate and again in `toRow` was measured at ~0.1 ms of every
 * 100-event batch (research A1.7), a twentieth of the whole append budget spent producing a string
 * that was thrown away.
 */
function serializeData(data: unknown): string | undefined {
  try {
    const json = JSON.stringify(data)
    return typeof json === 'string' ? json : undefined
  } catch {
    return undefined
  }
}

/**
 * Why `e` would be refused, or `null` when the table could accept it as-is. See `REJECTION_ORDER`
 * for the sequence and `types.ts` for what each reason names.
 */
export function rejectionOf(e: AgentisticsEvent): RejectionReason | null {
  const checked = checkEvent(e)
  return typeof checked === 'string' ? checked : null
}

/**
 * `rejectionOf`'s decision, handing back the serialized `data` when the event is accepted so
 * `planAppend` can build the row without stringifying it a second time. The rules and their ORDER
 * live here and only here.
 */
function checkEvent(e: AgentisticsEvent): RejectionReason | { data: string } {
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

  if (ev.data === undefined) return 'bad-data'
  const data = serializeData(ev.data)
  if (data === undefined) return 'bad-data'

  return { data }
}

// ── Row mapping ─────────────────────────────────────────────────────────────────────────────────

/**
 * `s` as `new Date(s).toISOString()` spells it. A string ALREADY in that exact shape is returned as
 * it is — for an instant `isIsoInstant` accepted, `toISOString` would hand back the identical
 * characters, so re-parsing it only costs time (~0.13 ms per 100-event batch measured, research
 * A1.7, for two timestamps an event almost always carries in this shape already). Anything else —
 * an offset, a missing fraction, more than three fraction digits — goes through `Date`, unchanged.
 */
function toUtcInstant(s: string): string {
  return CANONICAL_UTC_RE.test(s) ? s : new Date(s).toISOString()
}

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
 *
 * One argument on purpose: `toRow` is passed point-free (`events.map(toRow)`), and an optional
 * second parameter received the array INDEX as `data` there (found integrating A1.7). `planAppend`
 * goes through `rowWithData` with the string `checkEvent` already produced, so a batch is
 * stringified once.
 */
export function toRow(e: AgentisticsEvent): JournalRow {
  return rowWithData(e, JSON.stringify(e.data))
}

/** `toRow` with the `data` column already serialised (by `checkEvent`, from the same `e.data`). */
function rowWithData(e: AgentisticsEvent, data: string): JournalRow {
  return {
    event_id: e.eventId,
    schema: e.schema,
    type: e.type,
    occurred_at: toUtcInstant(e.occurredAt),
    recorded_at: toUtcInstant(e.recordedAt),
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
    data,
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

// ── Storage encoding (schema v2) ─────────────────────────────────────────────────────────────────
//
// `JournalRow` above is the LOGICAL row: the event's fields as text, which is what the v1 table
// stored verbatim. Measured on this machine's whole store (A1.7, `journal-budget-size.test.ts`),
// that cost 667 B per event, and most of it was the same text written again on every row: a
// 28-character `ses_…` / `run_…` / `agt_…` id three times, the transcript path in `source_ref`
// (57 B), the words `harness` / `claude` / `replayed` / `exact` / the adapter and harness versions,
// two 24-character ISO instants, a 32-character hex id (twice more in its UNIQUE index), and in
// `data` every object KEY of every payload (`"cacheWriteByTtl":{"ephemeral_5m":…` on 100k rows).
//
// `StoredRow` is what v2 writes. Every transformation is EXACTLY invertible — `decodeRow(encodeRow(
// r)) deep-equals r` for every row `toRow` can produce, and `journal-plan.test.ts` plus the
// size budget's end-to-end read-back over the whole real store pin it:
//
//  - **Repeated text is interned** into `event_strings (id, s)` and the row carries the integer:
//    `type`, `session_id`, `run_id`, `agent_id`, `task_id`, `source_kind`, `source_id`,
//    `source_version`, `mode`, `confidence`, `adapter_version`, the `source_ref` BASE and the data
//    SHAPE. The dictionary only ever grows (a string's id is never reused or rewritten), which is
//    what makes an id safe to cache for the life of a process.
//  - **`source_ref` is split at its last `:`** when what follows is a canonical decimal (`claude:
//    <conversation>:<lineNo>` → base + line), so the per-file prefix is interned once per FILE.
//  - **Instants are epoch milliseconds.** `toRow` has already normalised them to
//    `Date#toISOString()`, which `new Date(ms).toISOString()` reproduces character for character.
//  - **A 32-character lowercase hex `event_id` (the shape `deriveEventId` mints) is 16 raw bytes.**
//    Any other id is stored as the text it is; the two can never collide, because a given id always
//    takes the same form.
//  - **`data` is split into a SHAPE and its VALUES** — see `encodeData`.

/** An interned string's id. */
export type Intern = (s: string) => number
/** The string an interned id stands for. Throws on an unknown id: a row naming one is corrupt. */
export type Lookup = (id: number) => string

/** One row of the v2 `events` table, exactly as bound (the rowid, the cursor, is never bound). */
export interface StoredRow {
  event_id: string | Uint8Array
  schema: number
  type: number
  occurred_at: number
  recorded_at: number
  session_id: number | null
  run_id: number | null
  agent_id: number | null
  task_id: number | null
  source_kind: number
  source_id: number
  source_version: number | null
  mode: number
  confidence: number
  adapter_version: number
  source_ref: number | null
  source_ref_line: number | null
  data_shape: number | null
  data: string
}

const HEX_EVENT_ID_RE = /^[0-9a-f]{32}$/

export function encodeEventId(id: string): string | Uint8Array {
  return HEX_EVENT_ID_RE.test(id) ? new Uint8Array(Buffer.from(id, 'hex')) : id
}

export function decodeEventId(v: string | Uint8Array): string {
  return typeof v === 'string' ? v : Buffer.from(v).toString('hex')
}

/**
 * An instant `toRow` normalised, as epoch ms. THROWS when the text is not the normalised form: the
 * integer would then decode to a different string, and a journal that rewrites what it was given
 * is exactly what this encoding must never be. `toRow` makes that unreachable for anything the plan
 * accepted.
 */
export function encodeInstant(iso: string): number {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== iso) {
    throw new RangeError(`journal instant is not in normalised form: ${iso}`)
  }
  return ms
}

export function decodeInstant(ms: number): string {
  return new Date(ms).toISOString()
}

/** A canonical decimal line number that survives `Number` exactly (≤ 15 digits, no leading zero). */
const REF_LINE_RE = /^([\s\S]*):(0|[1-9][0-9]{0,14})$/

export function splitSourceRef(ref: string): { base: string; line: number | null } {
  const m = REF_LINE_RE.exec(ref)
  return m ? { base: m[1]!, line: Number(m[2]) } : { base: ref, line: null }
}

export function joinSourceRef(base: string, line: number | null): string {
  return line === null ? base : `${base}:${line}`
}

/**
 * A data SHAPE: the key sequence of a non-empty plain object, in order. An entry is a key whose value
 * is a leaf, or `[key, shape]` for a key whose value is itself a non-empty plain object. A leaf is
 * every other JSON value — a primitive, an array (arrays are never descended into, so the set of
 * shapes stays finite), or an empty object.
 */
type Shape = (string | [string, Shape])[]

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0
}

function shapeOf(o: Record<string, unknown>, leaves: unknown[]): Shape {
  const shape: Shape = []
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (isNonEmptyObject(v)) shape.push([k, shapeOf(v, leaves)])
    else { shape.push(k); leaves.push(v) }
  }
  return shape
}

/**
 * `data` (the JSON text `toRow` wrote) → a shape id and the JSON array of its leaf values, in order:
 * `{"provider":"anthropic","usage":{"input":3,"output":9}}` → shape `["provider",["usage",["input",
 * "output"]]]` (interned: a payload type has a handful of shapes, so every row pays one small
 * integer for all of its keys) and values `["anthropic",3,9]`. A `data` that is not a non-empty
 * object (a string, an array, `{}`) is stored as its JSON text with no shape.
 *
 * `decodeData` rebuilds the SAME TEXT, byte for byte: the keys come back in their original order and
 * each value is re-serialised by `JSON.stringify`, which is the identity on a value `JSON.parse`
 * produced. So `rowToEvent` parses exactly what it parsed before — `"__proto__"` included.
 */
export function encodeData(json: string, intern: Intern): { shape: number | null; values: string } {
  const value: unknown = JSON.parse(json)
  if (!isNonEmptyObject(value)) return { shape: null, values: json }
  const leaves: unknown[] = []
  const shape = shapeOf(value, leaves)
  return { shape: intern(JSON.stringify(shape)), values: JSON.stringify(leaves) }
}

function buildJson(shape: Shape, leaves: unknown[], at: { i: number }): string {
  const parts: string[] = []
  for (const entry of shape) {
    if (typeof entry === 'string') {
      if (at.i >= leaves.length) throw new RangeError('journal data has fewer values than its shape')
      parts.push(`${JSON.stringify(entry)}:${JSON.stringify(leaves[at.i++])}`)
    } else {
      parts.push(`${JSON.stringify(entry[0])}:${buildJson(entry[1], leaves, at)}`)
    }
  }
  return `{${parts.join(',')}}`
}

/** Parsed shapes by their text — a journal holds a few dozen; the cap only bounds a pathological one. */
const SHAPE_MEMO = new Map<string, Shape>()
const SHAPE_MEMO_MAX = 4096

function parseShape(text: string): Shape {
  let s = SHAPE_MEMO.get(text)
  if (!s) {
    s = JSON.parse(text) as Shape
    if (SHAPE_MEMO.size >= SHAPE_MEMO_MAX) SHAPE_MEMO.clear()
    SHAPE_MEMO.set(text, s)
  }
  return s
}

export function decodeData(shapeText: string | null, values: string): string {
  if (shapeText === null) return values
  const leaves = JSON.parse(values) as unknown[]
  const at = { i: 0 }
  const json = buildJson(parseShape(shapeText), leaves, at)
  if (at.i !== leaves.length) throw new RangeError('journal data has more values than its shape')
  return json
}

const internOrNull = (s: string | null, intern: Intern): number | null => (s === null ? null : intern(s))
const lookupOrNull = (id: number | null, lookup: Lookup): string | null => (id === null ? null : lookup(id))

/** The logical row → what v2 binds. See the section header for why each step is invertible. */
export function encodeRow(r: JournalRow, intern: Intern): StoredRow {
  const ref = r.source_ref === null ? null : splitSourceRef(r.source_ref)
  const data = encodeData(r.data, intern)
  return {
    event_id: encodeEventId(r.event_id),
    schema: r.schema,
    type: intern(r.type),
    occurred_at: encodeInstant(r.occurred_at),
    recorded_at: encodeInstant(r.recorded_at),
    session_id: internOrNull(r.session_id, intern),
    run_id: internOrNull(r.run_id, intern),
    agent_id: internOrNull(r.agent_id, intern),
    task_id: internOrNull(r.task_id, intern),
    source_kind: intern(r.source_kind),
    source_id: intern(r.source_id),
    source_version: internOrNull(r.source_version, intern),
    mode: intern(r.mode),
    confidence: intern(r.confidence),
    adapter_version: intern(r.adapter_version),
    source_ref: ref === null ? null : intern(ref.base),
    source_ref_line: ref === null ? null : ref.line,
    data_shape: data.shape,
    data: data.values,
  }
}

/** The inverse of `encodeRow`. */
export function decodeRow(s: StoredRow, lookup: Lookup): JournalRow {
  return {
    event_id: decodeEventId(s.event_id),
    schema: s.schema,
    type: lookup(s.type),
    occurred_at: decodeInstant(s.occurred_at),
    recorded_at: decodeInstant(s.recorded_at),
    session_id: lookupOrNull(s.session_id, lookup),
    run_id: lookupOrNull(s.run_id, lookup),
    agent_id: lookupOrNull(s.agent_id, lookup),
    task_id: lookupOrNull(s.task_id, lookup),
    source_kind: lookup(s.source_kind),
    source_id: lookup(s.source_id),
    source_version: lookupOrNull(s.source_version, lookup),
    mode: lookup(s.mode),
    confidence: lookup(s.confidence),
    adapter_version: lookup(s.adapter_version),
    source_ref: s.source_ref === null ? null : joinSourceRef(lookup(s.source_ref), s.source_ref_line),
    data: decodeData(s.data_shape === null ? null : lookup(s.data_shape), s.data),
  }
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
    const checked = checkEvent(e)
    if (typeof checked !== 'string') {
      rows.push({ index, row: rowWithData(e, checked.data) })
      return
    }
    const rejection: Rejection = { index, reason: checked }
    const loose = asLoose(e)
    if (typeof loose.eventId === 'string' && loose.eventId.trim() !== '') rejection.eventId = loose.eventId
    rejected.push(rejection)
  })
  return { rows, rejected }
}
