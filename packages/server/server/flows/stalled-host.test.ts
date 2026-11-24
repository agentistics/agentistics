import { expect, test } from 'bun:test'
import { stalledHostOps, type StalledHostDeps } from './stalled-host'
import type { ManagedSession } from '../sessions/types'

function fixture() {
  let now = 1_800_000
  const rows = [
    { id: 'worker', cwd: '/Users/fixture/work tree', parentSessionId: 'old', taskId: 'task', subtaskId: 'sub' },
    { id: 'old', cwd: '/Users/fixture', endedAt: 'retired', handoffTo: 'leader' },
    { id: 'leader', cwd: '/Users/fixture' },
  ] as ManagedSession[]
  const notices: unknown[] = []
  const d: StalledHostDeps = {
    registry: async () => rows,
    snapshot: async () => ({ polledAtMs: now, sessions: [{ id: 'worker', cwd: rows[0]!.cwd, status: 'running', activity: 'waiting', attached: false, approvalDetection: false, searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' }, lastLines: ['waiting'], chatTurns: [{ role: 'assistant', text: 'Ready for next phase', at: '2026-11-06T00:00:00Z' }] }] }),
    role: async r => r.id === 'worker' ? 'worker' : 'leader',
    dirty: async () => true,
    heavyLock: async () => false,
    message: async (...args) => { notices.push(args); return { ok: true } },
    now: () => now,
  }
  return { d, rows, notices, advance: (ms: number) => { now += ms } }
}

test('observes worker and current leader, bounded transcript text, dirty state and unknown account limit on macOS paths', async () => {
  const { d } = fixture()
  expect(await stalledHostOps(d)['observar-sessao-parada']({ sessionId: 'worker' })).toMatchObject({ ok: true, leaderId: 'leader', state: 'waiting', lastText: expect.stringContaining('Ready for next phase'), activeSignal: null, dirty: true, accountLimit: null, taskId: 'task', subtaskId: 'sub' })
})

test('refuses unknown, ended and leader targets; stale, failed and missing activity observations', async () => {
  const { d, rows } = fixture()
  const op = stalledHostOps(d)['observar-sessao-parada']
  for (const id of ['', 'unknown', 'leader']) expect(await op({ sessionId: id })).toMatchObject({ refused: true })
  rows[0]!.endedAt = 'ended'
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
  delete rows[0]!.endedAt
  d.snapshot = async () => ({ polledAtMs: 1, sessions: [] })
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
  d.snapshot = async () => ({ polledAtMs: d.now(), sessions: [], unavailable: 'poll failed' })
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
  d.snapshot = async () => ({ polledAtMs: d.now(), sessions: [] })
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
})

test('notices are block messages to freshly resolved parent, delivery refusal is preserved', async () => {
  const { d, rows, notices } = fixture()
  const op = stalledHostOps(d)['avisar-sessao-parada']
  rows[2]!.handoffTo = 'successor'
  rows.push({ id: 'successor', cwd: '/Users/fixture' } as ManagedSession)
  expect(await op({ sessionId: 'worker', body: 'Choose resume or save and close.' })).toEqual({ ok: true, to: 'successor' })
  expect(notices).toEqual([['worker', 'successor', 'Choose resume or save and close.']])
  d.message = async () => ({ ok: false, code: 'target_blocked', message: 'approval open' })
  expect(await op({ sessionId: 'worker', body: 'retry' })).toMatchObject({ refused: true, code: 'target_blocked' })
})

const turn = (extra: Record<string, unknown>) => ({ role: 'assistant' as const, text: '', at: '2026-11-23T10:00:00Z', ...extra })
const withTurns = (f: ReturnType<typeof fixture>, chatTurns: unknown[]) => {
  f.d.snapshot = async () => ({ polledAtMs: f.d.now(), sessions: [{ id: 'worker', cwd: f.rows[0]!.cwd, status: 'running', activity: 'waiting', attached: false, approvalDetection: false, searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' }, lastLines: ['x'], chatTurns }] as never })
}

test('a tool call open for 40 minutes is activity: state working, never an idle reading', async () => {
  const f = fixture()
  withTurns(f, [turn({ pending: true, tools: [{ name: 'Bash' }] })])
  const o = await stalledHostOps(f.d)['observar-sessao-parada']({ sessionId: 'worker' }) as Record<string, unknown>
  expect(o).toMatchObject({ ok: true, state: 'working', activeSignal: 'tool' })
  const key = o.activityKey
  f.advance(40 * 60_000)
  withTurns(f, [turn({ pending: true, tools: [{ name: 'Bash' }] })])
  expect(await stalledHostOps(f.d)['observar-sessao-parada']({ sessionId: 'worker' })).toMatchObject({ state: 'working', activeSignal: 'tool' })
  expect(key).toBeString()
})

test('a session waiting on the heavy lock is working, whatever the screen says', async () => {
  const f = fixture()
  f.d.heavyLock = async () => true
  expect(await stalledHostOps(f.d)['observar-sessao-parada']({ sessionId: 'worker' })).toMatchObject({ state: 'working', activeSignal: 'heavy-lock' })
})

test('a running background task is working', async () => {
  const f = fixture()
  withTurns(f, [turn({ task: { label: 'tests', running: true } }), turn({ text: 'done waiting' })])
  expect(await stalledHostOps(f.d)['observar-sessao-parada']({ sessionId: 'worker' })).toMatchObject({ state: 'working', activeSignal: 'task' })
})

test('truly idle: state stays waiting and the notice text names that no signal exists', async () => {
  const f = fixture()
  const o = await stalledHostOps(f.d)['observar-sessao-parada']({ sessionId: 'worker' }) as Record<string, unknown>
  expect(o).toMatchObject({ state: 'waiting', activeSignal: null })
  expect(String(o.lastText)).toContain('no activity signal')
})

const obs = async (f: ReturnType<typeof fixture>) => await stalledHostOps(f.d)['observar-sessao-parada']({ sessionId: 'worker' }) as Record<string, unknown>
const withView = (f: ReturnType<typeof fixture>, extra: Record<string, unknown>) => {
  f.d.snapshot = async () => ({ polledAtMs: f.d.now(), sessions: [{ id: 'worker', cwd: f.rows[0]!.cwd, status: 'running', activity: 'waiting', attached: false, approvalDetection: false, searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' }, lastLines: ['x'], chatTurns: [turn({ text: 'last turn text' })], ...extra }] as never })
}

test('waiting in the heavy queue is its own signal; holding the lock is running', async () => {
  const f = fixture()
  f.d.heavyLock = async () => 'waiting'
  expect(await obs(f)).toMatchObject({ state: 'working', activeSignal: 'heavy-lock' })
  f.d.heavyLock = async () => 'holding'
  expect(await obs(f)).toMatchObject({ state: 'working', activeSignal: 'heavy-hold' })
})

test('the fleet view\'s own heavy-lock reading (the one the sidebar draws) is what the alert reads', async () => {
  const f = fixture()
  withView(f, { heavyLock: 'waiting' })
  expect(await obs(f)).toMatchObject({ state: 'working', activeSignal: 'heavy-lock' })
})

test('output that moved since the previous observation is working; stable output is not', async () => {
  const f = fixture()
  withView(f, { lastLines: ['build 1'] })
  const first = await obs(f)
  expect(first).toMatchObject({ state: 'waiting', activeSignal: null })
  withView(f, { lastLines: ['build 2'] })
  const second = await obs(f)
  expect(second).toMatchObject({ state: 'working', activeSignal: 'output' })
  expect(second.activityKey).not.toBe(first.activityKey)
  withView(f, { lastLines: ['build 2'] })
  const third = await obs(f)
  expect(third).toMatchObject({ state: 'waiting', activeSignal: null })
})

test('the poller\'s own outputMoved on the view counts too', async () => {
  const f = fixture()
  withView(f, { outputMoved: true })
  expect(await obs(f)).toMatchObject({ state: 'working', activeSignal: 'output' })
})

test('an exited or ended session never reads working, even with a stale open tool call', async () => {
  for (const status of ['exited', 'closed', 'lost']) {
    const f = fixture()
    withView(f, { status, activity: 'waiting', chatTurns: [turn({ pending: true })] })
    const o = await obs(f)
    // no live reading at all: refused, never working.
    expect(o.state).not.toBe('working')
    expect(o.activeSignal ?? null).toBeNull()
  }
})

test('the idle notice keeps the last-turn attribution when the text is long', async () => {
  const f = fixture()
  withView(f, { chatTurns: [turn({ text: 'x'.repeat(5000) })] })
  const o = await obs(f)
  expect(String(o.lastText)).toContain('last turn 2026-11-23T10:00:00Z')
  expect(String(o.lastText).length).toBeLessThanOrEqual(2000)
})
