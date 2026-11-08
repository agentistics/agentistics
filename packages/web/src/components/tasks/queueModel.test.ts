import { describe, expect, test } from 'bun:test'
import { actionRequest, briefPreview, predispatchLine, scheduleIso, shortCwd, stateLine, toLocalInput, type QueueRow } from './queueModel'
import { queueLines, queueWaitLine } from './liveCardModel'
import { startsLine } from './queueTime'

const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 10, 7 + d, h, m, 0).toISOString()

const row = (o: Partial<QueueRow> = {}): QueueRow => ({
  subtaskId: 's1', taskId: 't1', title: 'Peça', taskTitle: 'Tarefa', priority: 'high', position: 1, globalPosition: 1, since: at(0, 9), group: null,
  predispatch: { ok: true, harness: 'claude', model: 'opus', effort: 'high', account: 'acc_1', accountName: 'Vini', cwd: '/home/u/work/repo', prompt: 'faça tudo' },
  slot: { ok: true, reason: null, at: at(0, 14) }, hold: null, ask: null, leaderSessionId: 'lead', leaderAlive: true, notes: { total: 0, last: [] }, ...o,
})

describe('queue model — words a person reads', () => {
  test('a scheduled start is said as an hour, with the day when it is not today', () => {
    expect(startsLine(at(0, 17, 30), NOW, true)).toBe('começa às 17:30')
    expect(startsLine(at(1, 9, 5), NOW, true)).toBe('começa amanhã às 09:05')
    expect(startsLine(at(3, 9, 5), NOW, true)).toBe('começa 10/11 às 09:05')
    expect(startsLine(at(0, 17, 30), NOW, false)).toBe('starts at 17:30')
    expect(startsLine(at(3, 9, 5), NOW, false)).toBe('starts 11/10 at 09:05')
  })

  test('the state line: hold beats question beats the slot verdict — in plain words, no ids', () => {
    expect(stateLine(row({ hold: { kind: 'nao', reason: 'espera o release', at: at(0, 14), actor: 'lead', active: true } }), NOW, true))
      .toEqual({ text: 'não por enquanto: espera o release', tone: 'hold' })
    expect(stateLine(row({ hold: { kind: 'agendar', reason: 'depois da reunião', at: at(0, 14), actor: 'lead', until: at(0, 17), active: true } }), NOW, true))
      .toEqual({ text: 'começa às 17:00 · depois da reunião', tone: 'hold' })
    // a lapsed schedule is no hold any more
    expect(stateLine(row({ hold: { kind: 'agendar', reason: 'x', at: at(0, 10), actor: 'lead', until: at(0, 11), active: false } }), NOW, true).tone).toBe('ready')
    const ask = { at: at(0, 14, 55), delivered: true, approved: false, expiresAt: at(0, 15, 5), onTimeout: 'sim' as const }
    expect(stateLine(row({ ask }), NOW, true)).toEqual({ text: 'perguntei ao líder · sem resposta em 5 min segue como sim', tone: 'ask' })
    expect(stateLine(row({ ask: { ...ask, onTimeout: 'esperar' } }), NOW, true).text).toContain('o modo autônomo está desligado')
    expect(stateLine(row({ ask: { ...ask, approved: true } }), NOW, true).tone).toBe('approved')
    expect(stateLine(row({ slot: { ok: false, reason: 'no slot: 4 workers running (machine ceiling 4)', at: at(0, 14) } }), NOW, true))
      .toEqual({ text: 'esperando vaga: 4 de 4 sessões em uso', tone: 'wait' })
    expect(stateLine(row({ slot: { ok: false, reason: 'no slot: 5 h window at 90% (≥ 85%)', at: at(0, 14) } }), NOW, true).text).toBe('esperando a conta liberar (janela de 5 h em 90%)')
    expect(stateLine(row({ slot: null }), NOW, true).text).toBe('vaga: ainda não checada')
    expect(stateLine(row(), NOW, true).tone).toBe('ready')
    expect(stateLine(row({ predispatch: { ...row().predispatch, ok: false, missing: ['model'] } }), NOW, true).text).toContain('pré-dispatch incompleto: model')
  })

  test('the pre-dispatch line, a collapsed brief and a short folder', () => {
    expect(predispatchLine(row().predispatch, true)).toBe('claude · opus · high · conta Vini')
    expect(predispatchLine({ ...row().predispatch, model: null, effort: null, accountName: null }, true)).toBe('claude')
    expect(briefPreview('a\n\nb')).toEqual({ short: 'a · b', cut: false })
    const long = briefPreview('x'.repeat(500), 100)
    expect(long.cut).toBe(true)
    expect(long.short.length).toBe(101)
    expect(shortCwd('/home/u/work/repo')).toBe('…/work/repo')
    expect(shortCwd('/r')).toBe('/r')
    expect(shortCwd(null)).toBeNull()
  })

  test('the tab\'s actions build the same requests the CLI and the MCP send; a missing reason or hour is refused', () => {
    expect(actionRequest('start', {})).toEqual({ body: { action: 'queue-answer', answer: 'sim' } })
    expect(actionRequest('dequeue', { reason: ' não vale ' })).toEqual({ body: { action: 'dequeue', reason: 'não vale' } })
    expect(actionRequest('dequeue', { reason: ' ' })).toEqual({ error: 'reason' })
    expect(actionRequest('schedule', { reason: 'depois', untilIso: '2026-11-08T14:00:00.000Z' })).toEqual({ body: { action: 'queue-answer', answer: 'agendar 2026-11-08T14:00:00.000Z depois' } })
    expect(actionRequest('schedule', { reason: 'depois' })).toEqual({ error: 'when' })
    expect(actionRequest('schedule', { untilIso: '2026-11-08T14:00:00.000Z' })).toEqual({ error: 'reason' })
  })

  test('scheduling accepts only a future local time', () => {
    expect(scheduleIso(toLocalInput(NOW + 3600_000), NOW)).toBe(new Date(new Date(toLocalInput(NOW + 3600_000)).getTime()).toISOString())
    expect(scheduleIso(toLocalInput(NOW - 3600_000), NOW)).toBeNull()
    expect(scheduleIso('', NOW)).toBeNull()
    expect(scheduleIso('lixo', NOW)).toBeNull()
  })
})

describe('the Live card carries the queue facts from the same record', () => {
  test('the card line says the reason, the hour, the question or the approval', () => {
    const hold = (kind: 'nao' | 'agendar', until: string | null) => ({ hold: { kind, reason: 'por causa do release', until, by: 'lead', atMs: 1 }, asking: false, approved: false })
    expect(queueWaitLine(null, true, NOW)).toBeNull()
    expect(queueWaitLine(hold('nao', null), true, NOW)).toBe('não por enquanto: por causa do release')
    expect(queueWaitLine(hold('agendar', at(0, 17, 30)), true, NOW)).toBe('começa às 17:30 · por causa do release')
    expect(queueWaitLine({ hold: null, asking: true, approved: false }, true, NOW)).toBe('esperando a resposta do líder')
    expect(queueWaitLine({ hold: null, asking: false, approved: true }, false, NOW)).toBe('approved — opens when a slot is free')
    expect(queueLines({ staged: null, slot: null, queue: hold('agendar', at(0, 17, 30)) }, true, undefined, NOW).wait).toBe('começa às 17:30 · por causa do release')
  })
})
