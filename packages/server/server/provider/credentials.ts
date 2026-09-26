/**
 * credentials.ts — the ONLY place a provider API key touches disk (§6.2, §6.3 HOLDER).
 *
 * `~/.agentistics/provider-keys/<provider>.json`, directory `0700`, file `0600`, written
 * ATOMICALLY: open a uniquely-named tmp file in the SAME directory (`open(tmp, 'wx', 0o600)`, so
 * `rename` is atomic on one filesystem), write, fsync, close, rename, chmod. On any failure the tmp
 * file is unlinked and a failure is reported — never a truncated key left on disk, and never a tmp
 * copy left for a backup pass to stumble on (`backup-plan.ts` also excludes `.tmp-` as regenerable,
 * but the unlink here is the rule, that exclusion is only the net). `envelope-keys.ts`'s
 * `writePrivate` is close but not this careful: it is NOT atomic (a crash mid-write leaves a
 * truncated key) and its `chmod` is best-effort (`.catch(() => {})`) — this module does neither.
 *
 * Every exported function takes an optional `opts.dir`, defaulting to `PROVIDER_KEYS_DIR`, so a
 * test never touches the real `~/.agentistics` — the same test-injection idiom `github-store.ts`
 * uses with its `file` parameter.
 *
 * This module NEVER reads the process environment — see the module doc of `credential-plan.ts` and §6.1 of
 * the spec: an env-var credential is a decision the verb layer and the Anthropic client make, not
 * this one, and this file has no business asking.
 */
export type { CredentialHandle, CredentialResolution } from './credential-plan.ts'

import { chmod, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import { providerKeyFile, PROVIDER_KEYS_DIR, type KeyedProviderId } from '../config.ts'
import {
  createCredentialHandle,
  fingerprintOf,
  formatMode,
  isModeTooOpen,
  parseStoredCredential,
  serializeCredential,
  validateKeyShape,
  type CredentialHandle,
  type CredentialResolution,
  type KeyShapeRefusal,
} from './credential-plan.ts'

export interface CredentialIoOpts {
  /** Overrides `PROVIDER_KEYS_DIR` — the test-injection point. Never read from the process environment. */
  dir?: string
}

/** Monotonic per-process counter mixed into every tmp filename, mirroring `preferences.ts`'s
 *  `writeFileAtomic` — `${pid}` alone is unique per process, not per CALL, and two writes racing
 *  inside one process must not pick the same tmp path. */
let _tmpSeq = 0

/** A tmp name inside `dir` itself (so `rename` stays on one filesystem), prefixed `.tmp-` per
 *  §6.2.3 — the same prefix `backup-plan.ts` already treats as regenerable debris. */
function tmpNameIn(dir: string): string {
  const rand = randomBytes(4).toString('hex')
  return join(dir, `.tmp-${process.pid}-${++_tmpSeq}-${rand}`)
}

export type StoreCredentialResult =
  | { ok: true; fingerprint: string; previous: string | null; path: string }
  | { ok: false; reason: 'invalid-shape'; shape: KeyShapeRefusal }
  | { ok: false; reason: 'exists'; previous: string }
  | { ok: false; reason: 'write-failed' | 'permissions' }

/**
 * Store (or rotate) the credential for `provider`. Refuses outright — never partially writes —
 * when the shape is wrong (§6.1) or a key is already stored and `opts.replace` was not asked for
 * (§6.5, "rotation asks for confirmation or requires `--replace`" — that confirmation itself is the
 * verb layer's job; this function only enforces that a caller who did not pass `replace` cannot
 * silently clobber an existing key).
 *
 * `opts.now` and `opts.beforeRename` exist for tests only: `now` pins `storedAt`, `beforeRename` is
 * the injection point for "the process died between the write and the rename" — it runs after the
 * tmp file is written and fsynced and before the rename; a thrown value there is treated exactly
 * like every other mid-write failure (unlink the tmp, report a failure, leave the existing file —
 * if any — untouched).
 */
export async function storeCredential(
  provider: KeyedProviderId,
  value: string,
  opts: CredentialIoOpts & {
    replace?: boolean
    now?: () => Date
    beforeRename?: () => Promise<void> | void
  } = {},
): Promise<StoreCredentialResult> {
  const shape = validateKeyShape(value)
  if (!shape.ok) return { ok: false, reason: 'invalid-shape', shape: shape.reason }

  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const finalPath = providerKeyFile(provider, dir)

  // Read whatever is already there BEFORE touching anything, both to refuse a silent overwrite
  // and to report the rotation as `old -> new` (§6.5). A file that exists but cannot be read as a
  // valid credential (wrong shape, wrong provider, corrupt) is treated as "nothing stored" here —
  // `replace` exists to guard a REAL key, not to block recovery from a broken file.
  const existing = await resolveCredential(provider, { dir })
  if (existing.ok && !opts.replace) {
    return { ok: false, reason: 'exists', previous: existing.handle.fingerprint }
  }
  const previous = existing.ok ? existing.handle.fingerprint : null

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
  // `mkdir`'s `mode` is masked by umask and ignored outright when the directory already exists
  // (§6.2.2) — the explicit chmod is what actually enforces 0700 either way.
  try {
    await chmod(dir, 0o700)
  } catch {
    return { ok: false, reason: 'permissions' }
  }

  const now = opts.now ?? (() => new Date())
  const body = serializeCredential(provider, value, now().toISOString())
  const tmp = tmpNameIn(dir)

  let handle
  try {
    handle = await open(tmp, 'wx', 0o600)
  } catch {
    return { ok: false, reason: 'write-failed' }
  }

  try {
    await handle.writeFile(body, 'utf-8')
    await handle.sync()
  } catch {
    await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    return { ok: false, reason: 'write-failed' }
  }
  await handle.close()

  if (opts.beforeRename) {
    try {
      await opts.beforeRename()
    } catch {
      await unlink(tmp).catch(() => {})
      return { ok: false, reason: 'write-failed' }
    }
  }

  try {
    await rename(tmp, finalPath)
  } catch {
    await unlink(tmp).catch(() => {})
    return { ok: false, reason: 'write-failed' }
  }

  // Explicit chmod AFTER rename: `open(..., 0o600)` only applies the mode at CREATE time, and a
  // filesystem's own umask can still widen it — this is the enforcement, not a formality
  // (`github-store.ts:107-118` documents the identical reasoning). A failed chmod here is reported,
  // never swallowed (§6.2.2, C-5) — the file exists at this point, so this is 'permissions', not
  // 'write-failed'.
  try {
    await chmod(finalPath, 0o600)
  } catch {
    return { ok: false, reason: 'permissions' }
  }

  return { ok: true, fingerprint: fingerprintOf(value), previous, path: finalPath }
}

/**
 * Resolve the stored credential for `provider` into a `CredentialHandle`, or say why not. Mode is
 * checked BEFORE content is read — a too-open file is refused on the stat alone, exactly as ssh
 * refuses a world-readable private key, without ever reading what it contains.
 */
export async function resolveCredential(
  provider: KeyedProviderId,
  opts: CredentialIoOpts = {},
): Promise<CredentialResolution> {
  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const path = providerKeyFile(provider, dir)

  let stats: Stats
  try {
    stats = await lstat(path)
  } catch {
    return { ok: false, reason: 'absent' }
  }
  if (isModeTooOpen(stats.mode)) {
    return { ok: false, reason: 'permissions-too-open' }
  }

  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  const parsed = parseStoredCredential(text, provider)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  return { ok: true, handle: createCredentialHandle(provider, parsed.value) }
}

export interface CredentialStatus {
  provider: KeyedProviderId
  path: string
  state: 'absent' | 'present' | 'unreadable' | 'permissions-too-open'
  mode?: string
  storedAt?: string
  fingerprint?: string
}

/**
 * What `agentop provider key status` may print (§6.2.6): presence, path, mode, `storedAt` and a
 * fingerprint — NEVER the value, a substring of it, or the raw file content.
 *
 * `opts.readContent: false` is the flag-off path (`AGENTISTICS_PROVIDER` unset): only an `lstat` is
 * done, so `status` can still answer present/absent/too-open without ever opening the file — the
 * verb layer decides whether that lstat itself should run at all; this function just honours the
 * flag once asked.
 */
export async function credentialStatus(
  provider: KeyedProviderId,
  opts: CredentialIoOpts & { readContent?: boolean } = {},
): Promise<CredentialStatus> {
  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const path = providerKeyFile(provider, dir)

  let stats: Stats
  try {
    stats = await lstat(path)
  } catch {
    return { provider, path, state: 'absent' }
  }
  const mode = formatMode(stats.mode)
  if (isModeTooOpen(stats.mode)) {
    return { provider, path, state: 'permissions-too-open', mode }
  }
  if (opts.readContent === false) {
    return { provider, path, state: 'present', mode }
  }

  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return { provider, path, state: 'unreadable', mode }
  }
  const parsed = parseStoredCredential(text, provider)
  if (!parsed.ok) return { provider, path, state: 'unreadable', mode }

  return {
    provider, path, state: 'present', mode,
    storedAt: parsed.storedAt,
    fingerprint: fingerprintOf(parsed.value),
  }
}

