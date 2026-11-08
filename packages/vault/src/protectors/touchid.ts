/**
 * touchid.ts — Touch ID or the Mac's own password, as a PRESENCE protector (owner decision
 * 2026-11-07, COFRE.DESBLOQUEIO: "no Mac eu nunca configurei o cofre e simplesmente não me deixa
 * configurar" — the only offer was a FIDO key that needs libfido2, which no Mac ships).
 *
 * Nothing is installed. Two programs every macOS has do the work:
 *
 *  - `/usr/bin/osascript -l JavaScript` runs a FIXED script (no payload, nothing secret on argv) that
 *    asks LocalAuthentication for `LAPolicyDeviceOwnerAuthentication` — Touch ID where the Mac has it,
 *    the Mac's login password everywhere else (and after Touch ID locks out). macOS draws that dialog;
 *    a script cannot answer it.
 *  - `/usr/bin/security` keeps a random 32-byte secret in the login Keychain (written through
 *    `security -i` on STDIN, exactly as keychain.ts does, so it never appears on an argv).
 *
 *   KEK = HKDF-SHA256(secret, kid, "agentistics/vault/v2/touchid")  (presence.ts)
 *   dek.touchid = { v:1, wrapped }                                   wrapped = AES-256-GCM(KEK, DEK)
 *
 * The service reads the secret ONLY after the dialog answered yes, every unlock and every confirmation.
 *
 * STATED LIMIT — read before trusting it like Windows Hello. The confirmation is enforced by agentop:
 * the Keychain item is readable by `security` without a dialog, because a Keychain item whose every
 * read needs Touch ID requires an Apple-signed app with a keychain entitlement, which a single
 * downloadable binary cannot have. So this stops a person at an unlocked Mac who does not know its
 * password, and anything that asks agentop; it does NOT stop malware already running as you, which
 * could read the Keychain item directly. Windows Hello binds the key in hardware; this does not.
 * Written against Apple's documented LocalAuthentication / security(1) behaviour and exercised only
 * with a fake here — no Mac was available when it was built. Verify on a real Mac.
 */
import { randomBytes } from 'node:crypto'
import type { Lang } from '../sentences'
import { deriveKek, gestureDone, kindOf, openDek, presenceReason, sealDek, zero, type PresenceCode } from './presence'
import { SECURITY } from './keychain'
import { bytes, firstLine, fromHex, text, toHex, type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord } from './types'

export const TOUCHID_FILE = 'dek.touchid'
export const TOUCHID_KEYCHAIN_SERVICE = 'agentistics-vault-touchid'
export const OSASCRIPT = '/usr/bin/osascript'
export const TOUCHID_TIMEOUT_MS = 60_000

/**
 * The fixed JXA script. argv[0] is `check` (can the dialog be shown at all? — no dialog) or `ask`;
 * argv[1] is the sentence macOS shows under "agentop wants to…". Output, one line on stdout:
 * `OK` | `NO <LAError code>` | `ERR <LAError code>` | `TIMEOUT`.
 * The reply block runs on LocalAuthentication's own queue; the script spins the run loop until it fires.
 */
export const TOUCHID_SCRIPT = [
  "ObjC.import('Foundation');",
  "ObjC.import('LocalAuthentication');",
  'function run(argv) {',
  "  var mode = argv[0] || 'ask';",
  "  var reason = argv[1] || 'Agentistics';",
  '  var policy = 2;',
  '  var ctx = $.LAContext.alloc.init;',
  '  var err = Ref();',
  '  if (!ctx.canEvaluatePolicyError(policy, err)) {',
  '    var c = 0; try { c = Number(err[0].code); } catch (e) { c = 0; }',
  "    return 'NO ' + c;",
  '  }',
  "  if (mode === 'check') return 'OK';",
  '  var done = false, ok = false, code = 0;',
  '  ctx.evaluatePolicyLocalizedReasonReply(policy, reason, function (success, e) {',
  '    ok = success === true || success === 1;',
  '    if (!ok) { try { code = Number(e.code); } catch (x) { code = 0; } }',
  '    done = true;',
  '  });',
  '  var until = $.NSDate.dateWithTimeIntervalSinceNow(60);',
  '  while (!done && $.NSDate.date.compare(until) < 0) {',
  '    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));',
  '  }',
  "  if (!done) return 'TIMEOUT';",
  "  return ok ? 'OK' : 'ERR ' + code;",
  '}',
].join('\n')

