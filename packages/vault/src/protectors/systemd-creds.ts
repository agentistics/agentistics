/**
 * systemd-creds.ts — a TPM2-sealed credential, through `systemd-creds --user`.
 *
 * Accepted ONLY with a TPM2. `--with-key=host` alone means "a key file on this same disk", which is
 * exactly the rejected option (a key stored beside the data it opens), so this adapter never emits
 * it — a test asserts the string never appears in any argv it builds. `has-tpm2` must answer `yes`;
 * `partial` or `no` is a refusal that names why.
 *
 * User-scoped credentials need systemd ≥ 256 (or access to the TPM's `tss` group); the refusal says
 * which when the tool rejects `--user`.
 *
 * Input and output go through stdin/stdout (`-` `-`), so neither the key nor the sealed blob is ever
 * a command-line argument; the blob is written to `vault/dek.cred` by the host's private writer.
 */
import type { Lang } from '../sentences'
import {
  bytes, firstLine, fromHex, probeValue, text, toHex,
  type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult,
} from './types'

export const CRED_FILE = 'dek.cred'
export const SYSTEMD_CREDS_PATHS = ['/usr/bin/systemd-creds', '/bin/systemd-creds'] as const

export function credName(kid: string): string {
  return `agentistics-vault-${kid}`
}

export function encryptArgs(kid: string): string[] {
  return ['encrypt', '--user', '--with-key=tpm2', `--name=${credName(kid)}`, '-', '-']
}
export function decryptArgs(kid: string): string[] {
  return ['decrypt', '--user', `--name=${credName(kid)}`, '-', '-']
}

function reasonOf(stderr: string, code: number): string {
  const s = stderr.toLowerCase()
  if (s.includes('unrecognized option') && s.includes('user')) return 'systemd is older than 256, which user-scoped credentials need (or join the tss group)'
  if (s.includes('tpm')) return 'no usable TPM2'
  return firstLine(stderr) || `systemd-creds exited ${code}`
}

export function systemdCredsProtector(io: ProtectorIo, vaultDir: string): Protector {
  const file = `${vaultDir}/${CRED_FILE}`
  /** Absolute path first; PATH only as the stated fallback. */
  async function bin(): Promise<string | null> {
    return (await io.firstExisting(SYSTEMD_CREDS_PATHS)) ?? (await io.which('systemd-creds'))
  }
  async function hasTpm2(b: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const r = await io.run(b, ['has-tpm2'], null, { timeoutMs: 15_000 })
    const answer = text(r.stdout).split(/\r?\n/)[0]?.trim() ?? ''
    return r.code === 0 && answer === 'yes' ? { ok: true } : { ok: false, reason: 'no TPM2' }
  }
  async function enc(b: string, kid: string, value: Uint8Array) {
    return io.run(b, encryptArgs(kid), bytes(toHex(value)), { timeoutMs: 30_000 })
  }
  async function dec(b: string, kid: string, blob: Uint8Array) {
    return io.run(b, decryptArgs(kid), blob, { timeoutMs: 30_000 })
  }
  return {
    id: 'systemd-creds',
    label: (lang: Lang) => lang === 'pt' ? 'o TPM2 desta máquina (systemd-creds), e só abre nesta máquina' : 'this machine\'s TPM2 (systemd-creds) and opens only on this machine',
    async probe(): Promise<ProbeResult> {
      const b = await bin()
      if (!b) return { ok: false, reason: 'systemd-creds is not installed' }
      const t = await hasTpm2(b)
      if (!t.ok) return t
      const kid = 'probe' + toHex(probeValue()).slice(0, 11)
      const value = probeValue()
      const e = await enc(b, kid, value)
      if (e.code !== 0) return { ok: false, reason: reasonOf(e.stderr, e.code) }
      const d = await dec(b, kid, e.stdout)
      if (d.code !== 0) return { ok: false, reason: reasonOf(d.stderr, d.code) }
      const got = fromHex(text(d.stdout))
      return got && Buffer.compare(Buffer.from(got), Buffer.from(value)) === 0 ? { ok: true } : { ok: false, reason: 'TPM2 round trip returned a different value' }
    },
    async wrap(dek, kid) {
      const b = await bin()
      if (!b) return { ok: false, reason: 'systemd-creds is not installed' }
      const e = await enc(b, kid, dek)
      if (e.code !== 0) return { ok: false, reason: reasonOf(e.stderr, e.code) }
      await io.writeFile(file, e.stdout)
      return { ok: true, record: { type: 'systemd-creds', createdAt: new Date().toISOString(), params: { file: CRED_FILE } } }
    },
    async unwrap(_r, kid): Promise<UnwrapResult> {
      const b = await bin()
      if (!b) return { ok: false, kind: 'unavailable', reason: 'systemd-creds is not installed' }
      const blob = await io.readFile(file)
      if (!blob) return { ok: false, kind: 'missing', reason: `${CRED_FILE} is missing` }
      const d = await dec(b, kid, blob)
      if (d.code !== 0) {
        const reason = reasonOf(d.stderr, d.code)
        return { ok: false, kind: reason === 'no usable TPM2' ? 'missing' : 'unavailable', reason }
      }
      const dek = fromHex(text(d.stdout))
      return dek ? { ok: true, dek } : { ok: false, kind: 'missing', reason: 'the TPM2 credential is not this vault\'s key' }
    },
    async remove() {
      await io.removeFile(file).catch(() => {})
    },
  }
}
