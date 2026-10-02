/**
 * protectors/types.ts — what a protector is, and the ONE door it reaches the machine through.
 *
 * A protector keeps the data key (DEK) wrapped by something the operating system guards for this
 * user: the macOS Keychain, Windows DPAPI (also from WSL, through interop), the Secret Service
 * (libsecret), or a TPM2 through systemd-creds. A passphrase is the fallback when none answers.
 *
 * Every adapter is PURE logic over `ProtectorIo`: the exact argv it runs, what it writes to stdin,
 * how it reads the answer and which failure becomes which sentence. The host supplies the real
 * `ProtectorIo` (spawn + files); tests supply a fake that fails the test the moment a secret
 * appears in an argv, because argv is world-readable through `ps` and `/proc/<pid>/cmdline`.
 */
import { randomBytes } from 'node:crypto'
import type { Lang } from '../sentences'

export type ProtectorId = 'keychain' | 'dpapi' | 'hello' | 'fido2' | 'recovery' | 'libsecret' | 'systemd-creds' | 'passphrase' | 'memory'

export interface RunResult {
  code: number
  stdout: Uint8Array
  stderr: string
}

export interface ProtectorIo {
  /** Run `cmd args`, writing `stdin` to it. The ONLY place a secret may travel to another process. */
  run(cmd: string, args: readonly string[], stdin: Uint8Array | null, opts?: { timeoutMs?: number }): Promise<RunResult>
  /** Read a file inside the vault directory; `null` when absent. */
  readFile(path: string): Promise<Uint8Array | null>
  /** Write a PRIVATE file atomically (0600, tmp + fsync + rename). */
  writeFile(path: string, data: Uint8Array): Promise<void>
  removeFile(path: string): Promise<void>
  /**
   * Create `path` with `data` ONLY if it does not exist (never replacing it): `false` when it already
   * did. How `vault.json` is born, so two processes initialising at once cannot both win.
   */
  createExclusive(path: string, data: Uint8Array): Promise<boolean>
  /** First existing path of `candidates`, or `null`. Used to resolve `powershell.exe` on WSL. */
  firstExisting(candidates: readonly string[]): Promise<string | null>
  /** Does `cmd` resolve on PATH? (A presence check is never ACCEPTANCE — only the probe is.) */
  which(cmd: string): Promise<string | null>
}

/** One wrapper as recorded in `vault.json`. `params` never holds the DEK or anything derived from it
 *  that would open it: a Keychain/libsecret entry lives in the OS store, a DPAPI or TPM blob lives in
 *  its own file, and the passphrase wrapper's file holds a scrypt-wrapped key. */
export interface WrapperRecord {
  type: ProtectorId
  createdAt: string
  /** Adapter-specific, non-secret: a file name, scrypt parameters' location, the keychain service. */
  params?: Record<string, string | number>
}

export type ProbeResult = { ok: true } | { ok: false; reason: string }
export type UnwrapResult =
  | { ok: true; dek: Uint8Array }
  /**
   * `missing` — the protector answered and has no such key (deleted, profile reset): protector-lost.
   * `unavailable` — the protector could not be reached at all right now (no session bus, keyring
   *   locked, powershell absent): the vault stays LOCKED and the open is retried later.
   * `denied` — a wrong passphrase / a refused prompt. Never more detail than that.
   */
  | { ok: false; kind: 'missing' | 'unavailable' | 'denied'; reason: string }

export interface Protector {
  readonly id: ProtectorId
  /** The protector as the user knows it ("Windows (DPAPI, reached from WSL)"). */
  label(lang: Lang): string
  /**
   * A REAL round trip: wrap a random throwaway value, unwrap it, compare. Never a presence check —
   * `which secret-tool` says nothing about whether a Secret Service is running and unlocked. The
   * probe value is random per probe and never logged; whatever the probe stored is removed.
   */
  probe(): Promise<ProbeResult>
  wrap(dek: Uint8Array, kid: string): Promise<{ ok: true; record: WrapperRecord } | { ok: false; reason: string }>
  unwrap(record: WrapperRecord, kid: string): Promise<UnwrapResult>
  /** Remove what `wrap` stored (vault reset / rekey). Best-effort, never throws. */
  remove(record: WrapperRecord, kid: string): Promise<void>
}

export const DEK_HEX = /^[0-9a-f]{64}$/

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
export function fromHex(s: string): Uint8Array | null {
  const t = s.trim()
  return DEK_HEX.test(t) ? new Uint8Array(Buffer.from(t, 'hex')) : null
}
export function text(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}
export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** The probe's throwaway value: random, 32 bytes, never a real key and never logged. */
export function probeValue(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}

/** Compress a tool's stderr into a reason that is safe to show: one line, bounded, no secret can be
 *  in it because no secret was ever on argv and the tools do not echo stdin. */
export function firstLine(stderr: string, max = 160): string {
  const line = stderr.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
