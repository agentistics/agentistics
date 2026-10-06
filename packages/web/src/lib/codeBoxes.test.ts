import { describe, expect, it } from 'bun:test'
import { eraseAt, typeAt, typedIn } from './codeBoxes'

describe('the 6-box code input', () => {
  it('typing fills box by box and moves on', () => {
    let s = { value: '', focus: 0 }
    for (const d of '123456') s = typeAt(s.value, s.focus, d)
    expect(s).toEqual({ value: '123456', focus: 5 })
  })
  it('a box past the last filled one types into the first empty box (no holes)', () => {
    expect(typeAt('12', 4, '7')).toEqual({ value: '127', focus: 3 })
  })
  it('typing on a filled box replaces that digit', () => {
    expect(typeAt('123456', 2, '9')).toEqual({ value: '129456', focus: 3 })
  })
  it('a pasted whole code fills every box, wherever it lands; separators are ignored', () => {
    expect(typeAt('', 3, '123456')).toEqual({ value: '123456', focus: 5 })
    expect(typeAt('99', 1, '123 456')).toEqual({ value: '123456', focus: 5 })
    expect(typeAt('', 0, '1234567890')).toEqual({ value: '123456', focus: 5 })
  })
  it('a partial paste fills from the box', () => {
    expect(typeAt('1', 1, '234')).toEqual({ value: '1234', focus: 4 })
  })
  it('non-digits type nothing', () => {
    expect(typeAt('12', 2, 'a')).toEqual({ value: '12', focus: 2 })
  })
  it('backspace on a filled box clears it; on an empty one goes back and clears the previous', () => {
    expect(eraseAt('123', 1)).toEqual({ value: '13', focus: 1 })
    expect(eraseAt('123', 3)).toEqual({ value: '12', focus: 2 })
    expect(eraseAt('123', 5)).toEqual({ value: '12', focus: 2 })
    expect(eraseAt('', 0)).toEqual({ value: '', focus: 0 })
  })
  it('typedIn recovers the new digit from "old+new"', () => {
    expect(typedIn('34', '3')).toBe('4')
    expect(typedIn('43', '3')).toBe('4')
    expect(typedIn('7', '3')).toBe('7')
    expect(typedIn('123456', '1')).toBe('123456')
  })
})
