import { afterAll, expect, test } from 'bun:test'
import { __setFleetHostForTest, runFleetAction, readFleet } from './fleet-web'
import { endExternalProcess } from './external-end'
import { procIO, collectOwnPids } from './kill-escalate'
import { readPreferences } from '../preferences'
import { fleetRow } from './fleet-row'
import { createControlHost } from '../cli-start'
import { __setSessionBackendForTest } from './index'
import { addSession, removeSession, readRegistry } from './registry'
import type { SessionBackend, ManagedSession } from './types'
import { controlStrings } from '@agentistics/tui/control/i18n'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

const row = {
  id: 'external:claude:missing-conversation', harness: 'claude', title: 'claude (deleted)',
  cwd: '/nonexistent/external-stuck/deleted', state: 'unknown', stateLabel: 'external',
  project: 'deleted', actionable: false, conversationId: 'missing-conversation',
} as ControlSession

afterAll(() => __setFleetHostForTest('en', null))

test('external cleanup verbs stay available without cwd or a reopen target', () => {
  const verbs = fleetRow({ ...row, pid: 4242 }, controlStrings('pt')).verbs
  expect(verbs.find(v => v.action === 'kill')?.enabled).toBe(true)
  expect(verbs.find(v => v.action === 'kill')?.reason).toBeUndefined()
  expect(verbs.find(v => v.action === 'forget')).toMatchObject({ enabled: true, label: 'Remover da lista' })
})

test('a live managed row is not offered "Remover da lista"; an ended one is', () => {
  const managed = { ...row, id: 'a1b2c3d4e5', state: 'working', stateLabel: 'working' } as ControlSession
  const forget = (r: ControlSession) => fleetRow(r, controlStrings('pt')).verbs.find(v => v.action === 'forget')
  expect(forget(managed)).toMatchObject({ enabled: false, reason: controlStrings('pt').sessionsForgetLive })
  expect(forget({ ...managed, state: 'exited' } as ControlSession)?.enabled).toBe(true)
  expect(forget({ ...managed, state: 'lost' } as ControlSession)?.enabled).toBe(true)
})

test('server ends the external process tree without looking up cwd or conversation', async () => {
  const child = Bun.spawn(['sh', '-c', 'sleep 120 & wait'], { stdout: 'ignore', stderr: 'ignore' })
  const own = await collectOwnPids(child.pid)
  __setFleetHostForTest('en', { sessions: async () => ({ sessions: [{ ...row, pid: child.pid }] }) } as never)
  try {
    expect((await runFleetAction('en', { id: row.id, action: 'kill' })).ok).toBe(true)
    await child.exited
    expect(own.every(ref => !procIO().alive(ref))).toBe(true)
  } finally { try { child.kill() } catch {} }
}, 10000)

test('remove persists a list exclusion without killing or deleting the conversation', async () => {
  __setFleetHostForTest('en', { sessions: async () => ({ sessions: [row] }) } as never)
  expect((await runFleetAction('en', { id: row.id, action: 'forget' })).ok).toBe(true)
  expect((await readPreferences()).ui?.forgottenSessionRows).toContain(row.id)
  const fleet = await readFleet('en')
  expect(fleet.rows.some(r => r.id === row.id)).toBe(false)
})

test('external end refuses unobserved or protected pids', async () => {
  expect(await endExternalProcess(process.pid)).toBe(false)
  expect(await endExternalProcess(4242, async () => [])).toBe(false)
})

test('managed row end/remove accept a deleted cwd and absent conversation', async () => {
  const id = 'external-stuck-managed'
  const killed: string[] = []
  __setSessionBackendForTest({
    id: 'tmux', unavailable: async () => undefined, list: async () => [],
    kill: async (id: string) => { killed.push(id); return true },
  } as unknown as SessionBackend)
  await addSession({ id, harness: 'claude', cwd: row.cwd, conversationId: row.conversationId,
    createdAt: new Date().toISOString() } as ManagedSession)
  const host = createControlHost('en', { suspend: async fn => fn() })
  // The action reads its target off the observed fleet; ending itself uses the real host method.
  __setFleetHostForTest('en', { sessions: async () => ({ sessions: [{ ...row, id, state: 'lost' }] }), killSession: host.killSession } as never)
  try {
    expect((await runFleetAction('en', { id, action: 'kill' })).ok).toBe(true)
    expect(killed).toEqual([id])
    expect((await readRegistry()).find(r => r.id === id)?.endedAt).toBeDefined()
    expect((await runFleetAction('en', { id, action: 'forget' })).ok).toBe(true)
  } finally { await removeSession(id); __setSessionBackendForTest(null) }
})

test('external termination escalates only captured identities that still survive', async () => {
  const refs = [{ pid: 4242, start: 'a' }, { pid: 4243, start: 'b' }]
  const alive = new Set([4242]) // the child PID was reused: it is no longer the captured identity
  const term: number[] = [], forced: number[] = []
  let now = 0
  expect(await endExternalProcess(4242, async () => refs, {
    alive: ref => alive.has(ref.pid), now: () => now, sleep: async ms => { now += ms },
    signal: pid => { forced.push(pid); alive.delete(pid); return true },
  }, pid => { term.push(pid) })).toBe(true)
  expect(term).toEqual([4242])
  expect(forced).toEqual([4242])
})
