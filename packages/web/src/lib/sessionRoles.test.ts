import { afterEach, describe, expect, it } from 'bun:test'
import { ensureRoleFresh, __resetRoleChecksForTest } from './sessionRoles'
import { getSessionRole, isWorkerMuted, leaderTitleFor, registerSessionRoleAlias, roleOriginLabel, setMuteWorkers, setSessionRole } from './sessionRoles'

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

  it('recognizes notification event names and both role identities', () => {
    setSessionRole('role-test-managed', 'worker')
    registerSessionRoleAlias('role-test-managed', 'role-test-conversation')
    setMuteWorkers(true)
    expect(isWorkerMuted('role-test-conversation', 'turn-done')).toBe(true)
    expect(isWorkerMuted('role-test-managed', 'responded')).toBe(true)
    expect(isWorkerMuted('role-test-conversation', 'needs-approval')).toBe(true)
    expect(isWorkerMuted('role-test-managed', 'exited')).toBe(false)
    setSessionRole('role-test-managed', null)
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

describe('ensureRoleFresh', () => {
  it('does not let a joiner reuse a GET that started before a role write', async () => {
    __resetRoleChecksForTest()
    const realFetch = globalThis.fetch
    let gets = 0
    const resolvers: Array<() => void> = []
    globalThis.fetch = (async (_u: unknown, init?: { method?: string }) => {
      if (init?.method === 'POST') return new Response('{}')
      gets++
      const n = gets
      await new Promise<void>(r => resolvers.push(r))
      return new Response(JSON.stringify({ roles: n === 1 ? {} : { 'rf-w': 'worker' } }))
    }) as typeof fetch
    try {
      const a = ensureRoleFresh('rf-a', 1000)
      setSessionRole('rf-w', 'worker') // write after GET #1 started
      const b = ensureRoleFresh('rf-w', 1001)
      await new Promise(r => setTimeout(r, 0))
      expect(gets).toBeGreaterThanOrEqual(2)
      while (resolvers.length) resolvers.shift()!()
      await Promise.all([a, b])
      expect(getSessionRole('rf-w')).toBe('worker')
    } finally { globalThis.fetch = realFetch; setSessionRole('rf-w', null) }
  })
  it('a role write invalidates the 10s memo', async () => {
    __resetRoleChecksForTest()
    const realFetch = globalThis.fetch
    let gets = 0
    globalThis.fetch = (async (_u: unknown, init?: { method?: string }) => {
      if (init?.method === 'POST') return new Response('{}')
      gets++
      return new Response(JSON.stringify({ roles: {} }))
    }) as typeof fetch
    try {
      await ensureRoleFresh('rf-m', 5000)
      const before = gets
      await ensureRoleFresh('rf-m', 5001)
      expect(gets).toBe(before)
      setSessionRole('rf-other', 'worker')
      await ensureRoleFresh('rf-m', 5002)
      expect(gets).toBeGreaterThan(before)
    } finally { globalThis.fetch = realFetch; setSessionRole('rf-other', null) }
  })
  it('a role written by another process: only a GET sent after the need is joined', async () => {
    __resetRoleChecksForTest()
    const realFetch = globalThis.fetch
    let gets = 0
    const resolvers: Array<() => void> = []
    globalThis.fetch = (async (_u: unknown, init?: { method?: string }) => {
      if (init?.method === 'POST') return new Response('{}')
      gets++
      const n = gets
      await new Promise<void>(r => resolvers.push(r))
      // GET #1 predates the server-side write (spawn/CLI/MCP); GET #2 sees it.
      return new Response(JSON.stringify({ roles: n === 1 ? {} : { 'rf-srv': 'worker' } }))
    }) as typeof fetch
    try {
      const sentBefore = Date.now()
      const a = ensureRoleFresh('rf-x', sentBefore, sentBefore - 1)
      await new Promise(r => setTimeout(r, 2))
      const early = ensureRoleFresh('rf-y', Date.now(), sentBefore - 1) // need older than GET #1: joins it
      await new Promise(r => setTimeout(r, 0))
      expect(gets).toBe(1)
      const b = ensureRoleFresh('rf-srv', Date.now(), Date.now()) // need arose after GET #1 was sent
      await new Promise(r => setTimeout(r, 0))
      expect(gets).toBe(2)
      while (resolvers.length) resolvers.shift()!()
      await Promise.all([a, early, b])
      expect(getSessionRole('rf-srv')).toBe('worker')
    } finally { globalThis.fetch = realFetch }
  })
})
