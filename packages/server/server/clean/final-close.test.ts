/**
 * Only a FINAL end (a person's or a leader's kill/retire, or fechar-entregue) may clean the worktree: an
 * account switch, a mode migration and a hand-off recreate the session in the SAME directory.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ControlHost } from '@agentistics/tui/control'
import { killAndRetireSession, type KillOptions, type SessionRegistry } from '../sessions/registry'
import type { runFleetAction as RunFleetAction } from '../sessions/fleet-web'
import { finalEndedCwds } from './clean-io'

declare const runFleetAction: typeof RunFleetAction
import type { ManagedSession } from '../sessions/types'

const row: ManagedSession = { id: 's1', harness: 'claude', cwd: '/repo/.worktrees/x', createdAt: '2026-11-28T00:00:00Z', taskId: 't1' }

async function end(endReason: KillOptions['endReason'], killed = true) {
  const rows = [{ ...row }]
  const scheduled: unknown[] = []
  const registry = {
    read: async () => rows,
    patch: async (id: string, p: Record<string, unknown>) => { Object.assign(rows.find(r => r.id === id)!, p); return true },
  } as unknown as SessionRegistry
  await killAndRetireSession('s1', async () => killed, registry, {
    endReason, observe: async () => ({ state: 'none' }), scheduleCleanup: s => { scheduled.push(s) },
  })
  return { scheduled, row: rows[0]! }
}

describe('which end of a session cleans its worktree', () => {
  test('a final end does, and the row records why it ended', async () => {
    const r = await end('final')
    expect(r.scheduled).toEqual([{ id: 's1', cwd: row.cwd, taskId: 't1' }])
    expect(r.row.endReason).toBe('final')
  })
  for (const reason of ['account-switch', 'mode-migration', 'handoff', 'delegation'] as const) {
    test(`${reason} does not`, async () => {
      const r = await end(reason)
      expect(r.scheduled).toEqual([])
      expect(r.row.endReason).toBe(reason)
    })
  }
  test('a kill the backend did not confirm does not, and leaves no reason behind', async () => {
    const r = await end('final', false)
    expect(r.scheduled).toEqual([])
    expect(r.row.endReason ?? null).toBeNull()
  })
})

describe('the planner reads only a FINAL end as "the owner is gone"', () => {
  test('finalEndedCwds', () => {
    expect(finalEndedCwds([
      { cwd: '/a', endedAt: 'x', endReason: 'final' }, { cwd: '/b', endedAt: 'x', endReason: 'account-switch' },
      { cwd: '/c', endedAt: 'x' }, { cwd: '/d', endReason: 'final' },
    ])).toEqual(['/a'])
  })
})

/** Every door states its reason: read from the source, so a changed or dropped argument fails here. */
describe('each door passes its reason', () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8')
  const doors: Array<[string, string]> = [
    ['sessions/account-switch-host.ts', "killAndRetireSession(id, kill, undefined, { endReason: 'account-switch' })"],
    ['cli-start.ts', "killAndRetireSession(id, () => backend.kill(id), undefined, { endReason: 'mode-migration' })"],
    ['cli-start.ts', "killAndRetireSession(id, () => backend.kill(id), undefined, { force, endReason })"],
    ['../../tui/src/control/tabs/Sessions.tsx', "kill.call(host, session.id, true, 'final')"],
    ['../../tui/src/control/tabs/Sessions.tsx', "kill.call(host, sess.id, false, 'final')"],
    ['../../tui/src/control/tabs/Sessions.tsx', "kill.call(host, session.id, false, 'final')"],
    ['engine/engine-delegate.ts', "runFleetAction(lang(), { id, action: 'kill' }, 'delegation')"],
    ['sessions/fleet-web.ts', 'host.killSession(req.id, req.force === true, endReason)'],
    ['index.ts', "runFleetAction(fleetLang(url.searchParams.get('lang')), body.value, 'final')"],
    ['flows/host-ops.ts', "runFleetAction('en', { action: 'kill', id: rowId }, 'final')"],
    ['engine/engine-book-host.ts', "runFleetAction(lang(), { id, action: 'kill' }, 'handoff')"],
    ['sessions/cli-session.ts', "{ force, endReason: 'final' }"],
    ['sessions/retire-runner.ts', '(id, endReason) => reg.killAndRetireSession(id, () => backend.kill(id), undefined, { endReason })'],
  ]
  for (const [file, call] of doors) test(`${file}: ${call}`, () => { expect(src(file)).toContain(call) })
  test('every kill.call in the cockpit states a reason', () => {
    const calls = src('../../tui/src/control/tabs/Sessions.tsx').match(/kill\.call\([^)]*\)/g) ?? []
    expect(calls.length).toBe(3)
    for (const c of calls) expect(c).toMatch(/, '(final|handoff|delegation|account-switch|mode-migration)'\)$/)
  })
})

/** Type-level gate (checked by `tsc`, never run): a kill without a reason does not compile. */
export function killNeedsAReason(host: Required<Pick<ControlHost, 'killSession'>>): void {
  // @ts-expect-error a kill must say why the session ends
  void runFleetAction('en', { id: 'x', action: 'kill' })
  // @ts-expect-error killAndRetireSession requires options
  void killAndRetireSession('x', async () => true)
  // @ts-expect-error killAndRetireSession requires an endReason
  void killAndRetireSession('x', async () => true, undefined, { force: true })
  // @ts-expect-error the host's kill requires an endReason
  void host.killSession('x', true)
}
