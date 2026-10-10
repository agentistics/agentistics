import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_TASK_STATUSES, PROTECTED_STATUS_IDS, canDeleteStatus, isKnownStatusId,
  isProtectedStatusId, isValidStatusColor, nextStatusId, planInReviewAdd, planStatusMigration, sortTaskStatuses,
  type TaskStatusDef,
} from './taskStatus'

describe('PROTECTED_STATUS_IDS / DEFAULT_TASK_STATUSES', () => {
  it('has four reserved keys; the defaults are those plus the non-protected in_review', () => {
    expect(PROTECTED_STATUS_IDS).toEqual(['todo', 'in_progress', 'blocked', 'done'])
    expect(DEFAULT_TASK_STATUSES.map(s => s.id)).toEqual(['todo', 'in_progress', 'blocked', 'in_review', 'done'])
    expect(DEFAULT_TASK_STATUSES.filter(s => s.protected).map(s => s.id)).toEqual([...PROTECTED_STATUS_IDS])
  })

  it('never seeds the other legacy words as defaults', () => {
    const ids = DEFAULT_TASK_STATUSES.map(s => s.id)
    expect(ids).not.toContain('backlog')
    expect(ids).not.toContain('abandoned')
  })

  it('isProtectedStatusId agrees with the constant', () => {
    for (const id of PROTECTED_STATUS_IDS) expect(isProtectedStatusId(id)).toBe(true)
    expect(isProtectedStatusId('backlog')).toBe(false)
    expect(isProtectedStatusId('anything_else')).toBe(false)
  })
})

describe('planStatusMigration', () => {
  it('seeds exactly the four protected defaults on a book with no list and nothing legacy in use', () => {
    const plan = planStatusMigration({ existing: undefined, usedStatusIds: ['todo', 'done'] })
    expect(plan?.map(s => s.id)).toEqual(['todo', 'in_progress', 'blocked', 'in_review', 'done'])
    expect(plan?.filter(s => s.protected).length).toBe(4)
  })

  it('also seeds a legacy word only when it is actually referenced', () => {
    const plan = planStatusMigration({
      existing: undefined,
      usedStatusIds: ['todo', 'backlog', 'in_review'],
    })
    const ids = plan?.map(s => s.id)
    expect(ids).toEqual(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'backlog'])
    const backlog = plan?.find(s => s.id === 'backlog')
    expect(backlog?.protected).toBe(false)
    expect(backlog?.label).toBe('Backlog')
    const inReview = plan?.find(s => s.id === 'in_review')
    expect(inReview?.protected).toBe(false)
    expect(inReview?.label).toBe('In review')
  })

  it('never seeds a legacy word that is not referenced anywhere', () => {
    const plan = planStatusMigration({ existing: undefined, usedStatusIds: ['todo'] })
    expect(plan?.map(s => s.id)).toEqual(['todo', 'in_progress', 'blocked', 'in_review', 'done'])
  })

  it('seeds an entirely unrecognised in-use status id too, labelled with itself', () => {
    const plan = planStatusMigration({ existing: undefined, usedStatusIds: ['todo', 'triage'] })
    const triage = plan?.find(s => s.id === 'triage')
    expect(triage).toEqual({ id: 'triage', label: 'triage', color: '#94a3b8', protected: false, order: 5 })
  })

  it('does nothing once a list already exists — idempotent by construction', () => {
    const existing: TaskStatusDef[] = [
      { id: 'todo', label: 'To do', color: '#3b82f6', protected: true, order: 0 },
    ]
    expect(planStatusMigration({ existing, usedStatusIds: ['backlog'] })).toBeNull()
  })

  it('is a no-op the SECOND time even without an existing check at the call site', () => {
    const first = planStatusMigration({ existing: undefined, usedStatusIds: ['backlog'] })
    expect(first).not.toBeNull()
    const second = planStatusMigration({ existing: first, usedStatusIds: ['backlog', 'triage'] })
    // `triage` showed up AFTER the seed-once moment — this function never tops the list up again.
    expect(second).toBeNull()
  })

  it('treats an empty existing array the same as absent — a book written before this feature', () => {
    const plan = planStatusMigration({ existing: [], usedStatusIds: [] })
    expect(plan?.map(s => s.id)).toEqual(['todo', 'in_progress', 'blocked', 'in_review', 'done'])
  })
})

