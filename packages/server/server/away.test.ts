import { afterEach, describe, expect, it } from 'bun:test'
import { AWAY_COOLDOWN_MS, AWAY_QUIET_MS, AWAY_SEND_TIMEOUT_MS, flushAwayNotices, awayStatus, readAwayView, resetAwayLiveDedupe, sendAwayNotice, sessionAwayStatus, setAway, setSessionAway, awaySessionRows, type AwaySessionRow, type AwayDeps, type SessionAwayDeps } from './away'
import { routeCapability } from './capability-guard'

const NOW = Date.now()
afterEach(() => resetAwayLiveDedupe())
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
  it('counts 4 waiting + 4 working + 89 running-truthy lost rows as 8, matching notice recipients', async () => {
    const rows: AwaySessionRow[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `waiting-${i}`, state: 'waiting', running: true })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `working-${i}`, state: 'working', running: true })),
      ...Array.from({ length: 89 }, (_, i) => ({ id: `lost-${i}`, state: 'lost', running: true })),
      ...['exited', 'closed', 'orphan'].map(state => ({ id: state, state, running: true })),
      { id: 'stopped', state: 'waiting', running: false },
    ]
    const typed: string[] = []
    const { d } = deps({ live: {
      rows: async () => rows,
      roleOf: async () => 'worker',
      prompt: async id => { typed.push(id); return { ok: true } },
    } })
    expect((await readAwayView(d)).activeSessions).toBe(8)
    await setAway({ on: true }, d)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS)).toBe(8)
    expect(typed).toEqual(rows.slice(0, 8).map(row => row.id))
  })
  it('uses fleet liveness, preserves dead registry flags for cleanup, and includes live external sessions', async () => {
    const rows = awaySessionRows([
      { id: 'waiting' }, { id: 'working' }, { id: 'lost', away: true },
      { id: 'exited' }, { id: 'closed' }, { id: 'orphan', away: true },
      { id: 'ended', endedAt: new Date(NOW).toISOString() },
    ], [
      { id: 'waiting', state: 'waiting' }, { id: 'working', state: 'working' },
      { id: 'lost', state: 'lost' }, { id: 'exited', state: 'exited' },
      { id: 'closed', state: 'closed' }, { id: 'ended', state: 'waiting' },
      { id: 'external', state: 'unknown' }, { id: 'approval', state: 'waiting-approval' },
    ])
    const { d } = deps({ live: {
      rows: async () => rows, roleOf: async () => 'worker', prompt: async () => ({ ok: true }),
    } })
    expect((await readAwayView(d)).activeSessions).toBe(4)
    expect(rows.find(row => row.id === 'orphan')).toMatchObject({ away: true, running: false })
    expect(rows.find(row => row.id === 'lost')).toMatchObject({ away: true, running: false })
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
  function sdeps(rows: AwaySessionRow[], global: unknown = undefined, over: Partial<SessionAwayDeps> = {}) {
    const patched: Array<[string, boolean]> = []
    const typed: Array<[string, string]> = []
    const d: SessionAwayDeps = {
      read: async () => global,
      verify: async (id, token) => (token === 'good' ? String(id) : null),
      roleOf: async id => (id === 'lead' ? 'leader' : 'worker'),
      rows: async () => rows,
      patch: async (id, away) => { patched.push([id, away]); const row = rows.find(r => r.id === id); if (row) row.away = away },
      prompt: async (id, text) => { typed.push([id, text]); return { ok: true } },
      now: () => NOW,
      ...over,
    }
    return { d, patched, typed }
  }
  it('switches one session on, records it and tells the running session', async () => {
    const { d, patched, typed } = sdeps([{ id: 's1', state: 'waiting', running: true }])
    const r = await setSessionAway({ target: 's1', on: true }, d)
    expect(r).toEqual({ ok: true, id: 's1', away: true, effective: true, queued: true })
    expect(typed).toEqual([])
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(patched).toEqual([['s1', true]])
    expect(typed[0]![1]).toContain('away mode is now ON for this session')
    expect(typed[0]![1]).toContain('Do not ask the owner anything')
  })
  it('switching off tells the session; a stopped one is only recorded', async () => {
    const a = sdeps([{ id: 's1', away: true, state: 'waiting', running: true }])
    expect(await setSessionAway({ target: 's1', on: false }, a.d)).toMatchObject({ ok: true, away: false, effective: false, queued: true })
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(a.typed[0]![1]).toContain('away mode is now OFF')
    const b = sdeps([{ id: 's2', conversationId: 'c2', state: 'exited', running: false }])
    expect(await setSessionAway({ target: 'c2', on: true }, b.d)).toMatchObject({ ok: true, id: 's2', queued: false })
    expect(b.typed).toEqual([])
    expect(b.patched).toEqual([['s2', true]])
  })
  it('under the global switch the effective state does not move, so nothing is typed', async () => {
    const { d, typed } = sdeps([{ id: 's1', away: true, state: 'waiting', running: true }], { on: true, since: '', until: null, authorised: [] })
    expect(await setSessionAway({ target: 's1', on: false }, d)).toMatchObject({ ok: true, effective: true, queued: true })
    expect(typed).toEqual([])
  })
  it('resolves a verified managed sender through its conversation role', async () => {
    const { d } = sdeps([{ id: 'managed-lead', conversationId: 'conv-lead', state: 'waiting', running: true }, { id: 's1', state: 'waiting', running: true }], undefined,
      { verify: async () => 'managed-lead', roleOf: async id => id === 'conv-lead' ? 'leader' : undefined })
    expect(await setSessionAway({ target: 's1', on: true, session: { id: 'conv-lead', token: 'good' } }, d)).toMatchObject({ ok: true })
  })
  it('active scope snapshots running sessions only and shares the global anti-flood queue', async () => {
    const { d, patched, typed } = sdeps([{ id: 'a', state: 'waiting', running: true }, { id: 'b', state: 'waiting', running: true }, { id: 'ended', state: 'exited', running: false }])
    await setSessionAway({ on: true, scope: 'active' }, d)
    await setSessionAway({ on: false, scope: 'active' }, d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(typed).toEqual([])
    expect(patched.map(p => p[0])).toEqual(['a', 'b', 'a', 'b'])
    await setSessionAway({ on: true, scope: 'active' }, d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(typed.map(p => p[0])).toEqual(['a', 'b'])
  })
  it('active scope and individual notices reject dead states even with running=true', async () => {
    const rows: AwaySessionRow[] = [
      { id: 'live', state: 'waiting', running: true },
      ...['lost', 'exited', 'closed', 'orphan'].map(state => ({ id: state, state, running: true })),
    ]
    const { d, patched, typed } = sdeps(rows)
    await setSessionAway({ on: true, scope: 'active' }, d)
    expect(patched).toEqual([['live', true]])
    for (const row of rows.slice(1)) {
      expect(await setSessionAway({ target: row.id, on: true }, d)).toMatchObject({ ok: true, queued: false })
    }
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS)).toBe(1)
    expect(typed.map(([id]) => id)).toEqual(['live'])
  })
  it('refusals: worker proof, unknown target, missing on', async () => {
    const { d } = sdeps([{ id: 's1', state: 'waiting', running: true }])
    const w = await setSessionAway({ target: 's1', on: true, session: { id: 'w1', token: 'good' } }, d)
    expect(sessionAwayStatus(w)).toBe(403)
    expect(await setSessionAway({ target: 's1', on: true, session: { id: 'lead', token: 'good' } }, d)).toMatchObject({ ok: true })
    const nf = await setSessionAway({ target: 'nope', on: true }, d)
    expect(sessionAwayStatus(nf)).toBe(404)
    expect(sessionAwayStatus(await setSessionAway({ target: 's1' }, d))).toBe(400)
  })
})

