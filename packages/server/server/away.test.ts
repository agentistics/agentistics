import { describe, expect, it } from 'bun:test'
import { awayStatus, readAwayView, resetAwayLiveDedupe, sendAwayNotice, sessionAwayStatus, setAway, setSessionAway, type AwayDeps, type SessionAwayDeps } from './away'
import { routeCapability } from './capability-guard'

const NOW = Date.parse('2026-10-12T03:00:00.000Z')
function deps(over: Partial<AwayDeps> = {}) {
  let stored: unknown
  const d: AwayDeps = {
    read: async () => stored,
    write: async s => { stored = s },
    verify: async (id, token) => (token === 'good' ? String(id) : null),
    roleOf: async id => (id === 'lead' ? 'leader' : 'worker'),
    now: () => NOW,
    ...over,
  }
  return { d, stored: () => stored }
}

describe('away routes', () => {
  it('reads off by default', async () => {
    expect(await readAwayView(deps().d)).toEqual({ state: { on: false, since: '', until: null, authorised: [], maxWorkers: 6, topCaps: {} }, active: false })
  })
  it('the person (no session field) may set it, and it persists', async () => {
    const { d, stored } = deps()
    const r = await setAway({ on: true, authorised: ['releases'] }, d)
    expect(r).toMatchObject({ ok: true, active: true })
    expect(stored()).toMatchObject({ on: true, authorised: ['releases'], until: null })
    expect((await readAwayView(d)).active).toBe(true)
  })
  it('a verified leader may set it; a worker or a bad proof may not', async () => {
    expect(await setAway({ on: true, session: { id: 'lead', token: 'good' } }, deps().d)).toMatchObject({ ok: true })
    const w = await setAway({ on: true, session: { id: 'w1', token: 'good' } }, deps().d)
    expect(w).toEqual({ ok: false, error: 'leader_only' })
    expect(awayStatus(w)).toBe(403)
    expect(await setAway({ on: false, session: { id: 'lead', token: 'bad' } }, deps().d)).toEqual({ ok: false, error: 'unverified_sender' })
  })
  it('a bad input is a 400 and writes nothing', async () => {
    const { d, stored } = deps()
    const r = await setAway({ on: true, authorised: ['everything'] }, d)
    expect(awayStatus(r)).toBe(400)
    expect(stored()).toBeUndefined()
  })
  it('the route is host power (localShell)', () => {
    expect(routeCapability('/api/away')).toBe('localShell')
  })
})

describe('away notice', () => {
  it('only a verified leader, only while away, and secrets are redacted', async () => {
    const sent: string[] = []
    const { d } = deps({ notify: t => { sent.push(t) } })
    expect(await sendAwayNotice({ text: 'x', session: { id: 'lead', token: 'good' } }, d)).toEqual({ ok: false, error: 'not_away' })
    await setAway({ on: true }, d)
    expect(await sendAwayNotice({ text: 'x', session: { id: 'w1', token: 'good' } }, d)).toEqual({ ok: false, error: 'leader_only' })
    expect(await sendAwayNotice({ text: 'x' }, d)).toEqual({ ok: false, error: 'unverified_sender' })
    expect(await sendAwayNotice({ text: '', session: { id: 'lead', token: 'good' } }, d)).toEqual({ ok: false, error: 'bad_notice' })
    const r = await sendAwayNotice({ text: 'release out; key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', session: { id: 'lead', token: 'good' } }, d)
    expect(r).toEqual({ ok: true })
    expect(sent[0]).toStartWith('release out')
    expect(sent[0]).not.toContain('AAAAAAAAAAAAAAAAAAAA')
    expect(routeCapability('/api/away/notice')).toBe('localShell')
  })
})

