/**
 * runtime-metrics-web.ts — `GET /api/runtime/metrics`, the projection query (P3 spec §3, A4.3).
 *
 * The door only: the arithmetic is `runtime-metrics-query.ts` (pure), and the projection store is a
 * `ProjectionReader` INJECTED by whoever wires the real one (`setRuntimeMetricsReader`) — this module
 * never opens a database itself.
 *
 * Order of refusals, each a code plus a sentence:
 *   1. `AGENTISTICS_PROJECTIONS` off (absent reads OFF, read PER REQUEST — P3 §7: flipping it back is
 *      immediate) → 404 `projections_disabled`, and NOTHING is touched: not the reader, not the query
 *      string. The flag being off must cost the product not one byte of behaviour.
 *   2. A central → 409 `unsupported_on_central`. The projection facts carry no machine or member
 *      attribution, so the visibility rule `/api/data` applies on a central (`scopeAppDataToTeams` +
 *      `dataTeamIdsOf`: owner sees all, anyone else the teams they MANAGE plus the machines they own)
 *      has nothing to key on; answering would show every viewer the central host's own projection,
 *      unscoped. Refusing is the honest answer until facts carry a machine id.
 *   3. Not GET → 405.
 *   4. No reader wired → 503 `projections_unavailable`.
 *   5. Bad input → 400 with the parser's code.
 * `capability-guard.ts` has already required `localTranscripts` before this runs, and the auth gate
 * already required a session wherever there is one (the path is not in AUTH_PUBLIC). An unexpected
 * failure is the CALLER's `safeError`.
 */
import type { ProjectionReader } from './projections/facts'
import { projectionsEnabled as storeProjectionsEnabled } from './projections/store'
import { parseMetricsQuery, runMetricsQuery } from './runtime-metrics-query'

export const RUNTIME_METRICS_PATH = '/api/runtime/metrics'

/** `AGENTISTICS_PROJECTIONS`: ON by default; only an explicit negative turns it off. */
export function projectionsEnabled(raw: string | undefined): boolean {
  // ONE reading of the flag: the store's (`projections/store.ts`), so the route and the catch-up can
  // never disagree about whether projections are on.
  return storeProjectionsEnabled({ AGENTISTICS_PROJECTIONS: raw })
}

let injectedReader: ProjectionReader | null = null

/** Wire the real projection store (A4.1). `null` unwires it. */
export function setRuntimeMetricsReader(reader: ProjectionReader | null): void {
  injectedReader = reader
}

export interface RuntimeMetricsDeps {
  /** The flag's raw value, read by the caller per request. */
  flag: string | undefined
  central: boolean
  reader: ProjectionReader | null
  /** The journal's first import (`journal/backfill.ts`): while it is pending, no projected answer. */
  backfill?: { pending: boolean; progress: import('./journal/backfill').BackfillProgress | null }
}

/**
 * The most journal rows the projections may be behind and still answer. Past it (right after the first
 * import, a rebuild after a version bump), the answer would be a partial one under a heading that does
 * not say so: the route refuses, every surface reads /api/data, and the catch-up keeps going.
 */
export const MAX_ANSWER_LAG = 20_000

export interface RouteAnswer { status: number; body: unknown }

export async function handleRuntimeMetricsRequest(
  req: Request,
  url: URL,
  deps: RuntimeMetricsDeps,
): Promise<RouteAnswer> {
  if (!projectionsEnabled(deps.flag)) {
    return {
      status: 404,
      body: { error: 'projections_disabled', sentence: 'the projection query is off on this machine (AGENTISTICS_PROJECTIONS is set off).' },
    }
  }
  if (deps.central) {
    return {
      status: 409,
      body: {
        error: 'unsupported_on_central',
        sentence: 'the projection query is not available on a central yet: its facts carry no machine or member attribution, so the viewer scoping /api/data applies cannot be enforced, and unscoped figures are not shown.',
      },
    }
  }
  if (req.method !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed', sentence: 'only GET is supported.' } }
  }
  if (deps.backfill?.pending) {
    const p = deps.backfill.progress
    return {
      status: 503,
      body: {
        error: 'projections_backfilling',
        sentence: 'the journal is still importing this machine\'s history for the first time; until it completes, the figures come from /api/data.',
        progress: p ? { state: p.state, written: p.written, harness: p.harness ?? null, done: p.done ?? null, total: p.total ?? null } : null,
      },
    }
  }
  const reader = deps.reader
  if (!reader) {
    return {
      status: 503,
      body: { error: 'projections_unavailable', sentence: 'the projection store is not ready on this machine yet.' },
    }
  }
  const parsed = parseMetricsQuery(url.searchParams)
  if (!parsed.ok) return { status: 400, body: { error: parsed.error.code, ...parsed.error } }
  const st = await reader.status()
  const lag = st.journalHead >= 0 ? st.journalHead - st.cursor : 0
  if (lag > MAX_ANSWER_LAG) {
    return {
      status: 503,
      body: {
        error: 'projections_catching_up', lag,
        sentence: `the projections are ${lag.toLocaleString('en-US')} journal rows behind; until they catch up, the figures come from /api/data.`,
      },
    }
  }
  return { status: 200, body: await runMetricsQuery(reader, parsed.query) }
}

