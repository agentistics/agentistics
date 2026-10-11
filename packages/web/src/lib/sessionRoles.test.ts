import { afterEach, describe, expect, it } from 'bun:test'
import { getSessionRole, isWorkerMuted, setMuteWorkers, setSessionRole } from './sessionRoles'

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
