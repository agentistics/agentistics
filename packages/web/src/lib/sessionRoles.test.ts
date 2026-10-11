import { afterEach, describe, expect, it } from 'bun:test'
import { getSessionRole, isWorkerMuted, leaderTitleFor, roleOriginLabel, setMuteWorkers, setSessionRole } from './sessionRoles'

const ids = ['role-test-worker', 'role-test-leader', 'role-test-unknown']

afterEach(() => {
  for (const id of ids) setSessionRole(id, null)
  setMuteWorkers(false)
})

describe('session roles', () => {
  it('reads and clears the manual role accessor', () => {
    expect(getSessionRole(ids[0]!)).toBeUndefined()
    setSessionRole(ids[0]!, 'worker')
    expect(getSessionRole(ids[0]!)).toBe('worker')
    setSessionRole(ids[0]!, null)
    expect(getSessionRole(ids[0]!)).toBeUndefined()
  })

  it('mutes only active workers', () => {
    setSessionRole(ids[0]!, 'worker')
    setSessionRole(ids[1]!, 'leader')
    setMuteWorkers(true)
    expect(isWorkerMuted(ids[0]!, 'working')).toBe(true)
    expect(isWorkerMuted(ids[0]!, 'exited')).toBe(false)
    expect(isWorkerMuted(ids[1]!, 'working')).toBe(false)
    expect(isWorkerMuted(ids[2]!, 'working')).toBe(false)
  })
})

describe('roleOriginLabel (the ⓘ wording)', () => {
  it('says the person set it for manual and for an entry with no origin', () => {
    expect(roleOriginLabel('manual', true)).toBe('definido por você')
    expect(roleOriginLabel(undefined, true)).toBe('definido por você')
    expect(roleOriginLabel('manual', false)).toBe('set by you')
  })
  it('names the leader session by title when known', () => {
    expect(roleOriginLabel({ leader: 'p' }, true, 'Líder X')).toBe('definido pelo líder Líder X')
    expect(roleOriginLabel({ leader: 'p' }, false, 'Lead X')).toBe('set by leader Lead X')
    expect(roleOriginLabel({ leader: 'p' }, true)).toBe('definido por um líder')
  })
  it('says the session set it itself for auto', () => {
    expect(roleOriginLabel('auto', true)).toBe('definido pela própria sessão')
    expect(roleOriginLabel('auto', false)).toBe('set by the session itself')
  })
})

describe('leaderTitleFor', () => {
  it('names the parent only when it is the leader that set the role', () => {
    expect(leaderTitleFor({ leader: 'p' }, { id: 'p', title: 'Lead' })).toBe('Lead')
    expect(leaderTitleFor({ leader: 'p' }, { id: 'other', title: 'Other' })).toBeUndefined()
    expect(leaderTitleFor({ leader: 'p' }, null)).toBeUndefined()
    expect(leaderTitleFor('manual', { id: 'p', title: 'Lead' })).toBeUndefined()
  })
})
