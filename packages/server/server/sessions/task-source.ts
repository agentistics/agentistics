/**
 * task-source.ts — the IO behind every task surface: the book, the fleet, the store.
 *
 * One reader, so the CLI and the HTTP route (and therefore the web and the MCP) can never disagree
 * about which sessions a task holds. The arithmetic on top of it is the pure `task-report.ts`.
 */

import { TASKS_FILE } from '../config'
import { ensureStatusStages } from './status-stage-sync'
import { loadConsolidated } from '../consolidate'
import { readPreferences } from '../preferences'
import { readRegistry } from './registry'
import { createTaskStore, type TaskStore } from './task-store'
import { migrateLegacyTasks, type TaskBook } from './task-model'
import { historicalRows } from './task-historical'
import { nativeRows } from './task-native'
import { withNativeAliases } from './native-id-alias'
import type { BoardRow, ManagedSession } from './types'
import {
  CORE_TYPE_ID, calcCost, coreStatusMigration, planInReviewAdd, planStatusMigration, planTypeMigration, sessionCostUSD as costByModel,
  type SessionMeta,
} from '@agentistics/core'

/** Cost of a single session. Always via `calcCost` — never an inline pricing formula. */
function sessionCostUSD(s: SessionMeta): number {
  // Per-model when the session spans several models; single-model otherwise.
  const byModel = costByModel(s)
  if (byModel !== null) return byModel
  return calcCost(
    {
      inputTokens: s.input_tokens ?? 0,
      outputTokens: s.output_tokens ?? 0,
      cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: 0,
    },
    s.model ?? '',
  )
}

/**
 * THE BOARD'S TWO ROW SETS, and why there is no field called plain `rows`.
 *
 * A conversation filed with no registry row behind it (`HistoricalSession`) is turned into a
 * synthetic, read-only `ManagedSession`-shaped row so that every rollup inherits it. That row must
 * never reach a path that WRITES to, or reasons about, the fleet — a stub in the registry would list
 * as a finished, reopenable session with no cwd. So the two sets are separate FIELDS with names that
 * say which is which, and a bare `rows` deliberately does not exist: any caller written against it
 * fails to compile and has to pick.
 *
 *  - `registryRows` — exactly `readRegistry()`. The rows that REALLY exist. Use it for everything
 *    that resolves a session id, patches a session, decides whether a session is there
 *    (`attachSession`'s lookup, `detachSession`, `conversation_in_fleet`), or seeds legacy names.
 *  - `rollupRows` — `registryRows` plus one synthetic row per historical link, APPENDED after them.
 *    Use it to answer "what belongs to this delivery and what did it cost": the list, detail,
 *    overview, stats, done gates, subtask `hasSession`, evidence.
 *    `loadTaskWorld` also appends one NATIVE row per `NativeSessionLink` (`task-native.ts`): a
 *    `BoardRow` whose harness is the native runtime — never a `ManagedSession`, so no fleet code can
 *    take one by type. `loadTaskBoard` (the light reader, no consolidate store) leaves them out.
 *
 * Audit of the readers (the registry itself is untouched, so fleet code that calls `readRegistry()`
 * directly — cli-session, cli-start, the sessions host, terminal/input channels, live claims, hardware
 * sessions — cannot see a synthetic row by construction and needs no change).
 */
