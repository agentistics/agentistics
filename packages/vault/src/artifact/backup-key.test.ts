import { describe, expect, it } from 'bun:test'
import { newObjectKey } from './chunk'
import {
  backupPublicKeyOf, newBackupKeypair, unwrapFromBackupKey, wrapForBackupKey, type DekWrap,
} from './backup-key'
import vectors from './vectors.json'

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const bk = newBackupKeypair(), device = newBackupKeypair(), stranger = newBackupKeypair()
const dek = newObjectKey()
const wrap = () => wrapForBackupKey(dek, device, bk.publicKey)
const open = (w: unknown, pins = [device.publicKey], priv = bk.privateKey) => unwrapFromBackupKey(w, priv, pins)
const flipB64 = (s: string) => { const b = Buffer.from(s, 'base64'); b[0]! ^= 1; return b.toString('base64') }

describe('backup key', () => {
  it('generates raw 32-byte X25519 pairs whose public half derives from the private', () => {
    expect([bk.publicKey.length, bk.privateKey.length]).toEqual([32, 32])
    expect(toHex(backupPublicKeyOf(bk.privateKey))).toBe(toHex(bk.publicKey))
    expect(toHex(newBackupKeypair().privateKey)).not.toBe(toHex(bk.privateKey))
  })

  it('matches the compatibility vectors', () => {
    const v = vectors.dekWrap
    expect(toHex(backupPublicKeyOf(hex(v.senderPrivate)))).toBe(v.senderPublic)
    expect(toHex(backupPublicKeyOf(hex(v.backupPrivate)))).toBe(v.backupPublic)
    const made = wrapForBackupKey(
      hex(v.dek), { privateKey: hex(v.senderPrivate), publicKey: hex(v.senderPublic) }, hex(v.backupPublic),
      { ephemeralPrivateKey: hex(v.ephemeralPrivate), nonce: hex(v.nonce) },
    )
    expect(made).toEqual(v.wrap as DekWrap)
    const r = unwrapFromBackupKey(v.wrap, hex(v.backupPrivate), [hex(v.senderPublic)])
    expect(r.ok && toHex(r.dek)).toBe(v.dek)
  })

  it('round-trips through JSON and names the sender', () => {
    const r = open(JSON.parse(JSON.stringify(wrap())), [stranger.publicKey, device.publicKey])
    expect(r.ok && toHex(r.dek)).toBe(toHex(dek))
    expect(r.ok && toHex(r.senderPublicKey)).toBe(toHex(device.publicKey))
  })

  it('uses a fresh ephemeral key and nonce each time', () => {
    const a = wrap(), b = wrap()
    expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ct).not.toBe(b.ct)
  })

  it('refuses an unknown sender, and an empty pin list', () => {
    expect(open(wrap(), [stranger.publicKey])).toEqual({ ok: false, code: 'unknown-sender' })
    expect(open(wrap(), [])).toEqual({ ok: false, code: 'unknown-sender' })
    const planted = wrapForBackupKey(newObjectKey(), stranger, bk.publicKey)
    expect(open(planted)).toEqual({ ok: false, code: 'unknown-sender' })
  })

  it('refuses a wrap that claims a pinned sender it was not made by', () => {
    const forged = { ...wrapForBackupKey(newObjectKey(), stranger, bk.publicKey), senderPublicKey: wrap().senderPublicKey }
    expect(open(forged)).toEqual({ ok: false, code: 'unwrap-failed' })
  })

  it('refuses the wrong backup key', () => {
    expect(open(wrap(), [device.publicKey], stranger.privateKey)).toEqual({ ok: false, code: 'unwrap-failed' })
  })

  it('refuses every tampered field', () => {
    for (const field of ['ephemeralPublicKey', 'nonce', 'ct'] as const) {
      const w = wrap()
      expect(open({ ...w, [field]: flipB64(w[field]) })).toEqual({ ok: false, code: 'unwrap-failed' })
    }
    const w = wrap()
    expect(open({ ...w, senderPublicKey: flipB64(w.senderPublicKey) })).toEqual({ ok: false, code: 'unknown-sender' })
    expect(open({ ...w, v: 2 })).toEqual({ ok: false, code: 'malformed' })
  })

  it('refuses malformed shapes without throwing', () => {
    const w = wrap()
    for (const bad of [null, 'x', 7, {}, { ...w, nonce: 'AAAA' }, { ...w, ct: '!!!!' }, { ...w, ct: 'AAAA' },
      { ...w, ephemeralPublicKey: 'AAAA' }, { ...w, senderPublicKey: 5 }]) {
      expect(open(bad)).toEqual({ ok: false, code: 'malformed' })
    }
    expect(open({ ...w, ephemeralPublicKey: Buffer.alloc(32).toString('base64') })).toEqual({ ok: false, code: 'unwrap-failed' })
    expect(unwrapFromBackupKey(w, new Uint8Array(3), [device.publicKey])).toEqual({ ok: false, code: 'unwrap-failed' })
  })

  it('refuses to wrap with wrong-sized material', () => {
    expect(() => wrapForBackupKey(new Uint8Array(16), device, bk.publicKey)).toThrow()
    expect(() => wrapForBackupKey(dek, device, new Uint8Array(31))).toThrow()
    expect(() => wrapForBackupKey(dek, { ...device, privateKey: new Uint8Array(1) }, bk.publicKey)).toThrow()
    expect(() => wrapForBackupKey(dek, { ...device, publicKey: stranger.publicKey }, bk.publicKey)).toThrow()
  })
})
