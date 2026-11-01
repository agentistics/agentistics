import { describe, expect, test } from 'bun:test'
import { waitLines, waitRequest, type WaitDoorDeps, type WaitEvent } from './waits'

function deps(o: { reply?: unknown; filed?: Record<string, { taskId?: string; subtaskId?: string }>; waits?: unknown } = {}) {
  const events: WaitEvent[] = []
  const reads: Array<[string, Record<string, unknown>]> = []
  let n = 0
  const d: WaitDoorDeps = {
    emit: async e => { events.push(e); return o.reply ?? { ok: true, wait: { waitId: 'w-1' } } },
    read: async (k, q) => { reads.push([k, q]); return o.waits ?? [] },
    filed: async id => o.filed?.[id] ?? {},
    newId: () => `id${++n}`,
  }
  return { d, events, reads }
}

describe('waitRequest — the verified session is the owner, never a request value', () => {
  test('an unverified caller is refused', async () => {
    const { d, events } = deps()
    expect((await waitRequest(null, { action: 'register' }, d)).status).toBe(403)
    expect(events).toHaveLength(0)
  })

  test('register: owner and task come from the proof and the registry; requestId makes a retry the same event', async () => {
    const { d, events } = deps({ filed: { L1: { taskId: 't-1', subtaskId: 's-1' } } })
    const out = await waitRequest('L1', { action: 'register', ownerSessionId: 'SOMEONE-ELSE', condition: { kind: 'handback', from: 'W' }, deadlineAt: '2030-01-01T00:00:00Z', requestId: 'r1', label: 'worker X' }, d)
    expect(out.status).toBe(200)
    expect(events[0]).toEqual({
      type: 'wait.register', id: 'wait.register:L1:r1',
      payload: { ownerSessionId: 'L1', condition: { kind: 'handback', from: 'W' }, deadlineAt: '2030-01-01T00:00:00Z', label: 'worker X', taskId: 't-1', subtaskId: 's-1' },
    })
    await waitRequest('L1', { action: 'register', condition: {}, deadlineAt: 'x', requestId: 'r1' }, d)
    expect(events[1]!.id).toBe('wait.register:L1:r1')
    expect((await waitRequest('L1', { action: 'register', requestId: 'bad id!' }, d)).status).toBe(400)
  })

  test('ack and cancel carry `by` = the caller; engine refusals map to statuses', async () => {
    const { d, events } = deps({ reply: { ok: false, code: 'revoked', message: 'gen 1 revoked' } })
    const out = await waitRequest('L1', { action: 'ack', waitId: 'w-1', generation: 1, by: 'OTHER' }, d)
    expect(events[0]!.payload).toEqual({ waitId: 'w-1', by: 'L1', generation: 1 })
    expect(out).toEqual({ status: 409, body: { ok: false, error: 'revoked', sentence: 'gen 1 revoked' } })
    const n = deps({ reply: { ok: false, code: 'not_owner', message: 'no' } })
    expect((await waitRequest('L2', { action: 'cancel', waitId: 'w-1' }, n.d)).status).toBe(403)
    expect(n.events[0]!.type).toBe('wait.cancel')
  })

  test('handoff: only to the caller, only from a session on the same task', async () => {
    const { d, events } = deps({ filed: { L1: { taskId: 't-1' }, L2: { taskId: 't-1' }, X: { taskId: 't-9' } } })
    expect((await waitRequest('L2', { action: 'handoff', from: 'X' }, d)).status).toBe(403)
    const ok = await waitRequest('L2', { action: 'handoff', from: 'L1', to: 'EVIL' }, d)
    expect(ok.status).toBe(200)
    expect(events.at(-1)!.payload).toEqual({ from: 'L1', to: 'L2' })
  })

  test('list reads the caller\'s own waits', async () => {
    const { d, reads } = deps({ waits: [{ waitId: 'w-1' }] })
    expect(await waitRequest('L1', { action: 'list' }, d)).toEqual({ status: 200, body: { ok: true, waits: [{ waitId: 'w-1' }] } })
    expect(reads[0]).toEqual(['waits', { sessionId: 'L1' }])
  })

  test('an engine without waits (the bus answers a run list) is 501, not a fake success', async () => {
    const { d } = deps({ reply: [] })
    expect((await waitRequest('L1', { action: 'register', condition: {}, deadlineAt: 'x' }, d)).status).toBe(501)
  })
})

test('waitLines: one line per owner, only waits still waiting, the nearest deadline', () => {
  const lines = waitLines([
    { waitId: 'a', owner: { sessionId: 'L1' }, describe: 'handback de W', deadlineAt: '2030-01-02T00:00:00Z', status: 'registered' },
    { waitId: 'b', owner: { sessionId: 'L1' }, describe: 'memória', deadlineAt: '2030-01-01T00:00:00Z', status: 'registered' },
    { waitId: 'c', owner: { sessionId: 'L2' }, describe: 'x', deadlineAt: '2030-01-01T00:00:00Z', status: 'queued' },
    { garbage: true },
  ])
  expect(lines).toEqual([{ sessionId: 'L1', waitId: 'b', describe: 'memória', deadlineAt: '2030-01-01T00:00:00Z', status: 'registered' }])
  expect(waitLines(null)).toEqual([])
})