export const touchIdArgs = (mode: 'check' | 'ask', reason: string): string[] => ['-l', 'JavaScript', '-e', TOUCHID_SCRIPT, mode, reason]

/** PURE. The script's answer as a presence outcome. LAError codes: -2/-4/-9 cancel, -1 failed, -5 no passcode, -6/-7 no biometry, -8 lockout. */
export function readTouchIdAnswer(stdout: string, exit: number): { ok: true } | { ok: false; code: PresenceCode; detail: string } {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  if (exit === 0 && line === 'OK') return { ok: true }
  if (line === 'TIMEOUT') return { ok: false, code: 'presence-timeout', detail: '' }
  const m = /^(NO|ERR) (-?\d+)$/.exec(line)
  if (!m) return { ok: false, code: 'presence-unavailable', detail: 'touchid-unavailable' }
  const n = Number(m[2])
  if (n === -2 || n === -4 || n === -9 || n === -1) return { ok: false, code: 'presence-cancelled', detail: '' }
  if (n === -5) return { ok: false, code: 'presence-unavailable', detail: 'touchid-not-set-up' }
  if (n === -8) return { ok: false, code: 'presence-unavailable', detail: 'touchid-locked' }
  return { ok: false, code: 'presence-unavailable', detail: 'touchid-unavailable' }
}

export function touchIdAddCommand(kid: string, hex: string): string {
  // kid is [0-9a-f]{16} (or `proof…` hex) and hex is [0-9a-f]{64}: nothing here can break the quoting.
  return `add-generic-password -U -s ${TOUCHID_KEYCHAIN_SERVICE} -a ${kid} -l "agentistics vault (Touch ID)" -w ${hex}\n`
}

export interface TouchIdOptions {
  io: ProtectorIo
  vaultDir: string
  /** The sentence macOS shows in its dialog, in the user's language. */
  reason?: (lang: Lang) => string
  lang?: Lang
}

interface TouchIdFile { v: 1; wrapped: string }

