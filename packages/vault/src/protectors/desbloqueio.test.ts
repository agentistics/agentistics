/**
 * COFRE.DESBLOQUEIO — the two new ways to confirm "it is you": the vault's OWN password (any system) and
 * Touch ID / the Mac password (macOS, through osascript + security, nothing installed). Both over a fake
 * ProtectorIo that FAILS the test the moment a secret appears on an argv (argv is world-readable).
 * The real Touch ID dialog cannot run here (no Mac): what is pinned is the exact argv, the script's
 * answers, and that no key is ever read before the dialog said yes.
 */
import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import type { ProtectorIo, RunResult } from './types'
import { bytes, text } from './types'
import { PASSWORD_FILE, passwordFailure, vaultPasswordProtector } from './vault-password'
import {
  OSASCRIPT, TOUCHID_FILE, TOUCHID_KEYCHAIN_SERVICE, TOUCHID_SCRIPT, readTouchIdAnswer, touchIdArgs, touchIdProtector,
} from './touchid'
import { SECURITY } from './keychain'
import { presenceCode } from './presence'

type Call = { cmd: string; args: readonly string[]; stdin: string }
function fakeIo(answer: (c: Call) => RunResult, opts: { exists?: string[] } = {}) {
  const files = new Map<string, Uint8Array>()
  const calls: Call[] = []
  const secretsSeen = new Set<string>()
  const io: ProtectorIo = {
    async run(cmd, args, stdin) {
      const s = stdin ? text(stdin) : ''
      for (const tok of s.split(/[\s\n]+/).filter(t => t.length >= 32)) secretsSeen.add(tok)
      for (const a of args) for (const sec of secretsSeen) if (a.includes(sec)) throw new Error(`SECRET IN ARGV: ${cmd}`)
      const c = { cmd, args, stdin: s }
      calls.push(c)
      return answer(c)
    },
    async readFile(p) { return files.get(p) ?? null },
    async writeFile(p, d) { files.set(p, d) },
    async removeFile(p) { files.delete(p) },
    async createExclusive(p, d) { if (files.has(p)) return false; files.set(p, d); return true },
    async firstExisting(cands) { return cands.find(c => (opts.exists ?? []).includes(c)) ?? null },
    async which() { return null },
  }
  return { io, files, calls }
}
const ok = (stdout = ''): RunResult => ({ code: 0, stdout: bytes(stdout), stderr: '' })
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: new Uint8Array(), stderr })
const LOW = { N: 2 ** 10, r: 8, p: 1 }
const KID = '0123456789abcdef'
const dek = () => new Uint8Array(randomBytes(32))
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
const rules = (pw: string) => pw.length >= 9 && /[A-Z]/.test(pw) && /\d/.test(pw) && (pw.match(/[^A-Za-z0-9\s]/g) ?? []).length >= 2

