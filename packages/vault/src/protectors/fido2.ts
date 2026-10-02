/**
 * fido2.ts — a security key's CTAP2 `hmac-secret` as the presence gesture. SECRETS.4 §3.3.
 *
 * Enrol: `makeCredential` with `hmac-secret` (non-resident, uv preferred); the credential id and a random
 * 32-byte salt are stored in `dek.fido2` beside the wrapped DEK. Unwrap: `getAssertion` with that salt
 * (touch, plus PIN when the key has one) → a 32-byte HMAC → `KEK = HKDF(hmac, kid)` (presence.ts).
 *
 * Two transports, one adapter:
 *  - `cli`      Linux / macOS — libfido2's `fido2-token`, `fido2-cred -M -h`, `fido2-assert -G -h`, inputs on
 *               STDIN, absolute tool paths first. Absent tools are refused with the install command.
 *  - `webauthn` Windows, and WSL through interop (WSL2 has no /dev/hidraw*) — a fixed PowerShell script that
 *               P/Invokes `webauthn.dll` (API ≥ 4, HMAC_SECRET). Same stdin/stdout shape as hello.ts.
 *
 * A key without `hmac-secret` is REFUSED AT ENROL, in words. UNVERIFIED against real hardware: the
 * libfido2 line positions and the webauthn.dll struct layouts follow the documentation — the owner's
 * smoke (a real key on Linux and on WSL→Windows) is what closes that.
 */
import { randomBytes } from 'node:crypto'
import type { Lang } from '../sentences'
import {
  deriveKek, describeThrown, kindOf, openDek, parseBridgeError, presenceReason, sealDek, zero,
  type PresenceCode,
} from './presence'
import { WSL_INTEROP, WSL_POWERSHELL } from './dpapi'
import {
  bytes, probeValue, text,
  type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord,
} from './types'

export const FIDO2_FILE = 'dek.fido2'
export const FIDO2_RP = 'agentistics-vault'
export const FIDO2_TIMEOUT_MS = 60_000

const TOOL_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin']
export const FIDO2_TOOL_PATHS = (tool: string): string[] => TOOL_DIRS.map(d => `${d}/${tool}`)
export const FIDO2_INSTALL_HINT = 'install libfido2 (`apt install fido2-tools`, `brew install libfido2`)'