/**
 * Remove the stored credential for `provider`. Unlinks the file, then prunes `provider-keys/`
 * itself if that was the last file in it — the directory existed only to hold the key
 * (`claude-hooks.ts`'s "containers that existed only to hold our entry are pruned" rule, CLAUDE.md).
 * Idempotent: removing an absent key returns `{ removed: false }` rather than throwing — the verb
 * layer turns that into "no key stored" and exits 0 (§6.5).
 */
export async function removeCredential(
  provider: KeyedProviderId,
  opts: CredentialIoOpts = {},
): Promise<{ removed: false } | { removed: true; fingerprint: string | null; prunedDir: boolean }> {
  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const path = providerKeyFile(provider, dir)

  // Best-effort: read the fingerprint being removed so the verb layer can say what it deleted.
  // Unreadable or malformed content is not a reason to refuse removal — it is still one file to
  // unlink — so this never returns early on a parse failure.
  let fingerprint: string | null = null
  try {
    const text = await readFile(path, 'utf-8')
    const parsed = parseStoredCredential(text, provider)
    if (parsed.ok) fingerprint = fingerprintOf(parsed.value)
  } catch {
    // absent, unreadable, or a permissions error stat would also have hit — nothing to report,
    // fall through to the unlink attempt below, which is the operation that actually decides
    // whether this was a no-op.
  }

  try {
    await unlink(path)
  } catch {
    return { removed: false }
  }

  let prunedDir = false
  try {
    await rmdir(dir)
    prunedDir = true
  } catch {
    // not empty (another provider's key lives there) or already gone — leave it.
  }

  return { removed: true, fingerprint, prunedDir }
}
