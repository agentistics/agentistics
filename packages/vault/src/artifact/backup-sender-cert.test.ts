import { describe, expect, it } from 'bun:test'
import { newBackupKeypair, unwrapFromBackupKey, wrapForBackupKey } from './backup-key'
import { newObjectKey } from './chunk'
import { makeSenderCert, verifySenderCerts, type SenderCert } from './backup-sender-cert'
import vectors from './vectors.json'

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const hexAll = (list: Uint8Array[]) => list.map(toHex)

const bk = newBackupKeypair(), otherBk = newBackupKeypair()
const device = newBackupKeypair(), second = newBackupKeypair(), stranger = newBackupKeypair()
const cert = makeSenderCert(bk.privateKey, device.publicKey)
const flipB64 = (s: string) => { const b = Buffer.from(s, 'base64'); b[0]! ^= 1; return b.toString('base64') }

describe('sender certificate', () => {
  it('matches the compatibility vector', () => {
    const v = vectors.senderCert
    expect(makeSenderCert(hex(v.backupPrivate), hex(v.senderPublic))).toEqual(v.cert as SenderCert)
    expect(hexAll(verifySenderCerts([v.cert], hex(v.backupPrivate)))).toEqual([v.senderPublic])
  })

  it('verifies through JSON and keeps the order of the valid entries', () => {
    const certs = JSON.parse(JSON.stringify([cert, makeSenderCert(bk.privateKey, second.publicKey)]))
    expect(hexAll(verifySenderCerts(certs, bk.privateKey))).toEqual(hexAll([device.publicKey, second.publicKey]))
  })

  it('drops a cert made under another backup key', () => {
    expect(verifySenderCerts([makeSenderCert(otherBk.privateKey, device.publicKey)], bk.privateKey)).toEqual([])
    expect(verifySenderCerts([cert], otherBk.privateKey)).toEqual([])
  })

  it('drops a flipped byte and a swapped sender', () => {
    expect(verifySenderCerts([{ ...cert, cert: flipB64(cert.cert) }], bk.privateKey)).toEqual([])
    expect(verifySenderCerts([{ ...cert, senderPublicKey: flipB64(cert.senderPublicKey) }], bk.privateKey)).toEqual([])
    const swapped = { ...cert, senderPublicKey: Buffer.from(stranger.publicKey).toString('base64') }
    expect(verifySenderCerts([swapped], bk.privateKey)).toEqual([])
  })

  it('drops malformed entries without throwing, keeping the good one', () => {
    const bad = [null, undefined, 'x', 7, [], {}, { ...cert, v: 2 }, { ...cert, cert: 'AAAA' }, { ...cert, cert: '!!!!' },
      { ...cert, senderPublicKey: 'AAAA' }, { ...cert, senderPublicKey: 5 }]
    expect(hexAll(verifySenderCerts([...bad, cert], bk.privateKey))).toEqual([toHex(device.publicKey)])
    expect(verifySenderCerts([], bk.privateKey)).toEqual([])
    expect(verifySenderCerts({} as unknown as unknown[], bk.privateKey)).toEqual([])
  })

  it('gives a restoring reader its pins: a certified sender unwraps, a planted one does not', () => {
    const pins = verifySenderCerts([cert], bk.privateKey)
    const dek = newObjectKey()
    const ok = unwrapFromBackupKey(wrapForBackupKey(dek, device, bk.publicKey), bk.privateKey, pins)
    expect(ok.ok && toHex(ok.dek)).toBe(toHex(dek))
    expect(unwrapFromBackupKey(wrapForBackupKey(dek, stranger, bk.publicKey), bk.privateKey, pins))
      .toEqual({ ok: false, code: 'unknown-sender' })
  })

  it('refuses to make or check with wrong-sized keys', () => {
    expect(() => makeSenderCert(new Uint8Array(31), device.publicKey)).toThrow()
    expect(() => makeSenderCert(bk.privateKey, new Uint8Array(33))).toThrow()
    expect(() => verifySenderCerts([cert], new Uint8Array(3))).toThrow()
  })
})
