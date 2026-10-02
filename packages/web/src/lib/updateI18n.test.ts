import { describe, expect, test } from 'bun:test'
import { PHRASE_KEYS, PHRASE_ROTATE_MS, UPDATE_STEPS, UPDATE_STRINGS, pickPhrase, ut, versionSeed, type UpdateKey } from './updateI18n'

describe('every update string exists in both languages', () => {
  const pt = UPDATE_STRINGS.pt, en = UPDATE_STRINGS.en
  test('same key set, nothing empty', () => {
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort())
    for (const k of Object.keys(pt) as UpdateKey[]) {
      expect(pt[k].trim().length).toBeGreaterThan(0)
      expect(en[k].trim().length).toBeGreaterThan(0)
    }
  })
  test('every narration phrase is really translated, not pasted twice', () => {
    for (const step of UPDATE_STEPS) for (const k of PHRASE_KEYS[step]) expect(pt[k]).not.toBe(en[k])
  })
  test('placeholders match across languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    for (const k of Object.keys(pt) as UpdateKey[]) expect(vars(pt[k])).toEqual(vars(en[k]))
  })
})

describe('the phrase pools', () => {
  test('every step has a varied pool', () => {
    for (const step of UPDATE_STEPS) expect(PHRASE_KEYS[step].length).toBeGreaterThanOrEqual(5)
  })
  test('the owner examples are in the pools', () => {
    const all = UPDATE_STEPS.flatMap(s => PHRASE_KEYS[s]).map(k => UPDATE_STRINGS.pt[k])
    for (const p of ['Obtendo dados da tecnologia futurística', 'Montando o cérebro do agente', 'Ligando os cabos até o coração central', 'Ligando a energia'])
      expect(all).toContain(p)
  })
  test('a phrase is always from its own step', () => {
    for (const step of UPDATE_STEPS) for (let t = 0; t < 20; t++) expect(PHRASE_KEYS[step]).toContain(pickPhrase(step, 12345, t))
  })
  test('rotates while a step lasts, and walks the whole pool', () => {
    const seen = new Set<string>()
    for (let t = 0; t < PHRASE_KEYS.data.length; t++) seen.add(pickPhrase('data', 7, t))
    expect(seen.size).toBe(PHRASE_KEYS.data.length)
    expect(PHRASE_ROTATE_MS).toBeGreaterThan(1500)
  })
  test('different versions open on different lines', () => {
    const openers = new Set(['2.31.0', '2.32.0', '2.33.0', '2.34.0', '2.35.0'].map(v => pickPhrase('data', versionSeed(v), 0)))
    expect(openers.size).toBeGreaterThan(1)
    expect(versionSeed('2.31.0')).toBe(versionSeed('2.31.0'))
  })
})

test('ut fills placeholders and leaves unknown ones visible', () => {
  expect(ut('pt', 'finale.updated_to', { version: '2.31.0' })).toBe('Atualizado para v2.31.0')
  expect(ut('en', 'finale.updated_to', { version: '2.31.0' })).toBe('Updated to v2.31.0')
  expect(ut('en', 'finale.updated_to')).toBe('Updated to v{version}')
})
