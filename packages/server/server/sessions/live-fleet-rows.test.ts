import { emptySearchFields } from '@agentistics/tui/control/search-scope'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ControlSession } from '@agentistics/tui/control'
import { cliStrings } from '../cli-i18n'
import { toControlSession } from './control-session'
import { liveFleetRows } from './live-fleet-rows'
import type { SessionView } from './session-view'

const S = cliStrings('en')

function view(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'a1', harness: 'claude', cwd: '/home/d/proj', status: 'running', attached: false,
    approvalDetection: true, searchFields: emptySearchFields(), ...over,
  }
}

/** The fields `liveDeliveries` reads off a row (task-web.ts) plus the role key (`roleOfRow`). */
const LIVE_FIELDS = ['id', 'title', 'harness', 'state', 'model', 'observedModel', 'effort', 'accountId', 'parentSessionId', 'lastLines', 'task', 'startedAt', 'conversationId'] as const
const pick = (r: ControlSession) => Object.fromEntries(LIVE_FIELDS.map(k => [k, (r as unknown as Record<string, unknown>)[k]]))

describe('liveFleetRows (LIVE.COLD-START)', () => {
  const sessions = [
    view({ id: 'a1', status: 'running', label: 'one', conversationId: 'c1', parentSessionId: 'p0' } as Partial<SessionView>),
    view({ id: 'a2', status: 'exited', cwd: '/gone/dir' }),
    view({ id: 'a3', status: 'closed', cwd: '/x/y' }),
  ]
  const snap = { sessions }

  test('every snapshot row is mapped by the SAME toControlSession, for every field the Live reads', () => {
    const rows = liveFleetRows(snap, S, [])
    expect(rows.map(r => r.id)).toEqual(['a1', 'a2', 'a3'])
    rows.forEach((r, i) => expect(pick(r)).toEqual(pick(toControlSession(sessions[i]!, S))))
  })

  test('native rows join after the managed ones, never shadowing a managed id', () => {
    const native = [{ id: 'ses_n1', state: 'working' }, { id: 'a1', state: 'working' }] as unknown as ControlSession[]
    const rows = liveFleetRows(snap, S, native)
    expect(rows.map(r => r.id)).toEqual(['a1', 'a2', 'a3', 'ses_n1'])
    expect(rows[0]!.state).toBe(toControlSession(sessions[0]!, S).state)
  })

  test('no snapshot: no rows (never invented)', () => {
    expect(liveFleetRows(null, S, [])).toEqual([])
  })
})

/**
 * The cold-start cause, pinned at the source: the Live build must NOT go through `host.sessions()`, which on the
 * first read after a start resolves `repoFacts` (git per directory, 1–5 s over a 3.6k fleet) and `restorableSessions`
 * for fields the Live never reads. Comments are stripped first; this file is required to explain itself.
 */
test('readLiveFleet builds from the hub snapshot, not from host.sessions()', () => {
  const src = readFileSync(join(import.meta.dir, 'fleet-web.ts'), 'utf8')
  const start = src.indexOf('async function startLiveFleetBuild')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  expect(body).not.toMatch(/\.sessions\s*\(/)
  expect(body).not.toMatch(/hostForFleet|repoFacts/)
  expect(body).toMatch(/liveFleetRows\(/)
})