export function touchIdProtector(o: TouchIdOptions): Protector {
  const file = `${o.vaultDir}/${TOUCHID_FILE}`
  const lang = o.lang ?? 'en'
  const reason = (o.reason ?? ((l: Lang) => l === 'pt' ? 'confirmar que é você para abrir o cofre do Agentistics' : 'confirm it is you to open the Agentistics vault'))(lang)

  async function ask(mode: 'check' | 'ask'): Promise<{ ok: true } | { ok: false; code: PresenceCode; detail: string }> {
    if (!(await o.io.firstExisting([OSASCRIPT]))) return { ok: false, code: 'presence-unavailable', detail: 'touchid-unavailable' }
    try {
      const r = await o.io.run(OSASCRIPT, touchIdArgs(mode, reason), null, { timeoutMs: TOUCHID_TIMEOUT_MS + 5_000 })
      const a = readTouchIdAnswer(text(r.stdout), r.code)
      if (a.ok && mode === 'ask') gestureDone()
      return a
    } catch {
      return { ok: false, code: 'presence-timeout', detail: '' }
    }
  }
  async function store(kid: string, value: Uint8Array): Promise<boolean> {
    const r = await o.io.run(SECURITY, ['-i'], bytes(touchIdAddCommand(kid, toHex(value))), { timeoutMs: 30_000 })
    return r.code === 0 && !/error|could not/i.test(r.stderr)
  }
  async function load(kid: string): Promise<{ ok: true; secret: Uint8Array } | { ok: false; code: PresenceCode; detail: string }> {
    const r = await o.io.run(SECURITY, ['find-generic-password', '-s', TOUCHID_KEYCHAIN_SERVICE, '-a', kid, '-w'], null, { timeoutMs: 30_000 })
    if (r.code !== 0) {
      const lost = /could not be found/i.test(r.stderr) || r.code === 44
      return { ok: false, code: lost ? 'presence-lost' : 'presence-unavailable', detail: lost ? 'credential-deleted' : 'keychain-failed' }
    }
    const s = fromHex(text(r.stdout))
    return s ? { ok: true, secret: s } : { ok: false, code: 'presence-lost', detail: 'file-damaged' }
  }
  async function del(kid: string): Promise<void> {
    await o.io.run(SECURITY, ['delete-generic-password', '-s', TOUCHID_KEYCHAIN_SERVICE, '-a', kid], null, { timeoutMs: 30_000 }).catch(() => {})
  }

  const self: Protector = {
    id: 'touchid',
    label: (l: Lang) => l === 'pt'
      ? 'o Touch ID ou a senha do Mac: cada abertura pede a sua digital ou a senha deste Mac'
      : 'Touch ID or the Mac password: every open asks for your fingerprint or this Mac\'s password',
    /** NO dialog: can LocalAuthentication be asked here at all (a session with a login password)? */
    async probe(): Promise<ProbeResult> {
      const a = await ask('check')
      return a.ok ? { ok: true } : { ok: false, reason: presenceReason(a.code, a.detail) }
    },
    /** ONE dialog, then a new random secret in the Keychain; nothing is written to the vault yet. */
    async derive(kid) {
      const a = await ask('ask')
      if (!a.ok) return { ok: false, reason: presenceReason(a.code, a.detail) }
      const secret = new Uint8Array(randomBytes(32))
      if (!(await store(kid, secret))) { zero(secret); return { ok: false, reason: presenceReason('presence-unavailable', 'keychain-failed') } }
      // Read it BACK before trusting it: a Keychain that accepted the write and returns something else is lost later.
      const back = await load(kid)
      const same = back.ok && Buffer.compare(Buffer.from(back.secret), Buffer.from(secret)) === 0
      if (back.ok) zero(back.secret)
      if (!same) { zero(secret); await del(kid); return { ok: false, reason: presenceReason('presence-unavailable', 'keychain-failed') } }
      const kek = deriveKek(secret, kid, 'touchid')
      zero(secret)
      return { ok: true, held: { kek, fields: {} } }
    },
    async sealHeld(held, dek, kid) {
      if (held.kek.length !== 32) return { ok: false, reason: presenceReason('presence-unavailable', 'bridge-failed') }
      const wrapped = sealDek(held.kek, dek, 'touchid', kid)
      const back = openDek(held.kek, wrapped, 'touchid', kid)
      const same = back !== null && Buffer.compare(Buffer.from(back), Buffer.from(dek)) === 0
      if (back) zero(back)
      if (!same) return { ok: false, reason: presenceReason('presence-unavailable', 'bridge-failed') }
      const f: TouchIdFile = { v: 1, wrapped: Buffer.from(wrapped).toString('base64') }
      await o.io.writeFile(file, bytes(JSON.stringify(f) + '\n'))
      return { ok: true, record: { type: 'touchid', createdAt: new Date().toISOString(), params: { file: TOUCHID_FILE, service: TOUCHID_KEYCHAIN_SERVICE } } }
    },
    async discardHeld(held, kid) { zero(held.kek); await del(kid) },
    async wrap(dek, kid) {
      const d = await self.derive!(kid)
      if (!d.ok) return d
      try {
        const s = await self.sealHeld!(d.held, dek, kid)
        if (!s.ok) await del(kid)
        return s
      } finally { zero(d.held.kek) }
    },
    /** ONE dialog, nothing kept — the page's first enrolment uses it in place of the terminal's setup code. */
    async proveHuman() {
      const a = await ask('ask')
      return a.ok ? { ok: true } : { ok: false, reason: presenceReason(a.code, a.detail) }
    },
    async unwrap(_record: WrapperRecord, kid: string): Promise<UnwrapResult> {
      const raw = await o.io.readFile(file)
      if (!raw) return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', 'file-missing') }
      let f: TouchIdFile
      try {
        f = JSON.parse(text(raw)) as TouchIdFile
        if (f.v !== 1 || typeof f.wrapped !== 'string') throw new Error('shape')
      } catch { return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', 'file-damaged') } }
      const a = await ask('ask')
      if (!a.ok) return { ok: false, kind: kindOf(a.code), reason: presenceReason(a.code, a.detail) }
      const s = await load(kid)
      if (!s.ok) return { ok: false, kind: kindOf(s.code), reason: presenceReason(s.code, s.detail) }
      const kek = deriveKek(s.secret, kid, 'touchid')
      zero(s.secret)
      const dek = openDek(kek, new Uint8Array(Buffer.from(f.wrapped, 'base64')), 'touchid', kid)
      zero(kek)
      return dek ? { ok: true, dek } : { ok: false, kind: 'missing', reason: presenceReason('presence-lost', 'not-reproducible') }
    },
    async remove(_record, kid) {
      await del(kid)
      await o.io.removeFile(file).catch(() => {})
    },
  }
  return self
}

/** For the log only: never a sentence. */
export function touchIdLogLine(stderr: string): string { return firstLine(stderr) }
