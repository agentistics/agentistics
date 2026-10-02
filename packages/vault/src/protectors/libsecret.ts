/**
 * libsecret.ts — the freedesktop Secret Service (GNOME Keyring, KWallet's bridge), via `secret-tool`.
 *
 * `secret-tool store` reads the secret from STDIN; `lookup` prints it on stdout. Neither puts it in
 * an argv. It needs the user's session bus and an UNLOCKED collection, so a headless box usually
 * cannot use it — the probe finds that out by doing a real round trip, never by `which`.
 *
 * Unreachable (no bus, collection locked) is `unavailable`: the vault stays locked and retries. A
 * lookup that answers with nothing is `missing`: the entry is gone (protector-lost).
 */
import type { Lang } from '../sentences'
import {
  firstLine, fromHex, probeValue, text, toHex, bytes,
  type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult,
} from './types'

export const SECRET_SERVICE = 'agentistics-vault'
export const SECRET_TOOL_PATHS = ['/usr/bin/secret-tool', '/bin/secret-tool'] as const

export function libsecretProtector(io: ProtectorIo): Protector {
  /** Absolute path first; PATH only as the stated fallback. */
  async function tool(): Promise<string | null> {
    return (await io.firstExisting(SECRET_TOOL_PATHS)) ?? (await io.which('secret-tool'))
  }
  async function store(bin: string, account: string, value: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
    const r = await io.run(bin, ['store', '--label=agentistics vault', 'service', SECRET_SERVICE, 'account', account], bytes(toHex(value)), { timeoutMs: 30_000 })
    return r.code === 0 ? { ok: true } : { ok: false, reason: reasonOf(r.stderr, r.code) }
  }
  async function lookup(bin: string, account: string): Promise<UnwrapResult> {
    const r = await io.run(bin, ['lookup', 'service', SECRET_SERVICE, 'account', account], null, { timeoutMs: 30_000 })
    if (r.code !== 0 && r.stderr.trim() !== '') return { ok: false, kind: 'unavailable', reason: reasonOf(r.stderr, r.code) }
    const dek = fromHex(text(r.stdout))
    return dek ? { ok: true, dek } : { ok: false, kind: 'missing', reason: 'the Secret Service has no agentistics-vault entry for this vault' }
  }
  async function clear(bin: string, account: string): Promise<void> {
    await io.run(bin, ['clear', 'service', SECRET_SERVICE, 'account', account], null, { timeoutMs: 30_000 }).catch(() => {})
  }
  return {
    id: 'libsecret',
    label: (lang: Lang) => lang === 'pt' ? 'o chaveiro da sua sessão (Secret Service / libsecret), e só abre para a sua conta' : 'your session keyring (Secret Service / libsecret) and opens only for your account',
    async probe(): Promise<ProbeResult> {
      const bin = await tool()
      if (!bin) return { ok: false, reason: 'secret-tool is not installed' }
      const account = 'probe-' + toHex(probeValue()).slice(0, 12)
      const value = probeValue()
      const s = await store(bin, account, value)
      if (!s.ok) return { ok: false, reason: s.reason }
      const l = await lookup(bin, account)
      await clear(bin, account)
      if (!l.ok) return { ok: false, reason: l.reason }
      return Buffer.compare(Buffer.from(l.dek), Buffer.from(value)) === 0 ? { ok: true } : { ok: false, reason: 'Secret Service round trip returned a different value' }
    },
    async wrap(dek, kid) {
      const bin = await tool()
      if (!bin) return { ok: false, reason: 'secret-tool is not installed' }
      const s = await store(bin, kid, dek)
      return s.ok ? { ok: true, record: { type: 'libsecret', createdAt: new Date().toISOString(), params: { service: SECRET_SERVICE } } } : s
    },
    async unwrap(_r, kid) {
      const bin = await tool()
      if (!bin) return { ok: false, kind: 'unavailable', reason: 'secret-tool is not installed' }
      return lookup(bin, kid)
    },
    async remove(_r, kid) {
      const bin = await tool()
      if (bin) await clear(bin, kid)
    },
  }
}

function reasonOf(stderr: string, code: number): string {
  const s = stderr.toLowerCase()
  if (s.includes('org.freedesktop.secrets') || s.includes('autolaunch') || s.includes('dbus') || s.includes('d-bus')) return 'no Secret Service answered'
  if (s.includes('locked') || s.includes('dismissed') || s.includes('cancel')) return 'the keyring is locked'
  return firstLine(stderr) || `secret-tool exited ${code}`
}
