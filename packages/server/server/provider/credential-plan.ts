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
import {
  ENDPOINT_PRESETS,
  isKeyVendor,
  PROVIDER_FLAG_ENV,
  type KeyedProviderId,
  type KeyVendorId,
  type OpenAICompatibleEndpointId,
} from '../config.ts'
import type { CredentialHandle, CredentialResolution } from '@agentistics/runtime'

/** `sha256:<first 8 hex of sha256(key)>`. Non-reversible for a high-entropy key, stable across
 *  reads (so a rotation shows as `old → new`), and itself never a substring of the key. The ONE
 *  piece of literal key material `status` may show is `lastFourOf` below (owner decision C-3). */
export function fingerprintOf(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)}`
}

/** How many trailing characters of a key `status` may show — a ceiling, never more (C-3). Enough to
 *  tell two keys apart in the console's list, far too few to be the key. */
export const KEY_TAIL_LENGTH = 4

/** The last `KEY_TAIL_LENGTH` characters, for `agentop provider key status` — what the Anthropic
 *  console itself shows beside a key, so the person can match the two. A value shorter than the
 *  tail yields nothing rather than the whole key (a validated key is never that short). */
export function lastFourOf(value: string): string {
  return value.length > KEY_TAIL_LENGTH * 4 ? value.slice(-KEY_TAIL_LENGTH) : ''
}

/** The ONLY shape in which a stored key leaves `credentials.ts`. The interface is the RUNTIME's
 *  (`@agentistics/runtime`, `provider/credential.ts`, D23): the runtime consumes it and the host
 *  builds it. Only the TYPES cross — `createCredentialHandle` below, the one constructor, stays
 *  here with the key store, so the runtime never holds a way to mint a handle. */
export type { CredentialHandle, CredentialResolution }

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/** Wraps a value that has ALREADY been validated. The label is what every stringification yields.
 *  A key VENDOR's handle names that vendor (`anthropic`, `google` — core's `ProviderId`). An ENDPOINT's
 *  handle names the PROTOCOL as its provider (`openai-compatible`) and the endpoint only in its label —
 *  `openai` the endpoint is not `openai` the vendor. */
export function createCredentialHandle(provider: KeyedProviderId, value: string): CredentialHandle {
  const fingerprint = fingerprintOf(value)
  const handleProvider = isKeyVendor(provider) ? provider : 'openai-compatible' as const
  const label = isKeyVendor(provider)
    ? `[credential ${provider} ${fingerprint}]`
    : `[credential openai-compatible/${provider} ${fingerprint}]`
  const handle = Object.create(null) as CredentialHandle
  Object.defineProperties(handle, {
    provider: { value: handleProvider, enumerable: false },
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

/** A Gemini API key is `AIza` + 35 characters: 39 in all (B5b.1-SEC G-2). Enforced EXACTLY, because the
 *  value goes out as a header to one fixed host and a wrong-vendor key stored here is a credential
 *  sent to a third party; a genuine key that ever changes shape is refused with a sentence naming the
 *  rule, which is cheaper than a leak. */
const GOOGLE_KEY_PREFIX = 'AIza'
const GOOGLE_KEY_LENGTH = 39
/** The `sk-` family — Anthropic (`sk-ant-`), OpenAI (`sk-proj-`), OpenRouter (`sk-or-`), LiteLLM's own
 *  examples (`sk-1234`). None is a Google key, and each would be sent to Google's host. */
const SK_FAMILY_PREFIX = 'sk-'

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
  | 'foreign-prefix'
  | 'too-short'
  | 'too-long'

export type KeyShapeResult = { ok: true } | { ok: false; reason: KeyShapeRefusal }

/**
 * The per-endpoint key rules — deliberately LOOSE (B5a). No endpoint's prefix is enforced: OpenRouter
 * says `sk-or-…`, a LiteLLM proxy key is whatever its operator minted (its own docs use `sk-1234`), and
 * a prefix rule that is wrong rejects a genuine key. What IS refused, everywhere: whitespace, control
 * characters, bracketed-paste residue, absurd lengths — and an ANTHROPIC or GOOGLE key (`foreign-prefix`,
 * `sk-ant-` / `AIza`), because storing one here would send it, in a bearer header, to a host that is
 * neither's vendor.
 * `minLength` is a truncated-paste guard, never a claim about the vendor's real minimum.
 */
const ENDPOINT_KEY_MIN_LENGTH: Readonly<Record<OpenAICompatibleEndpointId, number>> = {
  openai: 20,
  openrouter: 20,
  deepseek: 20,
  // Operator-minted keys: short ones are real (LiteLLM's own examples are 7 characters).
  litellm: 4,
  '9router': 4,
  ollama: 4,
}

function commonShape(value: string): KeyShapeResult {
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (WHITESPACE_CHAR.test(value)) return { ok: false, reason: 'whitespace' }
  if (CONTROL_CHARS.test(value)) return { ok: false, reason: 'control' }
  if (value.includes('[') || value.includes('~')) return { ok: false, reason: 'bracketed-paste' }
  return { ok: true }
}

/**
 * Is `value` shaped like a key for `provider` (default: Anthropic)? Pure — never touches disk, never
 * logs, and its OWN return value never carries `value` (only a `KeyShapeRefusal` code) so a caller
 * cannot accidentally echo the key back through this function's result.
 */
export function validateKeyShape(value: string, provider: KeyedProviderId = 'anthropic'): KeyShapeResult {
  const common = commonShape(value)
  if (!common.ok) return common
  if (provider === 'anthropic') {
    if (!value.startsWith(ANTHROPIC_KEY_PREFIX)) return { ok: false, reason: 'prefix' }
    if (value.length < MIN_KEY_LENGTH) return { ok: false, reason: 'too-short' }
    if (value.length > MAX_KEY_LENGTH) return { ok: false, reason: 'too-long' }
    return { ok: true }
  }
  if (provider === 'google') {
    // Refuse the whole `sk-` family, and require the real shape: a key for another vendor stored here
    // would be sent, in a header, to a host that is not its vendor's.
    if (value.startsWith(SK_FAMILY_PREFIX)) return { ok: false, reason: 'foreign-prefix' }
    if (!value.startsWith(GOOGLE_KEY_PREFIX)) return { ok: false, reason: 'prefix' }
    if (value.length < GOOGLE_KEY_LENGTH) return { ok: false, reason: 'too-short' }
    if (value.length > GOOGLE_KEY_LENGTH) return { ok: false, reason: 'too-long' }
    return { ok: true }
  }
  // An Anthropic key, or a Google key, stored under any endpoint would be sent, in a bearer header, to a
  // host that is neither's vendor.
  if (value.startsWith(ANTHROPIC_KEY_PREFIX) || value.startsWith(GOOGLE_KEY_PREFIX)) {
    return { ok: false, reason: 'foreign-prefix' }
  }
  const min = ENDPOINT_KEY_MIN_LENGTH[provider]
  if (value.length < min) return { ok: false, reason: 'too-short' }
  if (value.length > MAX_KEY_LENGTH) return { ok: false, reason: 'too-long' }
  return { ok: true }
}

/** One English sentence per refusal reason. Never includes the value that was rejected. */
export function keyShapeSentence(reason: KeyShapeRefusal, provider: KeyedProviderId = 'anthropic'): string {
  // Anything that is not a known endpoint id (including a stray second argument from `.map`) reads
  // as Anthropic — the sentence stays total rather than indexing a table with a non-key.
  const endpoint = typeof provider === 'string' && Object.hasOwn(ENDPOINT_PRESETS, provider)
    ? provider as OpenAICompatibleEndpointId
    : null
  const whose = provider === 'google'
    ? 'a Google Gemini API key'
    : endpoint === null ? 'an Anthropic API key' : `a key for ${ENDPOINT_PRESETS[endpoint].label}`
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
      return provider === 'google'
        ? `a Google Gemini API key begins with "${GOOGLE_KEY_PREFIX}" — this value does not.`
        : `an Anthropic API key begins with "${ANTHROPIC_KEY_PREFIX}" — this value does not.`
    case 'foreign-prefix':
      if (provider === 'google') {
        return 'that looks like a key for another vendor — Anthropic keys (`sk-ant-…`) are never sent to '
          + 'Google. Store an Anthropic key with `agentop provider key set anthropic`.'
      }
      return 'that looks like a key for another vendor — it is never sent to another endpoint. Store an '
        + 'Anthropic key with `agentop provider key set anthropic` and a Google key with '
        + '`agentop provider key set google`.'
    case 'too-short': {
      if (provider === 'google') return `a Google Gemini API key is ${GOOGLE_KEY_LENGTH} characters — this one is shorter.`
      const min = endpoint === null ? MIN_KEY_LENGTH : ENDPOINT_KEY_MIN_LENGTH[endpoint]
      return `a key this short (under ${min} characters) is not a valid ${whose.replace(/^an? /, '')}.`
    }
    case 'too-long':
      if (provider === 'google') return `a Google Gemini API key is ${GOOGLE_KEY_LENGTH} characters — this one is longer.`
      return `a value this long (over ${MAX_KEY_LENGTH} characters) is not a valid ${whose.replace(/^an? /, '')}.`
  }
}

// ---------------------------------------------------------------------------
// B5a, contract D6 — an endpoint's BASE URL. It is configuration, not a secret, and `status` prints
// it; but it decides which host receives the bearer key, so it is validated as strictly as the key:
// https anywhere, plain http ONLY to this machine (a loopback host), no userinfo (a `user:pass@` in a
// URL is a second credential riding in plain sight), no query or fragment (a path is all a base URL
// has), trailing slashes normalised away. A refusal never quotes the URL it refused — it may be the
// very thing carrying a pasted secret.
// ---------------------------------------------------------------------------

export type BaseUrlRefusal = 'empty' | 'unparseable' | 'scheme' | 'insecure-remote' | 'userinfo' | 'query-or-fragment'
export type BaseUrlResult = { ok: true; baseUrl: string } | { ok: false; reason: BaseUrlRefusal }

/** Loopback hosts: `localhost`, `127.0.0.0/8`, and `::1`. Nothing else is "this machine". */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true
  return /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h)
}

export function validateBaseUrl(raw: string): BaseUrlResult {
  if (raw.length === 0) return { ok: false, reason: 'empty' }
  if (/\s/.test(raw) || CONTROL_CHARS.test(raw)) return { ok: false, reason: 'unparseable' }
  if (raw.includes('?') || raw.includes('#')) return { ok: false, reason: 'query-or-fragment' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  if (url.username !== '' || url.password !== '' || raw.includes('@')) return { ok: false, reason: 'userinfo' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme' }
  if (url.hostname === '') return { ok: false, reason: 'unparseable' }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return { ok: false, reason: 'insecure-remote' }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${path}` }
}

