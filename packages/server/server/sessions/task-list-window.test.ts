import { describe, expect, test } from 'bun:test'
import { LIST_DETAIL_CLIP, RECENT_WINDOW_MS, clipDetails, listOptionsOf, recentRows } from './task-list-window'
import type { TaskListRow } from './task-report'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const row = (id: string, status: string, ageMs: number, extra: Record<string, unknown> = {}): TaskListRow => ({
  task: { id, title: id, status, createdAt: iso(NOW - 99 * RECENT_WINDOW_MS), updatedAt: iso(NOW - ageMs), ...extra },
} as unknown as TaskListRow)

describe('recentRows (step one of the split load)', () => {
  const day = 24 * 3600_000
  const all = [
    row('old-open', 'in_progress', 40 * day),
    row('old-todo', 'todo', 90 * day),
    row('fresh-done', 'done', day),
    row('old-done', 'done', 10 * day),
    row('old-abandoned', 'abandoned', 30 * day),
    row('delivered-status-open', 'in_review', 5 * day, { deliveredAt: iso(NOW - 5 * day) }),
  ]
  test('keeps every open task whatever its age, and closed ones only inside two days', () => {
    expect(recentRows(all, NOW).map(r => r.task.id)).toEqual(['old-open', 'old-todo', 'fresh-done', 'delivered-status-open'])
  })
  test('keeps the server order, so the rest merges in as a supersequence', () => {
    const ids = recentRows(all, NOW).map(r => r.task.id)
    expect(ids.map(i => all.findIndex(r => r.task.id === i))).toEqual([0, 1, 2, 5])
  })
  test('a reopened task keeps its old deliveredAt and is still open, not history', () => {
    const reopened = row('re', 'in_progress', 60 * day, { deliveredAt: iso(NOW - 60 * day) })
    expect(recentRows([reopened], NOW)).toEqual([reopened])
  })
  test('an unparseable updatedAt on a closed task is not "recent"', () => {
    expect(recentRows([row('x', 'done', 0, { updatedAt: 'nope' })], NOW)).toEqual([])
  })
})

describe('clipDetails', () => {
  test('cuts long descriptions, flags them, and never mutates the source row', () => {
    const long = row('a', 'todo', 0, { detail: 'x'.repeat(LIST_DETAIL_CLIP + 50) })
    const [c] = clipDetails([long])
    expect(c!.task.detail!.length).toBe(LIST_DETAIL_CLIP)
    expect(c!.detailClipped).toBe(true)
    expect(long.task.detail!.length).toBe(LIST_DETAIL_CLIP + 50)
    expect((long as { detailClipped?: boolean }).detailClipped).toBeUndefined()
  })
  test('short or absent descriptions are the same object, unflagged', () => {
    const short = row('b', 'todo', 0, { detail: 'hi' })
    const none = row('c', 'todo', 0)
    const out = clipDetails([short, none])
    expect(out[0]).toBe(short)
    expect(out[1]).toBe(none)
  })
})

describe('listOptionsOf — the MCP and CLI read the whole text', () => {
  const opts = (q: string) => listOptionsOf(new URL(`http://x/api/tasks${q}`).searchParams)
  test('a plain call (what the MCP tool sends) is unclipped and whole', () => {
    expect(opts('')).toEqual({ clip: false, recent: false })
  })
  test('only the web list opts into clipping, and full=1 still wins', () => {
    expect(opts('?clip=1&recent=1')).toEqual({ clip: true, recent: true })
    expect(opts('?clip=1&full=1').clip).toBe(false)
  })
})
