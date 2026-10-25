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
