import { describe, expect, it } from 'bun:test'
import type { ChatTurn } from '@agentistics/core'
import { forwardHasContent, forwardText, injectedLabel, isOwnerTurn, planForward, planRelay, relaySection } from './handoff-relay'
import { captureHandoffRelay, flushAllHandoffRelays, flushBeforeKill, flushHandoffRelay, successorRow } from './handoff-relay-io'
import { ownerWaitingFresh } from './handoff-relay'
import { parseGeminiChatTurns } from './gemini-chat'
import { parseCodexChat } from './codex-chat'
import { parseKimiChat } from './kimi-chat'
import { parseCopilotChat } from './copilot-chat'
import { parseAntigravityChat } from './antigravity-chat'
import { readRecentChatTurns } from './chat-tail'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedSession } from './types'
import { createSessionRegistry } from './registry'

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
    expect(isOwnerTurn({ role: 'user', text: 'Another Claude session sent a message:\n<agent-message from="x">report' })).toBe(false)
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
    expect(section).toContain('Sessão abc (handback)') // labelled as the session that sent it, not as Dono
    expect(section).not.toContain('Dono (2026-10-16 14:40')
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
    // Every harness has a reader now (opencode's arrived with OPENCODE.WP-A), so the missing one is a
    // harness id from a newer build — the case `transcriptReaderFor` answers `null` for.
    const none = await captureHandoffRelay(row({ harness: 'a-harness-from-a-newer-build' as never }))
    expect(none.section).toContain('a-harness-from-a-newer-build')
  })

  it('a failed forward is owed (kill refused); a delivered one moves the cursor', async () => {
    const later = [...CASE, t('user', 'e o motor?', 58)]
    const registry = [row({ handoffTo: 'next', handoffRelayedAt: CASE[6]!.at }), row({ id: 'next', conversationId: 'c2' })]
    const patches: unknown[] = []
    const io = { read: async () => ({ turns: later }), patch: async (_id: string, p: unknown) => { patches.push(p); return true } }
    const failed = await flushHandoffRelay(registry[0]!, registry, async () => false, io)
    expect(failed).toMatchObject({ ok: false, delivered: false, reason: 'send-failed' })
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


describe('HANDOFF.RELAY — kill is best-effort (fix1 H1/M5)', () => {
  const later = [...CASE, t('user', 'e o motor?', 58)]
  const cursor = CASE[6]!.at
  const io = (patches: unknown[] = []) => ({
    read: async () => ({ turns: later }),
    patch: async (_id: string, p: unknown) => { patches.push(p); return true },
  })
  const parent = row({ handoffTo: 'next', handoffRelayedAt: cursor, taskId: 't-1' })
  const comments: Array<[string, string]> = []
  const comment = async (ref: string, body: string) => { comments.push([ref, body]); return true }
  const NOW = Date.parse(cursor!) + 60_000

  it('a dead successor never blocks: the owed text goes to the task and the kill proceeds', async () => {
    comments.length = 0
    const reg = [parent, row({ id: 'next', conversationId: 'c2', endedAt: '2026-10-16T15:00:00.000Z', taskId: 't-2' })]
    let sent = 0
    const r = await flushBeforeKill('lead-1', async () => { sent++; return true }, 'pt', { registry: reg, ...io(), comment, now: NOW })
    expect(sent).toBe(0)
    expect(r.warning).toContain('lead-1')
    expect(comments[0]![0]).toBe('t-2')
    expect(comments[0]![1]).toContain('e o motor?')
  })

  it('a missing successor row never blocks', async () => {
    comments.length = 0
    const r = await flushBeforeKill('lead-1', async () => true, 'en', { registry: [parent], ...io(), comment, now: NOW })
    expect(r.warning).toContain('Ended lead-1')
    expect(comments[0]![0]).toBe('t-1')
  })

  it('a failed send never blocks and is recorded', async () => {
    comments.length = 0
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    const r = await flushBeforeKill('lead-1', async () => false, 'pt', { registry: reg, ...io(), comment, now: NOW })
    expect(r.warning).toContain('não respondeu a tempo')
    expect(comments).toHaveLength(1)
  })

  it('a live successor gets the message and there is no warning', async () => {
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    const sent: string[] = []
    const patches: unknown[] = []
    const r = await flushBeforeKill('lead-1', async to => { sent.push(to); return true }, 'pt', { registry: reg, ...io(patches), comment, now: NOW })
    expect(r.warning).toBeNull()
    expect(sent).toEqual(['next'])
    expect(patches).toHaveLength(2)
    expect(patches[0]).toMatchObject({ handoffRelayClosing: new Date(NOW).toISOString() })
    expect(patches[1]).toMatchObject({ handoffRelayedAt: later[7]!.at })
  })

  it('a session that was never handed off, and one past the 48 h window, are left alone', async () => {
    let sent = 0
    const send = async () => { sent++; return true }
    expect((await flushBeforeKill('lead-1', send, 'pt', { registry: [row({})], ...io(), comment, now: NOW })).warning).toBeNull()
    const old = Date.parse(cursor!) + 49 * 3600_000
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    expect((await flushBeforeKill('lead-1', send, 'pt', { registry: reg, ...io(), comment, now: old })).warning).toBeNull()
    expect(sent).toBe(0)
  })

  it('fix2 M-A: a send that hangs is a send-failed after the timeout and the kill proceeds', async () => {
    comments.length = 0
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    const t0 = Date.now()
    const r = await flushBeforeKill('lead-1', () => new Promise<boolean>(() => {}), 'en', { registry: reg, ...io(), comment, now: NOW, sendTimeoutMs: 30, lateGraceMs: 20 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.warning).toContain('did not answer in time')
    expect(r.warning).not.toContain('send-failed')
    expect(comments).toHaveLength(1)
  })

  it('fix2 M-B: with no task the owed text goes to the notice inbox, with or without away mode', async () => {
    const reg = [row({ handoffTo: 'next', handoffRelayedAt: cursor }), row({ id: 'next', conversationId: 'c2', endedAt: '2026-10-16T15:00:00.000Z' })]
    const notices: Array<[string, string]> = []
    const r = await flushBeforeKill('lead-1', async () => true, 'pt', { registry: reg, ...io(), comment, notify: (t, m) => { notices.push([t, m]); return true }, now: NOW })
    expect(notices).toHaveLength(1)
    expect(notices[0]![1]).toContain('e o motor?')
    expect(r.warning).toContain('sino')
    expect(r.warning).not.toContain('dead')
  })

  it('fix2 M-B: nothing could take the text — the warning says so', async () => {
    const reg = [row({ handoffTo: 'next', handoffRelayedAt: cursor })]
    const r = await flushBeforeKill('lead-1', async () => true, 'en', { registry: reg, ...io(), comment, notify: () => { throw new Error('x') }, now: NOW })
    expect(r.warning).toContain('could not be saved anywhere')
  })

  it('fix2 M-C: a window that did not reach the cursor is reported as owed, not skipped', async () => {
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    const notices: string[] = []
    const r = await flushBeforeKill('lead-1', async () => true, 'en', {
      registry: reg, comment: async () => false, notify: (_t, m) => { notices.push(m); return true }, now: NOW,
      read: async () => ({ turns: later, truncated: true }),
      patch: async () => true,
    })
    expect(r.warning).toContain('too long to check in full')
    expect(notices[0]).toContain('older owner messages')
  })

  it('flushAllHandoffRelays forwards inside the window, skips outside, counts deliveries', async () => {
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    const sent: string[] = []
    const send = async (to: string) => { sent.push(to); return true }
    expect(await flushAllHandoffRelays(send, NOW, { registry: reg, ...io() })).toBe(1)
    expect(await flushAllHandoffRelays(send, Date.parse(cursor!) + 49 * 3600_000, { registry: reg, ...io() })).toBe(0)
    expect(sent).toEqual(['next'])
  })

  it('fix4 M2: the periodic loop ignores a kill-marked predecessor', async () => {
    const ended = row({ handoffTo: 'next', handoffRelayedAt: cursor, handoffRelayClosing: new Date(NOW).toISOString() })
    const reg = [ended, row({ id: 'next', conversationId: 'c2' })]
    let sent = 0
    expect(await flushAllHandoffRelays(async () => { sent++; return true }, NOW, { registry: reg, ...io() })).toBe(0)
    expect(sent).toBe(0)
  })

  it('fix5 N1: a stale kill marker on a predecessor that never ended does not block the loop', async () => {
    const live = row({ handoffTo: 'next', handoffRelayedAt: cursor, handoffRelayClosing: new Date(NOW - 5 * 60_000).toISOString() })
    let sent = 0
    expect(await flushAllHandoffRelays(async () => { sent++; return true }, NOW, {
      registry: [live, row({ id: 'next' })], ...io(),
    })).toBe(1)
    expect(sent).toBe(1)
  })

  it('fix4 M3: an ended predecessor without a kill marker still forwards owed messages', async () => {
    const ended = row({ handoffTo: 'next', handoffRelayedAt: cursor, endedAt: new Date(NOW).toISOString() })
    let sends = 0
    expect(await flushAllHandoffRelays(async () => { sends++; return true }, NOW, {
      registry: [ended, row({ id: 'next' })], ...io(),
    })).toBe(1)
    expect(sends).toBe(1)
  })

  it('fix4 M2: a loop with a stale snapshot cannot resend during late-send grace', async () => {
    const reg = [parent, row({ id: 'next' })]
    let finish!: (ok: boolean) => void
    let started!: () => void
    const sending = new Promise<void>(resolve => { started = resolve })
    let sends = 0
    const patches: unknown[] = []
    const killing = flushBeforeKill(parent.id, () => {
      sends++
      started()
      return new Promise<boolean>(resolve => { finish = resolve })
    }, 'en', { registry: reg, ...io(patches), comment, now: NOW, sendTimeoutMs: 10, lateGraceMs: 500 })
    await sending
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(patches).toEqual([{ handoffRelayClosing: new Date(NOW).toISOString() }])
    expect(await flushAllHandoffRelays(async () => { sends++; return true }, NOW, { registry: reg, ...io() })).toBe(0)
    finish(true)
    expect((await killing).warning).toBeNull()
    expect(sends).toBe(1)
    expect(patches[1]).toMatchObject({ handoffRelayedAt: later[7]!.at })
  })

  it('fix4 M2: a separate registry reader sees closing before send and after a kill timeout', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.relay-registry-test-'))
    const file = join(dir, 'sessions.json')
    const store = createSessionRegistry(file)
    let closingBeforeSend: string | undefined
    let finish!: (ok: boolean) => void
    let sends = 0
    try {
      await store.add(parent)
      await store.add(row({ id: 'next' }))
      const r = await flushBeforeKill(parent.id, async () => {
        sends++
        const fresh = await createSessionRegistry(file).read()
        closingBeforeSend = fresh.find(m => m.id === parent.id)?.handoffRelayClosing
        return new Promise<boolean>(resolve => { finish = resolve })
      }, 'en', { registry: await store.read(), read: io().read, patch: store.patch, comment,
        now: NOW, sendTimeoutMs: 100, lateGraceMs: 30 })
      expect(closingBeforeSend).toBe(new Date(NOW).toISOString())
      expect(r.warning).toContain('did not answer in time')
      const fresh = await createSessionRegistry(file).read()
      expect(fresh.find(m => m.id === parent.id)?.handoffRelayedAt).toBe(cursor)
      expect(await flushAllHandoffRelays(async () => { sends++; return true }, NOW, {
        registry: fresh, read: io().read, patch: store.patch,
      })).toBe(0)
      expect(sends).toBe(1)
    } finally {
      finish?.(false)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fix3 M-D: a send that lands after the timeout is not reported as undelivered, and moves the cursor', async () => {
    comments.length = 0
    const reg = [parent, row({ id: 'next', conversationId: 'c2' })]
    const patches: unknown[] = []
    let sends = 0
    const r = await flushBeforeKill('lead-1', () => { sends++; return new Promise<boolean>(res => setTimeout(() => res(true), 60)) }, 'en', { registry: reg, ...io(patches), comment, now: NOW, sendTimeoutMs: 20, lateGraceMs: 500 })
    expect(r.warning).toBeNull()
    expect(comments).toHaveLength(0)
    expect(sends).toBe(1)
    expect(patches).toHaveLength(2)
    expect(patches[0]).toMatchObject({ handoffRelayClosing: new Date(NOW).toISOString() })
    expect(patches[1]).toMatchObject({ handoffRelayedAt: later[7]!.at })
  })
})

describe('HANDOFF.RELAY — the "owner waiting" gate (fix1 M4)', () => {
  const NOW = Date.UTC(2026, 9, 16, 14, 31)
  it('is open for a fresh unanswered message and closes after 30 min', () => {
    expect(ownerWaitingFresh([t('user', 'oi?', 20)], NOW)).toBe(true)
    expect(ownerWaitingFresh([t('user', 'oi?', 0)], NOW)).toBe(false)
  })
  it('a tool-only assistant turn counts as an answer', () => {
    expect(ownerWaitingFresh([t('user', 'oi?', 25), t('assistant', '', 26, { tools: [{ name: 'Bash' }] })], NOW)).toBe(false)
  })
})

describe('HANDOFF.RELAY — injected prompts are not the owner (fix1 M2), in every harness reader', () => {
  const cron = 'CRON 13h23 — verificar o release'
  it('cron and scheduled prompts are not the owner; pasted content is', () => {
    expect(isOwnerTurn(t('user', cron, 1))).toBe(false)
    expect(isOwnerTurn(t('user', '[scheduled] check', 1))).toBe(false)
    expect(isOwnerTurn(t('user', 'olha isso <pasted_content id="x">abc</pasted_content>', 1))).toBe(true)
  })
  it('gemini flags injected notes as system', () => {
    const l = JSON.stringify({ id: 'a', timestamp: '2026-10-16T14:00:00Z', type: 'user', content: '<system-reminder>x</system-reminder>' })
    const o = JSON.stringify({ id: 'b', timestamp: '2026-10-16T14:01:00Z', type: 'user', content: 'oi' })
    const turns = parseGeminiChatTurns([l, o], 50)
    expect(turns.map(isOwnerTurn)).toEqual([false, true])
  })
  it('codex, kimi, copilot and antigravity injected entries are not owner turns', () => {
    const AT = '2026-07-07T22:04:06.000Z'
    const codex = parseCodexChat([
      JSON.stringify({ timestamp: AT, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>\nx' }] } }),
      JSON.stringify({ timestamp: AT, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pergunta real' }] } }),
    ])
    expect(codex.filter(isOwnerTurn).map(x => x.text)).toEqual(['pergunta real'])
    const T = 1785943919760
    const kimi = parseKimiChat([JSON.stringify({
      time: T, type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nx' }], toolCalls: [], origin: { kind: 'permission_mode' } },
    })])
    expect(kimi.filter(isOwnerTurn)).toHaveLength(0)
    const copilot = parseCopilotChat([JSON.stringify({ type: 'system.message', data: { role: 'system', content: 'You are…' }, id: 'x', timestamp: '2026-06-30T14:53:11.560Z' })])
    expect(copilot.filter(isOwnerTurn)).toHaveLength(0)
    const agy = parseAntigravityChat([JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'x' })])
    expect(agy.filter(isOwnerTurn)).toHaveLength(0)
  })
  it('claude: a <task-notification> in the transcript is not the owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-claude-'))
    try {
      const f = join(dir, 'c.jsonl')
      await writeFile(f, [
        JSON.stringify({ type: 'user', message: { content: '<task-notification>done</task-notification>' } }),
        JSON.stringify({ type: 'user', message: { content: 'pergunta real' } }),
      ].join('\n') + '\n')
      const turns = await readRecentChatTurns(f)
      expect(turns.filter(isOwnerTurn).map(x => x.text)).toEqual(['pergunta real'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

})

describe('HANDOFF.RELAY — injected session messages are labelled, never the owner', () => {
  const wrapped = '<pasted_content id="a1">\n[from session e2fa75878c · handback]\nfeito @ abc\n</pasted_content id="a1">'
  it('a pasted-wrapped handback is not an owner turn and is labelled with its sender', () => {
    const turn = t('user', wrapped, 1)
    expect(isOwnerTurn(turn)).toBe(false)
    expect(injectedLabel(turn)).toBe('Sessão e2fa75878c (handback)')
    expect(isOwnerTurn(t('user', '[from agentistics · whatever]\nx', 1))).toBe(false)
  })
  it('snapshot and forward show it under its label and not as "Dono"', () => {
    const turns = [t('user', wrapped, 1), t('assistant', 'ok', 2)]
    const r = planRelay(turns)
    expect(r.owner).toHaveLength(0)
    const sec = relaySection('lead-1', r)
    expect(sec).toContain('Sessão e2fa75878c (handback)')
    expect(sec).not.toContain('Dono')
    const f = planForward(turns, undefined, false)!
    expect(f.owner).toHaveLength(0)
    const txt = forwardText('lead-1', f)
    expect(txt).toContain('Sessão e2fa75878c (handback)')
    expect(txt).not.toContain('Responda ao dono')
  })
})
