import { describe, expect, test } from 'bun:test'
import { handleUserUiPrefs, type UserUiPrefsDeps } from './user-ui-prefs-routes'
import { AUTH_PUBLIC, ADMIN_PATHS } from './index-routes'
import { routeCapability } from './capability-guard'

/** One machine file and a per-account document store, in memory — the shapes the real IO has. */
function world(central: boolean) {
  let machine: Record<string, unknown> = { team: { mode: 'central' }, chatEnabled: true, theme: 'dark', ui: { taskBoard: { view: 'board' } } }
  const accounts = new Map<string, Record<string, unknown>>()
  const deps: UserUiPrefsDeps = {
    central,
    accountOf: async req => req.headers.get('x-account'),
    readMachine: async () => machine,
    updateMachine: async mutate => { machine = { ...machine, ...mutate(machine) }; return machine },
    readAccount: async id => accounts.get(id) ?? null,
    writeAccount: async (id, patch) => { accounts.set(id, { ...(accounts.get(id) ?? {}), ...patch }) },
  }
  const call = async (method: 'GET' | 'PUT', account: string | null, body?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (account) headers['x-account'] = account
    const res = await handleUserUiPrefs(new Request('http://x/api/user-prefs', {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), {}, deps)
    return { status: res.status, writable: res.headers.get('X-Prefs-Writable'), body: await res.json() as Record<string, unknown> }
  }
  return { machine: () => machine, accounts, call }
}

describe('/api/user-prefs on a CENTRAL — per account, never the shared machine file', () => {
  test('two accounts do not see each other', async () => {
    const w = world(true)
    expect((await w.call('PUT', 'acct-a', { theme: 'light', pinnedSessions: ['s1'] })).status).toBe(200)
    expect((await w.call('PUT', 'acct-b', { theme: 'dark', sessionsAside: { groupBy: 'task' } })).status).toBe(200)
    expect((await w.call('GET', 'acct-a')).body).toEqual({ theme: 'light', pinnedSessions: ['s1'] })
    expect((await w.call('GET', 'acct-b')).body).toEqual({ theme: 'dark', sessionsAside: { groupBy: 'task' } })
  })

  test('an account with nothing stored reads empty — never the machine file\'s values', async () => {
    const w = world(true)
    const r = await w.call('GET', 'acct-new')
    expect(r.body).toEqual({})
    expect(r.writable).toBe('true')
  })

  test('a write never reaches the machine file everyone signed in shares', async () => {
    const w = world(true)
    await w.call('PUT', 'acct-a', { theme: 'light', lang: 'pt', taskBoard: { view: 'table' } })
    expect(w.machine().theme).toBe('dark')
    expect(w.machine().lang).toBeUndefined()
    expect(w.machine().ui).toEqual({ taskBoard: { view: 'board' } })
  })

  test('no account: defaults to read, a write refused, nothing stored anywhere', async () => {
    const w = world(true)
    const r = await w.call('GET', null)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({})
    expect(r.writable).toBe('false')
    expect((await w.call('PUT', null, { theme: 'light' })).status).toBe(409)
    expect(w.machine().theme).toBe('dark')
    expect(w.accounts.size).toBe(0)
  })
})

describe('/api/user-prefs on a MACHINE — each key at its own home', () => {
  test('a legacy key stays top-level and a new key goes under ui', async () => {
    const w = world(false)
    await w.call('PUT', null, { theme: 'light', sessionsAside: { groupBy: 'status' } })
    expect(w.machine().theme).toBe('light')
    expect(w.machine().sessionsAside).toBeUndefined()
    expect(w.machine().ui).toEqual({ taskBoard: { view: 'board' }, sessionsAside: { groupBy: 'status' } })
    expect(w.machine().chatEnabled).toBe(true)
  })

  test('reads existing machine data with no migration', async () => {
    const w = world(false)
    expect((await w.call('GET', null)).body).toEqual({ theme: 'dark', taskBoard: { view: 'board' } })
  })

  test('a machine gate cannot ride along — the whole PUT is refused', async () => {
    const w = world(false)
    const r = await w.call('PUT', null, { theme: 'light', chatEnabled: false })
    expect(r.status).toBe(400)
    expect(w.machine().theme).toBe('dark')
    expect(w.machine().chatEnabled).toBe(true)
  })
})

describe('routing posture — same as /api/accessibility', () => {
  test('authenticated by default: not public, not admin-only', () => {
    expect(AUTH_PUBLIC.has('/api/user-prefs')).toBe(false)
    expect(ADMIN_PATHS.has('/api/user-prefs')).toBe(false)
  })

  test('no host capability — it writes only the preferences stores', () => {
    expect(routeCapability('/api/user-prefs')).toBeNull()
  })
})
