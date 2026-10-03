/**
 * vault/bundle-io.ts — VAULT.PERSONAL backup, the SERVICE half of `packages/vault/src/bundle.ts`.
 *
 * BUILD (vault open): every `*.sealed` under the data dir sealed under the current key (the same walk
 * a key rotation uses — personal secrets, the GitHub token, the central tokens, the authenticator
 * seed), still sealed, plus `dek.recovery` and a vault.json holding only the recovery wrapper, into
 * ONE bundle. Nothing is opened to build it: the records go in as the bytes they are on disk.
 *
 * RESTORE on a fresh machine, in two steps that never need a value on disk in the clear:
 *  1. `stageBundleRestore` writes vault.json + dek.recovery + the bundle itself (0600). Refused when this
 *     data dir already has a vault: a restore never overwrites a live one.
 *  2. the 24 words (page on this computer, or `agentop vault recover`) open the data key; `recoverWithWords`
 *     then calls `finishBundleRestore`, which opens the payload with that key and writes every record back
 *     (relative paths only, inside the data dir, `.sealed` only), then removes the staged bundle.
 * The machine-bound wrappers never travel, so step 2 is the ONLY way in, and the vault lands in recovery
 * mode: new authenticator, personal confirmation, and new words — the old ones were in a backup.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { BUNDLE_FILE, RECOVERY_FILE, openBundle, parseBundle, safeRelPath, sealBundle, writePrivateAtomic, type VaultBundle } from '@agentistics/vault'
import { ensureVaultOpen, secretFs, vaultAudit, vaultDir } from './service'
import { dataRoot, findSealedUnder } from './rekey'

const STAGED = 'restore-bundle.json'

export async function buildVaultBundle(now = new Date()): Promise<{ ok: true; bundle: VaultBundle; count: number } | { ok: false; code: 'locked' | 'no-recovery' }> {
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return { ok: false, code: 'locked' }
  if (!o.vault.wrappers.some(w => w.type === 'recovery')) return { ok: false, code: 'no-recovery' }
  const recovery = await secretFs().readFile(join(vaultDir(), RECOVERY_FILE))
  if (!recovery) return { ok: false, code: 'no-recovery' }
  const root = dataRoot()
  const files: { path: string; bytes: Uint8Array }[] = []
  for (const abs of await findSealedUnder(root, o.kid)) {
    const bytes = await secretFs().readFile(abs)
    if (bytes) files.push({ path: relative(root, abs).split(sep).join('/'), bytes })
  }
  const bundle = sealBundle({ dek: o.dek, kid: o.kid, vault: o.vault as unknown as Record<string, unknown>, recovery, files, createdAt: now.toISOString() })
  return { ok: true, bundle, count: files.length }
}

/** Step 1 — on a machine whose data dir has NO vault yet. */
export async function stageBundleRestore(text: string): Promise<{ ok: true } | { ok: false; code: 'bad-bundle' | 'vault-exists' }> {
  const b = parseBundle(text)
  if (!b) return { ok: false, code: 'bad-bundle' }
  const dir = vaultDir()
  if (await stat(join(dir, 'vault.json')).then(() => true, () => false)) return { ok: false, code: 'vault-exists' }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const enc = new TextEncoder()
  await writePrivateAtomic(secretFs(), join(dir, RECOVERY_FILE), new Uint8Array(Buffer.from(b.recovery, 'base64')))
  await writePrivateAtomic(secretFs(), join(dir, STAGED), enc.encode(text))
  await writePrivateAtomic(secretFs(), join(dir, 'vault.json'), enc.encode(JSON.stringify(b.vault, null, 2) + '\n'))
  vaultAudit({ type: 'vault.bundle-staged' })
  return { ok: true }
}

/** Step 2 — called right after the 24 words opened the vault. No staged bundle → nothing to do. */
export async function finishBundleRestore(): Promise<{ restored: number } | null> {
  const dir = vaultDir()
  const raw = await readFile(join(dir, STAGED), 'utf8').catch(() => null)
  if (raw === null) return null
  const b = parseBundle(raw)
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!b || !o || b.kid !== o.kid) return { restored: 0 }
  const opened = openBundle(b, o.dek)
  if (!opened.ok) return { restored: 0 }
  const root = resolve(dataRoot())
  let restored = 0
  for (const f of opened.files) {
    if (!safeRelPath(f.path)) continue
    const abs = resolve(root, f.path)
    if (!abs.startsWith(root + sep)) continue
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 })
    await writePrivateAtomic(secretFs(), abs, f.bytes)
    restored++
  }
  await rm(join(dir, STAGED), { force: true })
  vaultAudit({ type: 'vault.bundle-restored' })
  return { restored }
}

export { BUNDLE_FILE }
