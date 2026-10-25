/**
 * HERANÇA (25/10): what a new session, a hand-off successor and a replaced (reopened / account-switched)
 * row carry over. One file for the four pieces so the rule set reads as one thing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionAwayView } from '@agentistics/core'
import { handoffAccountOf } from './handoff-inherit'
import { childrenOfReplaced, liveSuccessorOf, type TeamRow } from './team-links'
import { loadRoles, promoteSpawningParent, type RoleDeps } from './session-roles'
import { resetMessageRateLimit, sendSessionMessage, type MessageDeps } from './session-message'

describe('away: the control shows the EFFECTIVE state', () => {
  test('global on → on, from the global, locked (a per-session off would change nothing)', () => {
    expect(sessionAwayView(true, undefined)).toEqual({ on: true, source: 'global', locked: true })
    expect(sessionAwayView(true, false)).toEqual({ on: true, source: 'global', locked: true })
  })
  test('global off → the session\'s own flag, editable', () => {
    expect(sessionAwayView(false, true)).toEqual({ on: true, source: 'session', locked: false })
    expect(sessionAwayView(false, undefined)).toEqual({ on: false, source: null, locked: false })
  })
})

describe('hand-off: the successor keeps the predecessor\'s account', () => {
  test('same harness, nothing named → the predecessor\'s', () => {
    expect(handoffAccountOf({ harness: 'claude', accountId: 'acc_a' }, 'claude', undefined)).toBe('acc_a')
  })
  test('a named account wins; another harness inherits nothing; no predecessor account → automatic', () => {
    expect(handoffAccountOf({ harness: 'claude', accountId: 'acc_a' }, 'claude', 'acc_b')).toBeUndefined()
    expect(handoffAccountOf({ harness: 'claude', accountId: 'acc_a' }, 'codex', undefined)).toBeUndefined()
    expect(handoffAccountOf({ harness: 'claude' }, 'claude', undefined)).toBeUndefined()
    expect(handoffAccountOf(undefined, 'claude', undefined)).toBeUndefined()
  })
})

describe('a replaced row (reopen / account switch) hands its workers to its replacement', () => {
  const rows: TeamRow[] = [
    { id: 'old', conversationId: 'conv-L', endedAt: '2026-10-25T10:00:00Z' },
    { id: 'new', conversationId: 'conv-L' },
    { id: 'w1', parentSessionId: 'old', parentConversationId: 'conv-L' },
    { id: 'w2', parentSessionId: 'other' },
  ]
  test('a message to the dead id reaches the live row of the same conversation', () => {
    expect(liveSuccessorOf(rows, 'old')).toBe('new')
  })
  test('a live row, an unknown id and a dead row with no continuation are their own answer', () => {
    expect(liveSuccessorOf(rows, 'new')).toBe('new')
    expect(liveSuccessorOf(rows, 'nope')).toBe('nope')
    expect(liveSuccessorOf([{ id: 'x', conversationId: 'c', endedAt: 'z' }], 'x')).toBe('x')
  })
  test('a cross-harness switch (hand-off link, new conversation) is followed too', () => {
    const r: TeamRow[] = [{ id: 'old', conversationId: 'c1', endedAt: 'z', handoffTo: 'n' }, { id: 'n', conversationId: 'c2' }]
    expect(liveSuccessorOf(r, 'old')).toBe('n')
  })
  test('a leader that handed off but is still finishing its turn already forwards to its successor', () => {
    const r: TeamRow[] = [{ id: 'old', conversationId: 'c1', handoffTo: 'n' }, { id: 'n', conversationId: 'c2' }]
    expect(liveSuccessorOf(r, 'old')).toBe('n')
  })
  test.each([undefined, 'retired'])('reopen → handoff, replacement endedAt=%s', endedAt => {
    const r: TeamRow[] = [
      { id: 'a', conversationId: 'c1', endedAt: 'old' },
      { id: 'b', conversationId: 'c1', endedAt, handoffTo: 'c' },
      { id: 'c', conversationId: 'c2' },
    ]
    expect(liveSuccessorOf(r, 'a')).toBe('c')
    // Repeat the same combination after another replacement and handoff.
    r[2]!.endedAt = 'old'
    r.push({ id: 'd', conversationId: 'c2', endedAt: 'old', handoffTo: 'e' }, { id: 'e', conversationId: 'c3' })
    expect(liveSuccessorOf(r, 'a')).toBe('e')
    r[4]!.handoffTo = 'a'
    expect(liveSuccessorOf(r, 'a')).toBe('e') // shared visited set across both edge types
  })
  test('a retired replacement never returns to an older handoff in its conversation', () => {
    expect(liveSuccessorOf([{ id: 'a', conversationId: 'c', endedAt: 'old', handoffTo: 'b' }, { id: 'b', conversationId: 'c', endedAt: 'new' }], 'b')).toBe('b')
  })
  test('a long mixed chain stays bounded', () => {
    const r: TeamRow[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), conversationId: String(Math.floor(i / 2)), endedAt: 'old', ...(i % 2 ? { handoffTo: String(i + 1) } : {}) }))
    expect(Number(liveSuccessorOf(r, '0'))).toBeLessThanOrEqual(16)
  })
  test('the workers naming the old id are re-filed', () => {
    expect(childrenOfReplaced(rows, 'old', 'new')).toEqual(['w1'])
    expect(childrenOfReplaced(rows, 'new', 'new')).toEqual([])
  })
  test('sendSessionMessage routes through redirect', async () => {
    resetMessageRateLimit()
    const prompts: string[] = []
    const deps: MessageDeps = {
      rows: async () => [{ id: 'new', title: 'Leader', conversationId: 'conv-L' }],
      prompt: async id => { prompts.push(id); return { ok: true } },
      senderTask: async () => ({}),
      comment: async () => ({ ok: true }),
      redirect: async to => liveSuccessorOf(rows, to),
      now: () => 1,
    }
    const out = await sendSessionMessage('w1', { to: 'old', kind: 'handback', body: 'done' }, deps)
    expect(out.ok).toBe(true)
    expect(prompts).toEqual(['new'])
  })
  test.each(['retired-123', 'conversation-old'])('messages resolve retired reference %s before following successors', async ref => {
    resetMessageRateLimit()
    const registry: Array<TeamRow & { title: string }> = [
      { id: 'retired-123456', title: 'Former', conversationId: 'conversation-old-full', endedAt: 'old' },
      { id: 'replacement', title: 'Replacement', conversationId: 'conversation-old-full', endedAt: 'old', handoffTo: 'live' },
      { id: 'live', title: 'Leader', conversationId: 'current' },
    ]
    const prompts: string[] = []
    const d: MessageDeps = {
      rows: async () => [registry[2]!], registryRows: async () => registry,
      redirect: async id => liveSuccessorOf(registry, id),
      prompt: async id => { prompts.push(id); return { ok: true } },
      senderTask: async () => ({}), comment: async () => ({ ok: true }), now: () => 1,
    }
    // Conversation prefixes are ambiguous when several registry rows share that conversation.
    if (ref === 'conversation-old') registry[1]!.conversationId = 'other-conversation'
    if (ref === 'conversation-old') registry[0]!.handoffTo = 'replacement'
    expect((await sendSessionMessage('worker', { to: ref, kind: 'handback', body: 'done' }, d)).ok).toBe(true)
    expect(prompts).toEqual(['live'])
    registry.push({ id: 'retired-123999', title: 'Other', conversationId: 'conversation-old-other', endedAt: 'old' })
    const refused = await sendSessionMessage('worker', { to: ref, kind: 'handback', body: 'done' }, d)
    expect(refused).toMatchObject({ ok: false, code: 'ambiguous_session' })
    expect(prompts).toEqual(['live'])
  })

})

describe('auto → leader: a session with no role that starts a worker', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'inherit-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const deps = (rows: Array<{ id: string; conversationId?: string; title: string }>, renames: string[] = []): RoleDeps => ({
    dataDir: dir, rows: async () => rows, legacyPref: async () => undefined, uiLang: async () => 'en',
    rename: async (_id, t) => { renames.push(t); return { ok: true } }, prompt: async () => ({ ok: true }), parentOf: async () => undefined,
  })
  test('becomes leader, origin inferred, renamed', async () => {
    const renames: string[] = []
    const out = await promoteSpawningParent('p', true, 'pt', deps([{ id: 'p', conversationId: 'cp', title: 'Varredura' }], renames))
    expect(out.promoted).toBe(true)
    const doc = await loadRoles({ dataDir: dir, legacyPref: async () => undefined })
    expect(doc.roles.cp).toBe('leader')
    expect(doc.origins?.cp).toBe('inferred')
    expect(renames[0]).toContain('Varredura')
  })
  test('never overrides a stored role; never for an unverified parent', async () => {
    const d = deps([{ id: 'p', conversationId: 'cp', title: 'T' }])
    expect((await promoteSpawningParent('p', false, 'en', d)).promoted).toBe(false)
    const { writeRolesDoc } = await import('./session-roles')
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { cp: 'worker' } })
    expect((await promoteSpawningParent('p', true, 'en', d)).promoted).toBe(false)
    expect((await loadRoles({ dataDir: dir, legacyPref: async () => undefined })).roles.cp).toBe('worker')
  })
})