/** One English sentence per refusal. Never includes the URL. */
export function baseUrlSentence(reason: BaseUrlRefusal): string {
  switch (reason) {
    case 'empty':
      return 'a base URL is required — nothing was given.'
    case 'unparseable':
      return 'that base URL could not be read as a URL.'
    case 'scheme':
      return 'a base URL must be https:// (or http:// to this machine).'
    case 'insecure-remote':
      return 'plain http:// is accepted only for this machine (localhost, 127.x, ::1) — use https:// for '
        + 'anything else, or the key would cross the network in clear text.'
    case 'userinfo':
      return 'a base URL may not carry a user or password ("user:pass@") — the key is stored separately.'
    case 'query-or-fragment':
      return 'a base URL may not carry a query ("?") or fragment ("#").'
  }
}

// ---------------------------------------------------------------------------
// B5a, contract D6 — an endpoint's record on disk, in the SAME 0600 file as its key:
// `{ v: 1, provider: 'openai-compatible', endpoint, baseUrl, key | null, storedAt }`.
// ---------------------------------------------------------------------------

export type StoredEndpointResult =
  | { ok: true; baseUrl: string; key: string | null; storedAt: string }
  | { ok: false; reason: 'unreadable' | 'wrong-provider' }

/**
 * Parse an endpoint's record. Everything it carries is RE-validated — a hand-edited file with a
 * plain-http remote base URL, a malformed key, or a null key on an endpoint that requires one is
 * `unreadable`, never trusted because it happened to be on disk. A record for another endpoint (or
 * an Anthropic record) is `wrong-provider`.
 */
