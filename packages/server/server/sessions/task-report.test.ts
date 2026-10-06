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
import {
  buildTaskDetail, buildTaskList, groupVisibility, reposOfRows, rollupSessionsFor, subtaskViews,
} from './task-report'
import type { Subtask, Task } from './task-model'
import type { ManagedSession } from './types'
import { nativeRows } from './task-native'
import type { NativeSessionLink } from './task-model'

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

  it('turns Copilot premium requests into the task credits rollup', () => {
    const meta = meta2({
      harness: 'copilot',
      model: 'gpt-5.6-luna',
      copilot_credits: { nanoAiu: 808713000, premiumRequests: 2 },
    })
    const out = rollupSessionsFor([row({ conversationId: 'c1', harness: 'copilot' })], metasOf(meta), () => 99)
    expect(out[0]).toMatchObject({ costUSD: null, credits: { nanoAiu: 808713000, premiumRequests: 2 } })
  })

  it('keeps distinct conversations apart', async () => {
    const { rollupSessionsFor } = await import('./task-report')
    const rows = [row({ id: 'r1', conversationId: 'c1' }), row({ id: 'r2', conversationId: 'c2' })]
    const out = rollupSessionsFor(rows, metasOf(meta2(), meta2({ session_id: 'c2' })), () => 3)
    expect(out).toHaveLength(2)
  })
})

