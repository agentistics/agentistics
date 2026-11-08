import { describe, expect, test } from 'bun:test'
import { deliveryRequest } from './web'
import { isDeliveryFlowVerb, parseFlags } from './cli'
import type { DeliveryService } from './service'

function fakeService() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const rec = { subtaskId: 's1', phase: 'qa', revision: 3 }
  const ok = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); return { ok: true, status: 200, record: rec, warnings: [] } }
  const svc = {
    list: async () => [rec], get: async (id: string) => (id === 's1' ? rec : null), tick: async () => ({ actions: [] }),
    reconcile: async (o: { apply?: unknown }, actor: string) => { calls.push({ fn: 'reconcile', args: [o, actor] }); return { ok: true, status: 200, apply: o.apply === true, entries: [], moved: 0, unproven: 0 } },
    transition: ok('transition'), gate: ok('gate'), block: ok('block'), unblock: ok('unblock'), approve: ok('approve'), configure: ok('configure'),
    step: ok('step'), stage: ok('stage'), stageRun: ok('stageRun'), dequeue: ok('dequeue'), merge: ok('merge'),
  } as unknown as DeliveryService
  return { svc, calls }
}

describe('/api/deliveries', () => {
  const verify = async (id: unknown, token: unknown) => (id === 'w1' && token === 'good' ? 'w1' : null)
  test('lists and reads', async () => {
    const { svc } = fakeService()
    expect((await deliveryRequest('GET', '/api/deliveries', {}, { service: svc, verify })).status).toBe(200)
    expect((await deliveryRequest('GET', '/api/deliveries/s1', {}, { service: svc, verify })).status).toBe(200)
    expect((await deliveryRequest('GET', '/api/deliveries/zz', {}, { service: svc, verify })).status).toBe(404)
  })
  test('reconcile: dry run unless apply is exactly true; the verified session is the actor (FLUXO.CICLO-COMPLETO)', async () => {
    const { svc, calls } = fakeService()
    const dry = await deliveryRequest('POST', '/api/deliveries/reconcile', {}, { service: svc, verify })
    expect(dry.status).toBe(200)
    expect(calls.at(-1)).toEqual({ fn: 'reconcile', args: [{ apply: undefined }, 'owner'] })
    await deliveryRequest('POST', '/api/deliveries/reconcile', { apply: true, session: { id: 'w1', token: 'good' } }, { service: svc, verify })
    expect(calls.at(-1)).toEqual({ fn: 'reconcile', args: [{ apply: true }, 'w1'] })
    expect((await deliveryRequest('POST', '/api/deliveries/reconcile', { apply: true, session: { id: 'w1', token: 'bad' } }, { service: svc, verify })).status).toBe(403)
  })
  test('a claimed session must prove itself; the verified id is the actor', async () => {
    const { svc, calls } = fakeService()
    expect((await deliveryRequest('POST', '/api/deliveries/s1', { action: 'phase', to: 'qa', session: { id: 'w1', token: 'bad' } }, { service: svc, verify })).status).toBe(403)
    await deliveryRequest('POST', '/api/deliveries/s1', { action: 'phase', to: 'qa', session: { id: 'w1', token: 'good' }, verdict: 'APROVADO', findings: ' x ' }, { service: svc, verify })
    expect(calls.at(-1)).toEqual({ fn: 'transition', args: ['s1', 'qa', { verdict: 'APROVADO', findings: 'x' }, 'w1'] })
  })
  test('only a request with no session proof approves (the owner)', async () => {
    const { svc, calls } = fakeService()
    await deliveryRequest('POST', '/api/deliveries/s1', { action: 'approve', phase: 'pr_merge', decision: 'approve', session: { id: 'w1', token: 'good' } }, { service: svc, verify })
    expect(calls.at(-1)!.args[4]).toBe(false)
    await deliveryRequest('POST', '/api/deliveries/s1', { action: 'approve', phase: 'pr_merge', decision: 'approve' }, { service: svc, verify })
    expect(calls.at(-1)!.args[4]).toBe(true)
  })
  test('unknown action is 400', async () => {
    const { svc } = fakeService()
    expect((await deliveryRequest('POST', '/api/deliveries/s1', { action: 'skip' }, { service: svc, verify })).status).toBe(400)
  })
  test('step: a recorded delivery goes through the record; a piece without one writes only the event', async () => {
    const { svc, calls } = fakeService()
    const stepEvent = async (...args: unknown[]) => { calls.push({ fn: 'stepEvent', args }); return args[0] === 'zz' ? { ok: false as const, status: 404, code: 'no_such_subtask', sentence: 'no', missing: [] } : { ok: true as const, status: 200 as const, step: args[1] as number, recorded: 'event' as const } }
    const service = { ...svc, stepEvent } as unknown as DeliveryService
    await deliveryRequest('POST', '/api/deliveries/s1', { action: 'step', step: 2, session: { id: 'w1', token: 'good' } }, { service, verify })
    expect(calls.at(-1)).toEqual({ fn: 'step', args: ['s1', 2, 'w1'] })
    const legacy = await deliveryRequest('POST', '/api/deliveries/legacy1', { action: 'step', step: 3, session: { id: 'w1', token: 'good' } }, { service, verify })
    expect(calls.at(-1)).toEqual({ fn: 'stepEvent', args: ['legacy1', 3, 'w1'] })
    expect(legacy).toEqual({ status: 200, body: { ok: true, step: 3, recorded: 'event' } })
    expect((await deliveryRequest('POST', '/api/deliveries/zz', { action: 'step', step: 3 }, { service, verify })).status).toBe(404)
  })
  test('dequeue forwards the free-text reason and verified actor; forged proof refuses', async () => {
    const { svc, calls } = fakeService()
    const body = { action: 'dequeue', reason: 'already delivered', session: { id: 'w1', token: 'good' } }
    expect((await deliveryRequest('POST', '/api/deliveries/s1', body, { service: svc, verify })).status).toBe(200)
    expect(calls.at(-1)).toEqual({ fn: 'dequeue', args: ['s1', 'already delivered', 'w1'] })
    body.session.token = 'bad'
    expect((await deliveryRequest('POST', '/api/deliveries/s1', body, { service: svc, verify })).status).toBe(403)
  })
})

