import { expect, test } from 'bun:test'
import {
  autoUnfold, buildTeams, dedupeEnded, endedAge, fellAge, endedSections, isAsideTab, liveAge, teamSummary, waitingIds, type TeamRow,
} from './asideTabs'

const r = (id: string, state: TeamRow['state'], extra: Partial<TeamRow> = {}): TeamRow => ({ id, state, title: id, ...extra })
const leaders = new Set(['L1', 'L2'])
const opts = (pins: string[] = []) => ({
  isLeader: (x: TeamRow) => leaders.has(x.id),
  pinned: (x: TeamRow) => pins.includes(x.id),
  keyOf: (x: TeamRow) => `k:${x.id}`,
})

test('members sit under the leader that started them, by managed or conversation id', () => {
  const rows = [
    r('L1', 'working', { conversationId: 'c1' }), r('L2', 'waiting'),
    r('a', 'working', { parentSessionId: 'L1' }), r('b', 'waiting', { parentConversationId: 'c1' }),
    r('c', 'working', { parentSessionId: 'L2' }), r('loose', 'waiting'), r('orphan', 'working', { parentSessionId: 'gone' }),
  ]
  const { teams, loose } = buildTeams(rows, opts())
  expect(teams.map(t => [t.key, t.members.map(m => m.id)])).toEqual([['k:L1', ['a', 'b']], ['k:L2', ['c']]])
  expect(loose.map(x => x.id)).toEqual(['loose', 'orphan'])
})

test('a pinned leader sorts first and no row is drawn twice', () => {
  const rows = [r('L1', 'working'), r('L2', 'working'), r('x', 'working', { parentSessionId: 'L2' }), r('y', 'working'), r('z', 'working')]
  const { teams, loose } = buildTeams(rows, opts(['L2', 'z']))
  expect(teams.map(t => t.leader.id)).toEqual(['L2', 'L1'])
  expect(loose.map(x => x.id)).toEqual(['z', 'y'])
  const all = [...teams.flatMap(t => [t.leader, ...t.members]), ...loose].map(x => x.id)
  expect(new Set(all).size).toBe(all.length)
  expect(all.sort()).toEqual(rows.map(x => x.id).sort())
})

test('a leader started by another leader is its own team, never nested', () => {
  const { teams } = buildTeams([r('L1', 'working'), r('L2', 'working', { parentSessionId: 'L1' })], opts())
  expect(teams.map(t => t.members.length)).toEqual([0, 0])
})

test('team summary names the waiting members', () => {
  expect(teamSummary([r('a', 'working'), r('b', 'waiting'), r('c', 'waiting-approval')], true)).toBe('3 na equipe · 2 esperando você')
  expect(teamSummary([r('a', 'working')], false)).toBe('1 in the team')
})

test('a folded team unfolds only when a member STARTS waiting', () => {
  const team = (state: TeamRow['state']) => [{ key: 'k:L1', leader: r('L1', 'working'), members: [r('a', state)] }]
  const folded = ['k:L1', 'k:other']
  expect(autoUnfold(folded, team('working'), new Set())).toBe(folded)
  expect(autoUnfold(folded, team('waiting'), new Set(['a']))).toBe(folded)
  expect(autoUnfold(folded, team('waiting'), new Set())).toEqual(['k:other'])
  expect(waitingIds([r('a', 'waiting'), r('b', 'working')])).toEqual(new Set(['a']))
})

test('ended rows land in exactly one section, fell first', () => {
  const now = new Date(2026, 9, 23, 18, 0).getTime()
  const today = new Date(2026, 9, 23, 13, 51).getTime()
  const old = new Date(2026, 9, 20, 9, 0).getTime()
  const rows = [
    r('live', 'working'), r('fell', 'lost', { endedAt: today }), r('pinned', 'closed', { endedAt: old }),
    r('done', 'exited', { endedAt: today }), r('old', 'closed', { endedAt: old }), r('noEnd', 'closed'),
  ]
  const s = endedSections(rows, { fellIds: new Set(['fell']), keep: x => x.id === 'pinned', now })
  expect([s.fell, s.sleeping, s.today, s.older].map(l => l.map(x => x.id))).toEqual([['fell'], ['pinned'], ['done'], ['old', 'noEnd']])
  expect(endedAge(rows[3]!, now, true)).toBe('13:51')
  expect(endedAge(r('y', 'closed', { endedAt: now - 86_400_000 }), now, true)).toBe('ontem')
  expect(endedAge(r('n', 'closed'), now, true)).toBeNull()
})

