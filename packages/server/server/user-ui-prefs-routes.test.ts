import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { handleUserUiPrefs, type UserUiPrefsDeps } from './user-ui-prefs-routes'
import { routeCapability } from './capability-guard'

/** The machine's preferences file, in memory — the shape the real IO has. */
function world() {
  let machine: Record<string, unknown> = { chatEnabled: true, theme: 'dark', ui: { taskBoard: { view: 'board' } } }
  const deps: UserUiPrefsDeps = {
    readMachine: async () => machine,
    updateMachine: async mutate => { machine = { ...machine, ...mutate(machine) }; return machine },
  }
  const call = async (method: 'GET' | 'PUT', body?: unknown) => {
    const res = await handleUserUiPrefs(new Request('http://x/api/user-prefs', {
      method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), {}, deps)
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { machine: () => machine, call }
}

describe('/api/user-prefs — each key at its own home', () => {
  test('Nay persona writes use the shared server validator', async () => {
    const w = world()
    const bad = await w.call('PUT', { chatResponder: 'own-agent', chatWorkingDir: 'relative' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('existing absolute directory')
    const root = await mkdtemp('/tmp/nay-user-prefs-')
    const good = await w.call('PUT', { chatResponder: 'own-agent', chatWorkingDir: `${root}/.` })
    expect(good.status).toBe(200)
    expect(good.body.chatWorkingDir).toBe(root)
  })

  test('a legacy key stays top-level and a new key goes under ui', async () => {
    const w = world()
    await w.call('PUT', { theme: 'light', sessionsAside: { groupBy: 'status' } })
    expect(w.machine().theme).toBe('light')
    expect(w.machine().sessionsAside).toBeUndefined()
    expect(w.machine().ui).toEqual({ taskBoard: { view: 'board' }, sessionsAside: { groupBy: 'status' } })
    expect(w.machine().chatEnabled).toBe(true)
  })

  test('reads existing machine data with no migration', async () => {
    const w = world()
    expect((await w.call('GET')).body).toEqual({ theme: 'dark', taskBoard: { view: 'board' } })
  })

  test('a machine gate cannot ride along — the whole PUT is refused', async () => {
    const w = world()
    const r = await w.call('PUT', { theme: 'light', chatEnabled: false })
    expect(r.status).toBe(400)
    expect(w.machine().theme).toBe('dark')
    expect(w.machine().chatEnabled).toBe(true)
  })
})

describe('routing posture', () => {
  test('no host capability — it writes only the preferences store', () => {
    expect(routeCapability('/api/user-prefs')).toBeNull()
  })
})
