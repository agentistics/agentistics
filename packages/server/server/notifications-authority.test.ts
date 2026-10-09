import { describe, expect, test } from 'bun:test'
import { subjectVisibleTo, INSTANCE_WIDE_CODES, type NotificationAuthorityContext } from './notifications-authority'
import type { Principal } from './notifications-authority'

const emptyCtx: NotificationAuthorityContext = {
  machines: {},
  accountMemberships: {},
}

const owner: Principal = { accountId: 'owner-1', role: 'owner', memberships: [] }
const manager: Principal = { accountId: 'mgr-1', role: 'member', memberships: [{ teamId: 'team-a', role: 'manager' }] }
const teamMember: Principal = { accountId: 'user-1', role: 'member', memberships: [{ teamId: 'team-a', role: 'user' }] }
const outsider: Principal = { accountId: 'user-2', role: 'member', memberships: [{ teamId: 'team-b', role: 'user' }] }

describe('INSTANCE_WIDE_CODES — pinned contents (the review gate for this list)', () => {
  test('is exactly the codes deliberately allowed to skip subject scoping', () => {
    // A new subjectless emitter must add itself here ON PURPOSE — silently reaching everyone
    // (the "route not registered" mistake CLAUDE.md's capability-guard.ts rule calls out) is
    // exactly what this pinned list exists to prevent. Update this alongside the Set.
    expect([...INSTANCE_WIDE_CODES].sort()).toEqual(['app.update_available'])
  })
})

describe('subjectVisibleTo — no subject', () => {
  test('a code on INSTANCE_WIDE_CODES reaches every authenticated account, not just the owner', () => {
    expect(subjectVisibleTo(owner, undefined, emptyCtx, 'app.update_available')).toBe(true)
    expect(subjectVisibleTo(manager, undefined, emptyCtx, 'app.update_available')).toBe(true)
    expect(subjectVisibleTo(teamMember, undefined, emptyCtx, 'app.update_available')).toBe(true)
    expect(subjectVisibleTo(outsider, undefined, emptyCtx, 'app.update_available')).toBe(true)
  })

  test('a code NOT on INSTANCE_WIDE_CODES is denied to a non-owner — a forgotten subject must not silently go global', () => {
    expect(subjectVisibleTo(manager, undefined, emptyCtx, 'some.new_code')).toBe(false)
    expect(subjectVisibleTo(owner, undefined, emptyCtx, 'some.new_code')).toBe(true)
  })

  test('no code at all (a raw title/message notification) is denied to a non-owner — it cannot be classified as instance-wide', () => {
    expect(subjectVisibleTo(manager, undefined, emptyCtx)).toBe(false)
    expect(subjectVisibleTo(owner, undefined, emptyCtx)).toBe(true)
  })
})

describe('subjectVisibleTo — owner override', () => {
  test('the owner sees every subject, even one this module cannot resolve', () => {
    expect(subjectVisibleTo(owner, { kind: 'machine', id: 'unknown-machine' }, emptyCtx)).toBe(true)
    expect(subjectVisibleTo(owner, { kind: 'account', id: 'unknown-account' }, emptyCtx)).toBe(true)
    expect(subjectVisibleTo(owner, { kind: 'team', id: 'unknown-team' }, emptyCtx)).toBe(true)
  })
})

describe('subjectVisibleTo — team subject', () => {
  test('a member of the team sees it (belonging is enough, not just managing)', () => {
    expect(subjectVisibleTo(teamMember, { kind: 'team', id: 'team-a' }, emptyCtx)).toBe(true)
    expect(subjectVisibleTo(manager, { kind: 'team', id: 'team-a' }, emptyCtx)).toBe(true)
  })

  test('an outsider to the team does not see it', () => {
    expect(subjectVisibleTo(outsider, { kind: 'team', id: 'team-a' }, emptyCtx)).toBe(false)
  })
})

describe('subjectVisibleTo — machine subject', () => {
  const ctx: NotificationAuthorityContext = {
    ...emptyCtx,
    machines: {
      'machine-owned': { accountIds: ['user-1'] },
      'machine-in-team-a': { teamIds: ['team-a'] },
      'machine-in-team-b': { teamIds: ['team-b'] },
    },
  }

  test('the machine\'s own owner-account sees it', () => {
    expect(subjectVisibleTo(teamMember, { kind: 'machine', id: 'machine-owned' }, ctx)).toBe(true)
  })

  test('a manager of one of the machine\'s teams sees it', () => {
    expect(subjectVisibleTo(manager, { kind: 'machine', id: 'machine-in-team-a' }, ctx)).toBe(true)
  })

  test('a plain team member who neither owns the machine nor manages its team does not see it', () => {
    expect(subjectVisibleTo(teamMember, { kind: 'machine', id: 'machine-in-team-a' }, ctx)).toBe(false)
  })

  test('a manager of an unrelated team does not see it', () => {
    expect(subjectVisibleTo(manager, { kind: 'machine', id: 'machine-in-team-b' }, ctx)).toBe(false)
  })

  test('a machine id absent from the context is unresolved and fails closed', () => {
    expect(subjectVisibleTo(manager, { kind: 'machine', id: 'does-not-exist' }, ctx)).toBe(false)
  })
})

describe('subjectVisibleTo — account subject', () => {
  const ctx: NotificationAuthorityContext = {
    ...emptyCtx,
    accountMemberships: {
      'user-1': [{ teamId: 'team-a', role: 'user' }],
      'user-2': [{ teamId: 'team-b', role: 'user' }],
    },
  }

  test('a principal always sees a notification about themselves', () => {
    expect(subjectVisibleTo(teamMember, { kind: 'account', id: 'user-1' }, ctx)).toBe(true)
  })

  test('a manager of one of the target account\'s teams sees it', () => {
    expect(subjectVisibleTo(manager, { kind: 'account', id: 'user-1' }, ctx)).toBe(true)
  })

  test('a manager of an unrelated team does not see it', () => {
    expect(subjectVisibleTo(manager, { kind: 'account', id: 'user-2' }, ctx)).toBe(false)
  })

  test('a plain user never sees a notification about a colleague', () => {
    expect(subjectVisibleTo(teamMember, { kind: 'account', id: 'user-2' }, ctx)).toBe(false)
  })

  test('an account id absent from the context is unresolved and fails closed, even for a manager', () => {
    expect(subjectVisibleTo(manager, { kind: 'account', id: 'ghost' }, ctx)).toBe(false)
  })
})

describe('subjectVisibleTo — fails closed on the unknown', () => {
  test('an unrecognized subject kind is denied for anyone but the owner', () => {
    // @ts-expect-error deliberately malformed input — the store must never trust an unknown kind
    expect(subjectVisibleTo(manager, { kind: 'bogus', id: 'x' }, emptyCtx)).toBe(false)
  })

  test('a code that IS on INSTANCE_WIDE_CODES is irrelevant once a subject is present — subject wins', () => {
    // A subject always narrows scoping to itself; the code's instance-wide status only matters
    // when there is no subject to check instead.
    expect(subjectVisibleTo(manager, { kind: 'team', id: 'team-b' }, emptyCtx, 'app.update_available')).toBe(false)
  })
})
