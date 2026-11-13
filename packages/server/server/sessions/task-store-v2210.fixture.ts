/**
 * CAPTURED COPY of the v2.210.1 tasks.json load/serialize path (`sessions/task-store.ts` at tag v2.210.1:
 * `readUncached` + `sanitizeStatusDef` + `write`), reduced to what the downgrade tests need to be faithful about:
 *
 *   - `statuses` go through `sanitizeStatusDef`, a WHITELIST (`id, label, color, protected, order`) — so a
 *     `stage` field on a status is DROPPED by the older writer, and a status with an unknown colour is dropped whole;
 *   - `tasks` and `subtasks` keep `id` and `status` as written (a status id the old build has never heard of —
 *     `published` — is kept as a plain string: `TaskStatus` is a string, validated only at write time by the doors);
 *   - every other collection is carried as an array and written back, because the old writer round-trips them.
 *
 * `serializeV2210` is `JSON.stringify(book, null, 2)` exactly as `write()` does. FROZEN: do not update it when
 * `task-store.ts` changes. `task-store-v2210.fixture.test.ts` pins its agreement with the REAL store on statuses
 * for as long as the real store's whitelist is unchanged, so a fixture that drifted from what it captured is caught.
 * (Spec 2026-11-13-entrega-garantida §2.7, review r2 N1.)
 */
const HEX = /^#[0-9a-fA-F]{6}$/
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export interface OldStatusDef { id: string; label: string; color: string; protected: boolean; order: number }
export interface OldBook {
  tasks: Array<Record<string, unknown>>
  subtasks: Array<Record<string, unknown>>
  statuses: OldStatusDef[]
  rest: Record<string, unknown[]>
}

function sanitizeStatusDef(raw: unknown): OldStatusDef | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = str(s.id); const label = str(s.label)
  if (!id || !label) return null
  if (typeof s.color !== 'string' || !HEX.test(s.color)) return null
  return { id, label, color: s.color, protected: s.protected === true, order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : 0 }
}

export function loadV2210(text: string): OldBook {
  const raw = JSON.parse(text) as Record<string, unknown>
  const keep = (v: unknown) => arr(v).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
  const rest: Record<string, unknown[]> = {}
  for (const k of ['attempts', 'comments', 'threads', 'files', 'historicalSessions', 'nativeSessions', 'tombstones', 'events', 'types']) rest[k] = arr(raw[k])
  return { tasks: keep(raw.tasks), subtasks: keep(raw.subtasks), statuses: arr(raw.statuses).map(sanitizeStatusDef).filter((s): s is OldStatusDef => s !== null), rest }
}

export function serializeV2210(book: OldBook): string {
  return JSON.stringify({ tasks: book.tasks, attempts: book.rest.attempts, comments: book.rest.comments, threads: book.rest.threads,
    subtasks: book.subtasks, files: book.rest.files, historicalSessions: book.rest.historicalSessions, nativeSessions: book.rest.nativeSessions,
    tombstones: book.rest.tombstones, events: book.rest.events, statuses: book.statuses, types: book.rest.types }, null, 2)
}

/** What the old binary does on any board write: load, optionally mutate, serialize. Returns the bytes it would write. */
export function oldBoardRoundTrip(text: string, mutate?: (b: OldBook) => void): string {
  const b = loadV2210(text)
  mutate?.(b)
  return serializeV2210(b)
}
