import { describe, expect, it } from 'bun:test'
import type { ChatTurn } from '@agentistics/core'
import { forwardHasContent, forwardText, isOwnerTurn, planForward, planRelay, relaySection } from './handoff-relay'
import { captureHandoffRelay, flushHandoffRelay, successorRow } from './handoff-relay-io'
import type { ManagedSession } from './types'

const t = (role: 'user' | 'assistant', text: string, min: number, extra: Partial<ChatTurn> = {}): ChatTurn =>
  ({ role, text, at: new Date(Date.UTC(2026, 9, 16, 14, min)).toISOString(), ...extra })

// The 16/10 11:53 BRT case: owner asks, leader answers, the hint lands, the leader hands off.
const CASE: ChatTurn[] = [
  t('user', '[from session abc · handback]\nworker done', 40),
  t('user', 'o release saiu? qual versão?', 50),
  t('assistant', 'Vou checar.', 51, { tools: [{ name: 'Bash' }] }),
  t('assistant', 'Saiu: v2.136.1, com o fix do chat.', 52),
  t('user', '[from agentistics · question]\nTrocar agora pode economizar…', 53),
  t('assistant', 'Escrevendo a passagem.', 54),
  t('user', 'background', 55, { system: 'background task reported back' }),
]

describe('HANDOFF.RELAY — who is the owner', () => {
  it('session, agentistics, context and harness notes are not the owner', () => {
    expect(isOwnerTurn(CASE[0]!)).toBe(false)
    expect(isOwnerTurn(CASE[1]!)).toBe(true)
    expect(isOwnerTurn(CASE[4]!)).toBe(false)
    expect(isOwnerTurn(CASE[6]!)).toBe(false)
    expect(isOwnerTurn(t('user', '<task-notification>x</task-notification>', 1))).toBe(false)
    expect(isOwnerTurn(t('user', '<agentistics-context>\n…', 1))).toBe(false)
    expect(isOwnerTurn(t('assistant', 'hi', 1))).toBe(false)
  })
})

describe('HANDOFF.RELAY — the briefing snapshot', () => {
  it('carries the owner question and the predecessor answer, with the restate instruction', () => {
    const r = planRelay(CASE)
    expect(r.owner.map(m => m.text)).toEqual(['o release saiu? qual versão?'])
    expect(r.reply?.text).toContain('v2.136.1')
    expect(r.unanswered).toBe(false)
    expect(r.cursor).toBe(CASE[6]!.at)
    const section = relaySection('lead-1', r)
    expect(section).toContain('Mensagens do dono e a última resposta do antecessor')
    expect(section).toContain('> o release saiu? qual versão?')
    expect(section).toContain('v2.136.1')
    expect(section).toContain('PRIMEIRA resposta')
    expect(section).not.toContain('worker done')
  })

  it('an owner message with no reply is said to be unanswered', () => {
    const r = planRelay([t('user', 'pergunta?', 1)])
    expect(r.unanswered).toBe(true)
    expect(relaySection('p', r)).toContain('SEM resposta')
  })

  it('caps owner messages and counts the omitted ones; honours `since`', () => {
    const many = Array.from({ length: 13 }, (_, i) => t('user', `m${i}`, i))
    const r = planRelay(many)
    expect(r.owner).toHaveLength(10)
    expect(r.omitted).toBe(3)
    expect(r.owner[0]!.text).toBe('m3')
    expect(planRelay(many, many[10]!.at).owner.map(m => m.text)).toEqual(['m11', 'm12'])
  })

  it('an unreadable conversation is said, never skipped', () => {
    expect(relaySection('p', null, 'o harness "x" não tem leitor')).toContain('não tem leitor')
  })
})

describe('HANDOFF.RELAY — forwarding after the snapshot', () => {
  const cursor = CASE[6]!.at
  it('nothing new → nothing', () => {
    expect(planForward(CASE, cursor, false)).toBeNull()
  })
  it('an owner message written after the hand-off is forwarded with the reply that followed', () => {
    const later = [...CASE, t('user', 'e o motor?', 58), t('assistant', 'Motor verde.', 59)]
    const f = planForward(later, cursor, false)!
    expect(forwardHasContent(f)).toBe(true)
    expect(f.owner.map(m => m.text)).toEqual(['e o motor?'])
    expect(f.reply?.text).toBe('Motor verde.')
    expect(f.awaiting).toBe(false)
    expect(forwardText('lead-1', f)).toStartWith('[from agentistics · relay]')
  })
  it('an answer written after the snapshot to an unanswered question is forwarded', () => {
    const later = [...CASE, t('assistant', 'Resposta tardia.', 58)]
    expect(planForward(later, cursor, false)!.reply).toBeUndefined()
    expect(planForward(later, cursor, true)!.reply?.text).toBe('Resposta tardia.')
  })
  it('only predecessor chatter moves the cursor without content', () => {
    const later = [...CASE, t('assistant', 'Passagem feita.', 58)]
    const f = planForward(later, cursor, false)!
    expect(forwardHasContent(f)).toBe(false)
    expect(f.cursor).toBe(later[7]!.at)
  })
})

const row = (extra: Partial<ManagedSession>): ManagedSession =>
  ({ id: 'lead-1', harness: 'codex', cwd: '/w', createdAt: '2026-10-16T10:00:00.000Z', conversationId: 'c1', ...extra })

describe('HANDOFF.RELAY — IO with injected reader', () => {
  it('works for any harness through its reader, and names a missing one', async () => {
    const got = await captureHandoffRelay(row({}), async () => ({ turns: CASE }))
    expect(got.section).toContain('v2.136.1')
    expect(got.cursor).toBe(CASE[6]!.at)
    const none = await captureHandoffRelay(row({ harness: 'opencode' }))
    expect(none.section).toContain('opencode')
  })

  it('a failed forward is owed (kill refused); a delivered one moves the cursor', async () => {
    const later = [...CASE, t('user', 'e o motor?', 58)]
    const registry = [row({ handoffTo: 'next', handoffRelayedAt: CASE[6]!.at }), row({ id: 'next', conversationId: 'c2' })]
    const patches: unknown[] = []
    const io = { read: async () => ({ turns: later }), patch: async (_id: string, p: unknown) => { patches.push(p); return true } }
    const failed = await flushHandoffRelay(registry[0]!, registry, async () => false, io)
    expect(failed).toEqual({ ok: false, delivered: false })
    expect(patches).toHaveLength(0)
    const sentTo: string[] = []
    const ok = await flushHandoffRelay(registry[0]!, registry, async to => { sentTo.push(to); return true }, io)
    expect(ok.delivered).toBe(true)
    expect(sentTo).toEqual(['next'])
    expect(patches[0]).toMatchObject({ handoffRelayedAt: later[7]!.at, handoffRelayAwaiting: true })
  })

  it('follows a reopened successor to its live row', () => {
    const reg = [row({ id: 'next', conversationId: 'c2', endedAt: 'x' }), row({ id: 'next2', conversationId: 'c2' })]
    expect(successorRow(reg, 'next')?.id).toBe('next2')
  })
})
