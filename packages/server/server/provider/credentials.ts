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
import {
  ENDPOINT_PRESETS,
  isKeyVendor,
  isOpenAICompatibleEndpoint,
  providerKeyFile,
  PROVIDER_KEYS_DIR,
  type KeyedProviderId,
  type KeyVendorId,
  type OpenAICompatibleEndpointId,
} from '../config.ts'
import {
  createCredentialHandle,
  fingerprintOf,
  lastFourOf,
  formatMode,
  isModeTooOpen,
  parseStoredCredential,
  parseStoredEndpoint,
  serializeCredential,
  serializeEndpoint,
  validateBaseUrl,
  validateKeyShape,
  type BaseUrlRefusal,
  type CredentialHandle,
  type CredentialResolution,
  type KeyShapeRefusal,
} from './credential-plan.ts'
import type { CredentialRef } from '@agentistics/runtime'

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
  provider: KeyVendorId,
  value: string,
  opts: CredentialIoOpts & {
    replace?: boolean
    now?: () => Date
    beforeRename?: () => Promise<void> | void
  } = {},
): Promise<StoreCredentialResult> {
  const shape = validateKeyShape(value, provider)
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

  const now = opts.now ?? (() => new Date())
  const written = await writeRecordAtomic(dir, finalPath, serializeCredential(provider, value, now().toISOString()), opts.beforeRename)
  if (!written.ok) return written
  return { ok: true, fingerprint: fingerprintOf(value), previous, path: finalPath }
}

/**
 * The ONE atomic write every record in `provider-keys/` goes through (§6.2.3): 0700 directory,
 * `open(tmp, 'wx', 0o600)` in the same directory, write, fsync, close, rename, then an explicit
 * `chmod 0600`. On any failure the tmp file is unlinked and a failure is reported — never a truncated
 * record left on disk. Shared by the Anthropic key and every endpoint record, so the discipline cannot
 * drift between them.
 */