describe('the vault password protector', () => {
  const PW = 'Test-Only!Pw9' // a test value, not a secret
  test('derive → seal → unwrap: the right password gives the same key back; the file never holds the password', async () => {
    const { io, files, calls } = fakeIo(() => ok())
    const p = vaultPasswordProtector({ io, vaultDir: '/v', password: PW, check: rules, params: LOW })
    const k = dek()
    const w = await p.wrap(k, KID)
    expect(w.ok).toBe(true)
    expect(w.ok && w.record).toMatchObject({ type: 'password', params: { file: PASSWORD_FILE } })
    const raw = text(files.get(`/v/${PASSWORD_FILE}`)!)
    expect(raw).not.toContain(PW)
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kdf: 'scrypt', N: LOW.N, r: 8, p: 1 })
    const u = await vaultPasswordProtector({ io, vaultDir: '/v', password: PW, params: LOW }).unwrap(w.ok ? w.record : ({} as never), KID)
    expect(u.ok && same(u.dek, k)).toBe(true)
    expect(calls).toHaveLength(0) // no process is ever started for a password
  })
  test('a wrong password is DENIED with no detail; none at all is "password-required"', async () => {
    const { io } = fakeIo(() => ok())
    const w = await vaultPasswordProtector({ io, vaultDir: '/v', password: PW, check: rules, params: LOW }).wrap(dek(), KID)
    const rec = w.ok ? w.record : ({} as never)
    const wrong = await vaultPasswordProtector({ io, vaultDir: '/v', password: 'Other-Pass!1', params: LOW }).unwrap(rec, KID)
    expect(wrong).toMatchObject({ ok: false, kind: 'denied' })
    expect(!wrong.ok && passwordFailure(wrong.reason)).toBe('password-wrong')
    const none = await vaultPasswordProtector({ io, vaultDir: '/v', params: LOW }).unwrap(rec, KID)
    expect(!none.ok && passwordFailure(none.reason)).toBe('password-required')
  })
  test('another vault\'s kid opens nothing (the AAD binds the kid)', async () => {
    const { io } = fakeIo(() => ok())
    const w = await vaultPasswordProtector({ io, vaultDir: '/v', password: PW, params: LOW }).wrap(dek(), KID)
    const u = await vaultPasswordProtector({ io, vaultDir: '/v', password: PW, params: LOW }).unwrap(w.ok ? w.record : ({} as never), 'fedcba9876543210')
    expect(u.ok).toBe(false)
  })
  test('a weak password is refused BEFORE any key is made; nothing is written', async () => {
    const { io, files } = fakeIo(() => ok())
    const d = await vaultPasswordProtector({ io, vaultDir: '/v', password: 'weak', check: rules, params: LOW }).derive!(KID)
    expect(d.ok).toBe(false)
    expect(!d.ok && passwordFailure(d.reason)).toBe('password-weak')
    expect(files.size).toBe(0)
  })
  test('a missing file is protector-lost, never a silent success', async () => {
    const { io } = fakeIo(() => ok())
    const u = await vaultPasswordProtector({ io, vaultDir: '/v', password: PW, params: LOW }).unwrap({ type: 'password', createdAt: 'x' }, KID)
    expect(u).toMatchObject({ ok: false, kind: 'missing' })
  })
})