describe('distinctConversations', () => {
  const at = (hh: number) => `2026-09-05T${String(hh).padStart(2, '0')}:00:00.000Z`

  it('is the rule every surface that walks a task\'s rows must share', async () => {
    // `task-overview.ts` accumulates its own totals rather than going through the rollup, so the
    // headline counted a reopened conversation once per reopening while the delivery under it was
    // right. Measured on a live board: 13.110.140.051 tokens over deliveries summing 2.493.697.631.
    const { distinctConversations } = await import('./task-report')
    const rows = [
      row({ id: 'r1', conversationId: 'c1', createdAt: at(10) }),
      row({ id: 'r2', conversationId: 'c1', createdAt: at(11) }),
      row({ id: 'r3', conversationId: 'c2', createdAt: at(10) }),
      row({ id: 'r4', conversationId: undefined }),
      row({ id: 'r5', conversationId: undefined }),
    ]
    // ONE row per conversation — the NEWEST of them (r2), in the FIRST-SEEN slot of the conversation.
    expect(distinctConversations(rows).map(r => r.id)).toEqual(['r2', 'r3', 'r4', 'r5'])
  })

  it('picks the newest row by createdAt, whatever order the registry lists them in', async () => {
    const { distinctConversations } = await import('./task-report')
    const oldest = row({ id: 'old', conversationId: 'c1', createdAt: at(9) })
    const middle = row({ id: 'mid', conversationId: 'c1', createdAt: at(10) })
    const newest = row({ id: 'new', conversationId: 'c1', createdAt: at(11) })
    for (const order of [[oldest, middle, newest], [newest, middle, oldest], [middle, newest, oldest]]) {
      expect(distinctConversations(order).map(r => r.id)).toEqual(['new'])
    }
  })

  it('keeps the order in which the conversations were FIRST seen, so a list does not reshuffle', async () => {
    const { distinctConversations } = await import('./task-report')
    const out = distinctConversations([
      row({ id: 'a1', conversationId: 'ca', createdAt: at(9) }),
      row({ id: 'b1', conversationId: 'cb', createdAt: at(9) }),
      row({ id: 'a2', conversationId: 'ca', createdAt: at(12) }), // reopened last, but `ca` was first
    ])
    expect(out.map(r => r.id)).toEqual(['a2', 'b1'])
  })

  it('falls back to REGISTRY ORDER (the later row is the newer) when the stamps tie or cannot be read', async () => {
    const { distinctConversations } = await import('./task-report')
    // Tie.
    expect(distinctConversations([
      row({ id: 'x1', conversationId: 'c1', createdAt: at(10) }),
      row({ id: 'x2', conversationId: 'c1', createdAt: at(10) }),
    ]).map(r => r.id)).toEqual(['x2'])
    // A missing / garbage stamp is not evidence that a row is old — on either side.
    expect(distinctConversations([
      row({ id: 'y1', conversationId: 'c1', createdAt: at(10) }),
      row({ id: 'y2', conversationId: 'c1', createdAt: '' }),
    ]).map(r => r.id)).toEqual(['y2'])
    expect(distinctConversations([
      row({ id: 'z1', conversationId: 'c1', createdAt: 'not a date' }),
      row({ id: 'z2', conversationId: 'c1', createdAt: at(10) }),
    ]).map(r => r.id)).toEqual(['z2'])
  })

  it('only ever chooses among the candidates it is GIVEN', async () => {
    // The caller decides the scope: handed one task's rows, the newest row OF THAT TASK stands for
    // the conversation, however new a row filed elsewhere may be.
    const { distinctConversations } = await import('./task-report')
    const mine = [
      row({ id: 'm1', conversationId: 'c1', taskId: 't1', createdAt: at(9) }),
      row({ id: 'm2', conversationId: 'c1', taskId: 't1', createdAt: at(10) }),
    ]
    const elsewhere = row({ id: 'e1', conversationId: 'c1', taskId: 't2', createdAt: at(12) })
    expect(distinctConversations(mine).map(r => r.id)).toEqual(['m2'])
    expect(distinctConversations([...mine, elsewhere]).map(r => r.id)).toEqual(['e1'])
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
      row({ id: 'r1', conversationId: 'c1', createdAt: '2026-09-05T10:00:00.000Z', endedAt: '2026-09-05T11:00:00.000Z' }),
      row({ id: 'r2', conversationId: 'c1', createdAt: '2026-09-05T11:30:00.000Z', endedAt: '2026-09-05T12:00:00.000Z' }),
      row({ id: 'r3', conversationId: 'c1', createdAt: '2026-09-05T13:00:00.000Z' }),
    ])
    expect(detail.sessions.length).toBe(1)
    // The NEWEST row stands for the conversation — the rule `distinctConversations` states for every
    // other surface, because it carries the current filing and the current liveness.
    expect(detail.sessions[0]!.id).toBe('r3')
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
    expect(views[0]).toEqual({
      id: 's1', rollup: expect.objectContaining({ sessionsUsed: 1 }), stats: expect.anything(), times: expect.anything(),
    })
    expect(views[1]!.id).toBeNull()
  })

  describe('subtask groups — a hierarchy level, never a shared bucket (§F)', () => {
    // docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §F SUPERSEDES §B.2–§B.5: a group
    // is a real hierarchy level (`Subtask.isGroup`), not a label two subtasks share. A MEMBER
    // (`Subtask.parentGroupId` set) can never hold a session of its own (refused at filing time,
    // `subtask_in_group` — `task-attach.ts`), so it gets NO bucket of its own at all — not an
    // always-empty one — and a group's own bucket is the sessions filed DIRECTLY on the group's own
    // id, never a union of its members' (there is nothing to union: a member is never the target of
    // a filing to begin with).

    it("a group's own bucket is the sessions filed directly on the GROUP's own id", () => {
      const subs = [
        subtask({ id: 'g1', isGroup: true }),
        subtask({ id: 's1', parentGroupId: 'g1' }),
        subtask({ id: 's2', parentGroupId: 'g1' }),
      ]
      const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 'g1' })]
      const views = subtaskViews(task(), subs, rows, metasAll, costOf)

      expect(views).toHaveLength(1)
      expect(views[0]!.id).toBe('g1')
      expect(views[0]!.rollup.sessionsUsed).toBe(1)
      expect(views[0]!.rollup.costUSD).toBe(5) // c1
    })

    it('a group MEMBER gets NO bucket of its own at all — not an always-empty one', () => {
      const subs = [
        subtask({ id: 'g1', isGroup: true }),
        subtask({ id: 's1', parentGroupId: 'g1' }),
      ]
      const views = subtaskViews(task(), subs, [], metasAll, costOf)

      // Only the group appears — the member is absent entirely, never present with a zeroed rollup.
      expect(views).toHaveLength(1)
      expect(views[0]!.id).toBe('g1')
      expect(views.some(v => v.id === 's1')).toBe(false)
    })

    it('a stray row filed under a member (which the write path refuses) is not folded into the group bucket either — `subtaskViews` reads only rows filed on the GROUP\'s own id', () => {
      const subs = [
        subtask({ id: 'g1', isGroup: true }),
        subtask({ id: 's1', parentGroupId: 'g1' }),
      ]
      const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' })]
      const views = subtaskViews(task(), subs, rows, metasAll, costOf)

      expect(views).toHaveLength(1)
      expect(views[0]!.id).toBe('g1')
      expect(views[0]!.rollup.sessionsUsed).toBe(0)
    })

    it('a loose subtask (no isGroup, no parentGroupId) is completely unaffected, beside a group', () => {
      const subs = [
        subtask({ id: 's1' }), // loose
        subtask({ id: 'g1', isGroup: true }),
        subtask({ id: 's2', parentGroupId: 'g1' }),
      ]
      const rows = [
        row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
        row({ id: 'r2', conversationId: 'c2', subtaskId: 'g1' }),
      ]
      const detail = detailOf(rows, subs)

      expect(detail.subtaskRollups).toHaveLength(2)
      const byId = new Map(detail.subtaskRollups.map(v => [v.id, v]))
      expect([...byId.keys()].sort()).toEqual(['g1', 's1'].sort())
      expect(byId.get('s1')!.rollup.sessionsUsed).toBe(1)
      expect(byId.get('s1')!.rollup.costUSD).toBe(5) // c1
      expect(byId.get('g1')!.rollup.sessionsUsed).toBe(1)
      expect(byId.get('g1')!.rollup.costUSD).toBe(3) // c2
      // The task's own total still closes over everything, unaffected by the member's exclusion.
      expect(detail.rollup.costUSD).toBe(8)
    })

    it("a group's own progress is computed from its MEMBERS' status, round DOWN, and is absent for a loose subtask", () => {
      const subs = [
        subtask({ id: 'g1', isGroup: true }),
        subtask({ id: 'm1', parentGroupId: 'g1', status: 'done', done: true }),
        subtask({ id: 'm2', parentGroupId: 'g1', status: 'todo', done: false }),
        subtask({ id: 'm3', parentGroupId: 'g1', status: 'todo', done: false }),
        subtask({ id: 's1' }), // loose, unaffected
      ]
      const views = subtaskViews(task(), subs, [], metasAll, costOf)
      const group = views.find(v => v.id === 'g1')!
      const loose = views.find(v => v.id === 's1')!

      expect(group.groupProgress).toMatchObject({ done: 1, total: 3, counts: { done: 1, todo: 2 }, percent: 33, complete: false })
      expect(loose.groupProgress).toBeUndefined()
    })

    it('a group with no members yet draws no progress bar — "nobody joined it" is not 0%', () => {
      const subs = [subtask({ id: 'g1', isGroup: true })]
      const views = subtaskViews(task(), subs, [], metasAll, costOf)
      expect(views[0]!.groupProgress).toMatchObject({ done: 0, total: 0, counts: {}, percent: null, complete: false })
    })
  })

  describe('groupVisibility — downward-only from where a session is filed (§F.2)', () => {
    it('a group reveals itself and every one of its members', () => {
      const subs = [
        subtask({ id: 'g1', isGroup: true }),
        subtask({ id: 's1', parentGroupId: 'g1' }),
        subtask({ id: 's2', parentGroupId: 'g1' }),
        subtask({ id: 's3' }), // a loose sibling — never visible from the group
      ]
      expect([...groupVisibility('g1', subs)].sort()).toEqual(['g1', 's1', 's2'].sort())
    })

    it('names nothing for an id that is not an actual group', () => {
      const subs = [subtask({ id: 's1' })] // a loose subtask, not a group
      expect(groupVisibility('s1', subs)).toEqual([])
      expect(groupVisibility('nope', subs)).toEqual([])
    })

    it('a group with no members yet reveals only itself', () => {
      const subs = [subtask({ id: 'g1', isGroup: true })]
      expect(groupVisibility('g1', subs)).toEqual(['g1'])
    })
  })

  /**
   * `SubtaskView.stats` — the same evidence numbers `TaskDetail.stats` carries for the whole
   * delivery, re-partitioned per bucket. See §C.5 of
   * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md and `scopedTaskStats`'s own doc
   * comment in `task-stats.ts`.
   */
  describe('subtaskViews — stats, the same partition applied to the evidence numbers', () => {
    const statsMeta = (id: string, over: Partial<SessionMeta> = {}) =>
      meta({ session_id: id, files_modified: 0, lines_added: 0, lines_removed: 0, git_commits: 0, ...over })

    it('a bucket with no rows filed under it gets stats: null, never an all-null block', () => {
      const subs = [subtask({ id: 's1' }), subtask({ id: 's2' })]
      const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' })]
      const views = subtaskViews(task(), subs, rows, metasAll, costOf)
      expect(views.find(v => v.id === 's2')!.stats).toBeNull()
      expect(views.find(v => v.id === 's1')!.stats).not.toBeNull()
    })

    it('each subtask bucket carries only its own rows\' evidence numbers, never the whole task\'s', () => {
      const subs = [subtask({ id: 's1' }), subtask({ id: 's2' })]
      const rows = [
        row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's2' }),
      ]
      const metas = metasOf(
        statsMeta('c1', { files_modified: 3, lines_added: 20, lines_removed: 5, git_commits: 1 }),
        statsMeta('c2', { files_modified: 99, lines_added: 999, lines_removed: 999, git_commits: 9 }),
      )
      const views = subtaskViews(task(), subs, rows, metas, costOf)
      expect(views.find(v => v.id === 's1')!.stats!.filesModified).toBe(3)
      expect(views.find(v => v.id === 's2')!.stats!.filesModified).toBe(99)
    })

    it('the direct branch\'s stats block covers only the rows filed on the delivery itself', () => {
      const subs = [subtask({ id: 's1' })]
      const rows = [
        row({ id: 'r1', conversationId: 'c1' }), // direct
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's1' }),
      ]
      const metas = metasOf(
        statsMeta('c1', { files_modified: 3 }),
        statsMeta('c2', { files_modified: 99 }),
      )
      const views = subtaskViews(task(), subs, rows, metas, costOf)
      expect(views.find(v => v.id === null)!.stats!.filesModified).toBe(3)
    })

    it('a legacy `groupId` no longer buckets anything — §F supersedes §B, so two subtasks that still carry the same `groupId` get their OWN separate stats blocks, never a merged one', () => {
      // §B's shared-bucket model keyed on `groupId`; §F replaces it with `isGroup`/`parentGroupId`
      // and `subtaskViews` no longer reads `groupId` at all (see the field's own doc comment in
      // `task-model.ts`). `groupId` is kept only as an inert, still-writable column for the
      // already-shipped §B-era UI to keep compiling — it must never resurrect the old union-of-
      // members behaviour here.
      const subs = [
        subtask({ id: 's1', groupId: 'g1' }),
        subtask({ id: 's2', groupId: 'g1' }),
      ]
      const rows = [
        row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's2' }),
      ]
      const metas = metasOf(
        statsMeta('c1', { files_modified: 3, lines_added: 20, lines_removed: 5, git_commits: 1 }),
        statsMeta('c2', { files_modified: 7, lines_added: 4, lines_removed: 1, git_commits: 2 }),
      )
      const views = subtaskViews(task(), subs, rows, metas, costOf)
      expect(views).toHaveLength(2)
      expect(views.find(v => v.id === 's1')!.stats!.filesModified).toBe(3)
      expect(views.find(v => v.id === 's2')!.stats!.filesModified).toBe(7)
    })

    it('the whole task\'s stats equal the sum of every bucket\'s (subtasks + the direct branch)', () => {
      const subs = [subtask({ id: 's1' }), subtask({ id: 's2' })]
      const rows = [
        row({ id: 'r1', conversationId: 'c1' }), // direct
        row({ id: 'r2', conversationId: 'c2', subtaskId: 's1' }),
        row({ id: 'r3', conversationId: 'c3', subtaskId: 's2' }),
      ]
      const metas = metasOf(
        statsMeta('c1', { files_modified: 5 }),
        statsMeta('c2', { files_modified: 7 }),
        statsMeta('c3', { files_modified: 11 }),
      )
      const detail = buildTaskDetail({
        task: task(), attempts: [], rows, metas, costOf, comments: [], subtasks: subs, files: [],
      })
      const sum = detail.subtaskRollups.reduce((a, v) => a + (v.stats?.filesModified ?? 0), 0)
      expect(sum).toBe(23) // 5 + 7 + 11
      expect(detail.stats.filesModified).toBe(23)
    })
  })
})

