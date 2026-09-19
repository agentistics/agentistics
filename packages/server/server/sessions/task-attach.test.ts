import { describe, expect, it } from 'bun:test'
import {
  checkParentGroup, filedUnder, planAttach, reconcileAttachment, sanitizeSubtaskBlockedBy,
} from './task-attach'

const SUBS = [
  { id: 's1', taskId: 't1', done: false },
  { id: 's2', taskId: 't1', done: false },
  { id: 's9', taskId: 't2', done: false },
]
const TASKS = ['t1', 't2']

describe('planAttach', () => {
  it('files directly under a delivery — the "not broken out" branch has its own bucket now', () => {
    // See docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.1/§4.2: the
    // task-level total already summed direct rows regardless of subtaskId, and the per-subtask
    // rollup gives the un-broken-out part its own answerable bucket (subtaskId: null) instead of
    // an unaccounted-for gap.
    expect(planAttach({ target: { kind: 'task', id: 't1' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: null })
  })

  it('still refuses a delivery that does not exist, before anything else', () => {
    expect(planAttach({ target: { kind: 'task', id: 'gone' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: false, reason: 'no_such_task' })
  })

  it('files directly under a delivery that ALREADY has subtasks — the two branches coexist (#3)', () => {
    // A task is never forced into one shape: direct sessions and subtask-filed ones can both
    // exist on the same delivery, and neither blocks the other.
    expect(planAttach({ target: { kind: 'task', id: 't1' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: null })
    expect(planAttach({ target: { kind: 'subtask', id: 's1' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's1' })
  })

  it('files under a subtask, and takes the parent FROM the subtask', () => {
    // Never from the caller: that is what stops the two ids naming different deliveries.
    expect(planAttach({ target: { kind: 'subtask', id: 's9' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: 't2', subtaskId: 's9' })
  })

  it('never produces a row filed under BOTH a task and a subtask of another', () => {
    const plan = planAttach({ target: { kind: 'subtask', id: 's1' }, taskIds: TASKS, subtasks: SUBS })
    expect(plan).toEqual({ ok: true, taskId: 't1', subtaskId: 's1' })
    if (!plan.ok) return
    // The stored pair is the subtask and ITS task — the invariant, stated as an assertion.
    const sub = SUBS.find(s => s.id === plan.subtaskId)!
    expect(plan.taskId).toBe(sub.taskId)
  })

  it('unfiles', () => {
    expect(planAttach({ target: { kind: 'none' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: null, subtaskId: null })
  })

  it('refuses a subtask that names nothing, rather than guessing one', () => {
    expect(planAttach({ target: { kind: 'subtask', id: 'gone' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: false, reason: 'no_such_subtask' })
  })

  it("refuses a subtask still blocked by a sibling that is not done", () => {
    const blocked = [...SUBS, { id: 's3', taskId: 't1', done: false, blockedBy: ['s1'] }]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: blocked }))
      .toEqual({ ok: false, reason: 'blocked', blockedBy: ['s1'] })
  })

  it('files under a subtask once every one of its blockers is done', () => {
    const done = SUBS.map(s => (s.id === 's1' ? { ...s, done: true } : s))
    const withBlocker = [...done, { id: 's3', taskId: 't1', done: false, blockedBy: ['s1'] }]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: withBlocker }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's3' })
  })

  it('names every unmet blocker, in the order recorded, when there is more than one', () => {
    const withBlockers = [
      ...SUBS,
      { id: 's3', taskId: 't1', done: false, blockedBy: ['s2', 's1'] },
    ]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: withBlockers }))
      .toEqual({ ok: false, reason: 'blocked', blockedBy: ['s2', 's1'] })
  })

  it('a blocker naming a subtask that no longer exists is not a live block', () => {
    // The same reconciliation `filedUnder` already gives a session whose OWN subtask is gone —
    // a dangling reference stands in nobody's way forever.
    const withGoneBlocker = [...SUBS, { id: 's3', taskId: 't1', done: false, blockedBy: ['gone'] }]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: withGoneBlocker }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's3' })
  })

  it('a blocker outside this book of subtasks is not a live block either', () => {
    // `planAttach` is handed the DELIVERY's own subtasks in every measured caller; a blocker id
    // that does not resolve inside that set reads exactly like a deleted one.
    const scoped = [
      { id: 's1', taskId: 't1', done: false },
      { id: 's3', taskId: 't1', done: false, blockedBy: ['s9'] },
    ]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: scoped }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's3' })
  })

  describe('a GROUP MEMBER can never hold a session (§F.1)', () => {
    it('refuses filing directly on a member, with a NAMED reason — never a silent no-op', () => {
      const withGroup = [
        ...SUBS,
        { id: 'g1', taskId: 't1', done: false },
        { id: 'm1', taskId: 't1', done: false, parentGroupId: 'g1' },
      ]
      expect(planAttach({ target: { kind: 'subtask', id: 'm1' }, taskIds: TASKS, subtasks: withGroup }))
        .toEqual({ ok: false, reason: 'subtask_in_group' })
    })

    it('the GROUP itself is filed on exactly like any other subtask', () => {
      const withGroup = [
        ...SUBS,
        { id: 'g1', taskId: 't1', done: false },
        { id: 'm1', taskId: 't1', done: false, parentGroupId: 'g1' },
      ]
      expect(planAttach({ target: { kind: 'subtask', id: 'g1' }, taskIds: TASKS, subtasks: withGroup }))
        .toEqual({ ok: true, taskId: 't1', subtaskId: 'g1' })
    })

    it('a member refuses BEFORE its own blockedBy is even considered', () => {
      // Whether a member's own blockers are done is moot when it can never receive a session
      // either way — `subtask_in_group` must win regardless of what `blockedBy` says.
      const withGroup = [
        ...SUBS,
        { id: 'g1', taskId: 't1', done: false },
        { id: 'm1', taskId: 't1', done: false, parentGroupId: 'g1', blockedBy: [] },
      ]
      expect(planAttach({ target: { kind: 'subtask', id: 'm1' }, taskIds: TASKS, subtasks: withGroup }))
        .toEqual({ ok: false, reason: 'subtask_in_group' })
    })
  })
})

