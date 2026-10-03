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
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { BUNDLE_FILE, RECOVERY_FILE, openBundle, parseBundle, safeRelPath, sealBundle, writePrivateAtomic, type VaultBundle } from '@agentistics/vault'
import { ensureVaultOpen, lockVault, secretFs, vaultAudit, vaultDir } from './service'
import { dataRoot, findSealedUnder } from './rekey'

const STAGED = 'restore-bundle.json'

export async function buildVaultBundle(now = new Date()): Promise<{ ok: true; bundle: VaultBundle; count: number } | { ok: false; code: 'vault-locked' | 'no-recovery' }> {
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return { ok: false, code: 'vault-locked' }
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

/**
 * Step 1. A fresh machine usually ALREADY has a vault: agentop creates an empty one on first use. That
 * one holds nothing, so it is set aside (renamed `vault.replaced-<time>`, never deleted) and the bundle
 * takes its place. A vault that holds ANY sealed record is never replaced — `vault-exists`.
 */
export async function stageBundleRestore(text: string): Promise<{ ok: true; replacedEmpty: boolean } | { ok: false; code: 'bad-bundle' | 'vault-exists' }> {
  const b = parseBundle(text)
  if (!b) return { ok: false, code: 'bad-bundle' }
  const dir = vaultDir()
  let replacedEmpty = false
  const existing = await readFile(join(dir, 'vault.json'), 'utf8').catch(() => null)
  if (existing !== null) {
    let kid = ''
    try { kid = String((JSON.parse(existing) as { kid?: unknown }).kid ?? '') } catch { return { ok: false, code: 'vault-exists' } }
    // A restore already staged here (waiting for its 24 words) is not an empty vault either.
    const staged = await stat(join(dir, STAGED)).then(() => true, () => false)
    if (!kid || staged || (await findSealedUnder(dataRoot(), kid)).length > 0) return { ok: false, code: 'vault-exists' }
    lockVault('user')
    await rename(dir, `${dir}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    replacedEmpty = true
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const enc = new TextEncoder()
  await writePrivateAtomic(secretFs(), join(dir, RECOVERY_FILE), new Uint8Array(Buffer.from(b.recovery, 'base64')))
  await writePrivateAtomic(secretFs(), join(dir, STAGED), enc.encode(text))
  await writePrivateAtomic(secretFs(), join(dir, 'vault.json'), enc.encode(JSON.stringify(b.vault, null, 2) + '\n'))
  vaultAudit({ type: 'vault.bundle-staged' })
  return { ok: true, replacedEmpty }
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

/**
 * After a restore wrote the metrics: if the archive has a vault bundle beside it, stage it IN THE SERVICE
 * (which holds the vault open) and say what happens next in one line. Never fails the restore.
 */
export async function stageVaultFromArchive(archivePath: string, log: (l: string) => void, lang: 'en' | 'pt' = 'en'): Promise<'staged' | 'none' | 'refused'> {
  const text = await readFile(`${archivePath}.vault-bundle.json`, 'utf8').catch(() => null)
  if (text === null) return 'none'
  const { vaultRole } = await import('./service')
  let r: { ok: boolean; code?: string }
  if (vaultRole() === 'holder') r = await stageBundleRestore(text)
  else {
    const { askVault } = await import('./socket')
    const a = await askVault({ op: 'vault-stage-bundle' }, { body: new TextEncoder().encode(text) })
    r = (a?.reply as { ok: boolean; code?: string } | undefined) ?? { ok: false, code: 'service-down' }
  }
  if (r.ok) {
    log(lang === 'pt'
      ? 'cofre: o backup trouxe o cofre selado. Abra Cofre neste computador e use “Recuperar com as 24 palavras” para devolver os seus segredos.'
      : 'vault: the backup carried the sealed vault. Open Vault on this computer and use "Recover with the 24 words" to bring your secrets back.')
    return 'staged'
  }
  log(lang === 'pt'
    ? (r.code === 'vault-exists' ? 'cofre: este computador já tem segredos no cofre; o cofre do backup NÃO foi aplicado por cima deles.' : 'cofre: o cofre do backup não pôde ser preparado; o resto foi restaurado.')
    : (r.code === 'vault-exists' ? 'vault: this computer already holds secrets in its vault; the backup\'s vault was NOT applied over them.' : 'vault: the backup\'s vault could not be staged; everything else was restored.'))
  return 'refused'
}

/** The flag a data-key rotation leaves: the next confirmed upload erases the older bundles (owner decision). */
export const WIPE_PENDING_FILE = 'backup-wipe-pending'
export async function markBundleWipePending(): Promise<void> {
  await writePrivateAtomic(secretFs(), join(vaultDir(), WIPE_PENDING_FILE), new TextEncoder().encode(new Date().toISOString() + '\n')).catch(() => {})
}
export async function bundleWipePending(): Promise<boolean> { return stat(join(vaultDir(), WIPE_PENDING_FILE)).then(() => true, () => false) }
export async function clearBundleWipePending(): Promise<void> { await rm(join(vaultDir(), WIPE_PENDING_FILE), { force: true }) }

/**
 * The bundle for a backup, from whichever process runs it: the service builds it; a CLI asks the
 * service over vault.sock (the bundle is ciphertext — no plaintext crosses). `null` when there is no
 * vault to carry, it is locked, or it has no recovery key (a bundle that could never be restored).
 */
export async function bundleForBackup(): Promise<{ text: string; count: number } | null> {
  const { vaultRole } = await import('./service')
  if (vaultRole() === 'holder') {
    const b = await buildVaultBundle()
    if (!b.ok) return null
    vaultAudit({ type: 'vault.bundle-built' })
    return { text: JSON.stringify(b.bundle), count: b.count }
  }
  const { askVault } = await import('./socket')
  const r = await askVault({ op: 'vault-bundle' })
  const rep = r?.reply as { ok?: boolean; bundle?: string; count?: number } | undefined
  return rep?.ok && typeof rep.bundle === 'string' ? { text: rep.bundle, count: rep.count ?? 0 } : null
}