/**
 * THE CONVERSATION IS DESCRIBED BY ITS NEWEST ROW, AND BUCKETED BY ITS CURRENT FILING.
 *
 * Measured on the live board (task "Pelvie - novas alterações", 2026-09-21): ONE coordinator
 * conversation reopened twelve times, three of those rows in the task — the oldest filed on the
 * task directly and ended, a middle one filed on subtask s-b7c40d02cc and ended, and the newest,
 * RUNNING, filed on subtask s-6474c0f53b (the last of three filings a peer made; a filing is a MOVE).
 * `distinctConversations` kept the FIRST row, so the detail listed only the oldest one: the running
 * session was absent from `sessions` and its cost sat under the original task-level filing while
 * `subtaskRollups` never saw the subtask it was filed on. The COUNT was right; the DESCRIPTION was
 * of the wrong row.
 */
describe('buildTaskDetail — a moved conversation is where it was filed LAST', () => {
  const costs: Record<string, number> = { coord: 10, other: 5 }
  const costOf = (m: SessionMeta) => costs[m.session_id] ?? 0
  const metas = metasOf(
    meta({
      session_id: 'coord', files_modified: 7, lines_added: 30, git_commits: 2,
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      user_message_count: 9,
    }),
    meta({
      session_id: 'other', files_modified: 1,
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      user_message_count: 2,
    }),
  )
  const subs = [
    subtask({ id: 's-b7' }), subtask({ id: 's-64' }), subtask({ id: 's-other' }),
  ]

  // The registry appends, so this is oldest-first — exactly the order that used to pick the WRONG row.
  const registry = (): ManagedSession[] => [
    row({ id: 'old', conversationId: 'coord', createdAt: '2026-09-10T10:00:00.000Z',
      endedAt: '2026-09-11T10:00:00.000Z' }), // filed on the task itself
    // Rows of the SAME conversation filed on a DIFFERENT task never reach this task's rows.
    row({ id: 'elsewhere', conversationId: 'coord', taskId: 't2', createdAt: '2026-09-11T12:00:00.000Z' }),
    row({ id: 'mid', conversationId: 'coord', subtaskId: 's-b7', createdAt: '2026-09-12T08:00:00.000Z',
      endedAt: '2026-09-12T20:00:00.000Z' }),
    row({ id: 'other-row', conversationId: 'other', subtaskId: 's-other', createdAt: '2026-09-12T09:00:00.000Z' }),
    row({ id: 'live', conversationId: 'coord', subtaskId: 's-64', createdAt: '2026-09-13T08:00:00.000Z' }),
  ]

  const detailOf = (rows: ManagedSession[]) =>
    buildTaskDetail({
      task: task(), attempts: [], rows, metas, costOf, comments: [], subtasks: subs, files: [],
    })

  it('lists exactly ONE row for the conversation, and it is the newest', () => {
    const detail = detailOf(registry())
    expect(detail.sessions.map(s => s.id)).toEqual(['live', 'other-row'])
    const coord = detail.sessions.find(s => s.conversationId === 'coord')!
    expect(coord.subtaskId).toBe('s-64') // the newest filing
    expect(coord.endedAt).toBeUndefined() // the current liveness: still running
    expect(coord.costUSD).toBe(10) // counted once
  })

  it('counts the conversation once: the task total is the sum of distinct conversations, in any registry order', () => {
    const forward = detailOf(registry())
    const backward = detailOf([...registry()].reverse())
    for (const detail of [forward, backward]) {
      expect(detail.rollup.costUSD).toBe(15) // 10 + 5 — never 10 x 3 + 5
      expect(detail.rollup.tokens).toBe(165)
      expect(detail.rollup.rounds).toBe(11)
      expect(detail.rollup.sessionsUsed).toBe(2)
    }
    // Which row stands for the conversation must not move a single figure.
    expect(backward.rollup).toEqual(forward.rollup)
    expect(backward.sessions.find(s => s.conversationId === 'coord')!.id).toBe('live')
  })

  it('puts the conversation\'s cost under the subtask it is filed on NOW, not under the older filings', () => {
    const detail = detailOf(registry())
    const bucket = (id: string | null) => detail.subtaskRollups.find(v => v.id === id)
    expect(bucket('s-64')!.rollup.costUSD).toBe(10)
    expect(bucket('s-64')!.rollup.sessionsUsed).toBe(1)
    // The two OLD filings no longer carry it — the conversation moved away from them.
    expect(bucket('s-b7')!.rollup.sessionsUsed).toBe(0)
    expect(bucket('s-b7')!.rollup.costUSD).toBeNull()
    // Nor does the direct bucket: with the old task-level row superseded there is nothing filed
    // directly on the delivery, so there is no `id: null` bucket at all.
    expect(bucket(null)).toBeUndefined()
    // A partition: every conversation lands in exactly one bucket, and the buckets add up to the total.
    const sum = detail.subtaskRollups.reduce((a, v) => a + (v.rollup.costUSD ?? 0), 0)
    expect(sum).toBe(detail.rollup.costUSD!)
  })

  it('counts the conversation once in the evidence block too, per bucket and in total', () => {
    const detail = detailOf(registry())
    // 7 (coord) + 1 (other) — it was 7 x 3 + 1 while `stats` mapped over every row.
    expect(detail.stats.filesModified).toBe(8)
    expect(detail.stats.commits).toBe(2)
    expect(detail.stats.tokens).toEqual({ input: 110, output: 55, cacheRead: 0, cacheWrite: 0 })
    const bucket = (id: string) => detail.subtaskRollups.find(v => v.id === id)!
    expect(bucket('s-64').stats!.filesModified).toBe(7)
    expect(bucket('s-b7').stats).toBeNull()
    const sum = detail.subtaskRollups.reduce((a, v) => a + (v.stats?.filesModified ?? 0), 0)
    expect(sum).toBe(detail.stats.filesModified!)
  })

  it('agrees between the list card and the detail', () => {
    const rows = registry()
    const list = buildTaskList({ tasks: [task()], attempts: [], rows, metas, costOf, subtasks: subs })[0]!
    const detail = detailOf(rows)
    expect(list.rollup).toEqual(detail.rollup)
  })

  it('applies the same rule to ATTEMPTS: a conversation is in the attempt it is filed under now', () => {
    const attempts = [
      { id: 'a1', taskId: 't1', label: 'first try', status: 'running', createdAt: '', updatedAt: '' },
      { id: 'a2', taskId: 't1', label: 'second try', status: 'running', createdAt: '', updatedAt: '' },
    ] as never
    const rows = [
      row({ id: 'o1', conversationId: 'coord', attemptId: 'a1', createdAt: '2026-09-10T10:00:00.000Z' }),
      row({ id: 'o2', conversationId: 'coord', attemptId: 'a2', createdAt: '2026-09-11T10:00:00.000Z' }),
    ]
    const detail = buildTaskDetail({
      task: task(), attempts, rows, metas, costOf, comments: [], subtasks: [], files: [],
    })
    const view = (id: string | null) => detail.attempts.find(a => a.id === id)!
    expect(view('a2').rollup.costUSD).toBe(10)
    expect(view('a1').rollup.sessionsUsed).toBe(0)
    expect(detail.rollup.costUSD).toBe(10)
  })
})

