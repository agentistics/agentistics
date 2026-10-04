/**
 * bundle.ts — VAULT.PERSONAL backup: the vault travels in a backup as ONE sealed bundle (owner decision
 * 2026-10-03). PURE apart from `node:crypto`.
 *
 * Why one bundle and not one file per secret: a backup that lists `items/it_…/v000003.meta.sealed`
 * reveals how many secrets there are and how often each changes; a single opaque payload reveals only
 * its size and date. Why it can be restored anywhere: it carries the RECOVERY wrapper (`dek.recovery`,
 * the data key wrapped under the 24 words) and nothing machine-bound — the Hello/DPAPI/FIDO2 wrappers
 * open nothing on another machine and are left out, so the only way into a restored bundle is the 24
 * words. The payload (every sealed record, still sealed) is wrapped once more under a subkey of the data
 * key, so even the list of opaque file names stays inside.
 *
 *   bundle = { v, kind, createdAt, kid, vault: <vault.json with ONLY the recovery wrapper>, recovery:
 *              <dek.recovery bytes, base64>, payload: base64(nonce ‖ AES-256-GCM(files) ‖ tag) }
 *   AAD    = "agentistics-vault-bundle/v1" ‖ kid ‖ createdAt
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { subkey } from './seal'

export const BUNDLE_KIND = 'agentistics-vault-bundle'
export const BUNDLE_PURPOSE = 'vault/backup-bundle'
export const BUNDLE_FILE = 'vault-bundle.json'

export interface BundleFile { path: string; bytes: string }
export interface VaultBundle {
  v: 1
  kind: typeof BUNDLE_KIND
  createdAt: string
  kid: string
  /** vault.json as it must be restored: same kid and scope, the recovery wrapper ONLY. */
  vault: Record<string, unknown>
  /** `dek.recovery` as it is on disk (already encrypted under the 24 words). */
  recovery: string
  payload: string
}

const aad = (kid: string, createdAt: string) => new TextEncoder().encode(`agentistics-vault-bundle/v1${kid}${createdAt}`)

/** Build the bundle. `files` are paths RELATIVE to the data dir, holding sealed bytes (opened by no one here). */
export function sealBundle(i: { dek: Uint8Array; kid: string; vault: Record<string, unknown>; recovery: Uint8Array; files: readonly { path: string; bytes: Uint8Array }[]; createdAt: string }): VaultBundle {
  const wrappers = Array.isArray(i.vault.wrappers) ? (i.vault.wrappers as { type?: string }[]) : []
  const vault = { ...i.vault, wrappers: wrappers.filter(w => w.type === 'recovery') }
  delete (vault as { retired?: unknown }).retired
  delete (vault as { requirePresence?: unknown }).requirePresence
  const plain = Buffer.from(JSON.stringify({ files: i.files.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes).toString('base64') })) }), 'utf8')
  const key = subkey(i.dek, i.kid, BUNDLE_PURPOSE)
  const nonce = randomBytes(12)
  try {
    const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    c.setAAD(aad(i.kid, i.createdAt))
    const payload = Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()])
    return { v: 1, kind: BUNDLE_KIND, createdAt: i.createdAt, kid: i.kid, vault, recovery: Buffer.from(i.recovery).toString('base64'), payload: payload.toString('base64') }
  } finally { key.fill(0); plain.fill(0) }
}

/** Parse a bundle file; null for anything that is not exactly one. */
export function parseBundle(text: string): VaultBundle | null {
  try {
    const o = JSON.parse(text) as VaultBundle
    if (o?.v !== 1 || o.kind !== BUNDLE_KIND || typeof o.kid !== 'string' || typeof o.createdAt !== 'string' || typeof o.recovery !== 'string' || typeof o.payload !== 'string' || !o.vault || typeof o.vault !== 'object') return null
    return o
  } catch { return null }
}

/** Open the payload with the data key (obtained from the 24 words). Refuses a tampered or foreign bundle. */
export function openBundle(b: VaultBundle, dek: Uint8Array): { ok: true; files: { path: string; bytes: Uint8Array }[] } | { ok: false } {
  const raw = Buffer.from(b.payload, 'base64')
  if (raw.length < 28) return { ok: false }
  const key = subkey(dek, b.kid, BUNDLE_PURPOSE)
  try {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 })
    d.setAAD(aad(b.kid, b.createdAt))
    d.setAuthTag(raw.subarray(raw.length - 16))
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])
    try {
      const o = JSON.parse(plain.toString('utf8')) as { files: BundleFile[] }
      const files: { path: string; bytes: Uint8Array }[] = []
      for (const f of o.files ?? []) {
        if (!safeRelPath(f.path)) return { ok: false }
        files.push({ path: f.path, bytes: new Uint8Array(Buffer.from(f.bytes, 'base64')) })
      }
      return { ok: true, files }
    } finally { plain.fill(0) }
  } catch { return { ok: false } } finally { key.fill(0) }
}

/** A restored path must stay inside the data dir: relative, no `..`, no absolute, only the vault's own files. */
export function safeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  if (p.split('/').some(s => s === '..' || s === '')) return false
  return /\.sealed$/.test(p)
}
