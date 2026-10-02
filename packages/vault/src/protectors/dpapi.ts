/**
 * dpapi.ts — Windows DPAPI (CurrentUser), natively on Windows and from WSL through interop.
 *
 * `powershell.exe -NoProfile -NonInteractive -Command <script>`. The SCRIPT is fixed text and holds
 * nothing secret; the payload travels on STDIN as three lines — the verb, the entropy, the data, the
 * last two base64 — and the answer comes back base64 on stdout. The blob is stored in
 * `vault/dek.dpapi`; it opens only for this Windows account on this Windows installation.
 *
 * The entropy (`agentistics-vault/v1/<kid>`) is not a secret: it binds the blob to this vault, so a
 * `dek.dpapi` copied from another vault of the same account does not unwrap as this one.
 *
 * Measured on the reference machine (WSL2): one round trip ≈ 0.7 s, and it works from a
 * `systemd-run --user` unit — i.e. from the agentop service.
 *
 * Windows Credential Manager was considered and NOT chosen (size limits, enumerable by any same-user
 * tool, roaming-profile surprises); a DPAPI blob in our own file is the same protection with a
 * simpler lifecycle.
 */
import type { Lang } from '../sentences'
import {
  bytes, firstLine, fromHex, probeValue, text, toHex,
  type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord,
} from './types'

export const DPAPI_FILE = 'dek.dpapi'

/** Where powershell.exe is looked for after PATH, on WSL. */
export const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
export const WSL_INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop'

/** The fixed script. Exported so a test can assert it carries no payload. */
export const DPAPI_SCRIPT =
  '$ErrorActionPreference="Stop"; try { Add-Type -AssemblyName System.Security; ' +
  '$l=[Console]::In.ReadToEnd() -split "`n" | ForEach-Object { $_.Trim() }; ' +
  '$e=[Convert]::FromBase64String($l[1]); $d=[Convert]::FromBase64String($l[2]); ' +
  'if ($l[0] -eq "protect") { $o=[Security.Cryptography.ProtectedData]::Protect($d,$e,"CurrentUser") } ' +
  'else { $o=[Security.Cryptography.ProtectedData]::Unprotect($d,$e,"CurrentUser") }; ' +
  '[Console]::Out.Write([Convert]::ToBase64String($o)); exit 0 } ' +
  'catch { $x=$_.Exception; if ($x.InnerException) { $x=$x.InnerException }; ' +
  '[Console]::Error.Write("DPAPI-ERROR " + $x.GetType().FullName); exit 3 }'

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT] as const

export interface DpapiOptions {
  io: ProtectorIo
  vaultDir: string
  /** Running inside WSL (reached through interop) rather than on Windows itself. */
  wsl: boolean
  /** `%SystemRoot%` on native Windows. */
  systemRoot?: string
}

function entropy(kid: string): string {
  return Buffer.from(`agentistics-vault/v1/${kid}`).toString('base64')
}

export function dpapiStdin(verb: 'protect' | 'unprotect', kid: string, data: Uint8Array): Uint8Array {
  return bytes(`${verb}\n${entropy(kid)}\n${Buffer.from(data).toString('base64')}\n`)
}

export function dpapiProtector(o: DpapiOptions): Protector {
  const file = `${o.vaultDir}/${DPAPI_FILE}`

  /** ABSOLUTE path first — a `powershell.exe` earlier on PATH would receive the key — and PATH only
   *  as the stated fallback for an install that moved it. */
  async function powershell(): Promise<string | null> {
    if (!o.wsl) {
      const root = o.systemRoot ?? 'C:\\Windows'
      return (await o.io.firstExisting([`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`]))
        ?? (await o.io.which('powershell.exe'))
    }
    // WSL: interop must be on, or `powershell.exe` is a file Linux cannot execute.
    if (!(await o.io.firstExisting([WSL_INTEROP]))) return null
    return (await o.io.firstExisting([WSL_POWERSHELL])) ?? (await o.io.which('powershell.exe'))
  }

  type Call = { ok: true; out: Uint8Array } | { ok: false; unavailable: boolean; reason: string }
  async function call(verb: 'protect' | 'unprotect', kid: string, data: Uint8Array): Promise<Call> {
    const ps = await powershell()
    if (!ps) {
      return { ok: false, unavailable: true, reason: o.wsl ? 'Windows interop is off or powershell.exe was not found' : 'powershell.exe was not found' }
    }
    let r
    try {
      r = await o.io.run(ps, POWERSHELL_ARGS, dpapiStdin(verb, kid, data), { timeoutMs: 30_000 })
    } catch (err) {
      return { ok: false, unavailable: true, reason: `powershell.exe could not be started` }
    }
    if (r.code !== 0) {
      const line = firstLine(r.stderr)
      // A DPAPI-ERROR is DPAPI itself answering "no" (the blob is not this account's, or it is
      // damaged). Anything else is the bridge failing (interop, a profile that would not load).
      const dpapi = line.startsWith('DPAPI-ERROR')
      return { ok: false, unavailable: !dpapi, reason: dpapi ? `DPAPI refused: ${line.slice('DPAPI-ERROR '.length)}` : (line || `powershell.exe exited ${r.code}`) }
    }
    const out = Buffer.from(text(r.stdout).trim(), 'base64')
    if (out.length === 0) return { ok: false, unavailable: true, reason: 'powershell.exe returned nothing' }
    return { ok: true, out: new Uint8Array(out) }
  }

  return {
    id: 'dpapi',
    label(lang: Lang) {
      if (lang === 'pt') return o.wsl ? 'o Windows (DPAPI, acessado a partir do WSL), e só abre para a sua conta do Windows' : 'o Windows (DPAPI), e só abre para a sua conta do Windows'
      return o.wsl ? 'Windows (DPAPI, reached from WSL) and opens only for your Windows account' : 'Windows (DPAPI) and opens only for your Windows account'
    },
    async probe(): Promise<ProbeResult> {
      const value = probeValue()
      const kid = 'probe' + Math.random().toString(16).slice(2, 10)
      const w = await call('protect', kid, value)
      if (!w.ok) return { ok: false, reason: w.reason }
      const u = await call('unprotect', kid, w.out)
      if (!u.ok) return { ok: false, reason: u.reason }
      if (Buffer.compare(Buffer.from(u.out), Buffer.from(value)) !== 0) return { ok: false, reason: 'DPAPI round trip returned a different value' }
      return { ok: true }
    },
    async wrap(dek, kid) {
      const w = await call('protect', kid, bytes(toHex(dek)))
      if (!w.ok) return { ok: false, reason: w.reason }
      await o.io.writeFile(file, bytes(Buffer.from(w.out).toString('base64') + '\n'))
      return { ok: true, record: { type: 'dpapi', createdAt: new Date().toISOString(), params: { file: DPAPI_FILE } } }
    },
    async unwrap(_record: WrapperRecord, kid: string): Promise<UnwrapResult> {
      const blob = await o.io.readFile(file)
      if (!blob) return { ok: false, kind: 'missing', reason: `${DPAPI_FILE} is missing` }
      const u = await call('unprotect', kid, new Uint8Array(Buffer.from(text(blob).trim(), 'base64')))
      if (!u.ok) return { ok: false, kind: u.unavailable ? 'unavailable' : 'missing', reason: u.reason }
      const dek = fromHex(text(u.out))
      return dek ? { ok: true, dek } : { ok: false, kind: 'missing', reason: 'DPAPI returned something that is not this vault\'s key' }
    },
    async remove() {
      await o.io.removeFile(file).catch(() => {})
    },
  }
}