describe('sanitizeSubtaskBlockedBy', () => {
  const SIBLINGS = [
    { id: 's1', taskId: 't1' },
    { id: 's2', taskId: 't1' },
    { id: 's3', taskId: 't1' },
    { id: 's9', taskId: 't2' },
  ]

  it('keeps a sibling of the same task', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s1'], siblings: SIBLINGS }))
      .toEqual(['s1'])
  })

  it('drops a self-reference — a subtask cannot block itself', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s3', 's1'], siblings: SIBLINGS }))
      .toEqual(['s1'])
  })

  it('drops a subtask of a DIFFERENT delivery', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s9'], siblings: SIBLINGS }))
      .toEqual([])
  })

  it('drops an id naming nothing', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['ghost'], siblings: SIBLINGS }))
      .toEqual([])
  })

  it('dedupes', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s1', 's1', 's2'], siblings: SIBLINGS }))
      .toEqual(['s1', 's2'])
  })
})

describe('checkParentGroup — where a MEMBER may point its parentGroupId (§F.1)', () => {
  const SIBLINGS_WITH_GROUP = [
    { id: 'g1', taskId: 't1', isGroup: true },
    { id: 'g2', taskId: 't2', isGroup: true }, // a group of a DIFFERENT task
    { id: 's1', taskId: 't1' }, // a loose subtask — not a group
    { id: 'm1', taskId: 't1' },
  ]

  it('accepts a group of the SAME task', () => {
    expect(checkParentGroup({
      subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 'g1',
      siblings: SIBLINGS_WITH_GROUP,
    })).toEqual({ ok: true })
  })

  it('refuses a reference to a subtask that does not exist', () => {
    expect(checkParentGroup({
      subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 'gone',
      siblings: SIBLINGS_WITH_GROUP,
    })).toEqual({ ok: false, reason: 'invalid_group' })
  })

  it('refuses a reference to a subtask that is not actually a group', () => {
    expect(checkParentGroup({
      subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 's1',
      siblings: SIBLINGS_WITH_GROUP,
    })).toEqual({ ok: false, reason: 'invalid_group' })
  })

  it('refuses a group that belongs to a DIFFERENT parent task — a group cannot span two tasks', () => {
    expect(checkParentGroup({
      subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 'g2',
      siblings: SIBLINGS_WITH_GROUP,
    })).toEqual({ ok: false, reason: 'invalid_group' })
  })

  it('refuses a self-reference', () => {
    expect(checkParentGroup({
      subtaskId: 'g1', taskId: 't1', isGroup: false, parentGroupId: 'g1',
      siblings: SIBLINGS_WITH_GROUP,
    })).toEqual({ ok: false, reason: 'invalid_group' })
  })

  it('refuses when the subtask BEING PATCHED is itself a group — a group can never be a member', () => {
    expect(checkParentGroup({
      subtaskId: 'g1', taskId: 't1', isGroup: true, parentGroupId: 'g1',
      siblings: SIBLINGS_WITH_GROUP,
    })).toEqual({ ok: false, reason: 'invalid_group' })
    // Even naming a DIFFERENT, otherwise-valid group — a group is never a member of anything.
    const twoGroups = [...SIBLINGS_WITH_GROUP, { id: 'g3', taskId: 't1', isGroup: true }]
    expect(checkParentGroup({
      subtaskId: 'g3', taskId: 't1', isGroup: true, parentGroupId: 'g1',
      siblings: twoGroups,
    })).toEqual({ ok: false, reason: 'invalid_group' })
  })

  describe('`hasSession` — joining a group must not orphan a session already filed on the subtask', () => {
    it('accepts an otherwise-valid join when `hasSession` is false (or omitted)', () => {
      expect(checkParentGroup({
        subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 'g1',
        siblings: SIBLINGS_WITH_GROUP, hasSession: false,
      })).toEqual({ ok: true })
      // Omitted entirely — defaults to false, so every pre-existing call site above is unaffected.
      expect(checkParentGroup({
        subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 'g1',
        siblings: SIBLINGS_WITH_GROUP,
      })).toEqual({ ok: true })
    })

    it('refuses an otherwise-valid join with `subtask_has_sessions` when `hasSession` is true', () => {
      expect(checkParentGroup({
        subtaskId: 'm1', taskId: 't1', isGroup: false, parentGroupId: 'g1',
        siblings: SIBLINGS_WITH_GROUP, hasSession: true,
      })).toEqual({ ok: false, reason: 'subtask_has_sessions' })
    })

    it('a subtask that is itself a group is still `invalid_group` even with a session, never subtask_has_sessions', () => {
      // `isGroup` is checked first: whether it happens to carry a session is moot when it could
      // never be a member to begin with, and the caller should learn the more fundamental reason.
      expect(checkParentGroup({
        subtaskId: 'g1', taskId: 't1', isGroup: true, parentGroupId: 'g1',
        siblings: SIBLINGS_WITH_GROUP, hasSession: true,
      })).toEqual({ ok: false, reason: 'invalid_group' })
    })
  })
})

