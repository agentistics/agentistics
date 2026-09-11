/**
 * A task belongs to a repository through its SESSIONS, and this pins that rule.
 *
 * The Repositories page keys everything on `normalizeGitRemote` and nothing else; `buildTaskList`'s
 * `repos` is that same key, read off the sessions' metas. The cases below are the ones that decide
 * whether the Repositories → Tasks tab lists the right rows: a task spanning two repositories, the
 * "no linked repository" bucket, and a row nobody could place.
 */

import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { buildTaskDetail, buildTaskList, reposOfRows, subtaskViews } from './task-report'
import type { Subtask, Task } from './task-model'
import type { ManagedSession } from './types'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', title: 'a delivery', status: 'in_progress',
  createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
  ...over,
})

const subtask = (over: Partial<Subtask> = {}): Subtask => ({
  id: 's1', taskId: 't1', title: 'a piece of work', done: false, status: 'todo',
  createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
  ...over,
})

const row = (over: Partial<ManagedSession> = {}): ManagedSession => ({
  id: 'r1', harness: 'claude', cwd: '/repo', createdAt: '2026-09-05T10:00:00.000Z',
  taskId: 't1', conversationId: 'c1',
  ...over,
} as ManagedSession)

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 'c1', project_path: '/repo', start_time: '2026-09-05T10:00:00.000Z',
  harness: 'claude', git_remote: 'github.com/org/repo',
  ...over,
} as SessionMeta)

const metasOf = (...ms: SessionMeta[]) =>
  new Map(ms.map(m => [m.session_id, m] as [string, SessionMeta]))

const listOf = (rows: ManagedSession[], metas: ReadonlyMap<string, SessionMeta>) =>
  buildTaskList({ tasks: [task()], attempts: [], rows, metas, costOf: () => 1 })

describe('reposOfRows', () => {
  it('names every repository the task touched, once, in first-seen order', () => {
    // A task spanning two repositories appears under BOTH — that is the point of keying on the
    // sessions rather than on one field.
    const repos = reposOfRows(
      [row({ id: 'r1', conversationId: 'c1' }), row({ id: 'r2', conversationId: 'c2' }),
        row({ id: 'r3', conversationId: 'c3' })],
      metasOf(
        meta({ session_id: 'c1', git_remote: 'github.com/org/a' }),
        meta({ session_id: 'c2', git_remote: 'github.com/org/b' }),
        meta({ session_id: 'c3', git_remote: 'github.com/org/a' }),
      ),
    )
    expect(repos).toEqual(['github.com/org/a', 'github.com/org/b'])
  })

  it('keeps the "no linked repository" bucket as a real value', () => {
    // `''` is the bucket the repositories page already shows, and `sessionInScope` matches it. A
    // session outside a repository is not a session with no session.
    const repos = reposOfRows([row()], metasOf(meta({ git_remote: undefined })))
    expect(repos).toEqual([''])
  })

  it('names nothing for a row whose conversation is not in the store', () => {
    // No link, no repository. A `cwd` is not the key this dimension is measured by, and guessing
    // one from it would file the task under a repository nothing observed.
    expect(reposOfRows([row({ conversationId: undefined })], metasOf(meta()))).toEqual([])
    expect(reposOfRows([row({ conversationId: 'gone' })], metasOf(meta()))).toEqual([])
  })
})

describe('buildTaskList repos', () => {
  it('carries the repositories beside the harnesses', () => {
    const [only] = listOf([row()], metasOf(meta()))
    expect(only!.repos).toEqual(['github.com/org/repo'])
    expect(only!.harnesses).toEqual(['claude'])
  })

  it('names no repository when the caller scoped every session out', () => {
    // The metas arrive already scoped, so a task with nothing inside the window names nothing —
    // which is what keeps a repository tab from listing work it has not seen in that window.
    const [only] = listOf([row()], metasOf())
    expect(only!.repos).toEqual([])
    expect(only!.rollup.sessionsUsed).toBe(1)
  })
})

