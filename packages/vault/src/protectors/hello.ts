/**
 * hello.ts — Windows Hello (WinRT `KeyCredentialManager`), natively on Windows and from WSL through
 * interop. SECRETS.4 §3.1.
 *
 * Enrol: `RequestCreateAsync("agentistics-vault-<kid>", FailIfExists)` — a per-user, non-exportable RSA
 * key in the Passport KSP, every use gated by Hello. KEK: `RequestSignAsync(challenge)` over a fixed
 * 32-byte random challenge kept in `dek.hello`; RSASSA-PKCS1-v1_5/SHA-256 is deterministic, so the same
 * credential over the same challenge yields the same bytes, and `KEK = HKDF(signature, kid)` (presence.ts).
 *
 * Transport is dpapi.ts's: `powershell.exe -NoProfile -NonInteractive -Command <fixed script>`, the
 * payload on STDIN only (verb, credential name, challenge — none a secret; the SIGNATURE comes back on
 * stdout and never leaves the service/child pipe), absolute path first, WSL interop checked first. The
 * DEK never crosses into Windows.
 *
 * Foreground (owner, 2026-10-02 — the dialog opened minimized/behind every time): the script creates a
 * tiny topmost owner window, takes the foreground with AttachThreadInput (measured on the owner's
 * machine, Windows 10.0.26200, from WSL: the window becomes GetForegroundWindow(); a simulated ALT press
 * did not), and passes it as the WindowId of `RequestCreateForWindowAsync` / `RequestSignForWindowAsync`
 * so the credential dialog is OWNED by a window that is in front. Builds without the ForWindow
 * methods use the plain calls with the owner window still in front. Gestures (owner decision
 * 2026-10-02): enrolment = create + ONE sign; unlock = ONE sign; the device check = IsSupportedAsync.
 */
import { randomBytes } from 'node:crypto'
import type { Lang } from '../sentences'
import {
  deriveKek, describeThrown, gestureDone, kindOf, logBridge, openDek, parseBridgeError, presenceReason, sealDek, zero,
  type PresenceCode,
} from './presence'
import { WSL_INTEROP, WSL_POWERSHELL } from './dpapi'
import {
  bytes, probeValue, text,
  type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord,
} from './types'

export const HELLO_FILE = 'dek.hello'
export const HELLO_TIMEOUT_MS = 60_000

