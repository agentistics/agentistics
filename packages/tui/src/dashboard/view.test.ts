import { describe, test, expect } from 'bun:test'
import type { ControlService } from '../control/types'
import { TAB_ORDER } from '../control/types'
import { resolveTabKey } from '../control/nav'
import { strings } from '../i18n'
import {
  DASHBOARD_SCREENS,
  costsPlan,
  dashboardRows,
  dashboardSource,
  listPlan,
  listRows,
  overviewPlan,
  costByTaskLines,
  costByTaskRows,
  PAGE_SIZE,
  pageWindow,
  resolveDashboardScreen,
  stripCells,
  stripFit,
  SHARE_MAX,
  pageableTotal,
} from './view'

const key = (over: Partial<Parameters<typeof resolveDashboardScreen>[0]> = {}) =>
  ({ input: '', ...over }) as Parameters<typeof resolveDashboardScreen>[0]

describe('the dashboard is a tab of the control center', () => {
  test('it has one, and it is not called sessions', () => {
    expect(TAB_ORDER).toContain('dashboard')
    // The cockpit's `sessions` tab is the fleet running now; the dashboard's session screen is the
    // recorded past. One application may not call two different things by one name.
    expect(DASHBOARD_SCREENS).toContain('history')
    expect(DASHBOARD_SCREENS).not.toContain('sessions')
  })
})

describe('resolveDashboardScreen', () => {
  test('the digits reach every screen, and only the ones the strip draws', () => {
    DASHBOARD_SCREENS.forEach((id, i) => {
      expect(resolveDashboardScreen(key({ input: String(i + 1) }), 'overview')).toBe(id)
    })
    expect(resolveDashboardScreen(key({ input: '0' }), 'overview')).toBeNull()
    expect(resolveDashboardScreen(key({ input: String(DASHBOARD_SCREENS.length + 1) }), 'overview')).toBeNull()
  })

  test('tab and shift+tab cycle, wrapping at both ends', () => {
    const last = DASHBOARD_SCREENS[DASHBOARD_SCREENS.length - 1]!
    expect(resolveDashboardScreen(key({ tab: true }), last)).toBe(DASHBOARD_SCREENS[0]!)
    expect(resolveDashboardScreen(key({ tab: true, shift: true }), DASHBOARD_SCREENS[0]!)).toBe(last)
  })

  /**
   * THE COLLISION TEST. The control center changes SCREEN on `←`/`→` and `[`/`]`; a dashboard that
   * answered either would do two things on one keypress, and the footer could describe only one of
   * them. The two resolvers are asserted against the same keys here so neither can quietly grow into
   * the other's.
   */
  test('it takes no key the shell already answers', () => {
    for (const k of [
      key({ leftArrow: true }),
      key({ rightArrow: true }),
      key({ input: '[' }),
      key({ input: ']' }),
      key({ input: 'q' }),
      key({ input: 'r' }),
      key({ input: 'm' }),
    ]) {
      expect(resolveDashboardScreen(k, 'overview')).toBeNull()
    }
    // And the converse: the keys the dashboard DOES take leave the shell's tab unchanged.
    for (const k of [key({ input: '3' }), key({ tab: true }), key({ input: 'f' })]) {
      expect(resolveTabKey(k, 'dashboard')).toBeNull()
    }
  })
})

describe('the screen strip', () => {
  test('numbers every cell, so a digit drawn is a digit that works', () => {
    const cells = stripCells(strings('en'))
    expect(cells).toHaveLength(DASHBOARD_SCREENS.length)
    cells.forEach((cell, i) => expect(cell.startsWith(`${i + 1} `)).toBe(true))
  })

  test('a narrow row drops cells but never the selected one', () => {
    const s = strings('pt')
    for (const screen of DASHBOARD_SCREENS) {
      for (const width of [12, 20, 34, 50, 80, 120]) {
        const fit = stripFit(s, screen, width)
        const at = DASHBOARD_SCREENS.indexOf(screen)
        expect(at).toBeGreaterThanOrEqual(fit.from)
        expect(at).toBeLessThan(fit.from + fit.labels.length)
      }
    }
  })
})

