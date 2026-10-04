/**
 * useDashboardNav — the dashboard's own keyboard, wherever it is drawn.
 *
 * Which screen is open and which harness is selected are the same two questions full-screen and
 * inside the control center's tab, answered by the same keys, so they are answered ONCE here rather
 * than in both entry points. The rules themselves are pure (`resolveDashboardKey`); this holds
 * the state and the `useInput` subscription.
 *
 * `capture` is the contract with whatever is hosting it: while the harness picker is open the
 * dashboard owns the keyboard, and the control center's global keys must stand down — `q` would
 * otherwise quit the whole app out from under a list the user is choosing from. The standalone app
 * uses the same flag to hold its own `?`/`q` handler back.
 */

import type { DashboardFigures } from '../projected-figures'
import { useCallback, useMemo, useState } from 'react'
import { useInput } from 'ink'
import type { AppData, SurfaceHarnessId } from '@agentistics/core'
import { SURFACE_HARNESS_ORDER } from '@agentistics/core'
import {
  applyHarnessFilter,
  dashboardRows,
  DASHBOARD_SCREENS,
  listPlan,
  pageableTotal,
  pageWindow,
  resolveDashboardKey,
  type DashboardScreenId,
} from './view'

export interface DashboardFilter {
  /** `null` is the "all harnesses" entry, always first. */
  options: (SurfaceHarnessId | null)[]
  index: number
}

export interface DashboardNav {
  screen: DashboardScreenId
  setScreen: (id: DashboardScreenId) => void
  /** `null` means every harness — the filter is off. */
  harness: SurfaceHarnessId | null
  /** The harness picker, or `null` when it is closed. */
  filter: DashboardFilter | null
  /** True while the picker owns the keyboard. */
  capture: boolean
  /** The page the open screen's list is on, 0-based. Clamped where the rows are drawn as well. */
  page: number
}

export function useDashboardNav(opts: {
  isActive: boolean
  /** The harnesses that actually have data, so the picker never offers an empty one. */
  harnesses: readonly SurfaceHarnessId[] | undefined
  /**
   * What the screens are drawing, so a page can be clamped against the rows that EXIST.
   *
   * An unbounded counter takes as many presses to come back as it took to run past the end, and
   * correcting it where the rows are drawn is one frame too late — that frame is the one the next
   * key lands on.
   */
  data?: AppData | null
  /** The projected figures (A4.6) when the screens draw those instead of the selectors' over `data`. */
  figures?: DashboardFigures | null
  /** The height `DashboardView` is given, which is what decides how many rows a page holds. */
  height?: number
}): DashboardNav {
  const [screen, setScreen] = useState<DashboardScreenId>(DASHBOARD_SCREENS[0]!)
  const [harness, setHarness] = useState<SurfaceHarnessId | null>(null)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [page, setPage] = useState(0)

  // Keyed on the joined ids rather than the array: `data.harnesses` is a fresh array on every
  // payload, and rebuilding this list each time would reset nothing but would churn every consumer.
  const key = (opts.harnesses ?? []).join(',')
  const options = useMemo<(SurfaceHarnessId | null)[]>(() => {
    const present = new Set(key ? (key.split(',') as SurfaceHarnessId[]) : [])
    return [null, ...SURFACE_HARNESS_ORDER.filter(h => present.has(h))]
  }, [key])

  /**
   * Open a screen — the ONE way, so a click on the strip resets the page exactly as a key does.
   *
   * Each screen lists something else, so a page carried across is a position in a list that is not
   * there any more.
   */
  const goto = useCallback((id: DashboardScreenId) => {
    setScreen(id)
    setPage(0)
  }, [])

  // Paging is decided against the FILTERED list, so a page can never name a row the filter removed
  // and the page count is the count of what the filter left standing.
  const view = opts.data ? applyHarnessFilter(opts.data, harness) : null
  const total = pageableTotal(screen, view, opts.figures ?? null)
  const body = dashboardRows(opts.height ?? 0).body
  const pages = pageWindow(total, listPlan(body, total).size, 0).pages

  useInput((input, key2) => {
    // WHICH key means WHAT is the pure `resolveDashboardKey` — what the help overlay's key table is
    // tested against; only the state changes live here.
    const intent = resolveDashboardKey(
      {
        input, upArrow: key2.upArrow, downArrow: key2.downArrow, return: key2.return, escape: key2.escape,
        pageUp: key2.pageUp, pageDown: key2.pageDown, tab: key2.tab, shift: key2.shift, ctrl: key2.ctrl,
      },
      { open, screen },
    )
    if (!intent) return
    switch (intent.kind) {
      case 'filterClose': return setOpen(false)
      case 'filterMove':
        return setIndex(i => Math.max(0, Math.min(options.length - 1, i + intent.step)))
      case 'filterPick':
        setHarness(options[index] ?? null)
        // A new filter is a new list; keeping the page would land on a window of it that has
        // nothing to do with where the reader was.
        setPage(0)
        setOpen(false)
        return
      case 'filterOpen':
        // Opens on whatever is currently selected, so `f` twice is a no-op rather than a reset.
        setIndex(Math.max(0, options.indexOf(harness)))
        setOpen(true)
        return
      case 'page':
        if (intent.step < 0) setPage(p => Math.max(0, p - 1))
        else setPage(p => Math.min(pages - 1, p + 1))
        return
      case 'screen':
        return goto(intent.screen)
    }
  }, { isActive: opts.isActive })

  return {
    screen,
    setScreen: goto,
    harness,
    filter: open ? { options, index } : null,
    capture: open,
    page,
  }
}