async function writeRecordAtomic(
  dir: string,
  finalPath: string,
  body: string,
  beforeRename?: () => Promise<void> | void,
): Promise<{ ok: true } | { ok: false; reason: 'write-failed' | 'permissions' }> {
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

  if (beforeRename) {
    try {
      await beforeRename()
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
  return { ok: true }
}

/**
 * Resolve the stored credential for `provider` into a `CredentialHandle`, or say why not. Mode is
 * checked BEFORE content is read — a too-open file is refused on the stat alone, exactly as ssh
 * refuses a world-readable private key, without ever reading what it contains.
 */
export async function resolveCredential(
  provider: KeyVendorId,
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
  /** The last 4 characters of the key — never more (`lastFourOf`). */
  last4?: string
  /** B5a — an endpoint's stored base URL (configuration, not a secret). Absent for a key vendor. */
  baseUrl?: string
  /** B5a — true when an endpoint (Ollama) was stored with NO key (`--no-key`). */
  keyless?: boolean
}

/**
 * What `agentop provider key status` may print (§6.2.6): presence, path, mode, `storedAt` and a
 * fingerprint and the key's last 4 characters — NEVER the value, more than that tail, or the raw
 * file content. For an endpoint, also its base URL and whether it is keyless.
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

  if (isKeyVendor(provider)) {
    const parsed = parseStoredCredential(text, provider)
    if (!parsed.ok) return { provider, path, state: 'unreadable', mode }
    return {
      provider, path, state: 'present', mode,
      storedAt: parsed.storedAt,
      fingerprint: fingerprintOf(parsed.value),
      last4: lastFourOf(parsed.value),
    }
  }

  const parsed = parseStoredEndpoint(text, provider)
  if (!parsed.ok) return { provider, path, state: 'unreadable', mode }
  if (parsed.key === null) {
    return { provider, path, state: 'present', mode, storedAt: parsed.storedAt, baseUrl: parsed.baseUrl, keyless: true }
  }
  return {
    provider, path, state: 'present', mode,
    storedAt: parsed.storedAt,
    baseUrl: parsed.baseUrl,
    fingerprint: fingerprintOf(parsed.key),
    last4: lastFourOf(parsed.key),
  }
}

// ---------------------------------------------------------------------------
// B5a — OpenAI-compatible ENDPOINTS. One record per endpoint in the SAME 0600 file shape family as
// the Anthropic key (contract D6): `{ v, provider: 'openai-compatible', endpoint, baseUrl, key|null,
// storedAt }`, written through the same `writeRecordAtomic` and read under the same mode check.
// ---------------------------------------------------------------------------

export type StoreEndpointResult =
  | {
      ok: true
      /** `null` for a keyless (Ollama) record. */
      fingerprint: string | null
      /** What was replaced, when anything was: its key fingerprint (or `null`: keyless) and base URL. */
      previous: { fingerprint: string | null; baseUrl: string } | null
      baseUrl: string
      path: string
    }
  | { ok: false; reason: 'invalid-shape'; shape: KeyShapeRefusal }
  | { ok: false; reason: 'invalid-base-url'; baseUrl: BaseUrlRefusal }
  | { ok: false; reason: 'key-required' }
  | { ok: false; reason: 'exists'; previous: { fingerprint: string | null; baseUrl: string } }
  | { ok: false; reason: 'write-failed' | 'permissions' }

/**
 * Store (or replace) an endpoint's base URL and key. `key: null` is accepted only where the preset
 * says the endpoint may be keyless (Ollama). Refuses outright — never partially writes — on a bad base
 * URL, a bad key shape, or an existing record without `replace`.
 */
export async function storeEndpointCredential(
  endpoint: OpenAICompatibleEndpointId,
  input: { baseUrl: string; key: string | null },
  opts: CredentialIoOpts & {
    replace?: boolean
    now?: () => Date
    beforeRename?: () => Promise<void> | void
  } = {},
): Promise<StoreEndpointResult> {
  const url = validateBaseUrl(input.baseUrl)
  if (!url.ok) return { ok: false, reason: 'invalid-base-url', baseUrl: url.reason }
  if (input.key === null) {
    if (!ENDPOINT_PRESETS[endpoint].keyOptional) return { ok: false, reason: 'key-required' }
  } else {
    const shape = validateKeyShape(input.key, endpoint)
    if (!shape.ok) return { ok: false, reason: 'invalid-shape', shape: shape.reason }
  }

  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const finalPath = providerKeyFile(endpoint, dir)

  const existing = await readEndpointCredential(endpoint, { dir })
  const previous = existing.ok
    ? { fingerprint: existing.handle?.fingerprint ?? null, baseUrl: existing.baseUrl }
    : null
  if (previous !== null && !opts.replace) return { ok: false, reason: 'exists', previous }

  const now = opts.now ?? (() => new Date())
  const body = serializeEndpoint(endpoint, url.baseUrl, input.key, now().toISOString())
  const written = await writeRecordAtomic(dir, finalPath, body, opts.beforeRename)
  if (!written.ok) return written
  return {
    ok: true,
    fingerprint: input.key === null ? null : fingerprintOf(input.key),
    previous,
    baseUrl: url.baseUrl,
    path: finalPath,
  }
}

export type RebaseEndpointResult =
  | { ok: true; fingerprint: string | null; previousBaseUrl: string; baseUrl: string; path: string }
  | { ok: false; reason: 'invalid-base-url'; baseUrl: BaseUrlRefusal }
  | { ok: false; reason: 'absent' | 'unreadable' | 'permissions-too-open' | 'wrong-provider' }
  | { ok: false; reason: 'write-failed' | 'permissions' }

/**
 * Change ONLY an endpoint's base URL, keeping the key (or keylessness) already stored — the web
 * settings screen's "edit the URL, leave the key field empty" (UI.1). The stored key is read and
 * re-written HERE, inside the holder, so the route layer never needs the value to keep it: a caller
 * that wanted to preserve a key would otherwise have to reveal it just to hand it straight back.
 * Refuses when nothing usable is stored (there is no key to keep), and never partially writes.
 */
export async function rebaseEndpointCredential(
  endpoint: OpenAICompatibleEndpointId,
  baseUrl: string,
  opts: CredentialIoOpts & { now?: () => Date } = {},
): Promise<RebaseEndpointResult> {
  const url = validateBaseUrl(baseUrl)
  if (!url.ok) return { ok: false, reason: 'invalid-base-url', baseUrl: url.reason }

  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const finalPath = providerKeyFile(endpoint, dir)
  const existing = await readEndpointCredential(endpoint, { dir })
  if (!existing.ok) return { ok: false, reason: existing.reason }

  const now = opts.now ?? (() => new Date())
  const body = serializeEndpoint(
    endpoint, url.baseUrl, existing.handle === null ? null : existing.handle.reveal(), now().toISOString(),
  )
  const written = await writeRecordAtomic(dir, finalPath, body)
  if (!written.ok) return written
  return {
    ok: true,
    fingerprint: existing.handle?.fingerprint ?? null,
    previousBaseUrl: existing.baseUrl,
    baseUrl: url.baseUrl,
    path: finalPath,
  }
}

export type EndpointReadResult =
  | { ok: true; baseUrl: string; storedAt: string; handle: CredentialHandle | null }
  | { ok: false; reason: 'absent' | 'unreadable' | 'permissions-too-open' | 'wrong-provider' }

/** Read an endpoint's record: its base URL and, unless keyless, an opaque handle over its key. Mode is
 *  checked BEFORE content is read, exactly as for the Anthropic key. */
export async function readEndpointCredential(
  endpoint: OpenAICompatibleEndpointId,
  opts: CredentialIoOpts = {},
): Promise<EndpointReadResult> {
  const dir = opts.dir ?? PROVIDER_KEYS_DIR
  const path = providerKeyFile(endpoint, dir)

  let stats: Stats
  try {
    stats = await lstat(path)
  } catch {
    return { ok: false, reason: 'absent' }
  }
  if (isModeTooOpen(stats.mode)) return { ok: false, reason: 'permissions-too-open' }

  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const parsed = parseStoredEndpoint(text, endpoint)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  return {
    ok: true,
    baseUrl: parsed.baseUrl,
    storedAt: parsed.storedAt,
    handle: parsed.key === null ? null : createCredentialHandle(endpoint, parsed.key),
  }
}

/**
 * The host's answer to a runtime `CredentialRef` (D23) — the one mapping every resolver in this
 * binary goes through. `{anthropic, *}` → the Anthropic key; `{google, *}` → the Google key (B5b — the
 * same one-key-per-vendor shape). `{openai-compatible, <endpoint id>}` →
 * that endpoint's key; a KEYLESS endpoint answers `absent` (there is no key to hand over — the client
 * decides whether its endpoint may proceed without one). Any other pair — an unknown endpoint id, a
 * vendor `ProviderId` like `openai` that this store never keys by, `openai-compatible` naming
 * `anthropic` — is `wrong-provider`, refused without asking the store about it.
 */
export async function resolveCredentialRef(
  ref: CredentialRef,
  opts: CredentialIoOpts = {},
): Promise<CredentialResolution> {
  if (ref.provider === 'anthropic') return resolveCredential('anthropic', opts)
  if (ref.provider === 'google') return resolveCredential('google', opts)
  if (ref.provider === 'openai-compatible' && isOpenAICompatibleEndpoint(ref.id)) {
    const read = await readEndpointCredential(ref.id, opts)
    if (!read.ok) return { ok: false, reason: read.reason }
    if (read.handle === null) return { ok: false, reason: 'absent' }
    return { ok: true, handle: read.handle }
  }
  return { ok: false, reason: 'wrong-provider' }
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
    if (isKeyVendor(provider)) {
      const parsed = parseStoredCredential(text, provider)
      if (parsed.ok) fingerprint = fingerprintOf(parsed.value)
    } else {
      const parsed = parseStoredEndpoint(text, provider)
      if (parsed.ok && parsed.key !== null) fingerprint = fingerprintOf(parsed.key)
    }
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
