/**
 * projections/catch-up.ts — one CATCH-UP PASS: bring every materialised projection up to the journal's
 * head (P3 §1 item 1, §6; master spec §19.4). The server decides WHEN to call it; this module only
 * does it, and does nothing at all while `AGENTISTICS_PROJECTIONS` is off.
 *
 * ## Rebuild or resume, per projection (`catalog.ts`'s `planProjection`)
 *
 * - **Resume** (the ordinary case): fold only the events after the stored cursor, onto the stored fold
 *   state of each key they touch. The cost is proportional to NEW events, never to history.
 * - **Rebuild**: the projection's `version` changed, an adapter version changed (§19.4), it never
 *   existed, or the journal is not the one it was folded from. Its tables are dropped and it folds from
 *   rowid 0. A rebuild is REPORTED (`CatchUpReport.projections[].rebuildReason`, a sentence) and
 *   INTERRUPTIBLE: the cursor and the states commit per page, so an aborted rebuild continues from its
 *   last committed page on the next pass rather than starting over.
 *
 * ## Bounded memory
 *
 * The journal is paged (`readFrom`, ≤ `MAX_PAGE` events). For each page, per projection, the events are
 * grouped by key and ONLY those keys' states are loaded, folded, finished and written back — in one
 * `BEGIN IMMEDIATE` transaction together with the cursor, so a crash can never leave rows that disagree
 * with the cursor. Nothing survives a page in memory but the cursor.
 *
 * ## Why re-folding a page is harmless
 *
 * Projections can sit at different cursors (one was just rebuilt, the others were not), so one pass
 * reads from the LOWEST cursor and a projection skips every page wholly behind its own. A page that
 * straddles a projection's cursor is folded whole: every fold here is idempotent by `eventId` (its
 * state remembers what it has seen), so the events it had already folded add nothing. The cursor is
 * also re-read INSIDE each page's transaction, so two processes running a pass at once never fold the
 * same page twice into one state — the second one finds the cursor already past it.
 *
 * ## The journal it folded from
 *
 * A cursor is a rowid, and a rowid only means something in the journal that assigned it. The store
 * remembers the id of the journal's FIRST event; a journal whose first event differs, or whose head is
 * BELOW a stored cursor, is not the one these projections describe (a restored or recreated file), and
 * every projection is rebuilt from it with that reason — otherwise a fresh journal's first events would
 * sit under a cursor that has already moved past them, skipped forever.
 */
import type { AnyAgentisticsEvent } from '@agentistics/core'
import { MAX_PAGE, type Journal } from '../journal/types'
import { CURRENT_ADAPTER_VERSIONS } from './adapter-versions'
import { STORED_PROJECTIONS, planProjection, type ProjectionPlan, type StoredProjection } from './catalog'
import { canonicalJson, decodeState, encodeState } from './state-codec'
import { openProjectionStore, projectionsEnabled, type OpenStoreOptions, type ProjectionStore } from './store'

export interface CatchUpProgress {
  /** `rebuild` while any projection of this pass is rebuilding. */
  phase: 'rebuild' | 'resume'
  cursor: number
  /** `null` when the journal cannot say. */
  head: number | null
  pages: number
  eventsRead: number
  /** Why each rebuilding projection is rebuilding, by name. */
  rebuilding: Record<string, string>
}

export interface CatchUpOptions {
  journal: Journal
  /** An already-open store. Default: open one at `storeOptions.path` (and close it afterwards). */
  store?: ProjectionStore
  storeOptions?: OpenStoreOptions
  /** Default `process.env`. The flag is read here, per call. */
  env?: Record<string, string | undefined>
  /** Default every materialised projection. */
  projections?: readonly StoredProjection[]
  /** The adapter versions running now. Default `CURRENT_ADAPTER_VERSIONS`; `null` skips that comparison. */
  adapterVersions?: Record<string, string> | null
  /** Default `MAX_PAGE`. */
  pageSize?: number
  /** Stop after this many pages (reported as `interrupted`, resumable). Default: until the head. */
  maxPages?: number
  signal?: AbortSignal
  onProgress?: (p: CatchUpProgress) => void
}

