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
    transition: ok('transition'), gate: ok('gate'), block: ok('block'), unblock: ok('unblock'), approve: ok('approve'), configure: ok('configure'),
    step: ok('step'), stage: ok('stage'), stageRun: ok('stageRun'), merge: ok('merge'),
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
})

describe('delivery CLI parsing', () => {
  test('delivery verbs are recognised, the engine keeps its own', () => {
    expect(isDeliveryFlowVerb(['gate', 'salvo'])).toBe(true)
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
