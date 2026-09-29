import { describe, expect, test } from 'bun:test'
import { coerceHours, coerceLanguages, coerceSessionLists } from './sessionShape'

describe('coerceLanguages', () => {
  test('keeps a list of strings', () => expect(coerceLanguages(['ts', 'go'])).toEqual(['ts', 'go']))
  test('drops non-strings from a list', () => expect(coerceLanguages(['ts', 3, null])).toEqual(['ts']))
  test("reads Claude's map shape as its keys", () => expect(coerceLanguages({ TypeScript: 3, Go: 1 })).toEqual(['TypeScript', 'Go']))
  // The record that took a central down: an empty object.
  test('an empty object is an empty list', () => expect(coerceLanguages({})).toEqual([]))
  test('absent or scalar is an empty list', () => {
    expect(coerceLanguages(undefined)).toEqual([])
    expect(coerceLanguages('ts')).toEqual([])
  })
})

describe('coerceHours', () => {
  test('keeps numbers', () => expect(coerceHours([9, 10])).toEqual([9, 10]))
  test('a non-list is empty', () => expect(coerceHours({})).toEqual([]))
})

describe('coerceSessionLists', () => {
  test('returns the SAME object when nothing needs fixing', () => {
    const s = { languages: ['ts'], message_hours: [1] }
    expect(coerceSessionLists(s)).toBe(s)
  })
  test('repairs a record whose languages is an object, and the result is iterable', () => {
    const bad = { session_id: 'x', languages: {} as unknown as string[], message_hours: [] as number[] }
    const out = coerceSessionLists(bad)
    expect(out.languages).toEqual([])
    expect(() => { for (const l of out.languages) void l }).not.toThrow()
    expect(out.session_id).toBe('x')
  })
  test('repairs a missing message_hours', () => {
    const out = coerceSessionLists({ languages: [], message_hours: undefined as unknown as number[] })
    expect(out.message_hours).toEqual([])
  })
})