describe('rollupSessionsFor', () => {
  const meta2 = (over: Partial<SessionMeta> = {}): SessionMeta => ({
    session_id: 'c1', project_path: '/repo', start_time: '2026-09-05T10:00:00.000Z',
    harness: 'claude', input_tokens: 100, output_tokens: 50,
    cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
    user_message_count: 3,
    ...over,
  } as SessionMeta)

  it('counts one CONVERSATION once, however many rows point at it', async () => {
    // Every reopen mints a new managedId for the same conversation. Measured on a live board: six
    // rows of one conversation made a delivery report five times its real cost.
    const { rollupSessionsFor } = await import('./task-report')
    const rows = ['r1', 'r2', 'r3'].map(id => row({ id, conversationId: 'c1' }))
    const out = rollupSessionsFor(rows, metasOf(meta2()), () => 7)
    expect(out).toHaveLength(1)
    expect(out[0]!.costUSD).toBe(7)
  })

  it('keeps every row that has no conversation to be a duplicate OF', async () => {
    const { rollupSessionsFor } = await import('./task-report')
    const rows = [
      row({ id: 'r1', conversationId: undefined }),
      row({ id: 'r2', conversationId: undefined }),
      row({ id: 'r3', conversationId: 'c1' }),
    ]
    const out = rollupSessionsFor(rows, metasOf(meta2()), () => 1)
    expect(out).toHaveLength(3)
    // The two unlinked ones contribute nothing, which is what `sessionsLinked` is for.
    expect(out.filter(s => s.meta !== null)).toHaveLength(1)
  })

  it('keeps distinct conversations apart', async () => {
    const { rollupSessionsFor } = await import('./task-report')
    const rows = [row({ id: 'r1', conversationId: 'c1' }), row({ id: 'r2', conversationId: 'c2' })]
    const out = rollupSessionsFor(rows, metasOf(meta2(), meta2({ session_id: 'c2' })), () => 3)
    expect(out).toHaveLength(2)
  })
})

describe('distinctConversations', () => {
  it('is the rule every surface that walks a task\'s rows must share', async () => {
    // `task-overview.ts` accumulates its own totals rather than going through the rollup, so the
    // headline counted a reopened conversation once per reopening while the delivery under it was
    // right. Measured on a live board: 13.110.140.051 tokens over deliveries summing 2.493.697.631.
    const { distinctConversations } = await import('./task-report')
    const rows = [
      row({ id: 'r1', conversationId: 'c1' }),
      row({ id: 'r2', conversationId: 'c1' }),
      row({ id: 'r3', conversationId: 'c2' }),
      row({ id: 'r4', conversationId: undefined }),
      row({ id: 'r5', conversationId: undefined }),
    ]
    expect(distinctConversations(rows).map(r => r.id)).toEqual(['r1', 'r3', 'r4', 'r5'])
  })
})

/**
 * THE LIST MUST COUNT A CONVERSATION ONCE, exactly as the ROLLUP beside it already does.
 *
 * `rollupSessionsFor` was taught this on 2026-09-08, after the "ALM board" delivery reported
 * 13.072.988.605 tokens and $7.477,50 against a true 2.456.546.185 and $1.402,92 — five times over
 * on the headline figure of the whole feature. The fix went into the numbers and NOT into the list
 * beside them, which kept mapping over every registry row.
 *
 * Reported with a screenshot on 2026-09-09: a delivery whose rollup correctly said `2 sessions`
 * drew FIVE rows under its "Sessions" tab — one conversation repeated four times, each row carrying
 * that conversation's full R$384,89, three marked `finished` and one `working`. That is the exact
 * signature of the retired predecessors every attach/reopen/restart mints, and the same cost read
 * four times is the most expensive thing this screen can say wrongly, because reading cost is what
 * the screen is for.
 */
describe('buildTaskDetail — one row per conversation', () => {
  const detailOf = (rows: ManagedSession[]) =>
    buildTaskDetail({
      task: task(), attempts: [], rows, metas: metasOf(meta()), costOf: () => 1,
      comments: [], subtasks: [], files: [],
    })

  it('collapses the reopenings of ONE conversation into one row', () => {
    const detail = detailOf([
      row({ id: 'r1', conversationId: 'c1', endedAt: '2026-09-05T11:00:00.000Z' }),
      row({ id: 'r2', conversationId: 'c1', endedAt: '2026-09-05T12:00:00.000Z' }),
      row({ id: 'r3', conversationId: 'c1' }),
    ])
    expect(detail.sessions.length).toBe(1)
    // FIRST-SEEN order, the same rule `distinctConversations` states for every other surface.
    expect(detail.sessions[0]!.id).toBe('r1')
  })

  it('agrees with the rollup drawn beside it', () => {
    const rows = [
      row({ id: 'r1', conversationId: 'c1' }),
      row({ id: 'r2', conversationId: 'c1' }),
    ]
    const detail = detailOf(rows)
    // The tab's own count is `sessions.length`, so a list that disagrees with the rollup makes the
    // TAB LABEL lie too — "Sessions 5" over a delivery that used two.
    expect(detail.sessions.length).toBe(detail.rollup.sessionsUsed)
  })

  it('keeps DISTINCT conversations apart', () => {
    const detail = detailOf([
      row({ id: 'r1', conversationId: 'c1' }),
      row({ id: 'r2', conversationId: 'c2' }),
    ])
    expect(detail.sessions.map(s => s.id)).toEqual(['r1', 'r2'])
  })

  it('keeps every row that carries NO conversation link', () => {
    // It cannot be shown to be a duplicate of anything, and it contributes no numbers anyway —
    // the same rule `usage-dedupe.ts` applies to a usage record with no message id.
    const detail = detailOf([
      row({ id: 'r1', conversationId: undefined }),
      row({ id: 'r2', conversationId: undefined }),
    ])
    expect(detail.sessions.map(s => s.id)).toEqual(['r1', 'r2'])
  })
})