export interface ProjectionPassReport {
  name: string
  version: number
  mode: 'resume' | 'rebuild'
  /** Present exactly when `mode === 'rebuild'`: why, in one sentence. */
  rebuildReason?: string
  fromCursor: number
  toCursor: number
  /** Distinct keys whose state this pass rewrote (summed per page — a key touched on two pages counts twice). */
  keysTouched: number
  /** Events of the pages handed to this projection that it could not key (no session/run/task id). */
  unkeyed: number
}

export interface CatchUpReport {
  state: 'disabled' | 'done' | 'interrupted' | 'failed'
  /** Why a pass is disabled, interrupted or failed. */
  reason?: string
  projections: ProjectionPassReport[]
  pages: number
  eventsRead: number
  /** The journal rowid every projection of this pass has reached. */
  cursor: number
  journalHead: number | null
  ms: number
}

const INFO_FIRST_EVENT = 'journal_first_event'

/** Does the journal still look like the one the store folded from? `null` = yes (or cannot tell). */
async function journalReplaced(journal: Journal, store: ProjectionStore, maxCursor: number, head: number | null): Promise<string | null> {
  const stored = store.info(INFO_FIRST_EVENT)
  const first = await journal.readFrom(0, 1)
  const firstId = first.events[0]?.eventId ?? null
  if (stored !== null && firstId !== null && stored !== firstId) return 'its first event differs'
  if (head !== null && maxCursor > head) return `a stored cursor (${maxCursor}) is past its head (${head})`
  return null
}

