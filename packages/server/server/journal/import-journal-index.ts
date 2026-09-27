/**
 * journal/import-journal-index.ts — the three READ-ONLY questions the historical import asks the
 * journal that `Journal` (journal/types.ts) does not answer. IO.
 *
 * `Journal` exposes a rowid cursor and a count, which is everything a projection needs and nothing
 * the import needs: it has to know which RUNS already hold replayed events (so a coarse store copy
 * is not laid over them), which runs hold BOTH (the double-count check it reports), and — on a dry
 * run — which of the ids it would write are already present. Each is one query over the table
 * `schema.ts` owns, so it opens its OWN read-only connection instead of widening the writer's
 * interface for a one-off command. WAL lets it read beside the writer (in this process or another).
 *
 * The file is read in either schema: v1 stores strings in place, v2 interns them in
 * `event_strings` and stores 32-hex ids as 16 raw bytes (`encodeEventId`). A dry run can meet an
 * old file it must not migrate, so both are handled rather than refused. Every method is total: a
 * query that fails answers `null`, and the caller reports the check as "not run" — never as zero.
 */
import { existsSync } from 'node:fs'
import { encodeEventId } from './journal-plan'
import { IMPORT_STORE_SOURCE_ID } from './import-store'

export interface JournalIndex {
  /** Run ids holding at least one event whose source is NOT the import's store half. */
  replayedRunIds(): Set<string> | null
  /** How many runs hold both coarse store events and events from another source. */
  conflicts(): number | null
  /** How many of `ids` are already stored. */
  countPresent(ids: readonly string[]): number | null
  close(): void
}

type Db = import('bun:sqlite').Database

/** Opens the journal at `path` read-only, or answers `null` when there is no file to read. */
export async function openJournalIndex(path: string): Promise<JournalIndex | null> {
  if (!existsSync(path)) return null
  let db: Db
  try {
    const { Database } = await import('bun:sqlite')
    db = new Database(path, { readonly: true })
    db.exec('PRAGMA busy_timeout = 5000')
  } catch {
    return null
  }
  let version = 0
  try { version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version } catch { /* 0 */ }
  const interned = version >= 2

  function importSourceKey(): number | string | null {
    if (!interned) return IMPORT_STORE_SOURCE_ID
    try {
      const row = db.query('SELECT id FROM event_strings WHERE s = ?').get(IMPORT_STORE_SOURCE_ID) as { id: number } | null
      return row ? row.id : null
    } catch { return null }
  }

  return {
    replayedRunIds() {
      try {
        const key = importSourceKey()
        const out = new Set<string>()
        if (interned) {
          const rows = key === null
            ? db.query('SELECT s FROM event_strings WHERE id IN (SELECT DISTINCT run_id FROM events WHERE run_id IS NOT NULL)').all()
            : db.query('SELECT s FROM event_strings WHERE id IN (SELECT DISTINCT run_id FROM events WHERE run_id IS NOT NULL AND source_id != ?)').all(key)
          for (const r of rows as { s: string }[]) out.add(r.s)
        } else {
          const rows = db.query('SELECT DISTINCT run_id AS s FROM events WHERE run_id IS NOT NULL AND source_id != ?').all(IMPORT_STORE_SOURCE_ID)
          for (const r of rows as { s: string }[]) out.add(r.s)
        }
        return out
      } catch { return null }
    },
    conflicts() {
      try {
        const key = importSourceKey()
        if (key === null) return 0
        const row = db.query(
          'SELECT COUNT(*) AS n FROM (SELECT run_id FROM events WHERE run_id IS NOT NULL GROUP BY run_id '
          + 'HAVING SUM(source_id = ?1) > 0 AND SUM(source_id != ?1) > 0)',
        ).get(key) as { n: number }
        return row.n
      } catch { return null }
    },
    countPresent(ids) {
      try {
        const q = db.query('SELECT 1 FROM events WHERE event_id = ? LIMIT 1')
        let n = 0
        for (const id of ids) if (q.get(interned ? encodeEventId(id) : id)) n++
        return n
      } catch { return null }
    },
    close() {
      try { db.close() } catch { /* already closed */ }
    },
  }
}
