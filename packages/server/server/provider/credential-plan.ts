/**
 * PURE — what a provider credential IS to this product, decided without touching a disk.
 *
 * This module is a HOLDER in `provider-secrets.lint.test.ts`'s sense: it is handed the key's value
 * (to validate it, to fingerprint it, to wrap it) and nothing it RETURNS may carry that value in a
 * readable form. Spec: docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §6.
 *
 * The `CredentialHandle` is the contract the Anthropic client (B1.4) consumes. It is opaque: the
 * string lives in a closure, never on a property, and every way a value is normally turned into
 * text — `JSON.stringify`, `String`, a template literal, `util.inspect`, `Object.keys` — yields
 * the fingerprint label and nothing more. `reveal()` is the only way to the key, and the lint
 * forbids every non-holder from spelling it.
 */
import { createHash } from 'node:crypto'
import { PROVIDER_FLAG_ENV, type KeyedProviderId } from '../config.ts'

/** `sha256:<first 8 hex of sha256(key)>`. Non-reversible for a high-entropy key, stable across
 *  reads (so a rotation shows as `old → new`), and never a substring of the key: a suffix would be
 *  literal key material and would defeat the grep that proves nothing leaked (§6.2.6). */
export function fingerprintOf(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)}`
}

/** The ONLY shape in which a stored key leaves `credentials.ts`. */
export interface CredentialHandle {
  readonly provider: KeyedProviderId
  /** `sha256:xxxxxxxx` — safe to print, log and compare. */
  readonly fingerprint: string
  /** The key itself. Callable only by the holders (`anthropic/client.ts` in practice) — the lint
   *  refuses the spelling everywhere else. Never store what it returns on an object that outlives
   *  the call that needed it. */
  reveal(): string
}

/** What resolving a stored credential can answer. The refusals are CODES, rendered by the verb. */
export type CredentialResolution =
  | { ok: true; handle: CredentialHandle }
  | { ok: false; reason: 'absent' | 'unreadable' | 'permissions-too-open' | 'wrong-provider' }

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/** Wraps a value that has ALREADY been validated. The label is what every stringification yields. */
export function createCredentialHandle(provider: KeyedProviderId, value: string): CredentialHandle {
  const fingerprint = fingerprintOf(value)
  const label = `[credential ${provider} ${fingerprint}]`
  const handle = Object.create(null) as CredentialHandle
  Object.defineProperties(handle, {
    provider: { value: provider, enumerable: false },
    fingerprint: { value: fingerprint, enumerable: false },
    reveal: { value: () => value, enumerable: false },
    toJSON: { value: () => label, enumerable: false },
    toString: { value: () => label, enumerable: false },
    [Symbol.toPrimitive]: { value: () => label, enumerable: false },
    [INSPECT]: { value: () => label, enumerable: false },
  })
  return Object.freeze(handle)
}

// ---------------------------------------------------------------------------
// §6.1 — shape validation. `maskedInput()` (`cli-ui.ts`) keeps every character `>= ' '` and drops
// ESC, so a terminal that wraps a paste in bracketed-paste markers leaves `[200~…[201~` inside the
// value; this is the one thing standing between that raw keystroke stream and the file on disk.
// The caller strips ONE trailing \n or \r\n before calling — this function does not trim anything,
// so a value that is still whitespace-wrapped is refused rather than silently cleaned.
// ---------------------------------------------------------------------------

/** Shortest plausible `sk-ant-…` key. Not Anthropic's real minimum (unpublished) — a bound wide
 *  enough to reject a truncated paste without ever rejecting a genuine key. */
const MIN_KEY_LENGTH = 20
/** Far longer than any real key. A bound to reject a pasted document or log dump, not a real
 *  limit — same idiom as every other "this is a guard rail, not a spec" bound in this repo. */
const MAX_KEY_LENGTH = 512

const ANTHROPIC_KEY_PREFIX = 'sk-ant-'

/** Ordinary whitespace — space, tab, newline, CR, form feed, vertical tab. Checked separately from
 *  `CONTROL_CHARS` below so the two refusals can name what is actually wrong. */
const WHITESPACE_CHAR = /\s/
/** Control characters that are NOT whitespace (whitespace is refused first). `\x7f` is DEL. */
const CONTROL_CHARS = /[\x00-\x08\x0e-\x1f\x7f]/

export type KeyShapeRefusal =
  | 'empty'
  | 'whitespace'
  | 'control'
  | 'bracketed-paste'
  | 'prefix'
  | 'too-short'
  | 'too-long'

export type KeyShapeResult = { ok: true } | { ok: false; reason: KeyShapeRefusal }

/**
 * Is `value` shaped like an Anthropic API key? Pure — never touches disk, never logs, and its
 * OWN return value never carries `value` (only a `KeyShapeRefusal` code) so a caller cannot
 * accidentally echo the key back through this function's result.
 */
export function validateKeyShape(value: string): KeyShapeResult {
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (WHITESPACE_CHAR.test(value)) return { ok: false, reason: 'whitespace' }
  if (CONTROL_CHARS.test(value)) return { ok: false, reason: 'control' }
  if (value.includes('[') || value.includes('~')) return { ok: false, reason: 'bracketed-paste' }
  if (!value.startsWith(ANTHROPIC_KEY_PREFIX)) return { ok: false, reason: 'prefix' }
  if (value.length < MIN_KEY_LENGTH) return { ok: false, reason: 'too-short' }
  if (value.length > MAX_KEY_LENGTH) return { ok: false, reason: 'too-long' }
  return { ok: true }
}

/** One English sentence per refusal reason. Never includes the value that was rejected. */
export function keyShapeSentence(reason: KeyShapeRefusal): string {
  switch (reason) {
    case 'empty':
      return 'a key is required — nothing was entered.'
    case 'whitespace':
      return 'a key may not contain whitespace — check for a stray space, tab or newline.'
    case 'control':
      return 'a key may not contain control characters.'
    case 'bracketed-paste':
      return 'that looks like bracketed-paste markers around the key ("[" or "~") rather than the '
        + 'key itself — paste it again, or type it.'
    case 'prefix':
      return `an Anthropic API key begins with "${ANTHROPIC_KEY_PREFIX}" — this value does not.`
    case 'too-short':
      return `a key this short (under ${MIN_KEY_LENGTH} characters) is not a valid Anthropic API key.`
    case 'too-long':
      return `a value this long (over ${MAX_KEY_LENGTH} characters) is not a valid Anthropic API key.`
  }
}

// ---------------------------------------------------------------------------
// §6.2.2 — file mode. `envelope-keys.ts`'s `chmod(...).catch(() => {})` swallows exactly the
// failure a credential must not swallow (§6.2.2, C-5): these two are pure arithmetic over a mode
// integer so both the read path (`credentials.ts`) and the verb layer (`cli-provider.ts`) judge a
// mode the same way.
// ---------------------------------------------------------------------------

/** Does this mode carry ANY group or other bit? `0600` alone is safe; anything wider (a umask that
 *  did not apply, a `chmod 644`, …) is refused rather than trusted — the same posture ssh takes
 *  toward a private key. */
export function isModeTooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0
}

/** `0600`-style rendering of a mode, for a refusal sentence and for `status`. */
export function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`
}

// ---------------------------------------------------------------------------
// §6.2.1 — the one-file-per-provider shape on disk: `{ v: 1, provider, value, storedAt }`.
// ---------------------------------------------------------------------------

export type StoredCredentialResult =
  | { ok: true; value: string; storedAt: string }
  | { ok: false; reason: 'unreadable' | 'wrong-provider' }

/**
 * Parse the JSON body `credentials.ts` reads off disk. Pure: given the file's TEXT (not its path),
 * decide whether it is a usable record for `provider`. A value that parses as JSON but fails shape
 * validation reads as `'unreadable'` — a corrupt credential is exactly as unusable as corrupt JSON,
 * and giving it a different code would tempt a caller to treat it as "present but wrong provider".
 */
export function parseStoredCredential(text: string, provider: KeyedProviderId): StoredCredentialResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'unreadable' }
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.provider !== 'string' || typeof o.value !== 'string' || typeof o.storedAt !== 'string') {
    return { ok: false, reason: 'unreadable' }
  }
  if (o.provider !== provider) return { ok: false, reason: 'wrong-provider' }
  if (!validateKeyShape(o.value).ok) return { ok: false, reason: 'unreadable' }
  return { ok: true, value: o.value, storedAt: o.storedAt }
}

/** The inverse of `parseStoredCredential` — what `credentials.ts` writes to disk. `value` is
 *  assumed already shape-validated by the caller (`storeCredential` validates before calling). */
export function serializeCredential(provider: KeyedProviderId, value: string, storedAt: string): string {
  return JSON.stringify({ v: 1, provider, value, storedAt })
}

// ---------------------------------------------------------------------------
// §6.2.5 — refusals the verb layer (`cli-provider.ts`) renders before it ever touches
// `credentials.ts`. Both are checked ahead of any file I/O: a central or a flag left off must
// never reach the point of opening a key file.
// ---------------------------------------------------------------------------

export type ProviderRefusal = 'central' | 'flag-off'

/** One English sentence per refusal. Never includes the value of anything secret — there is
 *  nothing secret in either reason. */
export function refusalSentence(code: ProviderRefusal): string {
  switch (code) {
    case 'central':
      return 'a central does not run the native runtime and never stores a provider key.'
    case 'flag-off':
      return `the native provider runtime is off — set ${PROVIDER_FLAG_ENV}=1 to turn it on.`
  }
}
