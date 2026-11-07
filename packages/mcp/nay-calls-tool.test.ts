import { describe, expect, test } from 'bun:test'
import { callState, nayCallList, nayCallReopenTarget, nayCallTranscript, type CallLike, type FleetLike } from './nay-calls-tool'

const T0 = Date.parse('2026-11-07T15:30:00Z')
const nay = (over: Partial<CallLike> = {}): CallLike => ({
  callId: 'c1', target: { kind: 'nay', id: 'nay', title: 'Ligação com a Nay' }, sessionId: 'm-1', startedAt: T0, endedAt: T0 + 95_000, activeMs: 90_000,
  utterances: 3, summary: 'Pronto, abri a tarefa.',
  transcript: [{ who: 'user', text: 'abre a tarefa', at: T0 + 1000 }, { who: 'assistant', text: 'Pronto, abri a tarefa.', at: T0 + 5000 }, { who: 'user', text: 'valeu', at: T0 + 9000 }],
  ...over,
})
const fleet = (state: string, verbs: FleetLike['verbs'] = [{ action: 'resume', enabled: true }]): FleetLike[] => [{ id: 'm-1', state, conversationId: 'conv-1', verbs }]

describe('agentistics_session_nay_calls — the list', () => {
  test('lists only the Nay\'s calls (never a call with another session), newest first, with date, duration and state', () => {
    const other: CallLike = { callId: 'c9', target: { kind: 'session', id: 'x' }, startedAt: T0 + 1, endedAt: T0 + 2, utterances: 1 }
    const older = nay({ callId: 'c0', endedAt: T0 - 1000, startedAt: T0 - 50_000, sessionId: undefined })
    const out = nayCallList([older, other, nay()], fleet('exited'))
    expect(out.map(c => c.callId)).toEqual(['c1', 'c0'])
    expect(out[0]).toMatchObject({ callId: 'c1', startedAt: '2026-11-07T15:30:00.000Z', durationSeconds: 90, state: 'ended', sessionId: 'm-1', utterances: 3, summary: 'Pronto, abri a tarefa.' })
    expect(out[1]).toMatchObject({ state: 'no-session' }) // a call from before sessions existed: only its words
    expect('sessionId' in out[1]!).toBe(false)
  })
  test('a call whose session is still working is live; a dropped one says so', () => {
    expect(callState(nay(), fleet('working'))).toBe('live')
    expect(callState(nay(), fleet('waiting'))).toBe('live')
    expect(nayCallList([nay({ dropped: true })], fleet('exited'))[0]).toMatchObject({ dropped: true })
  })
  test('the limit is bounded and the session is found by its conversation id too', () => {
    const many = Array.from({ length: 70 }, (_, i) => nay({ callId: `c${i}`, endedAt: T0 + i }))
    expect(nayCallList(many, [], 500)).toHaveLength(50)
    expect(callState(nay({ sessionId: 'conv-1' }), fleet('working'))).toBe('live')
  })
})

describe('agentistics_session_nay_calls — the transcript', () => {
  test('both sides in order, the owner\'s words as `owner` and the answers as `nay`', () => {
    const t = nayCallTranscript(nay(), fleet('exited'))
    expect(t).toMatchObject({ ok: true, callId: 'c1', state: 'ended', sessionId: 'm-1' })
    expect(t.ok && t.turns.map(u => `${u.who}:${u.text}`)).toEqual(['owner:abre a tarefa', 'nay:Pronto, abri a tarefa.', 'owner:valeu'])
  })
  test('a call that kept only its excerpt is marked partial; a call with another session or none is refused', () => {
    const { transcript: _t, ...only } = nay({ excerpt: [{ who: 'user', text: 'oi', at: T0 }] })
    expect(nayCallTranscript(only, [])).toMatchObject({ ok: true, partial: true })
    expect(nayCallTranscript({ ...nay(), target: { kind: 'session', id: 'x' } }, [])).toEqual({ ok: false, reason: 'no_such_nay_call' })
    expect(nayCallTranscript(null, [])).toEqual({ ok: false, reason: 'no_such_nay_call' })
  })
})

describe('agentistics_session_nay_calls — reopen', () => {
  test('an ended call session reopens through its fleet row (the `resume` verb)', () => {
    expect(nayCallReopenTarget(nay(), fleet('exited'))).toEqual({ ok: true, id: 'm-1' })
    expect(nayCallReopenTarget(nay({ sessionId: 'conv-1' }), fleet('exited'))).toEqual({ ok: true, id: 'm-1' })
  })
  test('refused in a reason: still live, no session, not in the fleet, verb disabled, not a Nay call', () => {
    expect(nayCallReopenTarget(nay(), fleet('working'))).toEqual({ ok: false, reason: 'still_live' })
    expect(nayCallReopenTarget(nay({ sessionId: undefined }), fleet('exited'))).toEqual({ ok: false, reason: 'no_session' })
    expect(nayCallReopenTarget(nay(), [])).toEqual({ ok: false, reason: 'not_in_fleet' })
    expect(nayCallReopenTarget(nay(), fleet('exited', [{ action: 'resume', enabled: false }]))).toEqual({ ok: false, reason: 'not_reopenable' })
    expect(nayCallReopenTarget({ ...nay(), target: { kind: 'session' } }, fleet('exited'))).toEqual({ ok: false, reason: 'no_such_nay_call' })
  })
})
