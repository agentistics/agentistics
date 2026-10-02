import { describe, expect, test } from 'bun:test'
import { parseEnrolArgs, pickPresence, qrHalfBlocks, stepsToRun, wordGrid } from './enroll-plan'
import { qrMatrix } from '../../../web/src/lib/qr'

describe('parseEnrolArgs', () => {
  test('no flags = everything that is missing; flags pick single steps; presence takes its kind', () => {
    expect(parseEnrolArgs([])).toEqual({ ok: true, value: { only: [], presence: null, requirePresence: false } })
    expect(parseEnrolArgs(['--authenticator', '--recovery'])).toMatchObject({ ok: true, value: { only: ['authenticator', 'recovery'] } })
    expect(parseEnrolArgs(['--presence', 'fido2', '--require-presence'])).toEqual({ ok: true, value: { only: ['presence'], presence: 'fido2', requirePresence: true } })
  })
  test('Secure Enclave is DEFERRED (Q1) and says so; anything unknown is a usage error', () => {
    expect(parseEnrolArgs(['--presence', 'se'])).toMatchObject({ ok: false, deferred: 'se' })
    expect(parseEnrolArgs(['--presence'])).toMatchObject({ ok: false })
    expect(parseEnrolArgs(['--presence', 'pin'])).toMatchObject({ ok: false })
    expect(parseEnrolArgs(['--wat'])).toMatchObject({ ok: false })
  })
})

describe('stepsToRun — the §7.3 order, and only what is missing', () => {
  const none = { authenticator: false, recovery: false, presence: false, available: ['hello'] }
  test('a fresh machine runs all three: authenticator, presence, then the recovery key LAST (leader decision 2)', () => {
    expect(stepsToRun({ only: [], presence: null, requirePresence: false }, none)).toEqual(['authenticator', 'presence', 'recovery'])
  })
  test('a machine with no presence device skips presence (never offered and failing)', () => {
    expect(stepsToRun({ only: [], presence: null, requirePresence: false }, { ...none, available: [] })).toEqual(['authenticator', 'recovery'])
  })
  test('an already-enrolled machine has nothing left; a flag forces its step in the safe order', () => {
    const done = { authenticator: true, recovery: true, presence: true, available: ['hello'] }
    expect(stepsToRun({ only: [], presence: null, requirePresence: false }, done)).toEqual([])
    expect(stepsToRun({ only: ['recovery', 'authenticator'], presence: null, requirePresence: false }, done)).toEqual(['authenticator', 'recovery'])
  })
  test('pickPresence honours a request only when this machine offers it', () => {
    expect(pickPresence(null, ['hello', 'fido2'])).toBe('hello')
    expect(pickPresence('fido2', ['hello'])).toBeNull()
    expect(pickPresence(null, [])).toBeNull()
  })
})

describe('qrHalfBlocks', () => {
  const uri = 'otpauth://totp/Agentistics:box?secret=ABCDEFGHIJKLMNOP&issuer=Agentistics&digits=6&period=30'
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  test('draws every module: rows = ceil((n+2q)/2), each line as wide as the matrix plus the quiet zone', () => {
    const n = qrMatrix(uri).length
    const lines = qrHalfBlocks(uri)
    expect(lines).toHaveLength(Math.ceil((n + 4) / 2))
    for (const l of lines) expect([...strip(l)]).toHaveLength(n + 4)
  })
  test('sets its own colours (black on white) and resets them, so the theme cannot invert it', () => {
    for (const l of qrHalfBlocks(uri)) { expect(l.startsWith('\x1b[30;47m')).toBe(true); expect(l.endsWith('\x1b[0m')).toBe(true) }
  })
  test('the top-left finder pattern is dark (the corner after the quiet zone)', () => {
    const lines = qrHalfBlocks(uri).map(strip)
    expect(lines[1]![2]).toBe('█') // rows 2-3, column 2: inside the finder's first two rows
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