test('live age reads the last message, then the start, and never invents one', () => {
  const now = 10 * 60_000
  expect(liveAge(r('a', 'waiting', { lastUserMessageAt: now - 3 * 60_000, startedAt: 0 }), now, true)).toBe('3 min')
  expect(liveAge(r('a', 'working', { startedAt: now - 20_000 }), now, true)).toBe('agora')
  expect(liveAge(r('a', 'working'), now, true)).toBeNull()
  expect(isAsideTab('ended')).toBe(true)
  expect(isAsideTab('x')).toBe(false)
})

test('a fallen row says how long ago it went down', () => {
  expect(fellAge(r('f', 'lost', { endedAt: 0 }), 3 * 3_600_000, true)).toBe('há 3 h')
  expect(fellAge(r('f', 'lost', { endedAt: 0 }), 10 * 60_000, false)).toBe('10 min ago')
  expect(fellAge(r('f', 'lost'), 0, true)).toBeNull()
})

test('only pinned ended leaders and workers sleep; falls take precedence over pins', () => {
  const now = Date.now()
  const rows = [
    r('pinned-leader', 'closed', { title: '[ LEADER ] - Kept', endedAt: now }),
    r('unpinned-leader', 'closed', { title: '[ LEADER ] - Finished', endedAt: now }),
    r('pinned-worker', 'exited', { endedAt: now }),
    r('pinned-fell', 'lost', { endedAt: now }),
    r('live-pin', 'working'),
  ]
  const pinned = new Set(['pinned-leader', 'pinned-worker', 'pinned-fell', 'live-pin'])
  const sections = endedSections(rows, { fellIds: new Set(['pinned-fell']), keep: x => pinned.has(x.id), now })
  expect(sections.sleeping.map(x => x.id)).toEqual(['pinned-leader', 'pinned-worker'])
  expect(sections.today.map(x => x.id)).toEqual(['unpinned-leader'])
  expect(sections.fell.map(x => x.id)).toEqual(['pinned-fell'])
  expect(pinned.size).toBe(4)
})

test('a conversation ended twice is one finished row; live rows and distinct conversations stay', () => {
  const t = 1_000_000
  const rows = [
    r('a1', 'exited', { conversationId: 'c1', title: 'USO', endedAt: t }),
    r('a2', 'closed', { conversationId: 'c1', title: 'USO', endedAt: t - 120_000 }),
    r('b1', 'exited', { conversationId: 'c2', title: 'USO', endedAt: t - 60_000 }),
    r('live', 'working', { conversationId: 'c1', title: 'USO' }),
  ]
  expect(dedupeEnded(rows).map(x => x.id)).toEqual(['a1', 'b1', 'live'])
})

test('unlinked twins with one title ended minutes apart merge; far apart or different titles do not', () => {
  const t = 5_000_000
  const rows = [
    r('x1', 'exited', { title: 'QA', endedAt: t }),
    r('x2', 'exited', { title: 'QA', endedAt: t - 90_000 }),
    r('x3', 'exited', { title: 'QA', endedAt: t - 3_600_000 }),
    r('y', 'exited', { title: 'Other', endedAt: t - 30_000 }),
  ]
  expect(dedupeEnded(rows).map(x => x.id)).toEqual(['x1', 'x3', 'y'])
  const s = endedSections(rows, { fellIds: new Set(), keep: () => false, now: t })
  expect(s.today.length + s.older.length).toBe(3)
})
