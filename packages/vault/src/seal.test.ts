import { describe, expect, it } from 'bun:test'
import { hkdfSync, randomBytes } from 'node:crypto'
import { NONCE_BYTES, parseSealed, sealedAad, serializeSealed, isPurpose, isEnginePurpose } from './format'
import { newDataKey, openRecord, sealRecord, sealToBytes, subkey } from './seal'
import { VaultRefusalError, refusalSentence } from './sentences'

const MARKER = 'TEST-NOT-A-SECRET-' + randomBytes(8).toString('hex')
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

function fixture() {
  const { dek, kid } = newDataKey()
  const bytes = sealToBytes({ dek, kid, purpose: 'github-backup', name: 'github-backup', plaintext: enc(MARKER) })
  return { dek, kid, bytes, text: dec(bytes) }
}

describe('seal / open', () => {
  it('round-trips per purpose', () => {
    const { dek, kid } = newDataKey()
    for (const purpose of ['github-backup', 'central-token', 'envelope-key', 'central-env', 'engine/provider-key']) {
      const b = sealToBytes({ dek, kid, purpose, name: 'n', plaintext: enc(MARKER) })
      const o = openRecord({ dek, kid, purpose, name: 'n', bytes: b })
      expect(o.ok).toBe(true)
      if (o.ok) expect(dec(o.plaintext)).toBe(MARKER)
    }
  })

  it('the wrong purpose or name is tampered; the wrong kid is wrong-machine — distinct codes', () => {
    const { dek, kid, bytes } = fixture()
    expect(openRecord({ dek, kid, purpose: 'central-token', name: 'github-backup', bytes })).toEqual({ ok: false, code: 'tampered' })
    expect(openRecord({ dek, kid, purpose: 'github-backup', name: 'other', bytes })).toEqual({ ok: false, code: 'tampered' })
    const other = newDataKey()
    const r = openRecord({ dek: other.dek, kid: other.kid, purpose: 'github-backup', name: 'github-backup', bytes })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('wrong-machine'); expect(r.kid).toBe(kid) }
  })

  it('a header rewritten to the expected purpose still fails the tag (AAD binds the original)', () => {
    const { dek, kid, text } = fixture()
    const f = JSON.parse(text)
    f.purpose = 'central-token'
    const r = openRecord({ dek, kid, purpose: 'central-token', name: 'github-backup', bytes: JSON.stringify(f) })
    expect(r).toEqual({ ok: false, code: 'tampered' })
  })

  it('a flipped bit in the nonce, the ciphertext or the tag is tampered', () => {
    const { dek, kid, text } = fixture()
    for (const field of ['nonce', 'ct'] as const) {
      const f = JSON.parse(text)
      const raw = Buffer.from(f[field], 'base64')
      for (const at of [0, raw.length - 1]) {
        const copy = Buffer.from(raw)
        copy[at] = copy[at]! ^ 0x01
        const g = { ...f, [field]: copy.toString('base64') }
        expect(openRecord({ dek, kid, purpose: 'github-backup', name: 'github-backup', bytes: JSON.stringify(g) }).ok).toBe(false)
      }
    }
  })

  it('truncated or junk JSON is tampered', () => {
    const { dek, kid, text } = fixture()
    for (const t of [text.slice(0, text.length / 2), '', '{}', 'null', '[]', text.replace('"agentistics-sealed": 1', '"agentistics-sealed": 2')]) {
      expect(openRecord({ dek, kid, purpose: 'github-backup', name: 'github-backup', bytes: t })).toEqual({ ok: false, code: 'tampered' })
    }
  })

  it('nonces: 10^5 seals, no repeat, always 12 bytes', () => {
    const { dek, kid } = newDataKey()
    const seen = new Set<string>()
    for (let i = 0; i < 100_000; i++) {
      const f = sealRecord({ dek, kid, purpose: 'central-token', name: 'x', plaintext: new Uint8Array(1) })
      expect(Buffer.from(f.nonce, 'base64').length).toBe(NONCE_BYTES)
      seen.add(f.nonce)
    }
    expect(seen.size).toBe(100_000)
  })

  it('the file carries nothing derived from the secret beyond the ciphertext', () => {
    const { text } = fixture()
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain(MARKER.slice(-4))
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['agentistics-sealed', 'alg', 'ct', 'kid', 'name', 'nonce', 'purpose', 'sealedAt'])
    expect(parseSealed(text)).not.toBeNull()
    expect(serializeSealed(parseSealed(text)!)).toBe(text)
  })
})

describe('AAD encoding', () => {
  it('no two distinct (purpose, name, kid) tuples produce the same bytes — adversarial separators', () => {
    const atoms = ['', 'a', 'ab', '\u0000', '\u0000\u0000\u0000\u0004', '‖', 'a\u0000b', '\u0000\u0000\u0000\u0001a', 'é', 'engine/x']
    const seen = new Map<string, string>()
    for (const p of atoms) for (const n of atoms) for (const k of atoms) {
      const key = Buffer.from(sealedAad(p, n, k)).toString('hex')
      const tuple = JSON.stringify([p, n, k])
      expect(seen.get(key) ?? tuple).toBe(tuple)
      seen.set(key, tuple)
    }
    expect(seen.size).toBe(atoms.length ** 3)
  })
})

describe('HKDF', () => {
  it('the primitive matches RFC 5869 test case 1', () => {
    const okm = hkdfSync('sha256', Buffer.alloc(22, 0x0b), Buffer.from('000102030405060708090a0b0c', 'hex'), Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42)
    expect(Buffer.from(okm).toString('hex')).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
  })
  it('subkeys differ per purpose and per kid', () => {
    const { dek, kid } = newDataKey()
    const a = Buffer.from(subkey(dek, kid, 'github-backup')).toString('hex')
    const b = Buffer.from(subkey(dek, kid, 'central-token')).toString('hex')
    const c = Buffer.from(subkey(dek, 'ffffffffffffffff', 'github-backup')).toString('hex')
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('purposes', () => {
  it('accepts the closed host set and namespaced engine purposes only', () => {
    expect(isPurpose('github-backup')).toBe(true)
    expect(isPurpose('engine/provider-key')).toBe(true)
    expect(isPurpose('provider-key')).toBe(false)
    expect(isEnginePurpose('engine/')).toBe(false)
    expect(isEnginePurpose('engine/../x')).toBe(false)
    expect(isEnginePurpose('central-token')).toBe(false)
  })
})

describe('no secret in any message', () => {
  it('a refusal error never carries the value it refused', () => {
    const e = new VaultRefusalError('locked', refusalSentence('locked', 'en'))
    expect(e.message).not.toContain(MARKER)
    expect(JSON.stringify(e)).not.toContain(MARKER)
  })
  it('a failed open throws nothing and returns only a code', () => {
    const { dek, kid, bytes } = fixture()
    const r = openRecord({ dek, kid, purpose: 'x', name: 'y', bytes })
    expect(JSON.stringify(r)).not.toContain(MARKER)
  })
  it('a wrong-length key throws a message free of the input', () => {
    try {
      subkey(enc(MARKER), 'k', 'p')
      throw new Error('should have thrown')
    } catch (err) {
      expect(String(err)).not.toContain(MARKER)
    }
  })
})