describe('delivery CLI parsing', () => {
  test('dequeue CLI calls the shared service with reason and managed actor', async () => {
    const { runDeliveryCli } = await import('./cli')
    const { svc, calls } = fakeService()
    const out: string[] = []
    expect(await runDeliveryCli(['dequeue', '--subtask', 's1', '--reason', 'already delivered'], { out: l => out.push(l), err: l => out.push(l) }, { AGENTOP_MANAGED_ID: 'leader' }, svc)).toBe(0)
    expect(calls.at(-1)).toEqual({ fn: 'dequeue', args: ['s1', 'already delivered', 'leader'] })
    expect(await runDeliveryCli(['dequeue', '--reason', 'x'], { out: () => {}, err: () => {} }, {}, svc)).toBe(2)
  })
  test('delivery verbs are recognised, the engine keeps its own', () => {
    expect(isDeliveryFlowVerb(['gate', 'salvo'])).toBe(true)
    expect(isDeliveryFlowVerb(['dequeue', '--subtask', 's1', '--reason', 'delivered'])).toBe(true)
    expect(isDeliveryFlowVerb(['stage', 'run'])).toBe(true)
    expect(isDeliveryFlowVerb(['qa', 'open'])).toBe(true)
    expect(isDeliveryFlowVerb(['wait', 'qa-verdict'])).toBe(true)
    expect(isDeliveryFlowVerb(['run', 'pipeline-autonomo'])).toBe(false)
    expect(isDeliveryFlowVerb(['status', 'abc'])).toBe(false)
    expect(isDeliveryFlowVerb(['ls'])).toBe(false)
  })
  test('L4: `flow --help` lists the delivery verbs', async () => {
    expect(isDeliveryFlowVerb(['--help'])).toBe(true)
    const { runDeliveryCli, DELIVERY_FLOW_HELP } = await import('./cli')
    const out: string[] = []
    expect(await runDeliveryCli(['--help'], { out: l => out.push(l), err: () => {} }, {})).toBe(0)
    expect(out.join('\n')).toContain('agentop flow gate')
    for (const g of ['cabeca', 'mergeado']) expect(DELIVERY_FLOW_HELP).toContain(g)
  })
  test('flags', () => {
    expect(parseFlags(['phase', 'ci', '--subtask', 's1', '--merge-sha', 'abc', '--dry'])).toEqual({ pos: ['phase', 'ci'], flags: { subtask: 's1', mergeSha: 'abc', dry: 'true' } })
  })
})
