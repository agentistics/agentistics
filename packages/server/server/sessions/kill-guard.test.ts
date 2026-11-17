import { describe, expect, it } from 'bun:test'
import { decideKillAgainstCall, guardKillAgainstCall } from './kill-guard'
import { callsFromServer, observeFromCalls, probeCall, type CallsAnswer } from './call-state'

const T0 = Date.parse('2026-11-17T14:00:00.000Z')
const active = { state: 'active', since: T0 - 5 * 60_000, callId: 'call-9' } as const

describe('agentop session kill on a session in a voice call', () => {
  it('refuses, names who is in the call and the ways out', () => {
    const g = decideKillAgainstCall('p1', active, false, T0)
    expect(g.allow).toBe(false)
    if (g.allow) return
    expect(g.message).toContain('Not killing p1')
    expect(g.message).toContain('voice call')
    expect(g.message).toContain('call-9')
    expect(g.message).toContain('5 min ago')
    expect(g.message).toContain('--force')
    expect(g.message).toContain('agentop session retire p1')
  })
  it('--force kills anyway and says the call is hung up', () => {
    const g = decideKillAgainstCall('p1', active, true, T0)
    expect(g).toMatchObject({ allow: true })
    expect(g.allow && g.warn).toContain('--force')
  })
  it('no call: plain kill, no warning', () => {
    expect(decideKillAgainstCall('p1', { state: 'none' }, false, T0)).toEqual({ allow: true })
  })
  it('a call state that could not be read is refused too — unknown is not free to kill', () => {
    const g = decideKillAgainstCall('p1', { state: 'unknown' }, false, T0, 'the server did not answer in time')
    expect(g.allow).toBe(false)
    expect(!g.allow && g.message).toContain('did not answer in time')
    expect(decideKillAgainstCall('p1', { state: 'unknown' }, true, T0).allow).toBe(true)
  })
})

describe('guardKillAgainstCall reads the call by managed id OR conversation id', () => {
  const ans = (sessionId: string): CallsAnswer => ({ state: 'ok', calls: [{ callId: 'c1', sessionId, startedAt: T0 - 60_000 }] })
  it('matches the managed id', async () => {
    expect((await guardKillAgainstCall({ id: 'p1' }, false, async () => ans('p1'), () => T0)).allow).toBe(false)
  })
  it('matches the conversation id the voice page may have been opened with', async () => {
    expect((await guardKillAgainstCall({ id: 'p1', conversationId: 'conv-1' }, false, async () => ans('conv-1'), () => T0)).allow).toBe(false)
  })
  it('another session’s call does not block this one', async () => {
    expect((await guardKillAgainstCall({ id: 'p1' }, false, async () => ans('p2'), () => T0)).allow).toBe(true)
  })
  it('no server means no call', async () => {
    expect((await guardKillAgainstCall({ id: 'p1' }, false, async () => ({ state: 'no-server' }), () => T0)).allow).toBe(true)
  })
})

describe('call-state readers', () => {
  it('probeCall: no voice = none; a throwing voice = unknown; the first key that has a call wins', () => {
    expect(probeCall({ id: 'a' }, null)).toEqual({ state: 'none' })
    expect(probeCall({ id: 'a' }, { activeCall: () => { throw new Error('x') } })).toEqual({ state: 'unknown' })
    const voice = { activeCall: (id: string) => (id === 'conv' ? { callId: 'c', sessionId: id, startedAt: 5 } : null) }
    expect(probeCall({ id: 'a', conversationId: 'conv' }, voice)).toEqual({ state: 'active', since: 5, callId: 'c' })
    expect(probeCall({ id: 'a' }, voice)).toEqual({ state: 'none' })
  })
  it('observeFromCalls maps every answer kind', () => {
    expect(observeFromCalls({ id: 'a' }, { state: 'no-server' })).toEqual({ state: 'none' })
    expect(observeFromCalls({ id: 'a' }, { state: 'unknown', why: 'x' })).toEqual({ state: 'unknown' })
  })
  it('callsFromServer: refused connection = no-server; HTTP error and garbage = unknown; a list = ok', async () => {
    expect(await callsFromServer(1, (async () => { throw new TypeError('ECONNREFUSED') }) as unknown as typeof fetch)).toEqual({ state: 'no-server' })
    const t = Object.assign(new Error('t'), { name: 'TimeoutError' })
    expect((await callsFromServer(1, (async () => { throw t }) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await callsFromServer(1, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await callsFromServer(1, (async () => new Response('{"x":1}')) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await callsFromServer(1, (async () => new Response('nope')) as unknown as typeof fetch)).state).toBe('unknown')
    const ok = await callsFromServer(1, (async () => Response.json({ calls: [{ callId: 'c', sessionId: 's', startedAt: 1 }, { bad: true }] })) as unknown as typeof fetch)
    expect(ok).toEqual({ state: 'ok', calls: [{ callId: 'c', sessionId: 's', startedAt: 1 }] })
  })
})