export async function catchUpProjections(opts: CatchUpOptions): Promise<CatchUpReport> {
  const t0 = performance.now()
  const env = opts.env ?? process.env
  const base = { projections: [] as ProjectionPassReport[], pages: 0, eventsRead: 0, cursor: 0, journalHead: null as number | null }
  if (!projectionsEnabled(env)) return { state: 'disabled', reason: 'flag-off: AGENTISTICS_PROJECTIONS is not set', ...base, ms: 0 }

  const defs = opts.projections ?? STORED_PROJECTIONS
  const ownStore = opts.store === undefined
  const store = opts.store ?? await openProjectionStore({ ...opts.storeOptions, projections: defs })
  const done = (r: Omit<CatchUpReport, 'ms'>): CatchUpReport => {
    if (ownStore) store.close()
    return { ...r, ms: Math.round(performance.now() - t0) }
  }
  if (store.state !== 'open') return done({ state: 'disabled', reason: `store ${store.reason ?? store.state}`, ...base })

  const journalStatus = opts.journal.status()
  if (journalStatus.state !== 'open') return done({ state: 'disabled', reason: `journal ${journalStatus.reason ?? journalStatus.state}`, ...base })

  const adapters = opts.adapterVersions === undefined ? CURRENT_ADAPTER_VERSIONS : opts.adapterVersions
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? MAX_PAGE, MAX_PAGE))
  const failedReadsAtStart = journalStatus.counters.failedReads
  const readFailed = () => opts.journal.status().counters.failedReads > failedReadsAtStart

  try {
    const head = opts.journal.head ? await opts.journal.head() : null
    const metas = store.metas()
    const maxCursor = Math.max(0, ...defs.map(d => metas.get(d.id)?.cursor ?? 0))
    const replaced = await journalReplaced(opts.journal, store, maxCursor, head)

    // ── Plan, and reset every projection that rebuilds from scratch ──
    const plans = new Map<string, ProjectionPlan>()
    const reports = new Map<string, ProjectionPassReport>()
    for (const d of defs) {
      const plan = planProjection(metas.get(d.id), d.projection, adapters, replaced)
      plans.set(d.id, plan)
      if (plan.mode === 'rebuild' && plan.fresh) {
        const stamp = adapters ?? metas.get(d.id)?.adapterVersions ?? {}
        await store.resetProjection(d.id, d.projection.version, stamp, plan.reason)
      }
      reports.set(d.id, {
        name: d.projection.name, version: d.projection.version, mode: plan.mode,
        ...(plan.mode === 'rebuild' ? { rebuildReason: plan.reason } : {}),
        fromCursor: plan.from, toCursor: plan.from, keysTouched: 0, unkeyed: 0,
      })
    }
    const firstNow = (await opts.journal.readFrom(0, 1)).events[0]?.eventId
    if (firstNow !== undefined && store.info(INFO_FIRST_EVENT) !== firstNow) await store.setInfo(INFO_FIRST_EVENT, firstNow)

    const rebuilding: Record<string, string> = {}
    for (const [id, p] of plans) if (p.mode === 'rebuild') rebuilding[reports.get(id)!.name] = p.reason
    const phase: CatchUpProgress['phase'] = Object.keys(rebuilding).length > 0 ? 'rebuild' : 'resume'

    let cursor = Math.min(...[...plans.values()].map(p => p.from))
    let pages = 0
    let eventsRead = 0
    const progress = () => opts.onProgress?.({ phase, cursor, head, pages, eventsRead, rebuilding })
    const finishReport = (state: CatchUpReport['state'], reason?: string): CatchUpReport => {
      const projections = defs.map(d => reports.get(d.id)!)
      const reached = Math.min(...projections.map(r => r.toCursor))
      return done({ state, ...(reason ? { reason } : {}), projections, pages, eventsRead, cursor: reached, journalHead: head })
    }

    for (;;) {
      if (opts.signal?.aborted) return finishReport('interrupted', 'aborted: resumes from the last committed page on the next pass')
      if (opts.maxPages !== undefined && pages >= opts.maxPages) {
        return finishReport('interrupted', `page budget (${opts.maxPages}) spent: resumes from the last committed page on the next pass`)
      }
      const page = await opts.journal.readFrom(cursor, pageSize)
      if (readFailed()) return finishReport('failed', 'journal read failed: the cursor did not move; the next pass retries from it')
      if (page.events.length === 0) break
      const events = page.events as AnyAgentisticsEvent[]
      await store.transaction(tx => {
        for (const d of defs) {
          const r = reports.get(d.id)!
          const stored = tx.meta(d.id)
          const at = stored?.cursor ?? 0
          if (at >= page.cursor) { r.toCursor = Math.max(r.toCursor, at); continue }
          const groups = new Map<string, AnyAgentisticsEvent[]>()
          for (const e of events) {
            const k = d.keyOf(e)
            if (k === null) { r.unkeyed++; continue }
            let g = groups.get(k)
            if (!g) { g = []; groups.set(k, g) }
            g.push(e)
          }
          const keys = [...groups.keys()]
          const loaded = tx.loadStates(d.id, keys)
          for (const k of keys) {
            const text = loaded.get(k)
            const st = text === undefined ? d.projection.empty() : decodeState(text)
            d.projection.fold(st, groups.get(k)!)
            tx.saveState(d.id, k, encodeState(st))
            tx.replaceOutputs(d.id, k, d.rows(d.projection.finish(st)).map(o => ({ day: o.day, data: canonicalJson(o.data) })))
          }
          r.keysTouched += keys.length
          tx.setCursor(d.id, page.cursor)
          r.toCursor = page.cursor
        }
      })
      cursor = page.cursor
      pages++
      eventsRead += events.length
      progress()
    }

    await store.markCaughtUp(defs.map(d => d.id), cursor)
    return finishReport('done')
  } catch (e) {
    return done({ state: 'failed', reason: `store write failed (${e instanceof Error ? e.name : 'error'}): nothing of the failed page was kept; the next pass retries it`, ...base })
  }
}

/**
 * The entry point the server wires: one pass, or NOTHING while the flag is off — the flag is the first
 * thing `catchUpProjections` reads, before any store is opened, so no file is opened or created and not
 * a byte of existing behaviour changes.
 */
export const runProjectionCatchUp = catchUpProjections
