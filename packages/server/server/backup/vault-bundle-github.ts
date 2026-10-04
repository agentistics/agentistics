/**
 * backup/vault-bundle-github.ts — the vault's ONE sealed bundle beside a GitHub backup release
 * (VAULT.PERSONAL backup; owner decision 2026-10-03).
 *
 * A backup on GitHub is a RELEASE with one asset (the tar). The vault bundle rides as a SECOND asset,
 * `vault-bundle.json`, on the same release, and is confirmed the same way (listed, size, downloaded and
 * hashed). It is a separate asset rather than a file inside the tar for one reason: the history. Old
 * releases keep old bundles — ciphertext under the data key of their time, safe while that key is safe,
 * but not a deletion. "Erase the vault's history in the backup" deletes the `vault-bundle.json` asset
 * from every OLDER release of THIS machine, keeping the newest; with the bundle inside the tar that
 * would mean re-uploading every archive. It runs automatically after a data-key rotation (the next
 * successful upload, under the new key, is what makes the old copies redundant) and on demand,
 * gated by code + gesture.
 */
import { createHash } from 'node:crypto'
import { gh, type FetchLike } from './github-api'
import { isBackupTag, labelSlug, tagLabel } from './backup-github'

export const VAULT_BUNDLE_ASSET = 'vault-bundle.json'
/** Where the bundle lives locally: beside its archive, same name + `.vault-bundle.json`. */
export const vaultBundlePathFor = (archivePath: string) => `${archivePath}.vault-bundle.json`

interface Asset { id: number; name: string; size: number; state: string }
interface Release { id: number; tag_name: string; assets?: Asset[] }

/** PURE. Which `vault-bundle.json` assets to delete: every one on an older release of THIS machine. */
export function bundleAssetsToWipe(releases: readonly Release[], keepTag: string | null, label: string): { releaseTag: string; assetId: number }[] {
  const slug = labelSlug(label)
  const out: { releaseTag: string; assetId: number }[] = []
  // On demand there is no "this upload": keep this machine's NEWEST bundle (tags sort by their ISO stamp).
  if (keepTag === null) {
    const mine = releases.filter(r => isBackupTag(r.tag_name) && tagLabel(r.tag_name) === slug && (r.assets ?? []).some(a => a.name === VAULT_BUNDLE_ASSET)).map(r => r.tag_name).sort()
    keepTag = mine[mine.length - 1] ?? null
  }
  for (const r of releases) {
    if (!isBackupTag(r.tag_name) || r.tag_name === keepTag) continue
    // Never another machine's release, and never one this machine cannot prove is its own.
    if (tagLabel(r.tag_name) !== slug) continue
    for (const a of r.assets ?? []) if (a.name === VAULT_BUNDLE_ASSET) out.push({ releaseTag: r.tag_name, assetId: a.id })
  }
  return out
}

/** Upload + confirm the bundle as an asset of an already-created release. */
export async function uploadBundleAsset(o: {
  owner: string; repo: string; token: string; uploadUrl: string; releaseId: number; bytes: Uint8Array; fetchImpl?: FetchLike; log: (l: string) => void
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = o.uploadUrl.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(VAULT_BUNDLE_ASSET)}`
  const up = await gh<Asset>(url, o.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array(o.bytes) }, o.fetchImpl)
  if (!up.ok) return { ok: false, reason: `the vault bundle upload failed: ${up.message}` }
  const rel = await gh<Release>(`/repos/${o.owner}/${o.repo}/releases/${o.releaseId}`, o.token, {}, o.fetchImpl)
  const a = rel.ok ? rel.data.assets?.find(x => x.id === up.data.id) : undefined
  if (!a || a.state !== 'uploaded' || a.size !== o.bytes.length) return { ok: false, reason: 'the vault bundle did not land as uploaded' }
  const back = await gh<ArrayBuffer>(`/repos/${o.owner}/${o.repo}/releases/assets/${a.id}`, o.token, { headers: { Accept: 'application/octet-stream' } }, o.fetchImpl, 'arrayBuffer')
  if (!back.ok) return { ok: false, reason: `could not download the vault bundle back: ${back.message}` }
  const want = createHash('sha256').update(o.bytes).digest('hex')
  const got = createHash('sha256').update(Buffer.from(back.data)).digest('hex')
  if (want !== got) return { ok: false, reason: 'the vault bundle that arrived is not the one that left' }
  o.log('github backup: vault bundle confirmed byte-for-byte.')
  return { ok: true }
}

/** Delete this machine's older bundle assets. Returns how many were deleted (and how many failed). */
export async function wipeBundleHistory(o: {
  owner: string; repo: string; token: string; keepTag: string | null; label: string; fetchImpl?: FetchLike; log: (l: string) => void
}): Promise<{ ok: true; deleted: number; failed: number } | { ok: false; reason: string }> {
  const list = await gh<Release[]>(`/repos/${o.owner}/${o.repo}/releases?per_page=100`, o.token, {}, o.fetchImpl)
  if (!list.ok || !Array.isArray(list.data)) return { ok: false, reason: `could not list the releases: ${list.ok ? 'unexpected answer' : list.message}` }
  let deleted = 0, failed = 0
  for (const t of bundleAssetsToWipe(list.data, o.keepTag, o.label)) {
    const r = await gh<unknown>(`/repos/${o.owner}/${o.repo}/releases/assets/${t.assetId}`, o.token, { method: 'DELETE' }, o.fetchImpl, 'none')
    if (r.ok) deleted++; else failed++
  }
  o.log(`github backup: vault history erased — ${deleted} older bundle(s) deleted${failed ? `, ${failed} could not be` : ''}.`)
  return { ok: true, deleted, failed }
}

/** On demand (gated by the caller): read the machine's GitHub backup config and erase its older bundles. */
export async function wipeBundleHistoryNow(log: (l: string) => void): Promise<{ ok: true; deleted: number; failed: number } | { ok: false; reason: 'not-configured' | string }> {
  const { readGithubConfig } = await import('./github-store')
  const { resolveGithubAuth } = await import('./github-cli')
  const { hostname } = await import('node:os')
  const config = await readGithubConfig()
  if (!config) return { ok: false, reason: 'not-configured' }
  const auth = await resolveGithubAuth(config)
  if (!auth.ok) return { ok: false, reason: auth.reason }
  return wipeBundleHistory({ owner: config.owner, repo: config.repo, token: auth.token, keepTag: null, label: config.label ?? hostname(), log })
}
