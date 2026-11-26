import { expect, spyOn, test } from 'bun:test'
import { defaultOwnerMessageDeps, emitOwnerMessage, emitRelayedOwnerMessages, enableOwnerRequestFlows, ownerMessageTarget, isOwnerComposerRequest, type OwnerMessageDeps } from './owner-message'
import { ownerTaskSuggestion } from './owner-intent'
import type { ManagedSession } from '../sessions/types'
import { contextText } from '../sessions/agentistics-context'

const phrases = ['que horas você termina', 'terminou a skill?', 'me dá o path no Finder…', 'pode fazer']
function deps() {
  const events: unknown[] = []
  const d: OwnerMessageDeps = {
    flowsOn: () => true, row: async () => ({ id: 'lead', taskId: 't1' }), roleOf: async () => 'leader',
    mode: async () => 'queue', emit: async e => { events.push(e) }, now: Date.now,
  }
  return { d, events }
}

for (const text of [...phrases, 'Implement the new login screen', '> forwarded work\npode fazer']) {
  test(`unflagged composer and relay create no pedido or card: ${text}`, async () => {
    const { d, events } = deps()
    expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text }, d)).toBe('not-task')
    await emitRelayedOwnerMessages('lead', { id: 'old', conversationId: 'original' }, [{ text }], d)
    expect(events).toEqual([])
  })
}

test('a confirmed shared send still reaches the session without automatically registering work', async () => {
  const owner = await import('./owner-message')
  const fleet = await import('../sessions/fleet-web')
  const { d, events } = deps()
  const hook = spyOn(owner, 'defaultOwnerMessageDeps').mockReturnValue(d)
  const delivered: string[] = []
  fleet.__setFleetHostForTest('en', { sessions: async () => ({ sessions: [] }), promptSession: async (_id: string, text: string) => { delivered.push(text); return { ok: true, message: 'sent' } } } as never)
  try {
    for (const text of phrases) expect((await fleet.runFleetAction('en', { action: 'prompt', id: 'lead', text })).ok).toBe(true)
    expect(delivered).toEqual(phrases)
    expect(events).toEqual([])
  } finally { hook.mockRestore(); fleet.__setFleetHostForTest('en', null) }
})

// LIVRO.SEAMS 3b (N3): one owner composer order = exactly one owner.message; the five non-owner sources = none.
// Flows off there is NO owner-order path at all (the "as task" gesture is refused before delivery by
// composer-task.ts), so the same six requests emit nothing.
test('only the owner composer request emits owner.message (flows on); flows off nothing does', async () => {
  const base = { action: 'prompt', id: 'lead', text: 'faz o hotfix', asTask: { priority: 'high' as const } }
  const nonOwner = [
    { session: { id: 'worker', token: 'proof' } },
    { session: { id: 'worker', token: 'proof' }, handoff: true },
    { callerVerified: true },
    { handoff: true },
    { session: { id: 'worker', token: 'proof' }, callerVerified: true },
  ]
  const on = deps()
  const outcomes = await Promise.all(nonOwner.map(extra => emitOwnerMessage({ ...base, ...extra }, on.d)))
  expect(outcomes).toEqual(['not-composer', 'not-composer', 'not-composer', 'handoff', 'not-composer'])
  expect(on.events).toHaveLength(0)
  expect(await emitOwnerMessage(base, on.d)).toBe('emitted')
  expect(on.events).toHaveLength(1)
  expect(on.events[0]).toMatchObject({ type: 'owner.message', payload: { text: 'faz o hotfix', sessionId: 'lead', role: 'leader' } })

  const off = deps()
  off.d.flowsOn = () => false
  for (const extra of [{}, ...nonOwner]) expect(await emitOwnerMessage({ ...base, ...extra }, off.d)).toBe('flows-off')
  expect(off.events).toHaveLength(0)
})

test('an owner message to a session with no leader/worker role is not an order (no-role)', async () => {
  const { d, events } = deps()
  d.roleOf = async () => undefined
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: 'faz o hotfix', asTask: { priority: 'high' } }, d)).toBe('no-role')
  d.roleOf = async () => 'observer'
  expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: 'faz o hotfix', asTask: { priority: 'high' } }, d)).toBe('no-role')
  expect(events).toHaveLength(0)
})