export interface TaskWorld {
  store: TaskStore
  book: TaskBook
  registryRows: ManagedSession[]
  rollupRows: BoardRow[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
}

/**
 * Make sure every task name a person has already typed exists in the book.
 *
 * Idempotent by construction: `legacyTaskId` derives the id from the name, so a name already
 * carried is skipped and a second run changes nothing. Only what is MISSING is written — a task
 * already in the book may have been renamed or delivered since, and re-upserting the derived
 * record would undo that.
 */
async function ensureLegacyTasks(store: TaskStore, rows: readonly ManagedSession[], book: TaskBook): Promise<boolean> {
  const finished = await readPreferences()
    .then(p => p.finishedTasks ?? [])
    .catch(() => [] as string[])
  const names = rows.map(r => r.task).filter((t): t is string => Boolean(t))
  if (names.length === 0 && finished.length === 0) return false

  const knownIds = new Set(book.tasks.map(t => t.id))
  // A name that already exists as a TITLE is already this task, whatever its id. Checking only the
  // derived id created a duplicate the moment a task was marked done: `markTask` mirrors the title
  // into `preferences.finishedTasks`, the migration read it back as a legacy name, and minted a
  // second task under `legacyTaskId(title)` beside the real one. Seen on a live board.
  const knownTitles = new Set(book.tasks.map(t => t.title))
  // A task the user DELETED is not re-minted. Without this the migration resurrected it on the very
  // next read and the delete button read as broken.
  const buried = new Set(book.tombstones)
  const now = new Date().toISOString()
  let wrote = false
  for (const t of migrateLegacyTasks({ names, finished, now })) {
    if (knownIds.has(t.id) || knownTitles.has(t.title) || buried.has(t.id)) continue
    await store.upsertTask(t)
    wrote = true
  }
  return wrote
}

/**
 * Seed the status LIST the very first time this book is opened.
 *
 * `planStatusMigration` already refuses to do anything once a list exists, and `seedStatuses`
 * re-checks the same thing under the lock — this function's own read is only what decides WHETHER
 * to bother calling it, never the thing that makes the write safe. Idempotent the same way
 * `ensureLegacyTasks` is: called on every load, a no-op on every call after the first.
 */
async function ensureStatusesSeeded(store: TaskStore, book: TaskBook): Promise<boolean> {
  if (book.statuses.length > 0) return false
  const usedStatusIds = [
    ...book.tasks.map(t => t.status),
    ...book.subtasks.map(s => s.status),
  ]
  const plan = planStatusMigration({ existing: book.statuses, usedStatusIds })
  if (!plan) return false
  await store.seedStatuses(plan)
  return true
}

/** Add `in_review` once to a book whose list predates it; a fresh book already carries it. */
async function ensureInReview(store: TaskStore, book: TaskBook): Promise<boolean> {
  if (book.inReviewSeeded) return false
  await store.seedInReview(planInReviewAdd(book.statuses))
  return true
}

/** Seed the TYPE list once (CORE) and run the one-time core-status → type migration. Same shape as above. */
async function ensureTypesSeeded(store: TaskStore, book: TaskBook): Promise<boolean> {
  let wrote = false
  // The one-time migration: the old `core` STATUS becomes type=core + status in_progress. It
  // matches nothing once rewritten, so it is idempotent and runs on every load for free.
  for (const t of book.tasks) {
    const m = coreStatusMigration(t)
    if (m) { await store.patchTask(t.id, m); wrote = true }
  }
  if (book.typesSeeded || book.types.length > 0) return wrote
  const plan = planTypeMigration({
    existing: book.types,
    usedTypeIds: [...book.tasks.map(t => t.type ?? ''), ...(book.tasks.some(t => t.status === CORE_TYPE_ID) ? [CORE_TYPE_ID] : [])],
  })
  if (plan) { await store.seedTypes(plan); wrote = true }
  return wrote
}

/**
 * The book, after the four idempotent "seed what is missing" passes — read ONCE.
 *
 * Each pass used to open the book itself (`store.read()` parses a 13 MB JSON and sanitises 11k
 * comments: ~45–75 ms), so a plain read of an already-seeded board paid for five parses to learn
 * that nothing needed doing. The passes now judge the book they are handed and report whether they
 * WROTE; only then is the book read again, so a first-run migration still sees its own writes.
 */
async function readSeededBook(store: TaskStore, registryRows: readonly ManagedSession[]): Promise<TaskBook> {
  let book = await store.read()
  const passes: Array<(b: TaskBook) => Promise<boolean>> = [
    b => ensureLegacyTasks(store, registryRows, b),
    b => ensureStatusesSeeded(store, b),
    b => ensureStatusStages(store, b, TASKS_FILE),
    b => ensureInReview(store, b),
    b => ensureTypesSeeded(store, b),
  ]
  for (const pass of passes) {
    if (await pass(book)) book = await store.read()
  }
  return book
}

/**
 * The board and the fleet, WITHOUT the consolidate store.
 *
 * Callers that only need the filing (thread delivery, spawn context) would otherwise re-read a
 * multi-megabyte store on every call to learn what they do not use. `loadTaskWorld` is this plus the store, so there is still one reader of the book.
 */
export async function loadTaskBoard(): Promise<{
  store: TaskStore
  book: TaskBook
  registryRows: ManagedSession[]
  rollupRows: ManagedSession[]
}> {
  const store = createTaskStore(TASKS_FILE)
  const registryRows = await readRegistry()
  const book = await readSeededBook(store, registryRows)
  // No metas here (see this function's note): the rows carry the FILING, which is all these callers read.
  return { store, book, registryRows, rollupRows: [...registryRows, ...historicalRows(book.historicalSessions)] }
}

export async function loadTaskWorld(): Promise<TaskWorld> {
  const store = createTaskStore(TASKS_FILE)
  const registryRows = await readRegistry()
  const [book, metas] = await Promise.all([
    readSeededBook(store, registryRows),
    // The store is an enrichment, never a prerequisite: one that cannot be read costs the money
    // column, not the list.
    loadConsolidated().then(withNativeAliases).catch(() => new Map<string, SessionMeta>()),
  ])
  return {
    store, book, registryRows, metas, costOf: sessionCostUSD,
    rollupRows: [...registryRows, ...historicalRows(book.historicalSessions, metas), ...nativeRows(book.nativeSessions)],
  }
}
