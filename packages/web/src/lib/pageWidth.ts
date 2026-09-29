/**
 * pageWidth.ts — how wide a dashboard page's content may grow. PURE.
 *
 * Every non-workspace page sits in one centred container, and a flat 1400px cap left a 2240px
 * screen with ~400px of nothing on each side of the task board's table, while collapsing the aside
 * only moved that air around instead of giving it to the table (owner report, 2026-09-26).
 *
 * The TABLE pages — deliveries and repositories — are wider than any screen by nature and are
 * the ones that gain from the room, so they grow up to `WIDE_PAGE_MAX`. The container already
 * subtracts the aside's width, so collapsing it hands the freed width straight to the page. Every
 * other page keeps `PAGE_MAX`: a Home of stat cards and charts stretched to 1920px reads worse,
 * not better (owner decision, same day).
 */

export const PAGE_MAX = 1400
export const WIDE_PAGE_MAX = 1920

const WIDE_PREFIXES = ['/tasks', '/repositories', '/repo'] as const

export function isWidePage(pathname: string): boolean {
  return WIDE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

export function pageMaxWidth(pathname: string): number {
  return isWidePage(pathname) ? WIDE_PAGE_MAX : PAGE_MAX
}
