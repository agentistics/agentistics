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

/** `AGENTISTICS_PROJECTIONS` — absent reads OFF; only an explicit affirmative turns it on. */
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
}

export interface RouteAnswer { status: number; body: unknown }

export async function handleRuntimeMetricsRequest(
  req: Request,
  url: URL,
  deps: RuntimeMetricsDeps,
): Promise<RouteAnswer> {
  if (!projectionsEnabled(deps.flag)) {
    return {
      status: 404,
      body: { error: 'projections_disabled', sentence: 'the projection query is off on this machine (AGENTISTICS_PROJECTIONS is not set).' },
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
  const reader = deps.reader
  if (!reader) {
    return {
      status: 503,
      body: { error: 'projections_unavailable', sentence: 'the projection store is not ready on this machine yet.' },
    }
  }
  const parsed = parseMetricsQuery(url.searchParams)
  if (!parsed.ok) return { status: 400, body: { error: parsed.error.code, ...parsed.error } }
  return { status: 200, body: await runMetricsQuery(reader, parsed.query) }
}

/** How often a request may start a catch-up pass. A resume costs time proportional to the NEW events
 *  (P3 §6), so this bounds how stale an answer can be, not how much work a pass does. */
export const CATCH_UP_EVERY_MS = 15_000

interface LiveStore {
  reader: ProjectionReader
  close(): void
  catchUp(): Promise<unknown>
}

let live: LiveStore | null = null
let opening: Promise<LiveStore | null> | null = null
let catching: Promise<unknown> | null = null
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
      const [{ openJournal }, { openProjectionReader }, { runProjectionCatchUp }] = await Promise.all([
        import('./journal/journal'), import('./projections/reader'), import('./projections/catch-up'),
      ])
      const journal = await openJournal()
      const opened = await openProjectionReader({ journal })
      live = {
        reader: opened.reader,
        close: () => { opened.close(); journal.close() },
        catchUp: () => runProjectionCatchUp({ journal, store: opened.store }),
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
function maybeCatchUp(store: LiveStore, now = Date.now()): void {
  if (catching || now - lastCatchUpAt < CATCH_UP_EVERY_MS) return
  lastCatchUpAt = now
  catching = store.catchUp()
    .then(r => {
      const rep = r as { state?: string; reason?: string }
      if (rep.state === 'failed') console.error('[runtime-metrics] projection catch-up failed:', rep.reason ?? '')
    })
    .catch(err => console.error('[runtime-metrics] projection catch-up threw:', err instanceof Error ? err.message : String(err)))
    .finally(() => { catching = null })
}

/** The production dependencies, resolved per request (the flag in particular). With the flag OFF this
 *  touches nothing; with it on it opens the store lazily and nudges a catch-up. An injected reader
 *  (`setRuntimeMetricsReader`) wins, which is what tests use. */
export async function liveRuntimeMetricsDeps(central: boolean): Promise<RuntimeMetricsDeps> {
  const flag = process.env.AGENTISTICS_PROJECTIONS
  if (injectedReader || central || !projectionsEnabled(flag)) return { flag, central, reader: injectedReader }
  const store = await openLive()
  if (store) maybeCatchUp(store)
  return { flag, central, reader: store?.reader ?? null }
}

/** Test/teardown hook: close the lazily opened store. */
export function closeRuntimeMetricsStore(): void {
  live?.close()
  live = null
  lastCatchUpAt = 0
}