/** The fixed script. Carries no payload; exported so a test can assert it. */
export const HELLO_SCRIPT =
  '$ErrorActionPreference="Stop"; ' +
  'function Fail($c,$d,$r){ [Console]::Error.Write("PRESENCE-ERROR $c $d $r"); exit 3 } ' +
  'try { ' +
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime; ' +
  '$null=[Windows.Security.Credentials.KeyCredentialManager,Windows.Security.Credentials,ContentType=WindowsRuntime]; ' +
  // IBuffer: PowerShell 5.1 cannot cast a WinRT IBuffer (a bare System.__ComObject) to the interface —
  // that was the PSInvalidCastException. So no WinRT-made buffer is ever handed to the PS binder: the
  // challenge goes IN as a managed WindowsRuntimeBuffer (AsBuffer), and the signature comes OUT through
  // a REFLECTED ToArray(IBuffer), where the CLR performs the QueryInterface itself.
  '$IB=[Windows.Storage.Streams.IBuffer,Windows.Storage.Streams,ContentType=WindowsRuntime]; ' +
  '$toArr=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions].GetMethod("ToArray",[type[]]@($IB)); ' +
  '$ops=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 }; ' +
  '$asOp=$ops | Where-Object { $_.GetParameters()[0].ParameterType.Name -match "^IAsyncOperation.1$" } | Select-Object -First 1; ' +
  '$asAct=$ops | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" } | Select-Object -First 1; ' +
  // FOREGROUND (owner, 2026-10-02: the Hello dialog opened minimized/behind every time). A console-less
  // powershell.exe started from WSL owns no window, so the credential UI had nothing to come to the
  // front with. Front makes a 1x1, nearly transparent, topmost owner window, joins the input queue of
  // whatever window is in front (AttachThreadInput — the one way a background process may take the
  // foreground; a simulated ALT press was measured NOT to work here) and hands that window to the
  // ...ForWindowAsync calls as the dialog's owner. Never fatal: on any failure the call goes ahead unowned.
  'function Front(){ try { ' +
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  'Add-Type -Namespace Ag -Name W -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p); [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);\'; ' +
  '$script:F=New-Object System.Windows.Forms.Form; $F.FormBorderStyle="None"; $F.ShowInTaskbar=$false; $F.TopMost=$true; $F.StartPosition="CenterScreen"; $F.Size=New-Object System.Drawing.Size(1,1); $F.Opacity=0.01; $F.Show(); [System.Windows.Forms.Application]::DoEvents(); ' +
  '$fg=[Ag.W]::GetForegroundWindow(); $ft=[Ag.W]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $me=[Ag.W]::GetCurrentThreadId(); ' +
  '$att=($ft -ne 0 -and $ft -ne $me -and [Ag.W]::AttachThreadInput($me,$ft,$true)); [void][Ag.W]::BringWindowToTop($F.Handle); [void][Ag.W]::SetForegroundWindow($F.Handle); $F.Activate(); if ($att) { [void][Ag.W]::AttachThreadInput($me,$ft,$false) }; [System.Windows.Forms.Application]::DoEvents(); ' +
  '$wt=[Windows.Security.Credentials.KeyCredentialManager].GetMethod("RequestCreateForWindowAsync"); if (-not $wt) { return $null }; $w=[Activator]::CreateInstance($wt.GetParameters()[0].ParameterType); $w.Value=[uint64]$F.Handle.ToInt64(); return $w ' +
  '} catch { return $null } } ' +
  // The owner window's thread must keep pumping while the dialog is up, or it reads as not responding.
  'function Wait($t){ $sw=[Diagnostics.Stopwatch]::StartNew(); while (-not $t.IsCompleted) { if ($script:F) { [System.Windows.Forms.Application]::DoEvents() }; Start-Sleep -Milliseconds 30; if ($sw.ElapsedMilliseconds -gt 60000) { Fail "timeout" "" "" } } } ' +
  'function AwaitOp($op,$type){ $t=$asOp.MakeGenericMethod($type).Invoke($null,@($op)); Wait $t; $t.Result } ' +
  '$l=[Console]::In.ReadToEnd() -split "`n" | ForEach-Object { $_.Trim() }; ' +
  '$verb=$l[0]; $name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l[1])); ' +
  '$KCM=[Windows.Security.Credentials.KeyCredentialManager]; ' +
  'if ($verb -eq "check") { if (AwaitOp ($KCM::IsSupportedAsync()) ([bool])) { [Console]::Out.Write("ok"); exit 0 } else { Fail "unavailable" "hello-not-set-up" "" } } ' +
  // NTE_NO_KEY (0x8009000D): the credential is already gone — a delete is done, not failed.
  'if ($verb -eq "delete") { try { $t=$asAct.Invoke($null,@($KCM::DeleteAsync($name))); Wait $t } catch { $x=$_.Exception; while ($x.InnerException) { $x=$x.InnerException }; if ($x.HResult -ne 0x8009000D) { throw } }; [Console]::Out.Write("ok"); exit 0 } ' +
  'if ($verb -eq "create") { ' +
  '$wid=Front; $opt=[Windows.Security.Credentials.KeyCredentialCreationOption]::FailIfExists; ' +
  'if ($wid) { $r=AwaitOp ($KCM::RequestCreateForWindowAsync($wid,$name,$opt)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult]) } else { $r=AwaitOp ($KCM::RequestCreateAsync($name,$opt)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult]) }; ' +
  'switch ([string]$r.Status) { "Success" { [Console]::Out.Write("ok"); exit 0 } "UserCanceled" { Fail "cancelled" "" "" } "CredentialAlreadyExists" { Fail "unavailable" "credential-exists" "" } default { Fail "unavailable" "hello-status" ([string]$r.Status) } } } ' +
  'if ($verb -eq "sign") { ' +
  '$o=AwaitOp ($KCM::OpenAsync($name)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult]); ' +
  'if ([string]$o.Status -eq "NotFound") { Fail "lost" "credential-deleted" "" } ' +
  'if ([string]$o.Status -ne "Success") { Fail "unavailable" "hello-status" ([string]$o.Status) } ' +
  '$buf=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer([Convert]::FromBase64String($l[2])); ' +
  '$wid=Front; if ($wid) { $s=AwaitOp ($o.Credential.RequestSignForWindowAsync($wid,$buf)) ([Windows.Security.Credentials.KeyCredentialOperationResult]) } else { $s=AwaitOp ($o.Credential.RequestSignAsync($buf)) ([Windows.Security.Credentials.KeyCredentialOperationResult]) }; ' +
  'switch ([string]$s.Status) { "Success" { $b=[byte[]]$toArr.Invoke($null,[object[]]@($s.Result)); [Console]::Out.Write([Convert]::ToBase64String($b)); exit 0 } ' +
  '"UserCanceled" { Fail "cancelled" "" "" } "UserPrefersPassword" { Fail "cancelled" "" "" } "NotFound" { Fail "lost" "credential-deleted" "" } default { Fail "unavailable" "hello-status" ([string]$s.Status) } } } ' +
  'Fail "unavailable" "bad-request" "" } ' +
  'catch { $x=$_.Exception; while ($x.InnerException) { $x=$x.InnerException }; Fail "unavailable" "bridge-failed" ($x.GetType().FullName + " 0x" + $x.HResult.ToString("X8")) }'

