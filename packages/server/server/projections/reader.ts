/**
 * projections/reader.ts — `ProjectionReader` (facts.ts) over the materialised store. What A4.3's query
 * API consumes: it streams rows, it never loads the store.
 *
 * - `costFacts` / `runFacts` read the `cost-by-dimension` / `run-metrics` output tables in pages of
 *   `READ_PAGE` rows (rid-ordered, day-filtered by the index), yielding one fact at a time.
 * - `status()` says how fresh the answer is: the LOWEST cursor any projection has reached (a row can be
 *   no fresher than the slowest projection behind it), the journal's head (from the live journal when
 *   one is given, else the head the last completed pass recorded; `-1` when neither exists), each
 *   projection's version, and whether any is mid-rebuild.
 * - A reader over a disabled store (flag off, network path, …) yields nothing and reports cursor 0 —
 *   and `openProjectionReader` with the flag off opens NOTHING.
 */
import type { Journal } from '../journal/types'
import { COST_BY_DIMENSION, RUN_METRICS, STORED_PROJECTIONS } from './catalog'
import type { CostFact, ProjectionReader, RunFact } from './facts'
import { flagOffStore, openProjectionStore, projectionsEnabled, type OpenStoreOptions, type ProjectionStore } from './store'

const READ_PAGE = 500

async function* rowsOf<T>(store: ProjectionStore, id: string, range: { from?: string; to?: string }): AsyncIterable<T> {
  let after = 0
  for (;;) {
    const rows = store.outputs(id, range, after, READ_PAGE)
    if (rows.length === 0) return
    for (const r of rows) yield JSON.parse(r.data) as T
    after = rows[rows.length - 1]!.rid
    if (rows.length < READ_PAGE) return
  }
}

export interface ReaderOptions {
  /** The live journal, for a head that is current rather than as of the last pass. */
  journal?: Journal
}

export function createProjectionReader(store: ProjectionStore, opts: ReaderOptions = {}): ProjectionReader {
  return {
    costFacts: range => rowsOf<CostFact>(store, COST_BY_DIMENSION.id, range),
    runFacts: range => rowsOf<RunFact>(store, RUN_METRICS.id, range),
    async status() {
      const metas = store.metas()
      const versions: Record<string, number> = {}
      let cursor = Number.POSITIVE_INFINITY
      let rebuilding = false
      for (const d of STORED_PROJECTIONS) {
        const m = metas.get(d.id)
        if (m) versions[d.projection.name] = m.version
        cursor = Math.min(cursor, m?.cursor ?? 0)
        if (!m || m.rebuilding) rebuilding = rebuilding || m?.rebuilding === true
      }
      if (!Number.isFinite(cursor)) cursor = 0
      let journalHead: number | null = null
      if (opts.journal?.head) journalHead = await opts.journal.head()
      if (journalHead === null) {
        const recorded = store.info('journal_head')
        journalHead = recorded !== null && /^\d+$/.test(recorded) ? Number(recorded) : -1
      }
      return { cursor, journalHead, versions, rebuilding }
    },
  }
}

/**
 * The reader factory the server wires. Flag off → a reader over a store that touched nothing (it yields
 * no rows). Flag on → the store at `PROJECTIONS_PATH` (or `storeOptions.path`); the caller closes it
 * through the returned `close`.
 */
export async function openProjectionReader(opts: ReaderOptions & {
  env?: Record<string, string | undefined>
  storeOptions?: OpenStoreOptions
} = {}): Promise<{ reader: ProjectionReader; store: ProjectionStore; close(): void }> {
  const store = projectionsEnabled(opts.env ?? process.env)
    ? await openProjectionStore({ ...opts.storeOptions, projections: STORED_PROJECTIONS })
    : flagOffStore(opts.storeOptions?.path)
  return { reader: createProjectionReader(store, opts), store, close: () => store.close() }
}
