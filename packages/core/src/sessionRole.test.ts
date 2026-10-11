import { describe, expect, test } from 'bun:test'
import { hasRolePrefix, roleChangeNote, roleLine, rolePrefix, stripRolePrefix, titleForRole } from './sessionRole'

describe('role title prefix', () => {
  test('leader adds the prefix in the UI language, keeping the title', () => {
    expect(titleForRole('Fix login', 'leader', 'en')).toBe('[ LEADER ] - Fix login')
    expect(titleForRole('Corrigir login', 'leader', 'pt')).toBe('[ LÍDER ] - Corrigir login')
  })
  test('is idempotent and never doubles, across languages', () => {
    const once = titleForRole('Fix login', 'leader', 'en')
    expect(titleForRole(once, 'leader', 'en')).toBe(once)
    expect(titleForRole(once, 'leader', 'pt')).toBe('[ LÍDER ] - Fix login')
    expect(titleForRole('[ LEADER ] - [ LÍDER ] - x', 'leader', 'en')).toBe('[ LEADER ] - x')
  })
  test('worker, auto and null strip the prefix', () => {
    expect(titleForRole('[ LÍDER ] - Corrigir', 'worker', 'pt')).toBe('Corrigir')
    expect(titleForRole('[ LEADER ] - Fix', null, 'en')).toBe('Fix')
    expect(titleForRole('Plain', undefined, 'en')).toBe('Plain')
  })
  test('strip tolerates spacing and accent variants, and leaves ordinary brackets', () => {
    expect(stripRolePrefix('[LIDER]- x')).toBe('x')
    expect(stripRolePrefix('[ leader ] x')).toBe('x')
    expect(stripRolePrefix('[WIP] leader notes')).toBe('[WIP] leader notes')
    expect(hasRolePrefix('[ LEADER ] - x')).toBe(true)
    expect(hasRolePrefix('x')).toBe(false)
    expect(rolePrefix('en')).toBe('[ LEADER ] - ')
  })
  test('an empty title with leader yields the bare tag', () => {
    expect(titleForRole('', 'leader', 'en')).toBe('[ LEADER ]')
  })
})

describe('role lines', () => {
  test('each stored role has its own line; none keeps the decide-from-request line', () => {
    expect(roleLine('leader')).toContain('LEADER')
    expect(roleLine('worker')).toContain('WORKER')
    expect(roleLine(undefined)).toContain('decide from the request')
    expect(roleLine('leader')).not.toContain('decide from the request')
    // AUTO: the session must record its decision, either way, with the tool.
    expect(roleLine(undefined)).toContain('agentistics_session_role')
    expect(roleLine(undefined)).toContain('role "worker"')
    expect(roleLine(undefined)).toContain('role "leader"')
    expect(roleLine('leader')).not.toContain('agentistics_session_role')
  })
  test('the change note quotes the role line', () => {
    expect(roleChangeNote('leader')).toBe(`[agentistics] your role is now LEADER — ${roleLine('leader')}`)
    expect(roleChangeNote(null)).toContain('AUTO')
  })
})

describe('role origin', () => {
  test('parseRoleOrigin accepts the three shapes only', async () => {
    const { parseRoleOrigin } = await import('./sessionRole')
    expect(parseRoleOrigin('manual')).toBe('manual')
    expect(parseRoleOrigin('auto')).toBe('auto')
    expect(parseRoleOrigin({ leader: 'x' })).toEqual({ leader: 'x' })
    expect(parseRoleOrigin({ leader: '' })).toBeUndefined()
    expect(parseRoleOrigin('boss')).toBeUndefined()
    expect(parseRoleOrigin(null)).toBeUndefined()
  })
})
