import { describe, expect, test } from 'bun:test'
import type { HarnessId } from '@agentistics/core'
import { managedClaims, processClaims } from './live-claims'
import { conversationsInUse } from './conversation-claim'
import { scopeToRowHarness, type HarnessSessionIndex } from './harness-sessions'
import type { ManagedSession } from './types'

describe('processClaims', () => {
  const SES = 'ses_e7030a1bbffeIklK1ILCtj7v2H'
  test('a process the scan linked by itself (opencode log, argv, open file) holds its conversation', () => {
    const out = processClaims([{ harness: 'opencode', cwd: '/p', pid: 7, sessionId: SES }], () => undefined)
    expect(out).toEqual([{ id: `external:opencode:${SES}`, kind: 'process', pid: 7, alive: true, conversationId: SES, label: '/p' }])
  })
  test('the harness\'s own record for the pid wins over the scan', () => {
    const out = processClaims([{ harness: 'claude', cwd: '/p', pid: 7, sessionId: 'from-argv' }], () => 'from-record')
    expect(out[0]!.conversationId).toBe('from-record')
  })
  test('a process that names no conversation claims nothing', () => {
    expect(processClaims([{ harness: 'codex', cwd: '/p', pid: 7 }], () => undefined)).toEqual([])
  })
})

/**
 * REABRIR.OPENCODE (owner, 2026-11-02): reopening an OpenCode session was refused with "that conversation
 * is already open in [ LÍDER ] - Brainstorm…" while no opencode process existed. A claude record's `tmux`
 * field is an INHERITED environment variable, so a claude (here: a leader) started with the opencode pane's
 * environment wrote a record naming the opencode row — and the record was trusted as the opencode row's own.
 */
describe('managedClaims — a record is only the row\'s own when the same harness wrote it', () => {
  const SES = 'ses_e705faa69ffeTha147mWbwRs0z'
  const LEADER_CONV = '7c0ffee0-0000-4000-8000-000000000001'
  const registry: ManagedSession[] = [
    { id: 'oc00000001', harness: 'opencode', cwd: '/w', createdAt: '2026-11-02T19:00:00.000Z', label: 'opencode work', conversationId: SES },
    { id: 'ld00000001', harness: 'claude', cwd: '/w', createdAt: '2026-11-02T18:00:00.000Z', label: '[ LÍDER ] - Brainstorm', conversationId: LEADER_CONV },
  ]
  const crosstalk = (): HarnessSessionIndex => ({
    byManagedId: new Map([['oc00000001', { harness: 'claude', sessionId: LEADER_CONV, name: '[ LÍDER ] - Brainstorm', tmux: 'agentop-oc00000001:@0.%0' }]]),
    byPid: new Map(), byConversation: new Map(),
  })

  test('the opencode row keeps its own ses_… — a claude record naming its pane is not its record', () => {
    const claims = managedClaims(registry, new Set(['oc00000001', 'ld00000001']), crosstalk())
    expect(claims.find(c => c.id === 'oc00000001')?.conversationId).toBe(SES)
    const held = conversationsInUse(claims)
    // The live opencode row holds its own conversation (no second opencode may be started into it)…
    expect(held.get(SES)?.id).toBe('oc00000001')
    // …and the leader's conversation is the leader's, not the opencode row's.
    expect(held.get(LEADER_CONV)?.id).toBe('ld00000001')
  })

  test('with no opencode alive, nothing holds the opencode conversation — the reopen is free', () => {
    const held = conversationsInUse(managedClaims(registry, new Set(['ld00000001']), crosstalk()))
    expect(held.get(SES)).toBeUndefined()
  })

  test('a claude row still takes its conversation from its own claude record', () => {
    const index: HarnessSessionIndex = {
      byManagedId: new Map([['ld00000001', { harness: 'claude', sessionId: 'after-resume' }]]),
      byPid: new Map(), byConversation: new Map(),
    }
    const claims = managedClaims(registry, new Set(['ld00000001']), index)
    expect(claims.find(c => c.id === 'ld00000001')?.conversationId).toBe('after-resume')
  })
})

describe('scopeToRowHarness', () => {
  test('drops a link (and its candidates) written by another harness; keeps ids the registry does not hold', () => {
    const rec = { harness: 'claude' as const, sessionId: 'c' }
    const index: HarnessSessionIndex = {
      byManagedId: new Map([['oc', rec], ['cl', rec], ['unregistered', rec]]),
      byPid: new Map(), byConversation: new Map(),
      managedCandidates: new Map([['oc', [{ file: rec, mtimeMs: 1 }]], ['cl', [{ file: rec, mtimeMs: 1 }]]]),
    }
    const harnessOf = (id: string) => ({ oc: 'opencode', cl: 'claude' } as Record<string, HarnessId>)[id]
    const out = scopeToRowHarness(index, harnessOf)
    expect([...out.byManagedId.keys()].sort()).toEqual(['cl', 'unregistered'])
    expect([...out.managedCandidates!.keys()]).toEqual(['cl'])
  })
})