export const HELLO_ARGS = ['-NoProfile', '-NonInteractive', '-Command', HELLO_SCRIPT] as const

export interface HelloOptions {
  io: ProtectorIo
  vaultDir: string
  wsl: boolean
  systemRoot?: string
  /** Where the bridge's RAW words go (a .NET type, a WinRT status): the log, never a sentence. */
  log?: (line: string) => void
}

export type HelloVerb = 'check' | 'create' | 'sign' | 'delete'

export function helloCredentialName(kid: string): string {
  return `agentistics-vault-${kid}`
}

export function helloStdin(verb: HelloVerb, kid: string, challenge?: Uint8Array): Uint8Array {
  const name = Buffer.from(helloCredentialName(kid)).toString('base64')
  return bytes(`${verb}\n${name}\n${challenge ? Buffer.from(challenge).toString('base64') : ''}\n`)
}

/** What `dek.hello` holds: nothing here opens the DEK without the Hello gesture. */
interface HelloFile { v: 1; challenge: string; wrapped: string }

export function helloProtector(o: HelloOptions): Protector {
  const file = `${o.vaultDir}/${HELLO_FILE}`

  async function powershell(): Promise<string | null> {
    if (!o.wsl) {
      const root = o.systemRoot ?? 'C:\\Windows'
      return (await o.io.firstExisting([`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`])) ?? (await o.io.which('powershell.exe'))
    }
    if (!(await o.io.firstExisting([WSL_INTEROP]))) return null
    return (await o.io.firstExisting([WSL_POWERSHELL])) ?? (await o.io.which('powershell.exe'))
  }

  type Call = { ok: true; out: string } | { ok: false; code: PresenceCode; reason: string }
  async function call(verb: HelloVerb, kid: string, challenge?: Uint8Array): Promise<Call> {
    const ps = await powershell()
    if (!ps) {
      return { ok: false, code: 'presence-unavailable', reason: o.wsl ? 'Windows interop is off or powershell.exe was not found' : 'powershell.exe was not found' }
    }
    let r
    try {
      r = await o.io.run(ps, HELLO_ARGS, helloStdin(verb, kid, challenge), { timeoutMs: HELLO_TIMEOUT_MS + 5_000 })
    } catch (err) {
      return { ok: false, code: describeThrown(err), reason: 'powershell.exe did not answer' }
    }
    if (r.code !== 0) {
      const e = parseBridgeError(r.stderr)
      if (e.raw) (o.log ?? logBridge)(`hello ${verb}: ${e.raw}`)
      const code: PresenceCode = e.code === 'no-hmac-secret' ? 'presence-unavailable' : e.code
      return { ok: false, code, reason: e.detail }
    }
    if (verb === 'create' || verb === 'sign') gestureDone()
    return { ok: true, out: text(r.stdout).trim() }
  }

  async function signature(kid: string, challenge: Uint8Array): Promise<{ ok: true; sig: Uint8Array } | { ok: false; code: PresenceCode; reason: string }> {
    const s = await call('sign', kid, challenge)
    if (!s.ok) return s
    const sig = new Uint8Array(Buffer.from(s.out, 'base64'))
    if (sig.length === 0) return { ok: false, code: 'presence-unavailable', reason: 'Windows Hello returned no signature' }
    return { ok: true, sig }
  }

  const self: Protector = {
    id: 'hello',
    label(lang: Lang) {
      if (lang === 'pt') return o.wsl ? 'o Windows Hello (acessado a partir do WSL): cada abertura pede o seu PIN, rosto ou digital' : 'o Windows Hello: cada abertura pede o seu PIN, rosto ou digital'
      return o.wsl ? 'Windows Hello (reached from WSL): every open asks for your PIN, face or fingerprint' : 'Windows Hello: every open asks for your PIN, face or fingerprint'
    },
    /**
     * NO gesture (owner decision 2026-10-02: the whole setup asks Windows Hello the minimum the API
     * allows — create + ONE sign — and every unlock exactly one). `IsSupportedAsync` says Hello is set
     * up here; the enrolment proves it works; the FIRST real unlock proves the signature reproduces
     * (a mismatch is `presence-lost: not-reproducible`, sent to the recovery key — never a silent loss).
     */
    async probe(): Promise<ProbeResult> {
      const sup = await call('check', 'probe')
      return sup.ok ? { ok: true } : { ok: false, reason: presenceReason(sup.code, sup.reason) }
    },
    async derive(kid) {
      const c = await call('create', kid)
      if (!c.ok) return { ok: false, reason: presenceReason(c.code, c.reason) }
      const challenge = new Uint8Array(randomBytes(32))
      const s = await signature(kid, challenge)
      if (!s.ok) {
        await call('delete', kid) // never leave a credential no file refers to
        return { ok: false, reason: presenceReason(s.code, s.reason) }
      }
      const kek = deriveKek(s.sig, kid, 'hello')
      zero(s.sig)
      return { ok: true, held: { kek, fields: { challenge: Buffer.from(challenge).toString('base64') } } }
    },
    async sealHeld(held, dek, kid) {
      const challenge = held.fields.challenge
      if (!challenge || held.kek.length !== 32) return { ok: false, reason: presenceReason('presence-unavailable', 'bridge-failed') }
      const wrapped = sealDek(held.kek, dek, 'hello', kid)
      // Leader decision 2026-10-02: the wrapped DEK must open again with the KEK already derived — checked
      // here, in memory, before anything is written or retired. Never a second gesture.
      const back = openDek(held.kek, wrapped, 'hello', kid)
      const same = back !== null && Buffer.compare(Buffer.from(back), Buffer.from(dek)) === 0
      if (back) zero(back)
      if (!same) return { ok: false, reason: presenceReason('presence-unavailable', 'bridge-failed') }
      const f: HelloFile = { v: 1, challenge, wrapped: Buffer.from(wrapped).toString('base64') }
      await o.io.writeFile(file, bytes(JSON.stringify(f) + '\n'))
      return { ok: true, record: { type: 'hello', createdAt: new Date().toISOString(), params: { file: HELLO_FILE, credential: helloCredentialName(kid) } } }
    },
    async discardHeld(held, kid) {
      zero(held.kek)
      await call('delete', kid).catch(() => {})
    },
    async wrap(dek, kid) {
      const d = await self.derive!(kid)
      if (!d.ok) return d
      try {
        const s = await self.sealHeld!(d.held, dek, kid)
        if (!s.ok) await call('delete', kid)
        return s
      } finally { zero(d.held.kek) }
    },
    async unwrap(_record: WrapperRecord, kid: string): Promise<UnwrapResult> {
      const raw = await o.io.readFile(file)
      if (!raw) return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', `${HELLO_FILE} is missing`) }
      let f: HelloFile
      try {
        f = JSON.parse(text(raw)) as HelloFile
        if (f.v !== 1 || typeof f.challenge !== 'string' || typeof f.wrapped !== 'string') throw new Error('shape')
      } catch {
        return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', `${HELLO_FILE} is damaged`) }
      }
      const s = await signature(kid, new Uint8Array(Buffer.from(f.challenge, 'base64')))
      if (!s.ok) return { ok: false, kind: kindOf(s.code), reason: presenceReason(s.code, s.reason) }
      const kek = deriveKek(s.sig, kid, 'hello')
      const dek = openDek(kek, new Uint8Array(Buffer.from(f.wrapped, 'base64')), 'hello', kid)
      zero(kek); zero(s.sig)
      // A signature that opens nothing means the credential was recreated (a different key): lost.
      return dek
        ? { ok: true, dek }
        : { ok: false, kind: 'missing', reason: presenceReason('presence-lost', 'not-reproducible') }
    },
    async remove(_record, kid) {
      await call('delete', kid).catch(() => {})
      await o.io.removeFile(file).catch(() => {})
    },
  }
  return self
}