/**
 * `subtaskViews` — a rollup per subtask, plus one `id: null` bucket for sessions filed directly on
 * the delivery. See docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.2.
 *
 * `rowsOfTask` never conditioned on `subtaskId`, so `TaskDetail.rollup` already summed both
 * branches before this existed — these tests pin that the BREAKDOWN partitions the exact same rows
 * exactly once each, across all three shapes the diagrams describe, rather than merely agreeing on
 * a total two different bugs could still add up to.
 */
describe('subtaskViews — the three shapes, no session counted twice', () => {
  // Distinct, deliberately non-round costs per conversation, so a duplication (double-counted row)
  // or a drop (missing row) both move the sum away from the expected total instead of an accident
  // of the numbers used cancelling it out.
  const costs: Record<string, number> = { c1: 5, c2: 3, c3: 2, c4: 7, c5: 11 }
  const costOf = (m: SessionMeta) => costs[m.session_id] ?? 0
  const metasAll = metasOf(...Object.keys(costs).map(id => meta({ session_id: id })))

  const detailOf = (rows: ManagedSession[], subtasks: Subtask[] = []) =>
    buildTaskDetail({
      task: task(), attempts: [], rows, metas: metasAll, costOf,
      comments: [], subtasks, files: [],
    })

  it('shape #1 — two direct sessions, no subtasks: exactly one id:null bucket, equal to the total', () => {
    const detail = detailOf([
      row({ id: 'r1', conversationId: 'c1' }),
      row({ id: 'r2', conversationId: 'c2' }),
    ])
    expect(detail.subtaskRollups).toHaveLength(1)
    expect(detail.subtaskRollups[0]!.id).toBeNull()
    // The whole rollup IS the direct bucket's rollup here — nothing else could have contributed.
    expect(detail.subtaskRollups[0]!.rollup).toEqual(detail.rollup)
    expect(detail.rollup.sessionsUsed).toBe(2)
    expect(detail.rollup.costUSD).toBe(8)
  })

  it('shape #2 — three subtasks, each with a session, no direct ones: three buckets, no id:null', () => {
    const subs = [subtask({ id: 's1' }), subtask({ id: 's2' }), subtask({ id: 's3' })]
    const rows = [
      row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
      row({ id: 'r2', conversationId: 'c2', subtaskId: 's2' }),
      row({ id: 'r3', conversationId: 'c3', subtaskId: 's3' }),
    ]
    const detail = detailOf(rows, subs)

    expect(detail.subtaskRollups).toHaveLength(3)
    expect(detail.subtaskRollups.map(v => v.id)).toEqual(['s1', 's2', 's3'])
    expect(detail.subtaskRollups.some(v => v.id === null)).toBe(false)

    // Each subtask's bucket carries exactly its own session — not zero, not more than one.
    for (const v of detail.subtaskRollups) expect(v.rollup.sessionsUsed).toBe(1)

    // The partition sums back to the task's own total, computed independently over ALL the rows —
    // never by re-adding the partitions to derive the total (that would let a duplication that
    // cancels out in the sum pass silently; checking counts per bucket rules that out here too).
    const sumSessions = detail.subtaskRollups.reduce((a, v) => a + v.rollup.sessionsUsed, 0)
    const sumCost = detail.subtaskRollups.reduce((a, v) => a + (v.rollup.costUSD ?? 0), 0)
    expect(sumSessions).toBe(detail.rollup.sessionsUsed)
    expect(detail.rollup.costUSD).toBe(sumCost)
    expect(detail.rollup.costUSD).toBe(10) // 5 + 3 + 2
  })

  it('shape #3 — two direct + three subtasks with sessions: four buckets, union == the total, no overlap', () => {
    const subs = [subtask({ id: 's1' }), subtask({ id: 's2' }), subtask({ id: 's3' })]
    const rows = [
      row({ id: 'r1', conversationId: 'c1' }), // direct
      row({ id: 'r2', conversationId: 'c2' }), // direct
      row({ id: 'r3', conversationId: 'c3', subtaskId: 's1' }),
      row({ id: 'r4', conversationId: 'c4', subtaskId: 's2' }),
      row({ id: 'r5', conversationId: 'c5', subtaskId: 's3' }),
    ]
    const detail = detailOf(rows, subs)

    expect(detail.subtaskRollups).toHaveLength(4)
    const byId = new Map(detail.subtaskRollups.map(v => [v.id, v]))
    expect([...byId.keys()].sort()).toEqual([null, 's1', 's2', 's3'].sort())

    // The direct bucket holds exactly the two direct rows — never the subtask ones, never zero.
    expect(byId.get(null)!.rollup.sessionsUsed).toBe(2)
    expect(byId.get(null)!.rollup.costUSD).toBe(8) // c1 + c2

    // Each subtask bucket holds exactly its own row.
    expect(byId.get('s1')!.rollup.sessionsUsed).toBe(1)
    expect(byId.get('s1')!.rollup.costUSD).toBe(2) // c3
    expect(byId.get('s2')!.rollup.sessionsUsed).toBe(1)
    expect(byId.get('s2')!.rollup.costUSD).toBe(7) // c4
    expect(byId.get('s3')!.rollup.sessionsUsed).toBe(1)
    expect(byId.get('s3')!.rollup.costUSD).toBe(11) // c5

    // No session counted in two buckets: the sum of per-bucket counts equals the total exactly —
    // if a row leaked into two buckets this would read 6, not 5.
    const sumSessions = [...byId.values()].reduce((a, v) => a + v.rollup.sessionsUsed, 0)
    expect(sumSessions).toBe(5)
    expect(sumSessions).toBe(detail.rollup.sessionsUsed)

    const sumCost = [...byId.values()].reduce((a, v) => a + (v.rollup.costUSD ?? 0), 0)
    expect(detail.rollup.costUSD).toBe(sumCost)
    expect(detail.rollup.costUSD).toBe(28) // 5+3+2+7+11
  })

  it('gives a subtask with no sessions filed yet its own honest, empty bucket', () => {
    // "Nothing filed here yet" is not a zero pretending to be a measurement — sessionsUsed is a
    // real 0 (nothing IS filed), while cost/tokens/rounds stay null (nothing was MEASURED).
    const subs = [subtask({ id: 's1' }), subtask({ id: 's2' })]
    const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' })]
    const detail = detailOf(rows, subs)

    expect(detail.subtaskRollups).toHaveLength(2)
    const empty = detail.subtaskRollups.find(v => v.id === 's2')!
    expect(empty.rollup.sessionsUsed).toBe(0)
    expect(empty.rollup.sessionsLinked).toBe(0)
    expect(empty.rollup.costUSD).toBeNull()
    expect(empty.rollup.tokens).toBeNull()
    expect(empty.rollup.rounds).toBeNull()
  })

  it('is callable directly, on an already-scoped row set, matching attemptViews\'s own shape', () => {
    // The exported function itself, not only through buildTaskDetail — it is meant to be composed
    // the same way `attemptViews` is.
    const subs = [subtask({ id: 's1' })]
    const rows = [
      row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
      row({ id: 'r2', conversationId: 'c2' }),
    ]
    const views = subtaskViews(task(), subs, rows, metasAll, costOf)
    expect(views).toHaveLength(2)
    expect(views[0]).toEqual({ id: 's1', rollup: expect.objectContaining({ sessionsUsed: 1 }) })
    expect(views[1]!.id).toBeNull()
  })

  describe('grouped subtasks — one bucket per group, never per member', () => {
    // docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §B.3: two or more subtasks
    // sharing a `groupId` must collapse into ONE SubtaskView, keyed by the group id, whose rollup
    // is the union of rows filed under ANY member — never one bucket per member, which would
    // multiply a shared session's cost by the group's size.

    it('two subtasks sharing a groupId collapse into one bucket, summing sessions filed under either member exactly once', () => {
      const subs = [
        subtask({ id: 's1', groupId: 'g1' }),
        subtask({ id: 's2', groupId: 'g1' }),
      ]
      const rows = [
        row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's2' }),
      ]
      const views = subtaskViews(task(), subs, rows, metasAll, costOf)

      // ONE view for the group, never two.
      expect(views).toHaveLength(1)
      expect(views[0]!.id).toBe('g1')
      // Both sessions counted, once each — not doubled by appearing under two subtasks' totals.
      expect(views[0]!.rollup.sessionsUsed).toBe(2)
      expect(views[0]!.rollup.costUSD).toBe(8) // c1 (5) + c2 (3), summed once

      // Same session set read through buildTaskDetail agrees with the task's own total — the
      // group's bucket is a breakdown of the total, never a second, inflated sum beside it.
      const detail = detailOf(rows, subs)
      expect(detail.subtaskRollups).toHaveLength(1)
      expect(detail.rollup.costUSD).toBe(8)
    })

    it('a session filed under either group member is counted in the SAME bucket, not duplicated across it', () => {
      const subs = [
        subtask({ id: 's1', groupId: 'g1' }),
        subtask({ id: 's2', groupId: 'g1' }),
        subtask({ id: 's3', groupId: 'g1' }),
      ]
      const rows = [
        row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's1' }), // second session, same member
        row({ id: 'r3', conversationId: 'c3', subtaskId: 's3' }), // a different member
      ]
      const detail = detailOf(rows, subs)

      expect(detail.subtaskRollups).toHaveLength(1)
      expect(detail.subtaskRollups[0]!.id).toBe('g1')
      expect(detail.subtaskRollups[0]!.rollup.sessionsUsed).toBe(3)
      // The group's total matches the task's own total exactly — no inflation from the group
      // spanning three members while only two of them carry a session.
      expect(detail.subtaskRollups[0]!.rollup.costUSD).toBe(detail.rollup.costUSD)
      expect(detail.rollup.costUSD).toBe(10) // c1 (5) + c2 (3) + c3 (2)
    })

    it('subtasks with no groupId keep exactly today\'s behaviour — one bucket each, unaffected by a grouped sibling', () => {
      const subs = [
        subtask({ id: 's1' }), // ungrouped
        subtask({ id: 's2' }), // ungrouped
        subtask({ id: 's3', groupId: 'g1' }),
        subtask({ id: 's4', groupId: 'g1' }),
      ]
      const rows = [
        row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's2' }),
        row({ id: 'r3', conversationId: 'c3', subtaskId: 's3' }),
        row({ id: 'r4', conversationId: 'c4', subtaskId: 's4' }),
      ]
      const views = subtaskViews(task(), subs, rows, metasAll, costOf)

      // Four subtasks, but only three buckets: s1 and s2 stay independent (a group of one each),
      // s3+s4 collapse into a single 'g1' bucket.
      expect(views).toHaveLength(3)
      const byId = new Map(views.map(v => [v.id, v]))
      expect([...byId.keys()].sort()).toEqual(['g1', 's1', 's2'].sort())

      expect(byId.get('s1')!.rollup.sessionsUsed).toBe(1)
      expect(byId.get('s1')!.rollup.costUSD).toBe(5) // c1
      expect(byId.get('s2')!.rollup.sessionsUsed).toBe(1)
      expect(byId.get('s2')!.rollup.costUSD).toBe(3) // c2
      expect(byId.get('g1')!.rollup.sessionsUsed).toBe(2)
      expect(byId.get('g1')!.rollup.costUSD).toBe(9) // c3 (2) + c4 (7)
    })

    it('a grouped subtask with no sessions of its own still contributes zero, not a missing bucket, when a sibling has sessions', () => {
      // The group as a whole is measured, not each member separately — a member with nothing
      // filed under it directly must not create a second, empty view beside the group's own.
      const subs = [
        subtask({ id: 's1', groupId: 'g1' }),
        subtask({ id: 's2', groupId: 'g1' }),
      ]
      const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' })]
      const views = subtaskViews(task(), subs, rows, metasAll, costOf)

      expect(views).toHaveLength(1)
      expect(views[0]!.id).toBe('g1')
      expect(views[0]!.rollup.sessionsUsed).toBe(1)
      expect(views[0]!.rollup.costUSD).toBe(5)
    })
  })
})