describe('per-session away route', () => {
  function sdeps(rows: { id: string; conversationId?: string; away?: boolean; running: boolean }[], global: unknown = undefined, over: Partial<SessionAwayDeps> = {}) {
    const patched: Array<[string, boolean]> = []
    const typed: Array<[string, string]> = []
    const d: SessionAwayDeps = {
      read: async () => global,
      verify: async (id, token) => (token === 'good' ? String(id) : null),
      roleOf: async id => (id === 'lead' ? 'leader' : 'worker'),
      rows: async () => rows,
      patch: async (id, away) => { patched.push([id, away]) },
      prompt: async (id, text) => { typed.push([id, text]); return { ok: true } },
      now: () => NOW,
      ...over,
    }
    return { d, patched, typed }
  }
  it('switches one session on, records it and tells the running session', async () => {
    const { d, patched, typed } = sdeps([{ id: 's1', running: true }])
    const r = await setSessionAway({ target: 's1', on: true }, d)
    expect(r).toEqual({ ok: true, id: 's1', away: true, effective: true, notified: true })
    expect(patched).toEqual([['s1', true]])
    expect(typed[0]![1]).toContain('away mode is now ON for this session')
    expect(typed[0]![1]).toContain('Do not ask the owner anything')
  })
  it('switching off tells the session; a stopped one is only recorded', async () => {
    const a = sdeps([{ id: 's1', away: true, running: true }])
    expect(await setSessionAway({ target: 's1', on: false }, a.d)).toMatchObject({ ok: true, away: false, effective: false, notified: true })
    expect(a.typed[0]![1]).toContain('away mode is now OFF')
    const b = sdeps([{ id: 's2', conversationId: 'c2', running: false }])
    expect(await setSessionAway({ target: 'c2', on: true }, b.d)).toMatchObject({ ok: true, id: 's2', notified: false })
    expect(b.typed).toEqual([])
    expect(b.patched).toEqual([['s2', true]])
  })
  it('under the global switch the effective state does not move, so nothing is typed', async () => {
    const { d, typed } = sdeps([{ id: 's1', away: true, running: true }], { on: true, since: '', until: null, authorised: [] })
    expect(await setSessionAway({ target: 's1', on: false }, d)).toMatchObject({ ok: true, effective: true, notified: false })
    expect(typed).toEqual([])
  })
  it('refusals: worker proof, unknown target, missing on', async () => {
    const { d } = sdeps([{ id: 's1', running: true }])
    const w = await setSessionAway({ target: 's1', on: true, session: { id: 'w1', token: 'good' } }, d)
    expect(sessionAwayStatus(w)).toBe(403)
    expect(await setSessionAway({ target: 's1', on: true, session: { id: 'lead', token: 'good' } }, d)).toMatchObject({ ok: true })
    const nf = await setSessionAway({ target: 'nope', on: true }, d)
    expect(sessionAwayStatus(nf)).toBe(404)
    expect(sessionAwayStatus(await setSessionAway({ target: 's1' }, d))).toBe(400)
  })
})

describe('away live fan-out', () => {
  const rowsList = [
    { id: 'L', conversationId: 'cL', running: true },
    { id: 'W', conversationId: 'cW', running: true },
    { id: 'X', running: false },
  ]
  const roles: Record<string, 'leader' | 'worker'> = { L: 'leader', W: 'worker' }
  function live() {
    const typed: { id: string; text: string }[] = []
    return {
      typed,
      live: {
        rows: async () => rowsList,
        roleOf: async (id: string) => roles[id],
        prompt: async (id: string, text: string) => { typed.push({ id, text }); return { ok: true } },
      },
    }
  }

  it('on: every live leader and worker hears it, exited sessions do not', async () => {
    resetAwayLiveDedupe()
    const l = live()
    const { d } = deps({ live: l.live })
    const r = await setAway({ on: true, authorised: ['releases'] }, d)
    expect(r).toMatchObject({ ok: true, notified: 2 })
    expect(l.typed.map(t => t.id).sort()).toEqual(['L', 'W'])
    expect(l.typed.find(t => t.id === 'L')!.text).toContain('releases')
  })

  it('an authorisation change reaches the leader only; the same state again is not repeated', async () => {
    resetAwayLiveDedupe()
    const l = live()
    const { d } = deps({ live: l.live })
    await setAway({ on: true }, d)
    l.typed.length = 0
    await setAway({ on: true, authorised: ['merges'] }, d)
    expect(l.typed.map(t => t.id)).toEqual(['L'])
    expect(l.typed[0]!.text).toContain('UPDATED')
    l.typed.length = 0
    await setAway({ on: true, authorised: ['merges'] }, d)
    expect(l.typed).toEqual([])
  })

  it('off tells the running sessions the owner is back', async () => {
    resetAwayLiveDedupe()
    const l = live()
    const { d } = deps({ live: l.live })
    await setAway({ on: true }, d)
    l.typed.length = 0
    await setAway({ on: false }, d)
    expect(l.typed.map(t => t.id).sort()).toEqual(['L', 'W'])
    expect(l.typed[0]!.text).toContain('OFF')
  })

  it('a session in its own away mode is not told the global OFF', async () => {
    resetAwayLiveDedupe()
    const l = live()
    l.live.rows = async () => [{ id: 'L', running: true, away: true }]
    const { d } = deps({ live: l.live })
    await setAway({ on: true }, d)
    l.typed.length = 0
    await setAway({ on: false }, d)
    expect(l.typed.every(t => !t.text.includes('now OFF'))).toBe(true)
  })
})
