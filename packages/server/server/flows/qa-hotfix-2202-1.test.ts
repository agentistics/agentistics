/**
 * QA HOTFIX 2.202.1 (FLUXO.AVISOS 1, 2, 3, 11) — independent probe of 70c8dd1e3.
 * Passing tests pin what holds; `test.failing` pins a finding (it turns red once fixed — flip it to `test`).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nudgeExcerpt, ownerIntent } from './owner-intent'
import { createOwnerLedger } from './owner-ledger'
import { emitOwnerMessage, emitRelayedOwnerMessages, type OwnerMessageDeps } from './owner-message'
import { isOwnerTurn, planRelay } from '../sessions/handoff-relay'
import { captureHandoffRelay } from '../sessions/handoff-relay-io'
import { requestReminderText } from '../delivery/request-reminder'

function world() {
  const ledger = createOwnerLedger(join(mkdtempSync(join(tmpdir(), 'qa2202-')), 'owner-messages.json'))
  let clock = Date.parse('2026-11-08T04:00:00.000Z')
  const events: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  const d: OwnerMessageDeps = {
    flowsOn: () => true,
    row: async id => (id === 'old' || id === 'lead' ? { id: 'lead', conversationId: 'conv-new', taskId: 't-1' } : undefined),
    addressed: async id => (id === 'old' ? { id: 'old', conversationId: 'conv-old' } : id === 'lead' ? { id: 'lead', conversationId: 'conv-new' } : undefined),
    roleOf: async () => 'leader',
    seen: (scope, text, withinMs) => ledger.has(scope, text, clock, withinMs),
    remember: (scopes, text, at) => ledger.add(scopes, text, at),
    mode: async () => 'queue',
    emit: async e => { events.push(e) },
    now: () => clock,
  }
  return { d, events, tick: (ms: number) => { clock += ms } }
}

describe('item 1 — an answered owner message is never re-queued', () => {
  test('queued message, transcript clock 9 min off the composer clock, relayed after an answer → one pedido', async () => {
    const x = world()
    expect(await emitOwnerMessage({ action: 'prompt', id: 'old', text: 'quando sai as coisas?' }, x.d, { at: '2026-11-08T04:00:00.000Z' })).toBe('emitted')
    x.tick(30 * 60_000)
    await emitRelayedOwnerMessages('lead', { id: 'old', conversationId: 'conv-old' }, [{ at: '2026-11-08T04:09:00.000Z', text: 'quando sai as coisas?' }], x.d)
    expect(x.events).toHaveLength(1)
  })

  test('the ledger match is by text with no time window for the relay (a day later is still a duplicate)', async () => {
    const x = world()
    await emitOwnerMessage({ action: 'prompt', id: 'old', text: 'corrige a coluna de histórico' }, x.d, { at: '2026-11-08T04:00:00.000Z' })
    x.tick(20 * 60 * 60_000)
    await emitRelayedOwnerMessages('lead', { id: 'old', conversationId: 'conv-old' }, [{ at: '2026-11-09T00:00:00.000Z', text: 'corrige  a coluna de histórico ' }], x.d)
    expect(x.events).toHaveLength(1)
  })

  test('captureHandoffRelay flags a turn answered by a later assistant text; the relay then skips it even without a ledger', async () => {
    const turns = [
      { role: 'user', text: 'opcao C', at: '2026-11-08T03:00:00.000Z' },
      { role: 'assistant', text: 'Fechado, vou com a C.', at: '2026-11-08T03:00:30.000Z' },
    ] as never
    const got = await captureHandoffRelay({ id: 'old', conversationId: 'conv-old' } as never, async () => ({ turns }))
    expect(got.owner?.[0]?.answered).toBe(true)
    const x = world()
    await emitRelayedOwnerMessages('lead', { id: 'old', conversationId: 'conv-old' }, got.owner!, x.d)
    expect(x.events).toHaveLength(0)
  })
})

describe('item 2 — hand-off prompt, relay and questions never become owner work', () => {
  test('the hand-off prompt (handoff:true) emits nothing, and its sentence is not an owner turn in the relay', async () => {
    const x = world()
    const pt = 'Quero passar a liderança agora. Prepare o arquivo durável de passagem com estado, decisões, sessões ativas e fila.'
    expect(await emitOwnerMessage({ action: 'prompt', id: 'lead', text: pt, handoff: true }, x.d)).toBe('handoff')
    expect(isOwnerTurn({ role: 'user', text: pt })).toBe(false)
    expect(planRelay([{ role: 'user', text: pt, at: '2026-11-08T04:00:00.000Z' }] as never).owner).toHaveLength(0)
    expect(x.events).toHaveLength(0)
  })

  test('the same owner message twice (app + handoff-relay) → one pedido', async () => {
    const x = world()
    await emitOwnerMessage({ action: 'prompt', id: 'old', text: 'o que sai na próxima?' }, x.d, { at: '2026-11-08T04:00:00.000Z' })
    x.tick(15_000)
    await emitRelayedOwnerMessages('lead', { id: 'old', conversationId: 'conv-old' }, [{ at: '2026-11-08T04:03:00.000Z', text: 'o que sai na próxima?' }], x.d)
    expect(x.events).toHaveLength(1)
  })

  test('real cases from 08/11: answers and plain questions are questions, an explicit work request is work', () => {
    expect(ownerIntent('opcao C')).toBe('question')
    expect(ownerIntent('quando sai as coisas?')).toBe('question')
    expect(ownerIntent('o que sai na próxima?')).toBe('question')
    expect(ownerIntent('mano socorro, faz o hotfix urgente')).toBe('work')
  })

  test('the reminder never chases a question (host side)', () => {
    // service.ts filters by ownerIntent(p.text) === 'work'; covered by service.test.ts 'a QUESTION is answered…'.
    expect(ownerIntent('e o deploy?')).toBe('question')
  })

  // FINDING F1 — a work request whose verb is NOT the first word (or after "e/and/pra/to" or punctuation) is
  // classified `question` when it is ≤ 12 words. The reminder then never chases it, and the engine (once it consumes
  // `intent`) would record it answered on the leader's next reply: the owner's work silently dropped. The rule says it
  // "errs toward work", but here it errs toward question. Everyday pt phrasing from the owner:
  test.failing('F1: mid-sentence imperatives are work', () => {
    for (const w of [
      'mano faz o hotfix',             // "mano socorro, faz…" passes only because of the comma
      'agora manda o relatório',       // the author's own relay fixture text
      'bora fazer o hotfix',
      'então corrige o login',
      'tem que corrigir o login',
      'ok segue com a opção C',        // "segue" is not in the verb list (only "siga")
    ]) expect([w, ownerIntent(w)]).toEqual([w, 'work'])
  })

  // FINDING F2 (minor) — POLITE matches "pode" anywhere, so short answers/questions become work.
  test.failing('F2: "pode ser?" style answers are not work', () => {
    for (const q of ['pode ser?', 'pode ser a C']) expect([q, ownerIntent(q)]).toEqual([q, 'question'])
  })
})

describe('item 11 — the nudge cites id + start of the text', () => {
  test('id + ≤ ~80 chars, no attachment path, no whole message', () => {
    const text = `mano socorro, faz o hotfix urgente /home/me/.agentistics/attachments/aa-image.png ${'log '.repeat(400)}`
    const body = requestReminderText([{ id: 'p-abc', text }])
    expect(body).toContain('p-abc')
    expect(body).toContain('mano socorro, faz o hotfix urgente')
    expect(body).not.toContain('attachments')
    expect(body).not.toContain('log log log log log log log log log log log log log log log log log log log log log log')
    expect(nudgeExcerpt(text).length).toBeLessThanOrEqual(81)
  })
})