describe('away live fan-out and anti-flood', () => {
  function fleet() {
    let now = NOW
    const rows = [
      { id: 'L', conversationId: 'cL', state: 'waiting', running: true, away: false },
      { id: 'W', conversationId: 'cW', state: 'waiting', running: true, away: false },
      { id: 'X', conversationId: 'cX', state: 'exited', running: false, away: true },
    ]
    const typed: { id: string; text: string }[] = []
    const live = {
      rows: async () => rows.map(r => ({ ...r })),
      roleOf: async (id: string) => id === 'L' ? 'leader' as const : 'worker' as const,
      patch: async (id: string, away: boolean) => { rows.find(r => r.id === id)!.away = away },
      prompt: async (id: string, text: string) => { typed.push({ id, text }); return { ok: true } },
    }
    const { d } = deps({ live, now: () => now })
    return { rows, typed, live, d, at: (value: number) => { now = value } }
  }
  it('waits for quiet, reaches running sessions once, skips stopped sessions', async () => {
    const f = fleet()
    await setAway({ on: true, authorised: ['releases'] }, f.d)
    expect(f.typed).toEqual([])
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS - 1)).toBe(0)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS)).toBe(2)
    expect(f.typed.map(r => r.id)).toEqual(['L', 'W'])
    expect(f.typed[0]!.text).toContain('releases')
  })
  it('coalesces rapid on/off/on into the final permissions, workers hear only on/off', async () => {
    const f = fleet()
    await setAway({ on: true, authorised: ['releases'] }, f.d)
    f.at(NOW + 1_000); await setAway({ on: false }, f.d)
    f.at(NOW + 2_000); await setAway({ on: true, authorised: ['merges'] }, f.d)
    await flushAwayNotices(NOW + 2_000 + AWAY_QUIET_MS)
    expect(f.typed).toHaveLength(2)
    expect(f.typed[0]!.text).toContain('merge PRs')
    expect(f.typed[0]!.text).not.toContain('publish releases')
    f.at(NOW + AWAY_COOLDOWN_MS + 3_000)
    await setAway({ on: true, authorised: ['workers'] }, f.d)
    await flushAwayNotices(NOW + AWAY_COOLDOWN_MS + 3_000 + AWAY_QUIET_MS)
    expect(f.typed.map(r => r.id)).toEqual(['L', 'W', 'L'])
  })
  it('suppresses a final state equal to the initial state or last successful delivery', async () => {
    const f = fleet()
    await setAway({ on: true }, f.d); await setAway({ on: false }, f.d)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS)).toBe(0)
    await setAway({ on: true }, f.d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    f.typed.length = 0
    f.at(NOW + AWAY_QUIET_MS + 1)
    await setAway({ on: false }, f.d); await setAway({ on: true }, f.d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS + AWAY_COOLDOWN_MS)
    expect(f.typed).toEqual([])
  })
  it('caps each session at one delivery per five minutes, then delivers the latest state', async () => {
    const f = fleet()
    await setAway({ on: true }, f.d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    f.at(NOW + AWAY_QUIET_MS + 1)
    await setAway({ on: false }, f.d)
    expect(await flushAwayNotices(NOW + 2 * AWAY_QUIET_MS + 1)).toBe(0)
    expect((await readAwayView(f.d)).cooldownMs).toBeGreaterThan(0)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS + AWAY_COOLDOWN_MS - 1)).toBe(0)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS + AWAY_COOLDOWN_MS)).toBe(2)
    expect(f.typed[2]!.text).toContain('owner is back')
  })
  it('global OFF clears flags in ONE batched write when the registry supports it', async () => {
    const f = fleet()
    f.rows[0]!.away = true
    const batches: string[][] = []
    const live = { ...f.live, patch: async () => { throw new Error('patch loop used') },
      patchMany: async (ids: readonly string[]) => { batches.push([...ids]); for (const r of f.rows) if (ids.includes(r.id)) r.away = false } }
    const { d } = deps({ live, now: () => NOW })
    await setAway({ on: false }, d)
    expect(batches).toEqual([['L', 'X']])
    expect(f.rows.every(r => !r.away)).toBe(true)
  })
  it('global OFF clears all own flags immediately, including stopped sessions', async () => {
    const f = fleet()
    f.rows[0]!.away = true
    await setAway({ on: false }, f.d)
    expect(f.rows.every(r => !r.away)).toBe(true)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(f.typed).toHaveLength(1)
    expect(f.typed[0]!.text).toContain('OFF')
    // A later explicit session choice remains effective until the next global OFF.
    f.rows[0]!.away = true
    expect((await readAwayView(f.d)).active).toBe(false)
    expect(f.rows[0]!.away).toBe(true)
  })
  it('does not tell an exited session or the verified leader making the global change', async () => {
    const f = fleet()
    f.d.verify = async () => 'L'; f.d.roleOf = async () => 'leader'
    await setAway({ on: true, session: { id: 'cL', token: 'good' } }, f.d)
    f.rows[1]!.running = false
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(f.typed).toEqual([])
  })
  it('rechecks the resolved fleet state before delivering a queued notice', async () => {
    const f = fleet()
    await setAway({ on: true }, f.d)
    f.rows[0]!.state = 'lost'
    f.rows[1]!.state = 'exited'
    expect((await readAwayView(f.d)).activeSessions).toBe(0)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS)).toBe(0)
    expect(f.typed).toEqual([])
  })
  it('a later explicit individual ON survives global OFF, even when requested concurrently', async () => {
    const f = fleet()
    f.rows[0]!.away = true
    const sessionDeps: SessionAwayDeps = { read: f.d.read, verify: f.d.verify, roleOf: f.d.roleOf,
      rows: f.live.rows, patch: f.live.patch, prompt: f.live.prompt, now: f.d.now }
    const off = setAway({ on: false }, f.d)
    const on = setSessionAway({ target: 'L', on: true }, sessionDeps)
    await Promise.all([off, on])
    expect(f.rows[0]!.away).toBe(true)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(f.typed).toEqual([]) // The session already knew it was away: no redundant prompt.
  })
  it('retries failed delivery without remembering it as a successful notice', async () => {
    const f = fleet()
    let attempts = 0
    f.live.prompt = async (id, text) => {
      attempts++
      if (attempts <= 2) return { ok: false }
      f.typed.push({ id, text }); return { ok: true }
    }
    await setAway({ on: true }, f.d)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS)).toBe(0)
    expect(await flushAwayNotices(NOW + 2 * AWAY_QUIET_MS)).toBe(2)
    expect(f.typed.map(r => r.id)).toEqual(['L', 'W'])
  })
  it('redacts secret-looking notes in the delayed prompt', async () => {
    const f = fleet()
    await setAway({ on: true, note: 'api_key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, f.d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS)
    expect(f.typed[0]!.text).toContain('api_key=[REDACTED]')
    expect(f.typed[0]!.text).not.toContain('sk-ant-api03-AAAAAAAA')
  })
})

