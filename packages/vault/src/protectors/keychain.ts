/**
 * keychain.ts — the macOS login Keychain, through `/usr/bin/security`.
 *
 * Writing goes through `security -i`, which reads its COMMANDS from stdin — so the key travels on
 * stdin inside an `add-generic-password … -w <hex>` line and never appears in an argv (`ps` shows
 * every argv to every user). Reading is `find-generic-password -s … -a <kid> -w`, whose argv holds
 * only the service and the kid; the key comes back on stdout.
 *
 * The first access may raise a Keychain prompt: that is the protector working, not an error. A
 * refused prompt is `denied`; "could not be found" is `missing` (protector-lost).
 *
 * NOTE (stated limit): written against `security(1)`'s documented behaviour and exercised only with
 * a fake here — no macOS machine was available when this was built. Verify on a real Mac.
 */
import type { Lang } from '../sentences'
import {
  bytes, firstLine, fromHex, probeValue, text, toHex,
  type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult,
} from './types'

export const KEYCHAIN_SERVICE = 'agentistics-vault'
export const SECURITY = '/usr/bin/security'

/** `security -i` exits 0 even when a command in it failed, so failure is read from its output. */
function classify(stderr: string, code: number): { kind: 'missing' | 'denied' | 'unavailable'; reason: string } {
  const s = stderr.toLowerCase()
  if (s.includes('could not be found') || code === 44) return { kind: 'missing', reason: 'the Keychain has no agentistics-vault entry for this vault' }
  if (s.includes('cancel') || s.includes('-128') || s.includes('user interaction is not allowed')) return { kind: 'denied', reason: 'the Keychain prompt was refused or could not be shown' }
  return { kind: 'unavailable', reason: firstLine(stderr) || `security exited ${code}` }
}

export function keychainAddCommand(kid: string, hex: string): string {
  // kid is [0-9a-f]{16} (or a probe's hex) and hex is [0-9a-f]{64}: no quoting can be broken.
  return `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${kid} -l "agentistics vault" -w ${hex}\n`
}

export function keychainProtector(io: ProtectorIo): Protector {
  async function store(kid: string, value: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
    const r = await io.run(SECURITY, ['-i'], bytes(keychainAddCommand(kid, toHex(value))), { timeoutMs: 120_000 })
    if (r.code !== 0 || /error|could not/i.test(r.stderr)) return { ok: false, reason: classify(r.stderr, r.code).reason }
    return { ok: true }
  }
  async function load(kid: string): Promise<UnwrapResult> {
    const r = await io.run(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', kid, '-w'], null, { timeoutMs: 120_000 })
    if (r.code !== 0) return { ok: false, ...classify(r.stderr, r.code) }
    const dek = fromHex(text(r.stdout))
    return dek ? { ok: true, dek } : { ok: false, kind: 'missing', reason: 'the Keychain entry is not this vault\'s key' }
  }
  async function del(kid: string): Promise<void> {
    await io.run(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', kid], null, { timeoutMs: 30_000 }).catch(() => {})
  }
  return {
    id: 'keychain',
    label: (lang: Lang) => lang === 'pt' ? 'o Keychain do macOS, e só abre para a sua conta' : 'the macOS Keychain and opens only for your account',
    async probe(): Promise<ProbeResult> {
      if (!(await io.firstExisting([SECURITY]))) return { ok: false, reason: 'security(1) was not found' }
      const kid = 'probe' + toHex(probeValue()).slice(0, 11)
      const value = probeValue()
      const s = await store(kid, value)
      if (!s.ok) return { ok: false, reason: s.reason }
      const l = await load(kid)
      await del(kid)
      if (!l.ok) return { ok: false, reason: l.reason }
      return Buffer.compare(Buffer.from(l.dek), Buffer.from(value)) === 0 ? { ok: true } : { ok: false, reason: 'Keychain round trip returned a different value' }
    },
    async wrap(dek, kid) {
      const s = await store(kid, dek)
      return s.ok ? { ok: true, record: { type: 'keychain', createdAt: new Date().toISOString(), params: { service: KEYCHAIN_SERVICE } } } : s
    },
    unwrap: (_r, kid) => load(kid),
    async remove(_r, kid) { await del(kid) },
  }
}
