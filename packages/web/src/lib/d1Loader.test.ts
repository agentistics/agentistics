import { describe, expect, test } from 'bun:test'
import { d1Cells, d1Markup, d1Order, D1_ACCENT } from './d1Loader'

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

describe('D1 · Clássico markup', () => {
  test('a 10x10 grid with sparks from 40px, 7x7 without below — the prototype rule', () => {
    expect(d1Cells(56)).toBe(10)
    expect(d1Cells(39)).toBe(7)
    const big = d1Markup(56, 'a'), small = d1Markup(16, 'b')
    expect(count(big, /data-d1="px"/g)).toBe(100)
    expect(count(big, /data-d1="fk"/g)).toBe(100)
    expect(count(big, /data-d1="spark"/g)).toBe(8)
    expect(count(small, /data-d1="px"/g)).toBe(49)
    expect(count(small, /data-d1="spark"/g)).toBe(0)
  })

  test('five comets, the lead one brighter', () => {
    const m = d1Markup(56, 'a')
    expect(count(m, /data-d1="tail"/g)).toBe(5)
    expect(count(m, /stroke="#fff6ec"/g)).toBe(1)
    expect(count(m, /stroke="#fff3e3"/g)).toBe(4)
  })

  test('two glows: 1.3 for the comet, 3.2 for the halo', () => {
    const m = d1Markup(56, 'x')
    expect(m).toContain('<filter id="xf" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.3"')
    expect(m).toContain('<filter id="xh" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.2"')
    expect(m).toMatch(/data-d1="tail"[^>]*filter="url\(#xf\)"/)
    expect(m).toMatch(/data-d1="halo"[^>]*filter="url\(#xh\)"/)
  })

  test('the order starts at the speech tail and grows clockwise', () => {
    expect(d1Order(28 + Math.cos(132 * Math.PI / 180) * 10, 28 + Math.sin(132 * Math.PI / 180) * 10)).toBeCloseTo(0, 5)
    expect(d1Order(38, 28)).toBeCloseTo(228 / 360, 5)
  })

  test('only the amber follows the accent (a central draws teal); the harness colours stay', () => {
    const teal = d1Markup(56, 'c', false, '#06B6D4')
    expect(teal).not.toContain(D1_ACCENT)
    expect(teal).toContain('#06B6D4')
    expect(teal).toContain('#10A37F')
  })

  test('reduced motion draws the logo at rest, full strength', () => {
    expect(d1Markup(56, 'r', true)).not.toContain('opacity=".1"')
    expect(d1Markup(56, 'r', true)).not.toContain('data-d1')
  })
})
