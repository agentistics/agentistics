/**
 * Review S8: the libfido2 path did not ASK for user presence (`-p`) nor, on a key with a PIN, for
 * user verification (`-v`), and never looked at the flags the key signed — so "every open asks you
 * to touch the key" rested on the authenticator's default for an omitted option. Now the touch is
 * requested, the PIN is requested when the key has one (spec §3.3), and an assertion whose
 * authenticator data does not carry UP (and UV when asked) is refused.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { authDataFlags, fido2Protector } from './fido2'
import { presenceCode } from './presence'
import { bytes, text, type ProtectorIo, type RunResult } from './types'

const TOOLS = ['/usr/bin/fido2-token', '/usr/bin/fido2-cred', '/usr/bin/fido2-assert']
const DEVICE_LINE = '/dev/hidraw3: vendor=0x1050, product=0x0407 (Yubico YubiKey)\n'
const ok = (stdout = ''): RunResult => ({ code: 0, stdout: bytes(stdout), stderr: '' })

/** CBOR byte string (0x58 len) around rpIdHash(32) ‖ flags(1) ‖ signCount(4) — what fido2-assert prints, base64. */
function authData(flags: number): string {
  const raw = new Uint8Array(37); raw[32] = flags
  return Buffer.concat([Buffer.from([0x58, raw.length]), Buffer.from(raw)]).toString('base64')
}

function machine(opts: { pin: boolean; flags: number }) {
  const calls: { cmd: string; args: readonly string[]; stdin: string }[] = []
  const answer = (cmd: string, args: readonly string[], stdin: string): RunResult => {
    calls.push({ cmd, args, stdin })
    if (cmd.endsWith('fido2-token')) {
      if (args[0] === '-L') return ok(DEVICE_LINE)
      return ok(`extension strings: credProtect, hmac-secret\noptions: rk, up, noplat, ${opts.pin ? 'clientPin' : 'noclientPin'}\n`)
    }
    if (cmd.endsWith('fido2-cred')) return ok(['cdh', 'agentistics-vault', 'packed', authData(0x41), 'Y3JlZA==', 'sig'].join('\n') + '\n')
    const [, , credId, salt] = stdin.split('\n')
    return ok(['cdh', 'rp', authData(opts.flags), createHash('sha256').update(credId + '|' + salt).digest().toString('base64'), 'sig'].join('\n') + '\n')
  }
  const files = new Map<string, Uint8Array>()
  const io: ProtectorIo = {
    async run(cmd, args, stdin) { return answer(cmd, args, stdin ? text(stdin) : '') },
    async readFile(p) { return files.get(p) ?? null },
    async writeFile(p, d) { files.set(p, d) },
    async removeFile(p) { files.delete(p) },
    async createExclusive(p, d) { if (files.has(p)) return false; files.set(p, d); return true },
    async firstExisting(c) { return c.find(x => TOOLS.includes(x)) ?? null },
    async which() { return null },
  }
  return { io, calls }
}
const DEK = new Uint8Array(32).fill(5)
const UP = 0x01, UV = 0x04

describe('S8 — the touch is asked for, the PIN when the key has one, and the signed flags are checked', () => {
  it('a key without a PIN: -p on both make and assert, no -v', async () => {
    const m = machine({ pin: false, flags: UP })
    const w = await fido2Protector({ io: m.io, vaultDir: '/v', transport: 'cli' }).wrap(DEK, 'k1')
    expect(w.ok).toBe(true)
    const a = m.calls.find(c => c.cmd.endsWith('fido2-assert'))!
    expect(a.args).toContain('-p')
    expect(a.args).not.toContain('-v')
  })
  it('a key WITH a PIN: -p and -v', async () => {
    const m = machine({ pin: true, flags: UP | UV })
    const w = await fido2Protector({ io: m.io, vaultDir: '/v', transport: 'cli' }).wrap(DEK, 'k1')
    expect(w.ok).toBe(true)
    const a = m.calls.find(c => c.cmd.endsWith('fido2-assert'))!
    expect(a.args).toContain('-p')
    expect(a.args).toContain('-v')
    expect(m.calls.find(c => c.cmd.endsWith('fido2-cred'))!.args).toContain('-v')
  })
  it('an assertion WITHOUT the UP flag is refused — the key was never touched', async () => {
    const m = machine({ pin: false, flags: 0 })
    const w = await fido2Protector({ io: m.io, vaultDir: '/v', transport: 'cli' }).wrap(DEK, 'k1')
    expect(w.ok).toBe(false)
    expect(!w.ok && presenceCode(w.reason)).toBe('presence-unavailable')
  })
  it('a PIN key whose assertion lacks UV is refused', async () => {
    const m = machine({ pin: true, flags: UP })
    expect((await fido2Protector({ io: m.io, vaultDir: '/v', transport: 'cli' }).wrap(DEK, 'k1')).ok).toBe(false)
  })
  it('authDataFlags reads the flags byte under the CBOR byte-string header, and refuses junk', () => {
    expect(authDataFlags(authData(UP | UV))).toEqual({ up: true, uv: true })
    expect(authDataFlags(authData(0))).toEqual({ up: false, uv: false })
    expect(authDataFlags('authdata')).toBeNull()
    expect(authDataFlags(Buffer.from(new Uint8Array(10)).toString('base64'))).toBeNull()
  })
})