/** The webauthn.dll bridge's C#. Fixed text, no payload. UNVERIFIED struct layouts — see the header. */
export const WEBAUTHN_CSHARP = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class Wa {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CD { public int v; public int cb; public IntPtr pb; public string alg; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RP { public int v; public string id; public string name; public string icon; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct US { public int v; public int cb; public IntPtr pb; public string name; public string icon; public string disp; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CP { public int v; public string type; public int alg; }
  [StructLayout(LayoutKind.Sequential)] struct CPS { public int c; public IntPtr p; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct EX { public string id; public int cb; public IntPtr pv; }
  [StructLayout(LayoutKind.Sequential)] struct EXS { public int c; public IntPtr p; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CRED { public int v; public int cb; public IntPtr pb; public string type; }
  [StructLayout(LayoutKind.Sequential)] struct CREDS { public int c; public IntPtr p; }
  [StructLayout(LayoutKind.Sequential)] struct MKOPT { public int v; public int to; public CREDS cl; public EXS ex; public int att; public int rk; public int uv; public int ac; public int fl; }
  [StructLayout(LayoutKind.Sequential)] struct SALT { public int c1; public IntPtr p1; public int c2; public IntPtr p2; }
  [StructLayout(LayoutKind.Sequential)] struct SALTS { public IntPtr g; public int c; public IntPtr l; }
  [StructLayout(LayoutKind.Sequential)] struct GAOPT { public int v; public int to; public CREDS cl; public EXS ex; public int att; public int uv; public int fl; public IntPtr u2f; public IntPtr u2fb; public IntPtr canc; public IntPtr acl; public int lbo; public int lbc; public IntPtr lbp; public IntPtr hs; public int priv; }
  [StructLayout(LayoutKind.Sequential)] struct ATT { public int v; public IntPtr fmt; public int cbAD; public IntPtr pbAD; public int cbAtt; public IntPtr pbAtt; public int dt; public IntPtr pvDec; public int cbObj; public IntPtr pbObj; public int cbId; public IntPtr pbId; public EXS ext; }
  [StructLayout(LayoutKind.Sequential)] struct ASRT { public int v; public int cbAD; public IntPtr pbAD; public int cbSig; public IntPtr pbSig; public CRED cred; public int cbU; public IntPtr pbU; public EXS ext; public int cbLB; public IntPtr pbLB; public int lbs; public IntPtr hmac; }
  [DllImport("webauthn.dll")] static extern int WebAuthNGetApiVersionNumber();
  [DllImport("webauthn.dll", CharSet=CharSet.Unicode)] static extern int WebAuthNAuthenticatorMakeCredential(IntPtr h, ref RP rp, ref US u, ref CPS cp, ref CD cd, ref MKOPT o, out IntPtr res);
  [DllImport("webauthn.dll", CharSet=CharSet.Unicode)] static extern int WebAuthNAuthenticatorGetAssertion(IntPtr h, string rp, ref CD cd, ref GAOPT o, out IntPtr res);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static int Api() { return WebAuthNGetApiVersionNumber(); }
  static IntPtr Pin(byte[] b) { IntPtr p = Marshal.AllocHGlobal(Math.Max(1, b.Length)); Marshal.Copy(b, 0, p, b.Length); return p; }
  static byte[] Take(IntPtr p, int n) { byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n); return b; }
  static CD Client(string type) { byte[] j = Encoding.UTF8.GetBytes("{\\"type\\":\\"" + type + "\\",\\"challenge\\":\\"" + Convert.ToBase64String(Guid.NewGuid().ToByteArray()) + "\\",\\"origin\\":\\"agentistics-vault\\"}"); CD c = new CD(); c.v = 1; c.cb = j.Length; c.pb = Pin(j); c.alg = "SHA-256"; return c; }
  static string Hr(int hr) { string w = "unavailable"; if (hr == unchecked((int)0x800704C7) || hr == unchecked((int)0x80090036)) w = "cancelled"; else if (hr == unchecked((int)0x80090011)) w = "lost"; else if (hr == unchecked((int)0x800705B4)) w = "timeout"; return "ERR " + w + " HRESULT 0x" + hr.ToString("X8"); }
  static void Front() { try { SetForegroundWindow(GetConsoleWindow()); } catch {} }
  public static string Make(byte[] userId) {
    if (Api() < 4) return "ERR unavailable webauthn.dll is too old (needs API 4)";
    Front();
    RP rp = new RP(); rp.v = 1; rp.id = "${FIDO2_RP}"; rp.name = "Agentistics vault";
    US us = new US(); us.v = 1; us.cb = userId.Length; us.pb = Pin(userId); us.name = "vault"; us.disp = "vault";
    CP cp = new CP(); cp.v = 1; cp.type = "public-key"; cp.alg = -7;
    IntPtr pcp = Marshal.AllocHGlobal(Marshal.SizeOf(cp)); Marshal.StructureToPtr(cp, pcp, false);
    CPS cps = new CPS(); cps.c = 1; cps.p = pcp;
    IntPtr yes = Marshal.AllocHGlobal(4); Marshal.WriteInt32(yes, 1);
    EX ex = new EX(); ex.id = "hmac-secret"; ex.cb = 4; ex.pv = yes;
    IntPtr pex = Marshal.AllocHGlobal(Marshal.SizeOf(ex)); Marshal.StructureToPtr(ex, pex, false);
    MKOPT o = new MKOPT(); o.v = 1; o.to = 60000; o.ex.c = 1; o.ex.p = pex; o.att = 2; o.rk = 0; o.uv = 2; o.ac = 1;
    CD cd = Client("webauthn.create"); IntPtr res;
    int hr = WebAuthNAuthenticatorMakeCredential(GetConsoleWindow(), ref rp, ref us, ref cps, ref cd, ref o, out res);
    if (hr != 0) return Hr(hr);
    ATT a = (ATT)Marshal.PtrToStructure(res, typeof(ATT));
    bool hmac = false;
    if (a.v >= 2 && a.ext.c > 0) { for (int i = 0; i < a.ext.c; i++) { EX e = (EX)Marshal.PtrToStructure(IntPtr.Add(a.ext.p, i * Marshal.SizeOf(typeof(EX))), typeof(EX)); if (e.id == "hmac-secret" && e.pv != IntPtr.Zero && Marshal.ReadInt32(e.pv) != 0) hmac = true; } }
    if (!hmac) return "ERR no-hmac-secret this security key does not support hmac-secret";
    return "OK " + Convert.ToBase64String(Take(a.pbId, a.cbId));
  }
  public static string Get(byte[] credId, byte[] salt) {
    Front();
    CRED c = new CRED(); c.v = 1; c.cb = credId.Length; c.pb = Pin(credId); c.type = "public-key";
    IntPtr pc = Marshal.AllocHGlobal(Marshal.SizeOf(c)); Marshal.StructureToPtr(c, pc, false);
    SALT s = new SALT(); s.c1 = salt.Length; s.p1 = Pin(salt);
    IntPtr ps = Marshal.AllocHGlobal(Marshal.SizeOf(s)); Marshal.StructureToPtr(s, ps, false);
    SALTS ss = new SALTS(); ss.g = ps;
    IntPtr pss = Marshal.AllocHGlobal(Marshal.SizeOf(ss)); Marshal.StructureToPtr(ss, pss, false);
    GAOPT o = new GAOPT(); o.v = 6; o.to = 60000; o.cl.c = 1; o.cl.p = pc; o.uv = 0; o.hs = pss;
    CD cd = Client("webauthn.get"); IntPtr res;
    int hr = WebAuthNAuthenticatorGetAssertion(GetConsoleWindow(), "${FIDO2_RP}", ref cd, ref o, out res);
    if (hr != 0) return Hr(hr);
    ASRT r = (ASRT)Marshal.PtrToStructure(res, typeof(ASRT));
    if (r.hmac == IntPtr.Zero) return "ERR unavailable the key returned no hmac-secret";
    SALT h = (SALT)Marshal.PtrToStructure(r.hmac, typeof(SALT));
    return "OK " + Convert.ToBase64String(Take(h.p1, h.c1));
  }
}
`

/** Verbs on stdin line 1; line 2 = user id (make) or credential id (get); line 3 = salt (get). */
export const WEBAUTHN_SCRIPT =
  '$ErrorActionPreference="Stop"; ' +
  'function Fail($c,$d){ [Console]::Error.Write("PRESENCE-ERROR $c $d"); exit 3 } ' +
  'try { $src=@\'\n' + WEBAUTHN_CSHARP + '\n\'@; Add-Type -TypeDefinition $src; ' +
  '$l=[Console]::In.ReadToEnd() -split "`n" | ForEach-Object { $_.Trim() }; ' +
  'if ($l[0] -eq "check") { if ([Wa]::Api() -ge 4) { [Console]::Out.Write("ok"); exit 0 } else { Fail "unavailable" "webauthn.dll is too old (needs API 4)" } } ' +
  'if ($l[0] -eq "make") { $r=[Wa]::Make([Convert]::FromBase64String($l[1])) } ' +
  'elseif ($l[0] -eq "get") { $r=[Wa]::Get([Convert]::FromBase64String($l[1]),[Convert]::FromBase64String($l[2])) } ' +
  'else { Fail "unavailable" "unknown verb" }; ' +
  'if ($r.StartsWith("OK ")) { [Console]::Out.Write($r.Substring(3)); exit 0 } ' +
  '$p=$r.Split(" ",3); Fail $p[1] $p[2] } ' +
  'catch { $x=$_.Exception; if ($x.InnerException) { $x=$x.InnerException }; Fail "unavailable" $x.GetType().FullName }'

export const WEBAUTHN_ARGS = ['-NoProfile', '-NonInteractive', '-Command', WEBAUTHN_SCRIPT] as const

/**
 * The webauthn.dll struct layouts above were written from memory, not checked against Microsoft's
 * `webauthn.h`, and no real key has gone through them. A wrong layout is not a crash we would see —
 * it is a P/Invoke reading the wrong field. Until the owner's smoke (a real hmac-secret key on Windows
 * and on WSL→Windows) verifies them, the Windows transport REFUSES in words and never spawns the bridge.
 */
export const WEBAUTHN_BRIDGE_VERIFIED = false
export const WEBAUTHN_UNVERIFIED_REASON = 'the Windows security-key bridge (webauthn.dll) is not verified on real hardware yet, so it is not used; use Windows Hello on this machine'

export interface Fido2Options {
  io: ProtectorIo
  vaultDir: string
  /** `cli` = libfido2 on this OS; `webauthn` = the Windows bridge (native Windows, or WSL via interop). */
  transport: 'cli' | 'webauthn'
  wsl?: boolean
  systemRoot?: string
  /** Tests only: exercise the unverified webauthn bridge's stdin/stdout contract with a fake io. */
  allowUnverifiedBridge?: boolean
}

interface Fido2File { v: 1; credential: string; salt: string; wrapped: string }
type Out = { ok: true; out: string } | { ok: false; code: PresenceCode | 'no-hmac-secret'; reason: string }

const NO_HMAC = 'this security key does not support hmac-secret, which the vault needs. Use a YubiKey 5, SoloKey 2, Nitrokey 3 or another key that lists hmac-secret'

/** libfido2's stderr names the CTAP error; map it to the §3.5 codes. */
export function cliFailure(stderr: string): { code: PresenceCode; detail: string } {
  const m = /FIDO_ERR_[A-Z_0-9]+/.exec(stderr)?.[0] ?? ''
  const detail = m || (stderr.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? 'fido2 tool failed')
  if (/ACTION_TIMEOUT|TIMEOUT/.test(m)) return { code: 'presence-timeout', detail }
  if (/OPERATION_DENIED|USER_ACTION_PENDING|NOT_ALLOWED|KEEPALIVE_CANCEL|PIN_AUTH_BLOCKED/.test(m)) return { code: 'presence-cancelled', detail }
  if (/NO_CREDENTIALS/.test(m)) return { code: 'presence-lost', detail }
  return { code: 'presence-unavailable', detail }
}

export function fido2Protector(o: Fido2Options): Protector {
  const file = `${o.vaultDir}/${FIDO2_FILE}`
  const web = o.transport === 'webauthn'

  async function powershell(): Promise<string | null> {
    if (!o.wsl) {
      const root = o.systemRoot ?? 'C:\\Windows'
      return (await o.io.firstExisting([`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`])) ?? (await o.io.which('powershell.exe'))
    }
    if (!(await o.io.firstExisting([WSL_INTEROP]))) return null
    return (await o.io.firstExisting([WSL_POWERSHELL])) ?? (await o.io.which('powershell.exe'))
  }
  async function tool(name: string): Promise<string | null> {
    return (await o.io.firstExisting(FIDO2_TOOL_PATHS(name))) ?? (await o.io.which(name))
  }

  async function run(cmd: string, args: readonly string[], stdin: string | null): Promise<{ code: number; out: string; err: string } | { threw: PresenceCode }> {
    try {
      const r = await o.io.run(cmd, args, stdin === null ? null : bytes(stdin), { timeoutMs: FIDO2_TIMEOUT_MS + 5_000 })
      return { code: r.code, out: text(r.stdout), err: r.stderr }
    } catch (err) {
      return { threw: describeThrown(err) }
    }
  }

  /** Windows bridge call. */
  async function bridge(verb: 'check' | 'make' | 'get', a?: Uint8Array, salt?: Uint8Array): Promise<Out> {
    if (!WEBAUTHN_BRIDGE_VERIFIED && !o.allowUnverifiedBridge) return { ok: false, code: 'presence-unavailable', reason: WEBAUTHN_UNVERIFIED_REASON }
    const ps = await powershell()
    if (!ps) return { ok: false, code: 'presence-unavailable', reason: o.wsl ? 'Windows interop is off or powershell.exe was not found' : 'powershell.exe was not found' }
    const stdin = `${verb}\n${a ? Buffer.from(a).toString('base64') : ''}\n${salt ? Buffer.from(salt).toString('base64') : ''}\n`
    const r = await run(ps, WEBAUTHN_ARGS, stdin)
    if ('threw' in r) return { ok: false, code: r.threw, reason: 'powershell.exe did not answer' }
    if (r.code !== 0) {
      const e = parseBridgeError(r.err)
      return { ok: false, code: e.code, reason: e.code === 'no-hmac-secret' ? NO_HMAC : e.detail || `powershell.exe exited ${r.code}` }
    }
    return { ok: true, out: r.out.trim() }
  }

  /** libfido2: the first plugged-in key, and whether it lists hmac-secret. */
  async function device(): Promise<{ ok: true; path: string; token: string } | { ok: false; code: PresenceCode; reason: string }> {
    const token = await tool('fido2-token')
    if (!token) return { ok: false, code: 'presence-unavailable', reason: `libfido2's tools were not found — ${FIDO2_INSTALL_HINT}` }
    const l = await run(token, ['-L'], null)
    if ('threw' in l) return { ok: false, code: l.threw, reason: 'fido2-token did not answer' }
    const path = l.out.split(/\r?\n/).map(s => /^([^:\s]+):/.exec(s.trim())?.[1]).find(Boolean)
    if (l.code !== 0 || !path) return { ok: false, code: 'presence-unavailable', reason: 'no security key is plugged in' }
    return { ok: true, path, token }
  }
  async function hasHmac(d: { path: string; token: string }): Promise<boolean> {
    const i = await run(d.token, ['-I', d.path], null)
    return !('threw' in i) && i.code === 0 && /extension strings:.*hmac-secret/i.test(i.out)
  }

  async function make(): Promise<Out> {
    const userId = new Uint8Array(randomBytes(32))
    if (web) return bridge('make', userId)
    const d = await device()
    if (!d.ok) return d
    if (!(await hasHmac(d))) return { ok: false, code: 'no-hmac-secret', reason: NO_HMAC }
    const cred = await tool('fido2-cred')
    if (!cred) return { ok: false, code: 'presence-unavailable', reason: `fido2-cred was not found — ${FIDO2_INSTALL_HINT}` }
    const stdin = `${Buffer.from(randomBytes(32)).toString('base64')}\n${FIDO2_RP}\nvault\n${Buffer.from(userId).toString('base64')}\n`
    const r = await run(cred, ['-M', '-h', d.path], stdin)
    if ('threw' in r) return { ok: false, code: r.threw, reason: 'fido2-cred did not answer' }
    if (r.code !== 0) { const f = cliFailure(r.err); return { ok: false, code: f.code, reason: f.detail } }
    // -M prints: client data hash, rp id, format, authdata, credential id, signature[, x509]
    const credId = r.out.split(/\r?\n/)[4]?.trim()
    if (!credId) return { ok: false, code: 'presence-unavailable', reason: 'fido2-cred returned no credential id' }
    return { ok: true, out: credId }
  }

  async function secret(credential: string, salt: Uint8Array): Promise<Out> {
    if (web) return bridge('get', new Uint8Array(Buffer.from(credential, 'base64')), salt)
    const d = await device()
    if (!d.ok) return d
    const assert = await tool('fido2-assert')
    if (!assert) return { ok: false, code: 'presence-unavailable', reason: `fido2-assert was not found — ${FIDO2_INSTALL_HINT}` }
    const stdin = `${Buffer.from(randomBytes(32)).toString('base64')}\n${FIDO2_RP}\n${credential}\n${Buffer.from(salt).toString('base64')}\n`
    const r = await run(assert, ['-G', '-h', d.path], stdin)
    if ('threw' in r) return { ok: false, code: r.threw, reason: 'fido2-assert did not answer' }
    if (r.code !== 0) { const f = cliFailure(r.err); return { ok: false, code: f.code, reason: f.detail } }
    // -G -h prints: client data hash, rp id, authdata, hmac-secret, signature
    const hm = r.out.split(/\r?\n/)[3]?.trim()
    if (!hm) return { ok: false, code: 'presence-unavailable', reason: 'fido2-assert returned no hmac-secret' }
    return { ok: true, out: hm }
  }

  const fail = (f: { code: PresenceCode | 'no-hmac-secret'; reason: string }) =>
    ({ ok: false as const, reason: f.code === 'no-hmac-secret' ? `no-hmac-secret: ${f.reason}` : presenceReason(f.code, f.reason) })

  return {
    id: 'fido2',
    label(lang: Lang) {
      if (lang === 'pt') return web ? 'uma chave de segurança FIDO2 (pelo Windows): cada abertura pede o toque na chave' : 'uma chave de segurança FIDO2: cada abertura pede o toque na chave'
      return web ? 'a FIDO2 security key (through Windows): every open asks you to touch the key' : 'a FIDO2 security key: every open asks you to touch the key'
    },
    /** Costs gestures (a make + a get, twice): enrolment only. Refuses a key without hmac-secret. */
    async probe(): Promise<ProbeResult> {
      if (web) { const c = await bridge('check'); if (!c.ok) return fail(c) }
      const m = await make()
      if (!m.ok) return fail(m)
      const salt = probeValue()
      const a = await secret(m.out, salt)
      if (!a.ok) return fail(a)
      const b = await secret(m.out, salt)
      if (!b.ok) return fail(b)
      if (a.out !== b.out) return { ok: false, reason: presenceReason('presence-unavailable', 'the key answered differently for the same salt') }
      return { ok: true }
    },
    async wrap(dek, kid) {
      const m = await make()
      if (!m.ok) return fail(m)
      const salt = new Uint8Array(randomBytes(32))
      const s = await secret(m.out, salt)
      if (!s.ok) return fail(s)
      const key = new Uint8Array(Buffer.from(s.out, 'base64'))
      const kek = deriveKek(key, kid, 'fido2')
      const wrapped = sealDek(kek, dek, 'fido2', kid)
      zero(kek); zero(key)
      const f: Fido2File = { v: 1, credential: m.out, salt: Buffer.from(salt).toString('base64'), wrapped: Buffer.from(wrapped).toString('base64') }
      await o.io.writeFile(file, bytes(JSON.stringify(f) + '\n'))
      return { ok: true, record: { type: 'fido2', createdAt: new Date().toISOString(), params: { file: FIDO2_FILE, transport: o.transport } } }
    },
    async unwrap(_record: WrapperRecord, kid: string): Promise<UnwrapResult> {
      const raw = await o.io.readFile(file)
      if (!raw) return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', `${FIDO2_FILE} is missing`) }
      let f: Fido2File
      try {
        f = JSON.parse(text(raw)) as Fido2File
        if (f.v !== 1 || !f.credential || !f.salt || !f.wrapped) throw new Error('shape')
      } catch {
        return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', `${FIDO2_FILE} is damaged`) }
      }
      const s = await secret(f.credential, new Uint8Array(Buffer.from(f.salt, 'base64')))
      if (!s.ok) {
        const code: PresenceCode = s.code === 'no-hmac-secret' ? 'presence-unavailable' : s.code
        return { ok: false, kind: kindOf(code), reason: presenceReason(code, s.reason) }
      }
      const key = new Uint8Array(Buffer.from(s.out, 'base64'))
      const kek = deriveKek(key, kid, 'fido2')
      const dek = openDek(kek, new Uint8Array(Buffer.from(f.wrapped, 'base64')), 'fido2', kid)
      zero(kek); zero(key)
      return dek ? { ok: true, dek } : { ok: false, kind: 'missing', reason: presenceReason('presence-lost', 'this is not the security key that sealed the vault') }
    },
    async remove() {
      await o.io.removeFile(file).catch(() => {})
    },
  }
}