describe('filedUnder', () => {
  it('answers with ONE owner — the subtask when there is one', () => {
    expect(filedUnder({ taskId: 't1', subtaskId: 's1' })).toEqual({ kind: 'subtask', id: 's1' })
    expect(filedUnder({ taskId: 't1' })).toEqual({ kind: 'task', id: 't1' })
    expect(filedUnder({})).toEqual({ kind: 'none' })
  })
})

describe('reconcileAttachment', () => {
  it('falls back to the task when the subtask is gone', () => {
    // Deleted while a session pointed at it. The delivery is still true, so the row keeps it
    // rather than vanishing from both lists.
    expect(reconcileAttachment({ taskId: 't1', subtaskId: 'gone' }, SUBS))
      .toEqual({ taskId: 't1', subtaskId: null })
  })

  it('corrects a pair that names two different deliveries', () => {
    // Written by an older build, or by a move that half-failed: the SUBTASK decides.
    expect(reconcileAttachment({ taskId: 't1', subtaskId: 's9' }, SUBS))
      .toEqual({ taskId: 't2', subtaskId: 's9' })
  })

  it('leaves an ordinary task-only row alone', () => {
    expect(reconcileAttachment({ taskId: 't1' }, SUBS)).toEqual({ taskId: 't1', subtaskId: null })
    expect(reconcileAttachment({}, SUBS)).toEqual({ taskId: null, subtaskId: null })
  })
})
