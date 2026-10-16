import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { createRetireRunner, MCP_COMMAND_SOURCES, type RetireRunnerDeps } from './retire-runner'
import type { SessionSnapshot } from './sessions-host'
import type { SessionView } from './session-view'
import type { ManagedSession, RetireRequest, SessionActivity } from './types'
import type { SessionPatch } from './registry'

const T0 = Date.parse('2026-10-16T10:00:00.000Z')

function world(retire: RetireRequest, extra: ManagedSession[] = []) {
  let now = T0
  const rows: ManagedSession[] = [
    { id: 'p1', harness: 'claude', cwd: '/w', createdAt: new Date(T0).toISOString(), taskId: 't1', conversationId: 'c1', retire },
    ...extra,
  ]
  const calls = { kill: [] as string[], ended: [] as string[], filed: [] as string[], comments: [] as string[], notes: [] as string[], refresh: 0, probes: 0 }
  let bg: number | null = 0
  const deps: RetireRunnerDeps = {
    readRegistry: async () => rows.map(r => ({ ...r })),
    async patch(id: string, p: SessionPatch) {
      const i = rows.findIndex(r => r.id === id)
      if (i < 0) return false
      const next = { ...rows[i]!, ...p } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) if (v === null) delete next[k]
      rows[i] = next as unknown as ManagedSession
      return true
    },
    async kill(id) { calls.kill.push(id); return true },
    async markEnded(id) { calls.ended.push(id); await deps.patch(id, { endedAt: new Date(now).toISOString() }) },
    async fileInFolder(f, row) { calls.filed.push(`${f}:${row.id}`); return true },
    async bgTasks() { calls.probes++; return bg },
    async children() { return { checked: true, children: [] } },
    async comment(_t, body) { calls.comments.push(body) },
    notify(_l, title) { calls.notes.push(title) },
    refresh() { calls.refresh++ },
    now: () => now,
  }
  const view = (id: string, activity: SessionActivity, status: SessionView['status'] = 'running'): SessionView =>
    ({ id, cwd: '/w', status, activity, attached: false, approvalDetection: true, searchFields: {} as SessionView['searchFields'] })
  const snap = (views: SessionView[], unavailable?: string): SessionSnapshot =>
    ({ sessions: views, attention: 0, rang: [], polledAtMs: now, ...(unavailable ? { unavailable } : {}) })
  return {
    rows, calls, deps, view, snap,
    advance(ms: number) { now += ms },
    setBg(n: number | null) { bg = n },
  }
}

const req = (over: Partial<RetireRequest> = {}): RetireRequest => ({
  requestedAt: new Date(T0).toISOString(), by: 'p1', quietForMs: 10_000,
  deadlineAt: new Date(T0 + 60_000).toISOString(), folderId: 'fin', ...over,
})

describe('retire runner on the hub', () => {
  it('a working session is killed only after it is confirmed idle for quietFor — exactly once', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'working')]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'working')]))
    expect(w.calls.kill).toEqual([])
    // Goes idle: first poll is not confirmation; the probes do not run yet.
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
    expect(w.calls.probes).toBe(0)
    w.advance(5000)
    const s = w.snap([w.view('p1', 'waiting')])
    // The same snapshot delivered twice, concurrently: one kill.
    await Promise.all([r.consume(s), r.consume(s)])
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual(['p1'])
    expect(w.calls.ended).toEqual(['p1'])
    expect(w.calls.filed).toEqual(['fin:p1'])
    expect(w.calls.comments).toHaveLength(1)
    expect(w.calls.refresh).toBe(1)
    expect('retire' in w.rows[0]!).toBe(false)
  })

  it('a busy session past the deadline is NOT killed: the request expires with the reason', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    for (let i = 0; i < 13; i++) { await r.consume(w.snap([w.view('p1', 'working')])); w.advance(5000) }
    expect(w.calls.kill).toEqual([])
    expect(w.rows[0]!.retire?.expiredAt).toBeDefined()
    expect(w.rows[0]!.retire?.expiredReason).toBe('still working')
    expect(w.calls.notes).toEqual(['Retire expired'])
    // Expired is final: going idle later kills nothing.
    for (let i = 0; i < 5; i++) { await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000) }
    expect(w.calls.kill).toEqual([])
  })

  it('a running background task holds the kill; waiting-approval breaks the streak', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    w.setBg(1)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000)
    expect(w.calls.kill).toEqual([])
    w.setBg(0)
    await r.consume(w.snap([w.view('p1', 'waiting-approval')])); w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000)
    expect(w.calls.kill).toEqual([])
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual(['p1'])
  })

  it('a stale (unavailable) snapshot advances nothing', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')], 'poll failed'))
    expect(w.calls.kill).toEqual([])
  })

  it('a dead successor cancels the request and kills nothing', async () => {
    const succ: ManagedSession = { id: 's1', harness: 'codex', cwd: '/w', createdAt: new Date(T0).toISOString() }
    const w = world(req({ successorId: 's1' }), [succ])
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'working'), w.view('s1', 'working')]))
    expect('retire' in w.rows[0]!).toBe(true)
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting'), w.view('s1', 'exited', 'exited')]))
    expect('retire' in w.rows[0]!).toBe(false)
    expect(w.calls.kill).toEqual([])
    expect(w.calls.notes).toEqual(['Retire cancelled'])
  })

  it('a row that already stopped is filed without a kill', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'exited', 'exited')]))
    expect(w.calls.kill).toEqual([])
    expect(w.calls.ended).toEqual(['p1'])
  })

  it('a request cancelled after the snapshot was read is not carried out', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000)
    const real = w.deps.readRegistry
    let n = 0
    w.deps.readRegistry = async () => (++n === 2 ? (await real()).map(x => ({ ...x, retire: undefined })) : real())
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
  })
})

describe('MCP_COMMAND_SOURCES', () => {
  it('decides every harness', () => {
    for (const h of HARNESS_ORDER) expect(h in MCP_COMMAND_SOURCES).toBe(true)
  })
})
