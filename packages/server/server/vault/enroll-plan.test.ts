import { describe, expect, test } from 'bun:test'
import { parseEnrolArgs, pickPresence, stepsToRun, wordGrid } from './enroll-plan'

describe('parseEnrolArgs', () => {
  test('no flags = everything that is missing; flags pick single steps; presence takes its kind', () => {
    expect(parseEnrolArgs([])).toEqual({ ok: true, value: { only: [], presence: null, requirePresence: false } })
    expect(parseEnrolArgs(['--recovery'])).toMatchObject({ ok: true, value: { only: ['recovery'] } })
    expect(parseEnrolArgs(['--presence', 'fido2', '--require-presence'])).toEqual({ ok: true, value: { only: ['presence'], presence: 'fido2', requirePresence: true } })
    for (const k of ['touchid', 'hello', 'password', 'fido2'] as const) {
      expect(parseEnrolArgs(['--presence', k])).toEqual({ ok: true, value: { only: ['presence'], presence: k, requirePresence: false } })
    }
  })
  test('the authenticator is RETIRED (owner, 2026-11-07) and says so; anything unknown is a usage error', () => {
    expect(parseEnrolArgs(['--authenticator'])).toMatchObject({ ok: false, retired: 'authenticator' })
    expect(parseEnrolArgs(['--presence'])).toMatchObject({ ok: false })
    expect(parseEnrolArgs(['--presence', 'se'])).toMatchObject({ ok: false })
    expect(parseEnrolArgs(['--presence', 'pin'])).toMatchObject({ ok: false })
    expect(parseEnrolArgs(['--wat'])).toMatchObject({ ok: false })
  })
})

describe('stepsToRun — presence, then the recovery key LAST, and only what is missing', () => {
  const mac = [{ id: 'touchid', advanced: false }, { id: 'password', advanced: false }]
  const none = { recovery: false, presence: false, available: mac }
  test('a fresh machine runs both: presence, then the recovery key LAST (leader decision 2) — no authenticator step', () => {
    expect(stepsToRun({ only: [], presence: null, requirePresence: false }, none)).toEqual(['presence', 'recovery'])
  })
  test('an already-protected machine has nothing left; a flag forces its step in the safe order', () => {
    const done = { recovery: true, presence: true, available: mac }
    expect(stepsToRun({ only: [], presence: null, requirePresence: false }, done)).toEqual([])
    expect(stepsToRun({ only: ['recovery', 'presence'], presence: null, requirePresence: false }, done)).toEqual(['presence', 'recovery'])
  })
  test('pickPresence honours a request only when this machine offers it, and never picks an ADVANCED one by itself', () => {
    expect(pickPresence(null, mac)).toBe('touchid')
    expect(pickPresence('password', mac)).toBe('password')
    expect(pickPresence('fido2', mac)).toBeNull()
    expect(pickPresence(null, [{ id: 'fido2', advanced: true }, { id: 'password', advanced: false }])).toBe('password')
    expect(pickPresence('fido2', [{ id: 'fido2', advanced: true }])).toBe('fido2')
    expect(pickPresence(null, [])).toBeNull()
  })
})

describe('wordGrid', () => {
  test('24 words in 6 rows of 4, numbered 1-24 left to right', () => {
    const words = Array.from({ length: 24 }, (_, i) => `w${i + 1}`)
    const g = wordGrid(words)
    expect(g).toHaveLength(6)
    expect(g[0]).toContain(' 1. w1')
    expect(g[0]).toContain(' 4. w4')
    expect(g[5]).toContain('24. w24')
    expect(g.join('\n').match(/\d+\./g)).toHaveLength(24)
  })
})
