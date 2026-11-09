import { beforeEach, expect, test } from 'bun:test'
import { lastMessageTo, noteMessageTo, resetLastMessages } from '../sessions/last-message'
import { resetMessageRateLimit, sendSessionMessage, type MessageDeps } from '../sessions/session-message'
import { flowHostOps } from './host-ops'

beforeEach(() => { resetLastMessages(); resetMessageRateLimit() })

test('ultima-mensagem-sessao: nothing known is ok:false, a message is ISO + from + kind, and an older one never replaces a newer one', async () => {
  const op = flowHostOps()['ultima-mensagem-sessao']
  expect(await op({ sessionId: 'W' })).toEqual({ ok: false, sessionId: 'W' })
  expect(await op({})).toMatchObject({ refused: true })
  noteMessageTo('W', Date.parse('2026-11-08T10:00:00Z'), { from: 'L', kind: 'question' })
  expect(await op({ sessionId: 'W' })).toEqual({ ok: true, at: '2026-11-08T10:00:00.000Z', from: 'L', kind: 'question', sessionId: 'W' })
  noteMessageTo('W', Date.parse('2026-11-08T09:00:00Z'))
  expect(lastMessageTo('W')?.from).toBe('L')
  noteMessageTo('W', Date.parse('2026-11-08T11:00:00Z'))
  expect(await op({ sessionId: 'W' })).toEqual({ ok: true, at: '2026-11-08T11:00:00.000Z', sessionId: 'W' })
})

test('a delivered agentistics_session_message is what the op reports, with sender and kind', async () => {
  const deps: MessageDeps = {
    rows: async () => [{ id: 'W', title: 'worker' }] as never,
    prompt: async () => ({ ok: true }),
    senderTask: async () => ({}),
    comment: async () => ({ ok: true }),
    now: () => Date.parse('2026-11-08T12:00:00Z'),
  }
  expect(await sendSessionMessage('L', { to: 'W', kind: 'question', body: 'more work' }, deps)).toMatchObject({ ok: true })
  expect(await flowHostOps()['ultima-mensagem-sessao']({ sessionId: 'W' })).toMatchObject({ ok: true, at: '2026-11-08T12:00:00.000Z', from: 'L', kind: 'question' })
})
