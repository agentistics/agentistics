import { expect, test } from 'bun:test'
import { cliStrings } from '../cli-i18n'
import { reconcileSessions } from './session-ref'
import { buildSessionViews } from './session-view'
import { toControlSession } from './control-session'
import type { ManagedSession } from './types'
import { buildTeams, isLive } from '../../../web/src/lib/asideTabs'

// Same label, harness, directory and task; distinct conversations are distinct leaders.
const predecessor: ManagedSession = {
  id: 'old', harness: 'claude', cwd: '/repo', createdAt: '2026-10-25T00:00:00Z',
  label: '[ LEADER ] - Motor', conversationId: 'c-old', taskId: 't-engine', handoffTo: 'new',
}
const successor: ManagedSession = {
  ...predecessor, id: 'new', conversationId: 'c-new', handoffTo: undefined, handoffFrom: 'old',
}
const worker: ManagedSession = {
  id: 'worker', harness: 'claude', cwd: '/repo', createdAt: predecessor.createdAt,
  conversationId: 'c-worker', parentSessionId: 'new', parentConversationId: 'c-new',
}

function teams(registry: ManagedSession[]) {
  const backend = registry.filter(r => !r.endedAt).map(r => ({
    id: r.id, createdMs: 1, lastActivityMs: 2, attached: false, alive: true,
  }))
  const views = buildSessionViews({
    reconciled: reconcileSessions(registry, backend), processes: [],
    activity: new Map(backend.map(r => [r.id, 'working' as const])),
  })
  const rows = views.map(v => toControlSession(v, cliStrings('en'))).filter(r => isLive(r.state))
  return buildTeams(rows, {
    isLeader: r => r.id !== 'worker', pinned: () => false, keyOf: r => r.conversationId ?? r.id,
  })
}

test('handoff: both live registry rows remain separate leaders and the team appears once', () => {
  const out = teams([predecessor, successor, worker])
  expect(out.teams.map(t => [t.leader.id, t.members.map(m => m.id)])).toEqual([
    ['old', []], ['new', ['worker']],
  ])
  expect(out.loose).toEqual([])
})

test('handoff: ending the predecessor leaves the successor with its whole team', () => {
  const out = teams([{ ...predecessor, endedAt: '2026-10-25T01:00:00Z' }, successor, worker])
  expect(out.teams.map(t => [t.leader.id, t.members.map(m => m.id)])).toEqual([['new', ['worker']]])
})

test('handoff: failed spawn leaves the original leader and team visible', () => {
  const { handoffTo: _, ...original } = predecessor
  const out = teams([original, { ...worker, parentSessionId: 'old', parentConversationId: 'c-old' }])
  expect(out.teams.map(t => [t.leader.id, t.members.map(m => m.id)])).toEqual([['old', ['worker']]])
})
