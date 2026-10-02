/**
 * SECRETS.4 §12.2 (pure half), §12.4, §12.5 (bounds): the authenticator policy, the 24-word recovery
 * key and the auto-lock clock. Injected clock throughout; no process, no file.
 */
import { describe, expect, it, spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import { createHash, randomBytes } from 'node:crypto'
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from './bip39-english'
import { hotp, matchTotp } from './totp'
import {
  FRESH_STEPUP, afterFailure, judgeCode, mergeStepUpState, parseStepUpState, pauseFor, durationWords, skewWords,
  type StepUpState,
} from './stepup-policy'
import { confirmPositions, confirmWords, entropyToWords, recoveryProtector, resolveWord, wordsToEntropy } from './recovery'
import { AutoLockClock, parseAutoLockMinutes } from './autolock'
import type { ProtectorIo } from './protectors/types'

const SEED = new TextEncoder().encode('12345678901234567890') // the RFC 6238 SHA-1 key
const codeAt = (sec: number) => hotp(SEED, Math.floor(sec / 30))

describe('TOTP for the gate (bytes key)', () => {
  it('RFC 6238 vector: T=59 → 287082 (6 of 94287082), and the matched STEP is returned', () => {
    expect(hotp(SEED, 1, 8)).toBe('94287082')
    expect(matchTotp(SEED, '287082', 59)).toBe(1)
  })
  it('±1 step accepted, ±2 refused', () => {
    const now = 1_000_000
    for (const d of [-1, 0, 1]) expect(matchTotp(SEED, codeAt(now + d * 30), now)).not.toBeNull()
    for (const d of [-2, 2]) expect(matchTotp(SEED, codeAt(now + d * 30), now)).toBeNull()
  })
  it('compares in constant time (timingSafeEqual over every candidate)', () => {
    const spy = spyOn(crypto, 'timingSafeEqual')
    matchTotp(SEED, '000000', 1_000_000)
    expect(spy.mock.calls.length).toBe(3)
    spy.mockRestore()
  })
})

describe('the gate policy (§2.1, §2.3)', () => {
  const T0 = 1_700_000_000_000
  it('accepts a good code, records its step, and refuses a REPLAY of that step', () => {
    const r = judgeCode(SEED, codeAt(T0 / 1000), T0, FRESH_STEPUP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const again = judgeCode(SEED, codeAt(T0 / 1000), T0 + 1000, r.state)
    expect(again).toMatchObject({ ok: false, code: 'stepup-replayed' })
    // and an OLDER step too
    expect(judgeCode(SEED, codeAt(T0 / 1000 - 30), T0 + 1000, r.state)).toMatchObject({ ok: false, code: 'stepup-replayed' })
  })
  it('±2 steps is the clock sentence with the right N and direction; it still counts as a failure', () => {
    const r = judgeCode(SEED, codeAt(T0 / 1000 + 4 * 30), T0, FRESH_STEPUP)
    expect(r).toMatchObject({ ok: false, code: 'stepup-clock', skewSteps: 4 })
    expect(r.state.failures).toBe(1)
    expect(skewWords(4, 'en')).toEqual({ n: 2, direction: 'later' })
    expect(skewWords(-2, 'en')).toEqual({ n: 1, direction: 'earlier' })
  })
  it('the attempt table exactly: 1–4 no delay, 5 → 30 s, doubling, 15 min cap, 20 → frozen', () => {
    expect([1, 2, 3, 4].map(pauseFor)).toEqual([0, 0, 0, 0])
    expect([5, 6, 7, 8, 9, 10, 11, 19].map(pauseFor)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000])
    let s: StepUpState = FRESH_STEPUP
    let t = T0
    const codes: string[] = []
    for (let i = 1; i <= 20; i++) {
      const r = judgeCode(SEED, 'xx0000'.replace('xx', String(10 + i)), t, s)
      codes.push(r.ok ? 'ok' : r.code)
      s = r.state
      t = (s.pausedUntilMs ?? t) + 1
    }
    expect(codes.slice(0, 4)).toEqual(['stepup-wrong', 'stepup-wrong', 'stepup-wrong', 'stepup-wrong'])
    expect(codes[19]).toBe('stepup-frozen')
    expect(s.frozen).toBe(true)
    // Frozen: even the RIGHT code is refused.
    expect(judgeCode(SEED, codeAt(t / 1000), t, s)).toMatchObject({ ok: false, code: 'stepup-frozen' })
  })
  it('"N more tries before a pause", and a pause refuses even the right code until it ends', () => {
    let s: StepUpState = FRESH_STEPUP
    const lefts: number[] = []
    for (let i = 0; i < 4; i++) { const r = judgeCode(SEED, '000001', T0, s); if (!r.ok && r.code === 'stepup-wrong') lefts.push(r.left); s = r.state }
    expect(lefts).toEqual([4, 3, 2, 1])
    s = afterFailure(s, T0) // the 5th
    expect(s.pausedUntilMs).toBe(T0 + 30_000)
    expect(judgeCode(SEED, codeAt(T0 / 1000), T0 + 10_000, s)).toMatchObject({ ok: false, code: 'stepup-paused', untilMs: T0 + 30_000 })
    expect(durationWords(20_000, 'en')).toBe('20 seconds')
  })
  it('a success resets the counter', () => {
    let s: StepUpState = FRESH_STEPUP
    for (let i = 0; i < 3; i++) s = afterFailure(s, T0)
    const r = judgeCode(SEED, codeAt(T0 / 1000), T0, s)
    expect(r.ok && r.state.failures).toBe(0)
  })
  it('the counter survives a restart and never DEcreases when the file is older than memory', () => {
    const mem: StepUpState = { v: 1, failures: 7, lastStep: 100, pausedUntilMs: T0 + 5, frozen: false }
    const olderFile = parseStepUpState(JSON.stringify({ v: 1, failures: 2, lastStep: 90, pausedUntilMs: null, frozen: false }))
    expect(mergeStepUpState(olderFile, mem)).toEqual(mem)
    const restarted = mergeStepUpState(parseStepUpState(JSON.stringify(mem)), null)
    expect(restarted).toEqual(mem)
    expect(mergeStepUpState({ ...mem, frozen: true }, mem).frozen).toBe(true)
    expect(parseStepUpState('junk')).toBeNull()
  })
})

describe('the 24-word recovery key (§4)', () => {
  it('the vendored list is the pinned BIP-39 English list', () => {
    expect(BIP39_ENGLISH.length).toBe(2048)
    expect(createHash('sha256').update(BIP39_ENGLISH.join('\n') + '\n').digest('hex')).toBe(BIP39_ENGLISH_SHA256)
    expect(new Set(BIP39_ENGLISH.map(w => w.slice(0, 4))).size).toBe(2048)
  })
  it('BIP-39 vectors (256-bit entropy ↔ words)', () => {
    const v: [string, string][] = [
      ['00'.repeat(32), 'abandon '.repeat(23) + 'art'],
      ['7f'.repeat(32), 'legal winner thank year wave sausage worth useful '.repeat(3).trim().replace(/useful$/, 'title')],
      ['80'.repeat(32), 'letter advice cage absurd amount doctor acoustic avoid '.repeat(3).trim().replace(/avoid$/, 'bless')],
      ['ff'.repeat(32), 'zoo '.repeat(23) + 'vote'],
    ]
    for (const [hex, words] of v) {
      const e = new Uint8Array(Buffer.from(hex, 'hex'))
      expect(entropyToWords(e).join(' ')).toBe(words)
      const back = wordsToEntropy(words)
      expect(back.ok && Buffer.from(back.entropy).toString('hex')).toBe(hex)
    }
  })
  it('the checksum (and the list) catch every single-word substitution in a sample', () => {
    const words = entropyToWords(new Uint8Array(randomBytes(32)))
    let caught = 0, tried = 0
    for (let pos = 0; pos < 24; pos++) {
      for (let k = 0; k < 40; k++) {
        const w = [...words]
        const other = BIP39_ENGLISH[(BIP39_ENGLISH.indexOf(w[pos]!) + 1 + k * 37) % 2048]!
        if (other === w[pos]) continue
        w[pos] = other
        tried++
        if (!wordsToEntropy(w).ok) caught++
      }
    }
    // An 8-bit checksum misses ~1/256 of substitutions; a sample of 960 should catch the vast majority.
    expect(caught / tried).toBeGreaterThan(0.98)
  })
  it('a 4-letter prefix is enough, and an unknown word is named by position', () => {
    const words = entropyToWords(new Uint8Array(randomBytes(32)))
    const prefixed = words.map(w => w.slice(0, 4))
    expect(wordsToEntropy(prefixed).ok).toBe(true)
    expect(resolveWord('ABANDON')).toBe(0)
    const bad = [...words]; bad[6] = 'notaword'
    expect(wordsToEntropy(bad)).toEqual({ ok: false, reason: 'unknown-word', position: 7 })
    expect(wordsToEntropy(words.slice(1))).toEqual({ ok: false, reason: 'count', got: 23 })
  })
  it('confirmation: three distinct positions, typed words checked', () => {
    const words = entropyToWords(new Uint8Array(randomBytes(32)))
    const pos = confirmPositions()
    expect(new Set(pos).size).toBe(3)
    expect(pos.every(p => p >= 1 && p <= 24)).toBe(true)
    expect(confirmWords(words, pos, pos.map(p => words[p - 1]!))).toBe(true)
    expect(confirmWords(words, pos, pos.map(() => 'zoo'))).toBe(words.filter((_, i) => pos.includes(i + 1)).every(w => w === 'zoo'))
  })
  it('the wrapper round-trips, and different words do not open it', async () => {
    const files = new Map<string, Uint8Array>()
    const io = { async readFile(p: string) { return files.get(p) ?? null }, async writeFile(p: string, d: Uint8Array) { files.set(p, d) }, async removeFile(p: string) { files.delete(p) } } as unknown as ProtectorIo
    const entropy = new Uint8Array(randomBytes(32))
    const dek = new Uint8Array(randomBytes(32))
    const w = await recoveryProtector({ io, vaultDir: '/v', entropy }).wrap(dek, '0123456789abcdef')
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const u = await recoveryProtector({ io, vaultDir: '/v', entropy }).unwrap(w.record, '0123456789abcdef')
    expect(u.ok && Buffer.from(u.dek).equals(Buffer.from(dek))).toBe(true)
    const other = await recoveryProtector({ io, vaultDir: '/v', entropy: new Uint8Array(randomBytes(32)) }).unwrap(w.record, '0123456789abcdef')
    expect(other).toMatchObject({ ok: false, kind: 'denied' })
    const none = await recoveryProtector({ io, vaultDir: '/v' }).unwrap(w.record, '0123456789abcdef')
    expect(none).toMatchObject({ ok: false, kind: 'unavailable' })
    // The words appear nowhere in what was written.
    const onDisk = Buffer.from(files.get('/v/dek.recovery')!).toString()
    for (const word of entropyToWords(entropy)) expect(onDisk.includes(` ${word} `)).toBe(false)
    expect(onDisk).not.toContain(Buffer.from(entropy).toString('hex'))
  })
})

describe('auto-lock bounds and clock (§5.1)', () => {
  it('5–480 minutes; "never", 0 and out-of-range refused', () => {
    expect([5, 30, 480].map(parseAutoLockMinutes)).toEqual([5, 30, 480])
    for (const v of [0, 4, 481, -1, 'never', null, Infinity, 30.5]) expect(parseAutoLockMinutes(v)).toBeNull()
    expect(() => new AutoLockClock(0, 0)).toThrow()
  })
  it('due after the idle period; any use resets it', () => {
    const c = new AutoLockClock(30, 0)
    expect(c.due(29 * 60_000)).toBe(false)
    c.use(20 * 60_000)
    expect(c.due(49 * 60_000)).toBe(false)
    expect(c.due(50 * 60_000)).toBe(true)
    expect(c.remainingMs(45 * 60_000)).toBe(5 * 60_000)
  })
})
