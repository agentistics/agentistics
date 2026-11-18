import { describe, expect, it } from 'bun:test'
import { heldAsRefusal, heldSentence, refuseIfHeld } from './kill-door'
import { HoldError } from './hold-guard'

const T0 = Date.parse('2026-11-17T14:00:00.000Z')
const active = { state: 'held', since: T0 - 3 * 60_000, sentence: { en: 'engine words', pt: 'palavras do engine' } } as const

describe('the web/cockpit kill consults the hold', () => {
  it('the first press on a held session is refused with the reason and held — nothing else runs', async () => {
    const r = await refuseIfHeld({ id: 'p1' }, { force: false, lang: 'pt', observe: async () => active, now: () => T0 })
    expect(r).toEqual({ ok: false, held: true, message: 'Esta sessão está em uso agora: palavras do engine (há 3 min). Encerrar corta o que a usa.' })
  })
  it('the second, explicit confirm sends force and goes through (the hold is not even asked)', async () => {
    let asked = 0
    expect(await refuseIfHeld({ id: 'p1' }, { force: true, lang: 'pt', observe: async () => { asked++; return active } })).toBeNull()
    expect(asked).toBe(0)
  })
  it('no hold: nothing changes', async () => {
    expect(await refuseIfHeld({ id: 'p1' }, { force: false, lang: 'en', observe: async () => ({ state: 'none' }) })).toBeNull()
  })
  it('a hold that cannot be read is refused too, saying so (unknown is not free to kill); an observer that throws is unknown', async () => {
    const r = await refuseIfHeld({ id: 'p1' }, { force: false, lang: 'en', observe: async () => { throw new Error('x') } })
    expect(r).toMatchObject({ ok: false, held: true })
    expect(r!.message).toContain('Could not tell')
    const en = await refuseIfHeld({ id: 'p1' }, { force: false, lang: 'en', observe: async () => active, now: () => T0 })
    expect(en!.message).toContain('engine words')
    expect(heldSentence({ state: 'unknown' }, 'pt')).toContain('Não consegui saber')
  })
  it('a hold that starts after the pre-check (HoldError out of the kill) becomes the same refusal; other errors are not swallowed', () => {
    expect(heldAsRefusal(new HoldError('p1', active, T0), 'en')).toMatchObject({ ok: false, held: true })
    expect(() => heldAsRefusal(new Error('boom'), 'en')).toThrow('boom')
  })
})