describe('planInReviewAdd', () => {
  const todo: TaskStatusDef = { id: 'todo', label: 'To do', color: '#3b82f6', protected: true, order: 0 }
  it('appends in_review after the last entry of a list that lacks it, leaving custom statuses alone', () => {
    const custom: TaskStatusDef = { id: 'triage', label: 'Triage', color: '#000000', protected: false, order: 7 }
    const add = planInReviewAdd([todo, custom])
    expect(add).toMatchObject({ id: 'in_review', protected: false, order: 8 })
  })
  it('is null for an empty list (the seed carries it) or a list that has it', () => {
    expect(planInReviewAdd([])).toBeNull()
    expect(planInReviewAdd([todo, { ...todo, id: 'in_review', protected: false }])).toBeNull()
  })
})

describe('canDeleteStatus', () => {
  it('refuses a protected status regardless of usage', () => {
    expect(canDeleteStatus({ status: { id: 'done', protected: true }, usageCount: 0 }))
      .toEqual({ ok: false, reason: 'protected' })
    expect(canDeleteStatus({ status: { id: 'done', protected: true }, usageCount: 5 }))
      .toEqual({ ok: false, reason: 'protected' })
  })

  it('refuses one of the four reserved ids even if its own flag were somehow false', () => {
    expect(canDeleteStatus({ status: { id: 'blocked', protected: false }, usageCount: 0 }))
      .toEqual({ ok: false, reason: 'protected' })
  })

  it('refuses a non-protected status that is in use', () => {
    expect(canDeleteStatus({ status: { id: 'backlog', protected: false }, usageCount: 3 }))
      .toEqual({ ok: false, reason: 'in_use' })
  })

  it('allows a non-protected, unused status', () => {
    expect(canDeleteStatus({ status: { id: 'backlog', protected: false }, usageCount: 0 }))
      .toEqual({ ok: true })
  })
})

describe('isKnownStatusId', () => {
  it('is true only for an id actually in the list', () => {
    expect(isKnownStatusId('todo', DEFAULT_TASK_STATUSES)).toBe(true)
    expect(isKnownStatusId('nope', DEFAULT_TASK_STATUSES)).toBe(false)
  })
})

describe('isValidStatusColor', () => {
  it('accepts a 6-digit hex colour and nothing else', () => {
    expect(isValidStatusColor('#3b82f6')).toBe(true)
    expect(isValidStatusColor('#FFF')).toBe(false)
    expect(isValidStatusColor('blue')).toBe(false)
    expect(isValidStatusColor(123)).toBe(false)
    expect(isValidStatusColor(undefined)).toBe(false)
  })
})

describe('nextStatusId', () => {
  it('slugifies the label', () => {
    expect(nextStatusId('Waiting on client', [])).toBe('waiting_on_client')
  })

  it('resolves a collision with a numeric suffix rather than failing', () => {
    expect(nextStatusId('To do', ['to_do'])).toBe('to_do_2')
    expect(nextStatusId('To do', ['to_do', 'to_do_2'])).toBe('to_do_3')
  })

  it('never produces an empty id from a label with no alphanumerics', () => {
    expect(nextStatusId('!!!', [])).toBe('status')
  })
})

describe('sortTaskStatuses', () => {
  it('sorts by order, then by id as a deterministic tiebreak', () => {
    const a: TaskStatusDef = { id: 'b', label: 'B', color: '#000000', protected: false, order: 1 }
    const b: TaskStatusDef = { id: 'a', label: 'A', color: '#000000', protected: false, order: 1 }
    const c: TaskStatusDef = { id: 'c', label: 'C', color: '#000000', protected: false, order: 0 }
    expect(sortTaskStatuses([a, b, c]).map(s => s.id)).toEqual(['c', 'a', 'b'])
  })
})