describe('Touch ID / the Mac password (macOS, nothing installed)', () => {
  /** A Mac: osascript answers `answer`, the Keychain stores and returns what it was given. */
  function mac(answer: () => string, opts: { keychainFails?: boolean } = {}) {
    const keychain = new Map<string, string>()
    let dialogs = 0, reads = 0
    const f = fakeIo(c => {
      if (c.cmd === OSASCRIPT) { if (c.args[4] === 'ask') dialogs++; return ok(c.args[4] === 'check' ? 'OK' : answer()) }
      if (c.cmd === SECURITY && c.args[0] === '-i') {
        if (opts.keychainFails) return fail('security: SecKeychainItemCreateFromContent: error')
        const m = / -a (\S+) .* -w ([0-9a-f]{64})/.exec(c.stdin)
        if (m) keychain.set(m[1]!, m[2]!)
        return ok()
      }
      if (c.cmd === SECURITY && c.args[0] === 'find-generic-password') {
        reads++
        const v = keychain.get(c.args[c.args.indexOf('-a') + 1]!)
        return v ? ok(v + '\n') : fail('security: The specified item could not be found in the keychain.', 44)
      }
      if (c.cmd === SECURITY && c.args[0] === 'delete-generic-password') { keychain.delete(c.args[c.args.indexOf('-a') + 1]!); return ok() }
      return fail('unexpected command')
    }, { exists: [OSASCRIPT, SECURITY] })
    return { ...f, keychain, dialogs: () => dialogs, reads: () => reads }
  }

  test('the argv is fixed: osascript -l JavaScript -e <script> <mode> <sentence> — no key, no payload', () => {
    const a = touchIdArgs('ask', 'confirm it is you')
    expect(a).toEqual(['-l', 'JavaScript', '-e', TOUCHID_SCRIPT, 'ask', 'confirm it is you'])
    expect(TOUCHID_SCRIPT).toContain('LAContext')
    expect(TOUCHID_SCRIPT).toContain('var policy = 2;') // deviceOwnerAuthentication: Touch ID OR the Mac password
  })
  test('the script\'s answers map to the presence codes (cancel, no password, lockout, timeout, junk)', () => {
    expect(readTouchIdAnswer('OK\n', 0)).toEqual({ ok: true })
    for (const c of ['-2', '-4', '-9', '-1']) expect(readTouchIdAnswer(`ERR ${c}`, 0)).toMatchObject({ ok: false, code: 'presence-cancelled' })
    expect(readTouchIdAnswer('NO -5', 0)).toMatchObject({ ok: false, code: 'presence-unavailable', detail: 'touchid-not-set-up' })
    expect(readTouchIdAnswer('ERR -8', 0)).toMatchObject({ ok: false, detail: 'touchid-locked' })
    expect(readTouchIdAnswer('TIMEOUT', 0)).toMatchObject({ ok: false, code: 'presence-timeout' })
    expect(readTouchIdAnswer('execution error: something', 1)).toMatchObject({ ok: false, code: 'presence-unavailable', detail: 'touchid-unavailable' })
    expect(readTouchIdAnswer('OK', 1)).toMatchObject({ ok: false }) // a non-zero exit is never a yes
  })
  test('probe asks NO dialog', async () => {
    const m = mac(() => 'OK')
    const p = touchIdProtector({ io: m.io, vaultDir: '/v' })
    expect((await p.probe()).ok).toBe(true)
    expect(m.dialogs()).toBe(0)
  })
  test('enrol = ONE dialog, a random secret in the Keychain (on stdin only), and the file opens back with it', async () => {
    const m = mac(() => 'OK')
    const p = touchIdProtector({ io: m.io, vaultDir: '/v' })
    const k = dek()
    const w = await p.wrap(k, KID)
    expect(w.ok).toBe(true)
    expect(w.ok && w.record).toMatchObject({ type: 'touchid', params: { file: TOUCHID_FILE, service: TOUCHID_KEYCHAIN_SERVICE } })
    expect(m.dialogs()).toBe(1)
    expect(m.keychain.has(KID)).toBe(true)
    const u = await p.unwrap(w.ok ? w.record : ({} as never), KID)
    expect(u.ok && same(u.dek, k)).toBe(true)
    expect(m.dialogs()).toBe(2) // every unlock is ONE dialog
  })
  test('a cancelled dialog reads NOTHING from the Keychain and opens nothing', async () => {
    let answer = 'OK'
    const m = mac(() => answer)
    const p = touchIdProtector({ io: m.io, vaultDir: '/v' })
    const w = await p.wrap(dek(), KID)
    const before = m.reads()
    answer = 'ERR -2'
    const u = await p.unwrap(w.ok ? w.record : ({} as never), KID)
    expect(u).toMatchObject({ ok: false, kind: 'denied' })
    expect(!u.ok && presenceCode(u.reason)).toBe('presence-cancelled')
    expect(m.reads()).toBe(before)
  })
  test('a cancelled enrolment stores nothing; a Keychain that refuses the write fails in words and leaves nothing', async () => {
    const no = mac(() => 'ERR -2')
    expect((await touchIdProtector({ io: no.io, vaultDir: '/v' }).wrap(dek(), KID)).ok).toBe(false)
    expect(no.keychain.size).toBe(0)
    expect(no.files.size).toBe(0)
    const kc = mac(() => 'OK', { keychainFails: true })
    const r = await touchIdProtector({ io: kc.io, vaultDir: '/v' }).wrap(dek(), KID)
    expect(!r.ok && r.reason).toContain('keychain-failed')
    expect(kc.files.size).toBe(0)
  })
  test('the Keychain entry deleted behind its back is protector-lost (the 24 words open the vault)', async () => {
    const m = mac(() => 'OK')
    const p = touchIdProtector({ io: m.io, vaultDir: '/v' })
    const w = await p.wrap(dek(), KID)
    m.keychain.clear()
    const u = await p.unwrap(w.ok ? w.record : ({} as never), KID)
    expect(u).toMatchObject({ ok: false, kind: 'missing' })
  })
  test('no osascript (not a Mac): unavailable, never a crash', async () => {
    const { io } = fakeIo(() => ok('OK'), { exists: [] })
    expect(await touchIdProtector({ io, vaultDir: '/v' }).probe()).toMatchObject({ ok: false })
  })
  test('proveHuman is ONE dialog and keeps nothing', async () => {
    const m = mac(() => 'OK')
    expect(await touchIdProtector({ io: m.io, vaultDir: '/v' }).proveHuman!()).toEqual({ ok: true })
    expect(m.dialogs()).toBe(1)
    expect(m.keychain.size).toBe(0)
    expect(m.files.size).toBe(0)
  })
})
