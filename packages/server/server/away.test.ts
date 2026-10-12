import { describe, expect, it } from 'bun:test'
import { awayStatus, readAwayView, sendAwayNotice, setAway, type AwayDeps } from './away'
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
    expect(await readAwayView(deps().d)).toEqual({ state: { on: false, since: '', until: null, authorised: [], maxWorkers: 6, maxOpus: 2 }, active: false })
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
