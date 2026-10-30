import { expect, test } from 'bun:test'
import { emitOwnerMessage, isOwnerComposerRequest, type OwnerMessageDeps } from './owner-message'
import { isOwnerTurn } from '../sessions/handoff-relay'
import { contextText } from '../sessions/agentistics-context'

function deps(over: Partial<OwnerMessageDeps> = {}) {
  const events: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  const d: OwnerMessageDeps = {
    flowsOn: () => true,
    row: async id => (id === 'lead' ? { id: 'lead', conversationId: 'conv-l', taskId: 't-1' } : id === 'wk' ? { id: 'wk', taskId: 't-1', subtaskId: 's-1' } : undefined),
    roleOf: async row => (row.id === 'lead' ? 'leader' : row.id === 'wk' ? 'worker' : undefined),
    mode: async () => 'queue',
    emit: async e => { events.push(e) },
    now: () => Date.parse('2026-10-29T12:00:00.000Z'),
    ...over,
  }
  return { d, events }
}

test('H1.1: three owner messages emit three owner.message events; a [from session] relay and an <agent-message> emit none', async () => {
  const { d, events } = deps()
  for (const text of ['corrige o login', 'e o deploy?', 'manda o relatório']) expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text }, d)).toBe('emitted')
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: '[from session abc · handback]\nfeito' }, d)).toBe('not-owner')
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: '<agent-message from="x">oi</agent-message>' }, d)).toBe('not-owner')
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: '[from flow trabalho-sem-commit · nudge]\ncommite' }, d)).toBe('not-owner')
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: '<task-notification>x</task-notification>' }, d)).toBe('not-owner')
  expect(events.map(e => e.payload.text)).toEqual(['corrige o login', 'e o deploy?', 'manda o relatório'])
  expect(events[0]).toMatchObject({ type: 'owner.message', payload: { sessionId: 'lead', conversationId: 'conv-l', taskId: 't-1', role: 'leader', channel: 'app', mode: 'queue', at: '2026-10-29T12:00:00.000Z' } })
  expect(new Set(events.map(e => e.id)).size).toBe(3)
})

test('the classifier the hand-off relay shares treats agent and flow messages as not the owner', () => {
  expect(isOwnerTurn({ role: 'user', text: '<agent-message>x</agent-message>' })).toBe(false)
  expect(isOwnerTurn({ role: 'user', text: '[from flow pedido-do-dono · nudge]\nx' })).toBe(false)
  expect(isOwnerTurn({ role: 'user', text: 'e as correções???' })).toBe(true)
})

test('worker messages carry the worker role (the engine comments, no pedido); unknown sessions, no role or flows off emit nothing', async () => {
  const { d, events } = deps()
  expect(await emitOwnerMessage({ action: 'prompt', id: 'wk', text: 'commita' }, d)).toBe('emitted')
  expect(events[0]!.payload).toMatchObject({ role: 'worker', subtaskId: 's-1' })
  expect(await emitOwnerMessage({ action: 'prompt', id: 'ghost', text: 'x' }, d)).toBe('no-session')
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: 'x' }, { ...d, roleOf: async () => undefined })).toBe('no-role')
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: 'x' }, { ...d, flowsOn: () => false })).toBe('flows-off')
  expect(events).toHaveLength(1)
})

test('H1.4: a leader briefing opens with PEDIDOS ABERTOS DO DONO; a worker briefing never carries it', () => {
  const section = 'PEDIDOS ABERTOS DO DONO (1) — …\n- p-1 (há 5 min): «passagem deveria ser item de sistema»'
  const lead = contextText({ sessionId: 's', cwd: '/w', role: 'leader', ownerRequests: section })
  const lines = lead.split('\n')
  expect(lines[1]).toBe(section.split('\n')[0])
  expect(lead).toContain('«passagem deveria ser item de sistema»')
  expect(contextText({ sessionId: 's', cwd: '/w', role: 'worker', ownerRequests: section })).not.toContain('PEDIDOS ABERTOS')
})

test('LEADER-2: the plain composer rule — no session proof AND the classifier; any session proof (valid or not) emits nothing', async () => {
  const { markCallerVerified } = await import('../sessions/session-roles')
  const { d, events } = deps()
  const owner: Record<string, unknown> = { action: 'prompt', id: 'lead', text: 'faz o deploy' }
  await markCallerVerified(owner, async () => null)
  expect(isOwnerComposerRequest(owner)).toBe(true)
  expect(await emitOwnerMessage(owner as never, d)).toBe('emitted')
  for (const session of [{ id: 'lead', token: 'forged' }, { id: 'lead', token: 'valid' }, null]) {
    const body: Record<string, unknown> = { action: 'prompt', id: 'lead', text: 'faz o deploy', session }
    await markCallerVerified(body, async (_id, t) => (t === 'valid' ? 'lead' : null))
    expect(await emitOwnerMessage(body as never, d)).toBe('not-composer')
  }
  expect(await emitOwnerMessage({ action: 'kill', id: 'lead', text: 'x' }, d)).toBe('not-composer')
  expect(events).toHaveLength(1)
})
