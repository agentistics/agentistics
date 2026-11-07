import { expect, spyOn, test } from 'bun:test'
import { emitOwnerMessage, emitRelayedOwnerMessages, enableOwnerRequestFlows, ownerMessageTarget, isOwnerComposerRequest, type OwnerMessageDeps } from './owner-message'
import type { ManagedSession } from '../sessions/types'
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

test('the shared composer records owner requests from TUI and HTTP only after confirmed delivery', async () => {
  const owner = await import('./owner-message')
  const fleet = await import('../sessions/fleet-web')
  const { d, events } = deps()
  const hook = spyOn(owner, 'defaultOwnerMessageDeps').mockReturnValue(d)
  let sent = true
  fleet.__setFleetHostForTest('en', {
    sessions: async () => ({ sessions: [] }),
    promptSession: async () => ({ ok: sent, message: sent ? 'sent' : 'failed' }),
  } as never)
  try {
    expect((await fleet.runFleetAction('en', { action: 'prompt', id: 'lead', text: 'Fix the history column' })).ok).toBe(true)
    expect(events).toHaveLength(1)
    sent = false
    await fleet.runFleetAction('en', { action: 'prompt', id: 'lead', text: 'not delivered' })
    expect(events).toHaveLength(1)
  } finally { hook.mockRestore(); fleet.__setFleetHostForTest('en', null) }
})

test('an accepted but unconfirmed composer send records its request only when the late delivery succeeds', async () => {
  const owner = await import('./owner-message')
  const fleet = await import('../sessions/fleet-web')
  const { d, events } = deps()
  const hook = spyOn(owner, 'defaultOwnerMessageDeps').mockReturnValue(d)
  let finish!: (value: { ok: boolean; message: string }) => void
  fleet.__setFleetHostForTest('en', {
    sessions: async () => ({ sessions: [] }),
    promptSession: () => new Promise(resolve => { finish = resolve }),
  } as never)
  try {
    expect((await fleet.runFleetAction('en', { action: 'prompt', id: 'lead', text: 'Fix the percent display' })).ok).toBe(true)
    expect(events).toHaveLength(0)
    finish({ ok: true, message: 'delivered' })
    for (let i = 0; i < 100 && events.length === 0; i++) await Bun.sleep(10)
    expect(events).toHaveLength(1)
  } finally { hook.mockRestore(); fleet.__setFleetHostForTest('en', null) }
}, 8_000)

test('mandatory request flows use the official switches, including when the general flag was on but both triggers were off', async () => {
  const enabled = new Set<string>(), calls: string[][] = []
  const command = { verb: 'flow' as const, summary: { en: '', pt: '' }, run: async (args: string[], io: { out(s: string): void }) => {
    calls.push(args)
    if (args[0] === 'ls') for (const name of ['pedido-do-dono', 'encaixe-do-pedido']) io.out(`${name}\t${enabled.has(name) ? 'enabled' : 'disabled'}`)
    else enabled.add(args[1]!)
    return 0
  } }
  await enableOwnerRequestFlows([command])
  expect([...enabled]).toEqual(['pedido-do-dono', 'encaixe-do-pedido'])
  await enableOwnerRequestFlows([command])
  expect(calls.filter(c => c[0] === 'enable')).toHaveLength(2)
})

test('a trusted relay preserves the original conversation and time; ordinary session messages remain excluded', async () => {
  const { d, events } = deps()
  const source = { id: 'old', conversationId: 'original' }
  const messages = [{ at: '2026-10-29T11:59:00.000Z', text: 'Move Ligações to the top' }, { text: '[from session x · handback]\nfinished' }]
  await emitRelayedOwnerMessages('lead', source, messages, d)
  await emitRelayedOwnerMessages('lead', source, messages, d)
  expect(events).toHaveLength(2)
  expect(events[0]!.id).toBe(events[1]!.id)
  expect(events[0]!.payload).toMatchObject({ sessionId: 'lead', conversationId: 'original', at: messages[0]!.at, taskId: 't-1', channel: 'handoff-relay' })
  await emitRelayedOwnerMessages('lead', source, messages, { ...d, recorded: async () => true })
  expect(events).toHaveLength(2)
})

test('requests to a retired leader resolve through handoff and a reopened managed id, inheriting its task', () => {
  const rows = [{ id: 'old', taskId: 't1', handoffTo: 'successor', endedAt: 'x' }, { id: 'successor', conversationId: 'conv', endedAt: 'x' }, { id: 'new-id', conversationId: 'conv' }] as ManagedSession[]
  expect(ownerMessageTarget('old', rows)).toMatchObject({ id: 'new-id', taskId: 't1' })
})

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
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: 'x' }, { ...d, emit: async () => false })).toBe('no-engine')
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