export function parseStoredEndpoint(text: string, endpoint: OpenAICompatibleEndpointId): StoredEndpointResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'unreadable' }
  const o = parsed as Record<string, unknown>
  if (o.provider !== 'openai-compatible' || o.endpoint !== endpoint) {
    return typeof o.provider === 'string' ? { ok: false, reason: 'wrong-provider' } : { ok: false, reason: 'unreadable' }
  }
  if (typeof o.baseUrl !== 'string' || typeof o.storedAt !== 'string') return { ok: false, reason: 'unreadable' }
  const url = validateBaseUrl(o.baseUrl)
  if (!url.ok || url.baseUrl !== o.baseUrl) return { ok: false, reason: 'unreadable' }
  if (o.key === null) {
    if (!ENDPOINT_PRESETS[endpoint].keyOptional) return { ok: false, reason: 'unreadable' }
    return { ok: true, baseUrl: o.baseUrl, key: null, storedAt: o.storedAt }
  }
  if (typeof o.key !== 'string' || !validateKeyShape(o.key, endpoint).ok) return { ok: false, reason: 'unreadable' }
  return { ok: true, baseUrl: o.baseUrl, key: o.key, storedAt: o.storedAt }
}

/** The inverse — what `credentials.ts` writes. Inputs are assumed already validated by the caller. */
export function serializeEndpoint(
  endpoint: OpenAICompatibleEndpointId,
  baseUrl: string,
  key: string | null,
  storedAt: string,
): string {
  return JSON.stringify({ v: 1, provider: 'openai-compatible', endpoint, baseUrl, key, storedAt })
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
export function parseStoredCredential(text: string, provider: KeyVendorId): StoredCredentialResult {
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
  if (!validateKeyShape(o.value, provider).ok) return { ok: false, reason: 'unreadable' }
  return { ok: true, value: o.value, storedAt: o.storedAt }
}

/** The inverse of `parseStoredCredential` — what `credentials.ts` writes to disk. `value` is
 *  assumed already shape-validated by the caller (`storeCredential` validates before calling). */
export function serializeCredential(provider: KeyVendorId, value: string, storedAt: string): string {
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
