/**
 * journal/types.ts — the contract of the durable event journal (P1 §4.2, master spec §19).
 *
 * One journal per machine (decision D2): SQLite in WAL mode at `<data dir>/journal.db`. Three
 * modules sit behind this file and none of them re-declares a shape declared here:
 *   - `journal-plan.ts` (PURE) decides which events of a batch are acceptable and names the rest;
 *   - `schema.ts` owns the DDL, the pragma ORDER, migration and the network-filesystem refusal;
 *   - `journal.ts` owns the connection, the transaction per batch and the status.
 */
import type { AgentisticsEvent } from '@agentistics/core'

/**
 * Why an event was refused. A rejection is a bug in the PRODUCER and must be visible as one, so it
 * is never dropped silently and never folded into another reason.
 *
 * The first four are the spec's. The rest are ADDITIONS, all under one principle: **every row the
 * table would refuse is refused by the plan first, with a name.** A NOT NULL column violated inside
 * the batch's transaction would otherwise abort the WHOLE batch — every good event beside the bad one
 * lost to a single malformed row. And an empty `eventId` would be stored and then silently swallow
 * every later event that also lacked one as a "duplicate".
 */
export type RejectionReason =
  | 'schema-too-new'
  | 'missing-adapter-version'
  | 'bad-timestamp'
  | 'unknown-type'
  | 'missing-event-id'
  /** `schema` is not a positive integer — neither too new nor valid. */
  | 'bad-schema'
  /** `source.kind` or `source.id` absent or empty. */
  | 'missing-source'
  /** `provenance.mode` or `provenance.confidence` outside its closed vocabulary. */
  | 'bad-provenance'
  /** `data` absent, or not serialisable to JSON (a cycle, a BigInt). */
  | 'bad-data'

export interface Rejection {
  /** Position of the event in the batch handed to `append`. */
  index: number
  /** The event's own id when it had a usable one — a rejection names WHICH event where it can. */
  eventId?: string
  reason: RejectionReason
}

export interface AppendResult {
  /** Rows actually inserted. */
  written: number
  /** Events whose `eventId` was already in the journal (or earlier in the same batch). Counted,
   *  never silent — replay converging with live ingestion shows up HERE. */
  duplicates: number
  rejected: Rejection[]
}

export interface ReadPage {
  events: AgentisticsEvent[]
  /** The rowid of the last event returned — pass it back to continue. Unchanged when the page is
   *  empty, so a caller that polls never moves backwards. */
  cursor: number
}

export interface JournalStats {
  rows: number
  /** Bytes on disk: the database file plus its `-wal`. */
  bytes: number
  firstAt?: string
  lastAt?: string
}

/** What kind of filesystem the journal's directory is on. `unknown` OPENS — never refuse on a guess. */
export type PathKind = 'local' | 'network' | 'unknown'

export interface PathClassification {
  kind: PathKind
  /** The filesystem type as the OS named it (`ext4`, `nfs4`, `9p`, `smbfs`), when determined. */
  fsType?: string
  /** The mount point the path was matched under (longest prefix), when determined. */
  mountPoint?: string
}

/** Why the journal is a no-op. A code, rendered into words by whoever surfaces it (A1.5's health). */
export type JournalDisabledReason =
  /** The directory is on nfs / cifs / smb / 9p / sshfs / a UNC path — WAL is not safe there. */
  | 'network-filesystem'
  /** `bun:sqlite` could not be loaded (a non-Bun runtime). */
  | 'no-sqlite'
  /** The file could not be created or opened. */
  | 'open-failed'
  /** SQLite refused WAL (it reported another journal_mode) — it silently downgrades on some filesystems. */
  | 'wal-unavailable'
  /** The file was written by a NEWER agentop (its user_version is above ours); we do not write into it. */
  | 'db-schema-too-new'
  /** Opening succeeded but the schema could not be created or migrated. */
  | 'migrate-failed'

export interface JournalCounters {
  /** Rows written since this process opened the journal. */
  written: number
  duplicates: number
  rejected: number
  /** Events handed to a journal that could not accept them (disabled, closed, or a failed write).
   *  This is the counter that makes a no-op visible: the feature's cost, not a lost build. */
  dropped: number
  /** Append calls that threw inside SQLite after the journal was open. */
  failedAppends: number
  /** `readFrom` / `stats` calls that failed inside SQLite. Such a read answers an empty page (cursor
   *  unchanged) or `rows: 0`, which on its own is indistinguishable from "nothing new" / "empty" —
   *  this counter is what tells the two apart. */
  failedReads: number
}

export interface JournalStatus {
  state: 'open' | 'disabled' | 'closed'
  /** Present exactly when `state === 'disabled'`. */
  reason?: JournalDisabledReason
  path: string
  pathKind: PathKind
  fsType?: string
  counters: JournalCounters
}

export interface Journal {
  append(events: readonly AgentisticsEvent[]): Promise<AppendResult>
  readFrom(cursor: number, limit: number): Promise<ReadPage>
  stats(): Promise<JournalStats>
  status(): JournalStatus
  close(): void
}

/** The largest page `readFrom` ever returns, whatever `limit` asks for. No method returns everything. */
export const MAX_PAGE = 1000
