import { describe, expect, test } from 'bun:test'
import { compareVersions, planWhatsNew, releasesBetween } from './select'
import type { ReleaseNotes } from './releases'

const L = (s: string) => ({ pt: s, en: s })
const n = (f: string[], x: string[] = []): ReleaseNotes => ({ features: f.map(L), fixes: x.map(L) })
const T = { '2.1.0': n(['a']), '2.1.2': n([], ['b']), '2.1.3': n([]), '2.2.0': n(['c']), '2.10.0': n(['d']) }

describe('compareVersions', () => {
  test('numeric, not lexical', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1)
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
    expect(compareVersions('x', '1.0.0')).toBeNull()
  })
})

describe('releasesBetween', () => {
  test('(from, to], newest first, skipping versions without an entry', () => {
    expect(releasesBetween('2.1.0', '2.2.0', T).map(r => r.version)).toEqual(['2.2.0', '2.1.2'])
  })
  test('an entry with no lines announces nothing', () => {
    expect(releasesBetween('2.1.2', '2.1.3', T)).toEqual([])
  })
  test('does not include versions newer than the running one', () => {
    expect(releasesBetween('2.0.0', '2.1.2', T).map(r => r.version)).toEqual(['2.1.2', '2.1.0'])
  })
  test('10 sorts after 2', () => {
    expect(releasesBetween('2.2.0', '2.10.0', T).map(r => r.version)).toEqual(['2.10.0'])
  })
})

describe('planWhatsNew', () => {
  test('first install and unknown seen announce nothing', () => {
    expect(planWhatsNew({ current: '2.2.0', seen: null, table: T })).toBeNull()
    expect(planWhatsNew({ current: '2.2.0', seen: '', table: T })).toBeNull()
  })
  test('same version or downgrade announce nothing', () => {
    expect(planWhatsNew({ current: '2.2.0', seen: '2.2.0', table: T })).toBeNull()
    expect(planWhatsNew({ current: '2.1.0', seen: '2.2.0', table: T })).toBeNull()
  })
  test('skipped versions show every entry between', () => {
    const p = planWhatsNew({ current: '2.2.0', seen: '2.0.0', table: T })
    expect(p?.entries.map(e => e.version)).toEqual(['2.2.0', '2.1.2', '2.1.0'])
  })
  test('upgrade to a version without an entry announces nothing', () => {
    expect(planWhatsNew({ current: '2.1.3', seen: '2.1.2', table: T })).toBeNull()
  })
})
