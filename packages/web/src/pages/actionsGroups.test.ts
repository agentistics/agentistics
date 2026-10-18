import { describe, expect, test } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { groupCiSessions } from './actionsGroups'

const run = (id: string, remote: string | undefined, at: string, ci?: boolean) => ({
  session_id: id, git_remote: remote, start_time: at, ci,
}) as SessionMeta

describe('groupCiSessions', () => {
  test('drops non-CI sessions, including an absent CI flag', () => {
    expect(groupCiSessions([
      run('interactive', 'repo', '2026-10-17', false),
      run('unknown', 'repo', '2026-10-17'),
    ])).toEqual([])
    expect(groupCiSessions([])).toEqual([])
  })

  test('groups two remotes and orders groups and runs by newest start', () => {
    const old = run('old', 'github.com/team/a', '2026-10-15', true)
    const other = run('other', 'github.com/team/b', '2026-10-16', true)
    const newest = run('new', 'github.com/team/a', '2026-10-17', true)
    const input = [old, other, newest]
    expect(groupCiSessions(input)).toEqual([
      { remote: 'github.com/team/a', sessions: [newest, old] },
      { remote: 'github.com/team/b', sessions: [other] },
    ])
    expect(input).toEqual([old, other, newest])
  })

  test('empty and missing remotes share one last bucket even with the newest run', () => {
    const empty = run('empty', '', '2026-10-18', true)
    const missing = run('missing', undefined, '2026-10-17', true)
    const linked = run('linked', 'github.com/team/a', '2026-10-16', true)
    expect(groupCiSessions([empty, linked, missing])).toEqual([
      { remote: 'github.com/team/a', sessions: [linked] },
      { remote: '', sessions: [empty, missing] },
    ])
  })

  test('unknown timestamps sort after dated runs without losing them', () => {
    const unknown = run('unknown', 'a', 'invalid', true)
    const known = run('known', 'b', '2026-10-17', true)
    expect(groupCiSessions([unknown, known]).map(g => g.remote)).toEqual(['b', 'a'])
  })
})
