import { describe, expect, test } from 'bun:test'
import { TEAM_MOVE, TEAM_UNLINK, leaderPickerEntries, looseFacts, teamLeaderChoices, teamMenuExtras } from './teamMenu'

const r = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, state: 'waiting' as const, ...extra })
const motor = r('L1', { title: '[ LÍDER ] - Motor', conversationId: 'c1' })
const side = r('L2', { title: '[ LÍDER ] - Side Tasks' })

describe('team menu entries', () => {
  test('a member gets "take out" and "move to…"; an orphan only "move to…"', () => {
    const member = r('w', { parentSessionId: 'L1' })
    expect(teamMenuExtras(member, false, [motor, side], true).map(e => [e.action, e.label, e.enabled]))
      .toEqual([[TEAM_UNLINK, 'Tirar da equipe', true], [TEAM_MOVE, 'Mover para a equipe de…', true]])
    expect(teamMenuExtras(r('o'), false, [motor], false).map(e => e.action)).toEqual([TEAM_MOVE])
  })
  test('a leader gets no team entries — it stays at the root', () => {
    expect(teamMenuExtras(motor, true, [motor, side], true)).toEqual([])
    expect(teamMenuExtras(undefined, false, [motor], true)).toEqual([])
  })
  test('no other leader: the move entry is disabled and says why', () => {
    const e = teamMenuExtras(r('w', { parentConversationId: 'c1' }), false, [motor], true).find(x => x.action === TEAM_MOVE)!
    expect(e.enabled).toBe(false)
    expect(e.reason).toBe('Não há outro líder ativo.')
  })
  test('the picker lists other leaders by display title, never the current one', () => {
    const member = r('w', { parentSessionId: 'L1' })
    expect(teamLeaderChoices(member, [motor, side]).map(l => l.id)).toEqual(['L2'])
    expect(leaderPickerEntries(member, [motor, side], true)).toEqual([{ action: 'L2', label: 'Side Tasks', enabled: true, leader: true, leaderLabel: 'Líder' }])
  })
})

describe('"No leader" rows say what they are', () => {
  test('project and who started it', () => {
    const rows = [motor]
    expect(looseFacts({ project: 'agentistics', parentSessionId: 'L1' }, rows, true)).toBe('agentistics · criada por Motor')
    expect(looseFacts({ project: 'x', projectGroup: 'Agentistics' }, rows, false)).toBe('Agentistics')
    expect(looseFacts({ project: '' }, rows, false)).toBe('')
    // a parent that left the fleet has no name to show — never a bare id
    expect(looseFacts({ project: 'agentistics', parentSessionId: 'gone' }, rows, true)).toBe('agentistics')
  })
})
