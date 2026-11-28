import { describe, expect, it } from 'bun:test'
import { entropyToWords, newRecoveryEntropy } from '../recovery'
import { newBackupKeypair } from './backup-key'
import { makeRecoveryWrap, openRecoveryWrap, type RecoveryWrap } from './backup-recovery'
import vectors from './vectors.json'

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const bk = newBackupKeypair()
const entropy = newRecoveryEntropy()
const words = entropyToWords(entropy)
const wrap = makeRecoveryWrap(bk.privateKey, entropy)
const flipB64 = (s: string) => { const b = Buffer.from(s, 'base64'); b[0]! ^= 1; return b.toString('base64') }

describe('recovery wrap of the backup key', () => {
  it('matches the compatibility vectors', () => {
    const v = vectors.recovery
    expect(makeRecoveryWrap(hex(v.backupPrivate), hex(v.entropy), { nonce: hex(v.nonce) })).toEqual(v.wrap as RecoveryWrap)
    const r = openRecoveryWrap(v.wrap, entropyToWords(hex(v.entropy)))
    expect(r.ok && toHex(r.privateKey)).toBe(v.backupPrivate)
    expect(r.ok && toHex(r.publicKey)).toBe(v.backupPublic)
  })

  it('is 24 words, and they open the wrap (string or list, any case)', () => {
    expect(words.length).toBe(24)
    for (const input of [words, words.join(' '), words.join('  ').toUpperCase()]) {
      const r = openRecoveryWrap(JSON.parse(JSON.stringify(wrap)), input)
      expect(r.ok && toHex(r.privateKey)).toBe(toHex(bk.privateKey))
      expect(r.ok && toHex(r.publicKey)).toBe(toHex(bk.publicKey))
    }
  })

  it('uses a fresh nonce', () => {
    expect(makeRecoveryWrap(bk.privateKey, entropy).nonce).not.toBe(wrap.nonce)
  })

  it('refuses other valid words', () => {
    expect(openRecoveryWrap(wrap, entropyToWords(newRecoveryEntropy()))).toEqual({ ok: false, code: 'wrong-words' })
  })

  it('refuses garbled words with a code', () => {
    expect(openRecoveryWrap(wrap, words.slice(1))).toEqual({ ok: false, code: 'word-count' })
    expect(openRecoveryWrap(wrap, '')).toEqual({ ok: false, code: 'word-count' })
    expect(openRecoveryWrap(wrap, [...words.slice(0, 4), 'zzzzqq', ...words.slice(5)])).toEqual({ ok: false, code: 'unknown-word' })
    // 23 × "abandon" + "abandon": a valid list with a bad checksum.
    expect(openRecoveryWrap(wrap, new Array(24).fill('abandon'))).toEqual({ ok: false, code: 'checksum' })
  })

  it('never puts the input in a result', () => {
    const r = openRecoveryWrap(wrap, [...words.slice(0, 23), 'my-private-typo'])
    expect(JSON.stringify(r)).not.toContain('my-private-typo')
  })

  it('refuses a tampered or malformed wrap', () => {
    for (const field of ['nonce', 'ct'] as const) {
      expect(openRecoveryWrap({ ...wrap, [field]: flipB64(wrap[field]) }, words)).toEqual({ ok: false, code: 'wrong-words' })
    }
    for (const bad of [null, 3, {}, { ...wrap, v: 2 }, { ...wrap, nonce: 'AAAA' }, { ...wrap, ct: 'AAAA' }, { ...wrap, ct: '!!' }]) {
      expect(openRecoveryWrap(bad, words)).toEqual({ ok: false, code: 'malformed' })
    }
  })

  it('refuses to wrap with wrong-sized material', () => {
    expect(() => makeRecoveryWrap(new Uint8Array(31), entropy)).toThrow()
    expect(() => makeRecoveryWrap(bk.privateKey, new Uint8Array(16))).toThrow()
  })
})