describe('subtaskViews times (from sessions, not status)', () => {
  const metas = metasOf(
    meta({ session_id: 'c1', start_time: '2026-10-01T10:00:00Z', end_time: '2026-10-01T11:00:00Z', active_minutes: 40 }),
    meta({ session_id: 'c2', start_time: '2026-10-02T10:00:00Z', end_time: '2026-10-02T10:30:00Z', active_minutes: 20 }),
  )
  it('a done subtask with sessions takes start/end from them and the union of active time', () => {
    const subs = [subtask({ id: 's1', done: true, startedAt: '2026-09-01T00:00:00Z', deliveredAt: '2026-09-01T01:00:00Z' })]
    const rows = [
      row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
      row({ id: 'r2', conversationId: 'c2', subtaskId: 's1' }),
    ]
    const v = subtaskViews(task(), subs, rows, metas, () => 0).find(x => x.id === 's1')!
    expect(v.times).toMatchObject({
      source: 'sessions', startedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-02T10:30:00.000Z', activeMinutes: 60,
    })
  })
  it('a subtask that is not done shows no completed; one with no session falls back to its status stamps', () => {
    const subs = [
      subtask({ id: 's1', done: false }),
      subtask({ id: 's2', done: true, startedAt: '2026-09-01T00:00:00Z', deliveredAt: '2026-09-01T02:00:00Z' }),
    ]
    const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' })]
    const views = subtaskViews(task(), subs, rows, metas, () => 0)
    expect(views.find(x => x.id === 's1')!.times.completedAt).toBeNull()
    expect(views.find(x => x.id === 's2')!.times).toMatchObject({ source: 'status', durationMs: 2 * 3_600_000 })
  })
  it('a NATIVE session filed on a subtask counts too: its span starts when it was filed (UI.3 x times)', () => {
    const subs = [subtask({ id: 's1', done: true, startedAt: '2026-09-01T00:00:00Z', deliveredAt: '2026-09-01T01:00:00Z' })]
    const rows = nativeRows([{ sessionId: 'ses_n1', taskId: 't1', subtaskId: 's1', linkedAt: '2026-10-03T09:00:00Z' } as NativeSessionLink])
    const v = subtaskViews(task(), subs, rows, metas, () => 0).find(x => x.id === 's1')!
    expect(v.times).toMatchObject({ source: 'sessions', startedAt: '2026-10-03T09:00:00.000Z' })
  })
})
