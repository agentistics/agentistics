import { expect, spyOn, test } from 'bun:test'
import { emitOwnerMessage, emitRelayedOwnerMessages, enableOwnerRequestFlows, ownerMessageTarget, isOwnerComposerRequest, type OwnerMessageDeps } from './owner-message'
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
