import { describe, expect, test } from 'bun:test'
import { nativeFleetEntries, nativeFleetEntry, nativeState, withNativeSessions, type NativeListRecord } from './nativeFleetRow'
import { nativeVerbRequest } from './nativeFleet'
import { summaryCounts } from './asideSummary'
import { fleetIndex, type FleetRow } from './fleet'

const SID = 'ses_' + 'a'.repeat(32)
const rec = (over: Partial<NativeListRecord> = {}): NativeListRecord => ({
  sessionId: SID, title: 'Fix the parser', model: 'claude-sonnet-4.6', provider: 'anthropic', status: 'open',
  cwd: '/home/u/agentistics', createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:05:00.000Z', ...over,
})

describe('nativeState — the engine\'s measured activity, never a guess (H17)', () => {
  test('an open session takes its activity; open with none yet is unknown (active only); ended is closed', () => {
    expect([
      { status: 'open', activity: 'working' }, { status: 'open', activity: 'waiting-approval' },
      { status: 'open', activity: 'waiting' }, { status: 'open' }, { status: 'ended', activity: 'waiting' },
    ].map(nativeState)).toEqual(['working', 'waiting-approval', 'waiting', 'unknown', 'closed'])
  })
  test('the summary line counts native rows through the SAME rule as every other harness', () => {
    const { sessions } = nativeFleetEntries([
      rec({ sessionId: 'ses_' + '1'.repeat(32), activity: 'working' }),
      rec({ sessionId: 'ses_' + '2'.repeat(32), activity: 'waiting-approval' }),
      rec({ sessionId: 'ses_' + '3'.repeat(32), activity: 'waiting' }),
      rec({ sessionId: 'ses_' + '4'.repeat(32) }),
      rec({ sessionId: 'ses_' + '5'.repeat(32), status: 'ended' }),
    ], {}, 'en')
    expect(summaryCounts(sessions)).toEqual({ active: 4, working: 1, needs: 2 })
  })
})

describe('nativeFleetEntry — a native session is an ordinary fleet row', () => {
  test('the same shape a CLI row has: harness mark, project, state chip, task, the conversation = the session', () => {
    const { row, session } = nativeFleetEntry(rec({ activity: 'waiting' }), { taskId: 't-1', taskTitle: 'Delivery', costUSD: 0.42, tokens: 1500 }, 'pt')
    expect(row).toMatchObject({ id: SID, harness: 'agentistics', title: 'Fix the parser', project: 'agentistics', state: 'waiting', stateLabel: 'precisa de você', task: 'Delivery', conversationId: SID, model: 'claude-sonnet-4.6' })
    expect(session).toMatchObject({ id: SID, harness: 'agentistics', projectGroup: 'agentistics', task: 'Delivery', taskId: 't-1', cost: '$0.42', tokens: '1.5k', named: true, startedAt: Date.parse('2026-10-03T12:00:00.000Z') })
    expect(session.searchFields).toMatchObject({ name: 'Fix the parser', folder: '/home/u/agentistics', task: 'Delivery', harness: 'agentistics' })
  })
  test('an unfiled session carries NO cost or tokens — absent, never a confident zero', () => {
    const { session } = nativeFleetEntry(rec(), undefined, 'en')
    expect('cost' in session).toBe(false)
    expect('tokens' in session).toBe(false)
    expect(session.stateLabel).toBe('open')
  })
  test('untitled falls back to the model, as the old aside did', () => {
    expect(nativeFleetEntry(rec({ title: '  ' }), undefined, 'en').row.title).toBe('claude-sonnet-4.6')
  })
  test('the row menu: lifecycle verbs follow the state; note is enabled like every harness, and the row carries it', () => {
    const verbs = (r: NativeListRecord) => Object.fromEntries(nativeFleetEntry(r, undefined, 'en').row.verbs.map(v => [v.action, v]))
    const open = verbs(rec())
    expect(open.rename!.enabled).toBe(true)
    expect(open.task!.enabled).toBe(true)
    expect(open.kill!.enabled).toBe(true)
    expect(open.resume!.enabled).toBe(false)
    expect(open.resume!.reason).toBeTruthy()
    expect(open.note!.enabled).toBe(true)
    expect(open.note!.reason).toBeUndefined()
    const noted = nativeFleetEntry(rec(), undefined, 'en', 'waiting on review')
    expect(noted.row.note).toBe('waiting on review')
    expect(nativeFleetEntries([rec()], {}, 'en', { [rec().sessionId]: 'n1' }).rows[0]!.note).toBe('n1')
    const ended = verbs(rec({ status: 'ended' }))
    expect(ended.resume!.enabled).toBe(true)
    expect(ended.kill!.enabled).toBe(false)
  })
})

describe('withNativeSessions — folded into the fleet the whole product reads', () => {
  const cli = { id: 'agentop-1', title: 'claude', harness: 'claude', state: 'waiting' } as unknown as FleetRow
  const base = { sessions: [cli], rows: [{ id: 'agentop-1', state: 'waiting' } as never], attention: 1, tasks: [] as string[] }
  test('appended to both shapes; only a MEASURED wait adds to the attention counter', () => {
    const native = nativeFleetEntries([rec({ activity: 'waiting' }), rec({ sessionId: 'ses_' + 'b'.repeat(32) })], {}, 'en')
    const out = withNativeSessions(base, native)
    expect(out.sessions.map(s => s.id)).toEqual(['agentop-1', SID, 'ses_' + 'b'.repeat(32)])
    expect(out.rows).toHaveLength(3)
    expect(out.attention).toBe(2)
    expect(out.tasks).toBe(base.tasks)
    // The index the workspace resolves `/sessions/:id` through finds a native id like any other.
    expect(fleetIndex(out.sessions).get(SID)?.harness).toBe('agentistics')
  })
  test('no native sessions: the payload is returned untouched', () => {
    expect(withNativeSessions(base, { rows: [], sessions: [], measuredWaiting: [] })).toBe(base)
  })
  test('an id the fleet already carries is never added twice', () => {
    const dup = { ...base, sessions: [{ ...cli, id: SID }] }
    expect(withNativeSessions(dup, nativeFleetEntries([rec()], {}, 'en')).sessions).toHaveLength(1)
  })
})

describe('nativeVerbRequest — the row verbs go to the engine\'s lifecycle routes', () => {
  test('rename / stop / reopen go to the engine; a note to the machine\'s own act; anything else is not a native verb', () => {
    expect(nativeVerbRequest({ id: SID, action: 'rename', text: 'New' })).toEqual({ url: `/api/runtime/sessions/${SID}`, method: 'PATCH', body: { title: 'New' } })
    expect(nativeVerbRequest({ id: SID, action: 'kill' })).toEqual({ url: `/api/runtime/sessions/${SID}/end`, method: 'POST' })
    expect(nativeVerbRequest({ id: SID, action: 'resume' })).toEqual({ url: `/api/runtime/sessions/${SID}/reopen`, method: 'POST' })
    expect(nativeVerbRequest({ id: SID, action: 'note', text: 'x' })).toEqual({ url: '/api/fleet/act', method: 'POST', body: { id: SID, action: 'note', text: 'x' } })
    expect(nativeVerbRequest({ id: SID, action: 'approve' })).toBeNull()
  })
})