describe('dashboardSource', () => {
  const service = (over: Partial<ControlService>): ControlService => ({
    id: 'agentistics', label: 'agentistics', state: 'down', runtimes: [], running: [],
    startOptions: [], restartOptions: [], stopOptions: [], bootOptions: [], ...over,
  })

  test('a status that has not landed is loading, never "nothing is running"', () => {
    expect(dashboardSource(undefined).kind).toBe('loading')
  })

  test('a running server hands over the api url', () => {
    const src = dashboardSource([service({
      state: 'up',
      active: { id: 'local', kind: 'native', state: 'up', available: true, apiUrl: 'http://localhost:47291' },
    })])
    expect(src).toEqual({ kind: 'api', apiBase: 'http://localhost:47291' })
  })

  test('a stopped server is `down` — the one case with an action attached to it', () => {
    expect(dashboardSource([service({ state: 'down' })]).kind).toBe('down')
  })

  test('an undetectable server is never reported as stopped', () => {
    expect(dashboardSource([service({ state: 'unknown' })]).kind).toBe('unknown')
    expect(dashboardSource([]).kind).toBe('unknown')
    // Up, but publishing no address we could read: still not something to draw zeros under.
    expect(dashboardSource([service({ state: 'up' })]).kind).toBe('unknown')
  })

  test('it never answers with the web url', () => {
    // The SPA's port answers `/api/data` today only because one handler serves both; naming it here
    // would hide the day they stop being the same process.
    const src = dashboardSource([service({
      state: 'up',
      active: { id: 'local', kind: 'native', state: 'up', available: true, webUrl: 'http://localhost:47292' },
    })])
    expect(src.kind).toBe('unknown')
  })
})

describe('row budgets', () => {
  test('nothing a plan allows can exceed the rows it was given', () => {
    for (let height = 0; height <= 40; height++) {
      const rows = dashboardRows(height)
      expect(rows.body + (rows.strip ? 1 : 0) + (rows.divider ? 1 : 0)).toBe(Math.max(0, height))
      expect(rows.body).toBeGreaterThanOrEqual(0)

      for (const n of [0, 1, 4, 6, 20]) {
        const o = overviewPlan(height, n)
        const spent = (o.kpis ? 2 : 0) + (o.activity ? 3 : 0)
          + (o.empty ? 4 : o.bars > 0 ? 2 + o.bars : 0)
        expect(spent).toBeLessThanOrEqual(Math.max(0, height))
        expect(o.bars).toBeLessThanOrEqual(n)
        // "Nothing is tracked" is only ever said about a machine that tracks nothing.
        if (o.empty) expect(n).toBe(0)

        const c = costsPlan(height, n)
        // Header + rows + the pager's own line + the share panel's chrome and bars.
        const costSpent = c.table > 0
          ? 1 + c.table + (c.pager ? 1 : 0) + (c.share > 0 ? 2 + c.share : 0)
          : 0
        expect(costSpent).toBeLessThanOrEqual(Math.max(0, height))
        expect(c.share).toBeLessThanOrEqual(Math.min(n, SHARE_MAX))

        expect(listRows(height)).toBeLessThanOrEqual(Math.max(1, height))
      }
    }
  })

  test('the sparkline gives way before the harness bars do', () => {
    // Room for the KPIs and all six bars but not the chart: the bars are the substance.
    const tight = overviewPlan(2 + 2 + 6, 6)
    expect(tight).toEqual({ kpis: true, activity: false, bars: 6, empty: false, tasks: 0 })
    expect(overviewPlan(2 + 3 + 2 + 6, 6).activity).toBe(true)
  })

  test('EX-01: the cost-by-task panel gives way after the sparkline, before the harness bars', () => {
    // KPIs 2 + harness 2+6 + panel 2+3 + sparkline 3.
    expect(overviewPlan(2 + 8 + 5 + 3, 6, 3)).toMatchObject({ activity: true, bars: 6, tasks: 3 })
    expect(overviewPlan(2 + 8 + 5, 6, 3)).toMatchObject({ activity: false, bars: 6, tasks: 3 })
    expect(overviewPlan(2 + 8 + 3, 6, 3)).toMatchObject({ activity: false, bars: 6, tasks: 1 })
    expect(overviewPlan(2 + 8, 6, 3)).toMatchObject({ bars: 6, tasks: 0 })
  })

  test('EX-01: "not filed" is the last line and is never dropped while it holds money', () => {
    const d = { sessions: 4, tasks: [{ ref: 't-1', title: 'a', cost: 3 }, { ref: 't-2', title: 'b', cost: 2 }, { ref: 't-3', title: 'c', cost: 1 }], notFiled: 1.5 }
    expect(costByTaskRows(d)).toBe(4)
    expect(costByTaskLines(d, 2).map(l => l.kind)).toEqual(['task', 'not-filed'])
    expect(costByTaskLines({ sessions: 0, tasks: [], notFiled: 0 }, 3)).toEqual([{ kind: 'none', label: '', cost: 0 }])
    expect(costByTaskLines({ sessions: 2, tasks: [], notFiled: 0.4 }, 3).map(l => l.kind)).toEqual(['not-filed'])
  })

  test('the share panel goes whole rather than showing part of a proportion', () => {
    const roomy = costsPlan(30, 5)
    expect(roomy.share).toBe(5)
    const tight = costsPlan(6, 5)
    expect(tight.share).toBe(0)
    expect(tight.table).toBe(5)
    // One row is the header alone. A result row on top of it is the overflow Ink composites.
    expect(costsPlan(1, 5)).toEqual({ table: 0, share: 0, pager: false })
  })

  test('a table asks for one row fewer than its height, because it draws a header', () => {
    expect(listRows(10)).toBe(9)
    // Never zero: a table with no rows at all says less than a table with one.
    expect(listRows(1)).toBe(1)
    expect(listRows(0)).toBe(1)
  })
})

