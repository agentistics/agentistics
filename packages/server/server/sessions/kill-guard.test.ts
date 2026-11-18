import { describe, expect, it } from 'bun:test'
import { decideKillAgainstHold, guardKillAgainstHold } from './kill-guard'
import { holdsFromServer, observeFromAnswer, normalizeHold, probeHold, type HoldAnswer } from './hold-state'

const T0 = Date.parse('2026-11-17T14:00:00.000Z')
const sentence = { en: 'a live thing the engine runs is using it', pt: 'algo vivo que o engine roda a está usando' }
const held = { state: 'held', since: T0 - 5 * 60_000, sentence } as const

describe('agentop session kill on a held session', () => {
  it('refuses, says WHAT holds it in the engine\'s own words, and names the ways out', () => {
    const g = decideKillAgainstHold('p1', held, false, T0)
    expect(g.allow).toBe(false)
    if (g.allow) return
    expect(g.message).toContain('Not killing p1')
    expect(g.message).toContain(sentence.en)
    expect(g.message).toContain('5 min ago')
    expect(g.message).toContain('--force')
    expect(g.message).toContain('agentop session retire p1')
  })
  it('--force kills anyway and says whoever uses it is cut off', () => {
    const g = decideKillAgainstHold('p1', held, true, T0)
    expect(g).toMatchObject({ allow: true })
    expect(g.allow && g.warn).toContain('--force')
  })
  it('no hold: plain kill, no warning', () => {
    expect(decideKillAgainstHold('p1', { state: 'none' }, false, T0)).toEqual({ allow: true })
  })
  it('a hold state that could not be read is refused too — unknown is not free to kill', () => {
    const g = decideKillAgainstHold('p1', { state: 'unknown' }, false, T0, 'the server did not answer in time')
    expect(g.allow).toBe(false)
    expect(!g.allow && g.message).toContain('did not answer in time')
    expect(decideKillAgainstHold('p1', { state: 'unknown' }, true, T0).allow).toBe(true)
  })
})

describe('guardKillAgainstHold reads what the server answered', () => {
  const ok = (hold: unknown): HoldAnswer => ({ state: 'ok', hold: normalizeHold(hold) })
  it('a held answer blocks', async () => {
    expect((await guardKillAgainstHold({ id: 'p1' }, false, async () => ok(held), () => T0)).allow).toBe(false)
  })
  it('a none answer does not', async () => {
    expect((await guardKillAgainstHold({ id: 'p1' }, false, async () => ok({ state: 'none' }), () => T0)).allow).toBe(true)
  })
  it('no server means nothing holds it', async () => {
    expect((await guardKillAgainstHold({ id: 'p1' }, false, async () => ({ state: 'no-server' }), () => T0)).allow).toBe(true)
  })
})

describe('hold-state readers', () => {
  it('probeHold: no holds = none; a throwing engine = unknown; a malformed answer = unknown, never none', async () => {
    expect(await probeHold({ id: 'a' }, null)).toEqual({ state: 'none' })
    expect(await probeHold({ id: 'a' }, { observe: async () => { throw new Error('x') } })).toEqual({ state: 'unknown' })
    expect(await probeHold({ id: 'a' }, { observe: async () => ({ state: 'held', since: 5 }) as never })).toEqual({ state: 'unknown' })
    expect(await probeHold({ id: 'a' }, { observe: async () => ({ state: 'weird' }) as never })).toEqual({ state: 'unknown' })
  })
  it('probeHold passes the conversation id along and returns the engine\'s held reading with its sentence', async () => {
    let asked: unknown
    const holds = { observe: async (row: unknown) => { asked = row; return { state: 'held' as const, since: 5, sentence } } }
    expect(await probeHold({ id: 'a', conversationId: 'conv' }, holds)).toEqual({ state: 'held', since: 5, sentence })
    expect(asked).toEqual({ id: 'a', conversationId: 'conv' })
    expect(await probeHold({ id: 'a' }, { observe: async () => ({ state: 'none' }) })).toEqual({ state: 'none' })
  })
  it('observeFromAnswer maps every answer kind', () => {
    expect(observeFromAnswer({ state: 'no-server' })).toEqual({ state: 'none' })
    expect(observeFromAnswer({ state: 'unknown', why: 'x' })).toEqual({ state: 'unknown' })
    expect(observeFromAnswer({ state: 'ok', hold: held })).toEqual(held)
  })
  it('holdsFromServer: refused connection = no-server; HTTP error and garbage = unknown; a reading = ok', async () => {
    const row = { id: 's' }
    expect(await holdsFromServer(1, row, (async () => { throw new TypeError('ECONNREFUSED') }) as unknown as typeof fetch)).toEqual({ state: 'no-server' })
    const t = Object.assign(new Error('t'), { name: 'TimeoutError' })
    expect((await holdsFromServer(1, row, (async () => { throw t }) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await holdsFromServer(1, row, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await holdsFromServer(1, row, (async () => new Response('{"x":1}')) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await holdsFromServer(1, row, (async () => new Response('nope')) as unknown as typeof fetch)).state).toBe('unknown')
    expect((await holdsFromServer(1, row, (async () => Response.json({ available: true, session: { id: 's', hold: { state: 'bad' } } })) as unknown as typeof fetch)).state).toBe('unknown')
    expect(await holdsFromServer(1, row, (async () => Response.json({ available: false })) as unknown as typeof fetch)).toEqual({ state: 'ok', hold: { state: 'none' } })
    expect(await holdsFromServer(1, row, (async () => Response.json({ available: true, session: { id: 's', hold: held } })) as unknown as typeof fetch)).toEqual({ state: 'ok', hold: held })
  })
})