/** How often a request may start a catch-up pass. A resume costs time proportional to the NEW events
 *  (P3 §6), so this bounds how stale an answer can be, not how much work a pass does. */
export const CATCH_UP_EVERY_MS = 15_000
/**
 * Journal pages one catch-up pass folds before it stops (`interrupted`, resumable from its committed
 * cursor) — LIVE C5. A first pass on a large journal is a rebuild; bounding a pass bounds how long one
 * holds the store, and the next pass continues where it stopped.
 */
export const CATCH_UP_MAX_PAGES = 50

export interface LiveStore {
  reader: ProjectionReader
  close(): void
  catchUp(): Promise<unknown>
}

let live: LiveStore | null = null
let opening: Promise<LiveStore | null> | null = null
let catching: Promise<unknown> | null = null
let catchUpDirty = false
let lastCatchUpAt = 0

/**
 * The real store, opened on the FIRST request that arrives with the flag on — never at boot, so a
 * machine with the flag off opens, creates and runs nothing (P3: "with the flag off, not one byte of
 * behaviour changes"). A failure to open is logged and answered as `projections_unavailable`; the next
 * request tries again.
 */
async function openLive(): Promise<LiveStore | null> {
  if (live) return live
  opening ??= (async () => {
    try {
      const [{ openJournal }, { openProjectionReader }, { runProjectionCatchUp }, { memoRepoResolver }, { getGitRemote }] = await Promise.all([
        import('./journal/journal'), import('./projections/reader'), import('./projections/catch-up'),
        import('./projections/repo-attribution'), import('./git'),
      ])
      const journal = await openJournal()
      // The repository of a fact the journal left without one: its project root's `origin`, read
      // once per root, the same git read the legacy `/api/data` makes.
      const opened = await openProjectionReader({ journal, repoOf: memoRepoResolver(getGitRemote) })
      live = {
        reader: opened.reader,
        close: () => { opened.close(); journal.close() },
        catchUp: () => runProjectionCatchUp({ journal, store: opened.store, maxPages: CATCH_UP_MAX_PAGES }),
      }
      return live
    } catch (err) {
      console.error('[runtime-metrics] projection store could not be opened:', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      opening = null
    }
  })()
  return opening
}

/**
 * Start a catch-up pass in the background when none is running and the last one started more than
 * `CATCH_UP_EVERY_MS` ago. NOT awaited: the first pass on a machine is a full rebuild (minutes on a
 * large journal, P3 §6), and the answer states its own freshness (`basis.freshness`) rather than
 * holding the request.
 */
export function maybeCatchUp(store: LiveStore, now = Date.now()): void {
  if (now - lastCatchUpAt < CATCH_UP_EVERY_MS) return
  // Single flight, COALESCED (LIVE C5): a due request that finds a pass running sets one dirty bit,
  // and the running pass is followed by exactly one more — never a queue of passes.
  if (catching) { catchUpDirty = true; return }
  lastCatchUpAt = now
  catching = (async () => {
    do {
      catchUpDirty = false
      try {
        const rep = await store.catchUp() as { state?: string; reason?: string }
        if (rep.state === 'failed') console.error('[runtime-metrics] projection catch-up failed:', rep.reason ?? '')
      } catch (err) {
        console.error('[runtime-metrics] projection catch-up threw:', err instanceof Error ? err.message : String(err))
      }
    } while (catchUpDirty)
  })().finally(() => { catching = null })
}

/** Tests only: what the next catch-up decision sees. */
export function catchUpStateForTests(): { running: boolean; dirty: boolean } {
  return { running: catching !== null, dirty: catchUpDirty }
}

/** The production dependencies, resolved per request (the flag in particular). With the flag OFF this
 *  touches nothing; with it on it opens the store lazily and nudges a catch-up. An injected reader
 *  (`setRuntimeMetricsReader`) wins, which is what tests use. */
export async function liveRuntimeMetricsDeps(central: boolean): Promise<RuntimeMetricsDeps> {
  const flag = process.env.AGENTISTICS_PROJECTIONS
  if (injectedReader || central || !projectionsEnabled(flag)) return { flag, central, reader: injectedReader }
  const store = await openLive()
  // The catch-up keeps going while the route refuses (first import, a large lag), so the projections
  // are ready when it stops refusing.
  if (store) maybeCatchUp(store)
  const [{ JOURNAL_BACKFILL_PATH, JOURNAL_PATH }, { backfillPending, readBackfillProgress }] = await Promise.all([
    import('./config'), import('./journal/backfill'),
  ])
  const backfill = { pending: backfillPending(JOURNAL_PATH, JOURNAL_BACKFILL_PATH), progress: readBackfillProgress(JOURNAL_BACKFILL_PATH) }
  return { flag, central, reader: store?.reader ?? null, backfill }
}

/** Test/teardown hook: close the lazily opened store. */
export function closeRuntimeMetricsStore(): void {
  live?.close()
  live = null
  lastCatchUpAt = 0
  catchUpDirty = false
}