test('the default emitter hands owner.message to the engine flows bus only when the flows are on', async () => {
  const load = await import('../engine/load')
  const { makeFakeEngine } = await import('../engine/fixtures/fake-engine')
  const emitted: unknown[] = []
  const create = async (host: never) => {
    const e = await makeFakeEngine()(host)
    return {
      ...e,
      commands: [...e.commands, { verb: 'flow', summary: { en: 'flow', pt: 'flow' }, run: async (args: string[], io: { out(s: string): void }) => {
        if (args[0] === 'ls') { io.out('pedido-do-dono\tenabled'); io.out('encaixe-do-pedido\tenabled') }
        return 0
      } }],
      flows: { list: () => [], run: async () => null, status: async () => null, emit: async (ev: unknown) => { emitted.push(ev); return true } },
    }
  }
  const prev = process.env.AGENTISTICS_FLOWS
  load.resetEngineForTests()
  try {
    await load.loadEngine({ create: create as never, host: () => ({}) as never, env: {}, log: () => {} })
    expect(load.engine()?.flows?.emit).toBeDefined()
    const event = { type: 'owner.message', id: 'owner.message:c:1', payload: { text: 'x' } }
    delete process.env.AGENTISTICS_FLOWS
    expect(await defaultOwnerMessageDeps().emit(event)).toBe(false)
    expect(emitted).toHaveLength(0)
    process.env.AGENTISTICS_FLOWS = '1'
    expect(await defaultOwnerMessageDeps().emit(event)).toBe(true)
    expect(emitted).toEqual([event])
  } finally {
    if (prev === undefined) delete process.env.AGENTISTICS_FLOWS; else process.env.AGENTISTICS_FLOWS = prev
    load.resetEngineForTests()
  }
})

test('the classifier is an opt-in hint, off by default; a suggestion never emits anything', () => {
  expect(ownerTaskSuggestion('corrige o login')).toBe(false)
  expect(ownerTaskSuggestion('corrige o login', false)).toBe(false)
  expect(ownerTaskSuggestion('corrige o login', true)).toBe(true)
  expect(ownerTaskSuggestion('> corrige o login', true)).toBe(false)
})

test('plain composer identity excludes session proofs, verified agents and other verbs', () => {
  expect(isOwnerComposerRequest({ action: 'prompt' })).toBe(true)
  for (const session of [null, {}, { id: 'lead', token: 'invalid' }]) expect(isOwnerComposerRequest({ action: 'prompt', session })).toBe(false)
  expect(isOwnerComposerRequest({ action: 'prompt', callerVerified: true })).toBe(false)
  expect(isOwnerComposerRequest({ action: 'kill' })).toBe(false)
})

test('retired leaders resolve through handoff and reopening, inheriting the original task', () => {
  const rows = [{ id: 'old', taskId: 't1', handoffTo: 'successor', endedAt: 'x' }, { id: 'successor', conversationId: 'conv', endedAt: 'x' }, { id: 'new-id', conversationId: 'conv' }] as ManagedSession[]
  expect(ownerMessageTarget('old', rows)).toMatchObject({ id: 'new-id', taskId: 't1' })
})

test('existing request flow switches remain idempotent for explicit operational callers', async () => {
  const enabled = new Set<string>(), calls: string[][] = []
  const command = { verb: 'flow' as const, summary: { en: '', pt: '' }, run: async (args: string[], io: { out(s: string): void }) => {
    calls.push(args)
    if (args[0] === 'ls') for (const name of ['pedido-do-dono', 'encaixe-do-pedido']) io.out(`${name}\t${enabled.has(name) ? 'enabled' : 'disabled'}`)
    else enabled.add(args[1]!)
    return 0
  } }
  await enableOwnerRequestFlows([command]); await enableOwnerRequestFlows([command])
  expect(calls.filter(c => c[0] === 'enable')).toHaveLength(2)
})

test('open requests remain visible to leaders through the existing briefing', () => {
  const section = 'OWNER OPEN REQUESTS: p1'
  expect(contextText({ sessionId: 's', cwd: '/w', role: 'leader', ownerRequests: section })).toContain(section)
  expect(contextText({ sessionId: 's', cwd: '/w', role: 'worker', ownerRequests: section })).not.toContain(section)
})