describe('away delivery fan-out — a dead session never holds the others', () => {
  function fleet(prompt: (id: string) => Promise<{ ok: boolean }>) {
    const ids = ['a', 'dead', 'b', 'slow', 'c']
    const rows = ids.map(id => ({ id, conversationId: `c${id}`, state: 'waiting', running: true, away: false }))
    const { d } = deps({ live: { rows: async () => rows.map(r => ({ ...r })), roleOf: async () => 'worker', prompt } })
    return d
  }
  it('bounds each send above the 4 s prompt ack, so a slow-but-alive pane is not cut off', () => {
    expect(AWAY_SEND_TIMEOUT_MS).toBeGreaterThan(4_000)
  })
  it('delivers to every live session while one send never settles', async () => {
    const typed: string[] = []
    const d = fleet(async id => {
      if (id === 'dead') await new Promise(() => {})
      typed.push(id); return { ok: true }
    })
    await setAway({ on: true }, d)
    expect(await flushAwayNotices(NOW + AWAY_QUIET_MS, 50)).toBe(4)
    expect(typed.sort()).toEqual(['a', 'b', 'c', 'slow'])
  })
  it('sends in parallel: a slow session does not delay the ones queued after it', async () => {
    const at: Record<string, number> = {}
    const start = Date.now()
    const d = fleet(async id => {
      await Bun.sleep(id === 'slow' ? 200 : 10)
      at[id] = Date.now() - start; return { ok: true }
    })
    await setAway({ on: true }, d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS, 1_000)
    expect(at.c!).toBeLessThan(at.slow!)
  })
  it('retries a timed-out session after quiet, and only that one', async () => {
    let deadAlive = false
    const typed: string[] = []
    const d = fleet(async id => {
      if (id === 'dead' && !deadAlive) await new Promise(() => {})
      typed.push(id); return { ok: true }
    })
    await setAway({ on: true }, d)
    await flushAwayNotices(NOW + AWAY_QUIET_MS, 20)
    deadAlive = true
    expect(await flushAwayNotices(NOW + 2 * AWAY_QUIET_MS - 1, 20)).toBe(0)
    expect(await flushAwayNotices(NOW + 2 * AWAY_QUIET_MS, 20)).toBe(1)
    expect(typed.filter(id => id === 'dead')).toEqual(['dead'])
  })
})