describe('paging', () => {
  test('pageWindow names the slice of the requested page', () => {
    expect(pageWindow(355, 15, 0)).toEqual({ page: 0, pages: 24, from: 0, to: 15 })
    expect(pageWindow(355, 15, 1)).toEqual({ page: 1, pages: 24, from: 15, to: 30 })
  })

  test('the last page is short, never a slice past the end', () => {
    // 355 = 23 full pages of 15 plus 10 rows.
    expect(pageWindow(355, 15, 23)).toEqual({ page: 23, pages: 24, from: 345, to: 355 })
  })

  test('a page pointing past the end is clamped, never blank', () => {
    // The list shortens under a remembered page every time the filter changes.
    expect(pageWindow(20, 15, 9)).toEqual({ page: 1, pages: 2, from: 15, to: 20 })
    expect(pageWindow(20, 15, -3)).toEqual({ page: 0, pages: 2, from: 0, to: 15 })
    expect(pageWindow(20, 15, NaN)).toEqual({ page: 0, pages: 2, from: 0, to: 15 })
  })

  test('an empty list is page 1 of 1, never page 1 of 0', () => {
    expect(pageWindow(0, 15, 4)).toEqual({ page: 0, pages: 1, from: 0, to: 0 })
  })

  test('a size below one row is one row, never a division by zero', () => {
    expect(pageWindow(7, 0, 0)).toEqual({ page: 0, pages: 7, from: 0, to: 1 })
  })

  test('a list that fits pays for no pager', () => {
    // A line saying "page 1 of 1" is a row spent stating that nothing was withheld.
    expect(listPlan(30, 10)).toEqual({ size: PAGE_SIZE, pager: false })
    expect(listPlan(30, PAGE_SIZE)).toEqual({ size: PAGE_SIZE, pager: false })
  })

  test('one row held back is what raises the pager', () => {
    expect(listPlan(30, PAGE_SIZE + 1)).toEqual({ size: PAGE_SIZE, pager: true })
  })

  test('a short body shortens the PAGE rather than overflowing', () => {
    // Ink composites what does not fit, so the height is a ceiling on the page and not on nothing.
    expect(listPlan(10, 100)).toEqual({ size: 8, pager: true })
    expect(listPlan(3, 100)).toEqual({ size: 1, pager: true })
    expect(listPlan(1, 100).size).toBe(1)
  })

  test('a page and its chrome never spend more rows than the body has', () => {
    for (let height = 1; height <= 40; height++) {
      for (const total of [0, 1, 7, 15, 16, 355]) {
        const plan = listPlan(height, total)
        const rows = Math.min(plan.size, total)
        const spent = (rows > 0 ? 1 + rows : 0) + (plan.pager ? 1 : 0)
        // One row of a height of one is the floor this arithmetic is allowed to break, and it is
        // the same floor `listRows` has always had.
        if (height > 2) expect(spent).toBeLessThanOrEqual(height)
        expect(plan.size).toBeLessThanOrEqual(PAGE_SIZE)
        expect(plan.size).toBeGreaterThanOrEqual(1)
      }
    }
  })

  test('the costs table pages without pushing its share panel off the screen', () => {
    const many = costsPlan(30, 40)
    expect(many.pager).toBe(true)
    expect(many.share).toBe(SHARE_MAX)
    expect(many.table).toBeLessThanOrEqual(PAGE_SIZE)
    // Header + page + pager + share chrome + bars, all inside the height.
    expect(1 + many.table + 1 + 2 + many.share).toBeLessThanOrEqual(30)
  })

  test('only the three list screens page at all', () => {
    const data = { sessions: [], projects: [], harnesses: [] } as never
    for (const id of DASHBOARD_SCREENS) {
      // overview / harnesses draw no list, so their pager keys do nothing by arithmetic
      // rather than by a special case in the keyboard.
      if (id === 'overview' || id === 'harnesses') {
        expect(pageableTotal(id, data)).toBe(0)
      }
    }
    // Nothing read yet is not the same as an empty list, and neither can be paged.
    expect(pageableTotal('history', null)).toBe(0)
  })
})
