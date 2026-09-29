import { describe, expect, test } from 'bun:test'
import { parseJsonc } from './jsonc.ts'

describe('parseJsonc', () => {
  test('comments, trailing commas and line map', () => {
    const r = parseJsonc('// c\n{\n  /* x\n y */ "a": [1,\n 2,],\n  "b": {"c": true},\n}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ a: [1, 2], b: { c: true } })
    expect(r.lines.get('/a')).toBe(4)
    expect(r.lines.get('/a/1')).toBe(5)
    expect(r.lines.get('/b/c')).toBe(6)
  })
  test('syntax error carries the line', () => {
    const r = parseJsonc('{\n "a": 1\n "b": 2\n}')
    expect(r).toMatchObject({ ok: false, line: 3 })
  })
  test('duplicate key is an error at the second key', () => {
    const r = parseJsonc('{\n "a": 1,\n "a": 2\n}')
    expect(r).toMatchObject({ ok: false, line: 3 })
  })
  test('never throws on garbage', () => {
    expect(parseJsonc('{"a": ').ok).toBe(false)
    expect(parseJsonc('').ok).toBe(false)
    expect(parseJsonc('/* open').ok).toBe(false)
  })
})
