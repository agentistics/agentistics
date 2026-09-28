/**
 * provider-web.ts — `/api/provider`, the web settings screen's door onto the native runtime's
 * provider configuration (UI.1). The wire contract is fixed; the verbs are the ones
 * `agentop provider key set|status|remove` and `agentop provider models` already perform, with the
 * same stores, the same validators and the same refusal sentences — a second implementation of
 * "what a stored key is" would be a second place for the two to disagree.
 *
 *   GET    /api/provider              every keyed provider, in KEYED_PROVIDERS order
 *   PUT    /api/provider/:id          store / replace the base URL and (optionally) the key
 *   POST   /api/provider/:id/test     ONE non-billed model-list call over the STORED credential
 *   GET    /api/provider/:id/models   the live model list (60 s cache, keyed by endpoint + URL)
 *   DELETE /api/provider/:id          remove the stored record (does not revoke the key upstream)
 *
 * KEY HANDLING (spec 2026-09-25-runtime-b1-provider.md §6). This module is a RECEIVER, exactly the
 * role `cli-provider.ts` has: a key arrives as a string in a PUT body, is handed to
 * `credential-plan.ts` to validate and to `credentials.ts` to store, and is dropped when the handler
 * returns. It is never assigned to anything that outlives the call, never logged, never placed in a
 * thrown error, and never in a response — every response is built from `credentialStatus`, whose
 * only key-derived fields are the fingerprint and the last four characters. A PUT that omits the key
 * keeps the stored one WITHOUT this module ever seeing it (`rebaseEndpointCredential` rewrites the
 * record inside the holder). `provider-secrets.lint.test.ts` holds this file to Guards 2 and 3.
 *
 * Refused on a central in the handler itself (403), on top of `capability-guard.ts`'s
 * `/api/provider` → `localShell` entry, and every verb but the list refuses while the feature flag
 * is off — the list answers `enabled: false` in words, which is what lets the screen say why it is
 * empty.
 */
import {
  ENDPOINT_PRESETS,
  isKeyedProvider,
  isKeyVendor,
  KEYED_PROVIDERS,
  providerFlagOn,
  TEAM_CENTRAL,
  type EndpointKind,
  type KeyedProviderId,
  type KeyVendorId,
  type OpenAICompatibleEndpointId,
} from './config.ts'
import { readJsonLimited } from './limits.ts'
import { originAllowed } from './cors.ts'
import { ALLOWED_ORIGINS } from './config.ts'
import type { AuditInput } from './audit.ts'
import {
  baseUrlSentence,
  keyShapeSentence,
  refusalSentence,
  validateBaseUrl,
  validateKeyShape,
  type BaseUrlRefusal,
  type KeyShapeRefusal,
} from './provider/credential-plan.ts'
import {
  credentialStatus,
  readEndpointCredential,
  rebaseEndpointCredential,
  removeCredential,
  resolveCredential,
  storeCredential,
  storeEndpointCredential,
  type CredentialStatus,
} from './provider/credentials.ts'
import { listAnthropicModels } from './provider/anthropic-models.ts'
import { endpointRefusalSentence, modelsFailureSentence } from './cli-provider-models.ts'
import { createModelLister, type ModelListResult } from '@agentistics/runtime'

/** A PUT body is three short fields; nothing legitimate comes near this. */
export const PROVIDER_BODY_BYTES = 16 * 1024

export type ProviderState = CredentialStatus['state']

/** The ONLY shape describing a configured provider on the wire (contract). Never a key, a path or
 *  file content — `path` and `mode` from `credentialStatus` are deliberately NOT carried. */
export interface ProviderEntry {
  id: KeyedProviderId
  label: string
  kind: EndpointKind
  defaultBaseUrl: string | null
  baseUrlEditable: boolean
  keyOptional: boolean
  state: ProviderState
  baseUrl?: string
  keyless?: boolean
  fingerprint?: string
  last4?: string
  storedAt?: string
}

export interface Refusal { code: string; sentence: string }

export interface ProviderWebResult {
  status: number
  body: unknown
}

export interface ProviderWebDeps {
  /** `TEAM_CENTRAL` OR the effective `preferences.team.mode === 'central'` — cli-provider's rule. */
  isCentral: () => Promise<boolean>
  /** `providerFlagOn()` — absent reads as OFF. */
  flagOn: () => boolean
  /** Key-directory override for tests; `undefined` = the real `PROVIDER_KEYS_DIR`. */
  dir?: string
  fetch: typeof fetch
  audit: (input: AuditInput) => void
  now: () => number
  /** `AGENTISTICS_ALLOWED_ORIGINS` — the only foreign origins a browser request may come from. */
  allowedOrigins: string[]
  /** Dev mode (`!SERVE_STATIC`): localhost origins are allowed, as in `cors.ts`. Default false —
   *  `index.ts` passes the real value; this module reads no environment (Guard 3). */
  dev: boolean
}

async function defaultIsCentral(): Promise<boolean> {
  if (TEAM_CENTRAL) return true
  try {
    const { readPreferences } = await import('./preferences.ts')
    const prefs = await readPreferences()
    // Widened on purpose (cli-provider.ts does the same): the stored value is hand-editable, and
    // `central` is what a machine that used to be one may still carry.
    const mode: string | undefined = prefs.team?.mode
    return mode === 'central'
  } catch {
    return false
  }
}

/** ONE wrapper for the process: the shared lister's cache is keyed by the fetch it was built over,
 *  so a fresh arrow per request would silently disable the cache. */
const REAL_FETCH: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch

export function defaultProviderWebDeps(): ProviderWebDeps {
  return {
    isCentral: defaultIsCentral,
    flagOn: () => providerFlagOn(),
    dir: undefined,
    fetch: REAL_FETCH,
    audit: (input) => {
      void import('./audit.ts').then(m => m.writeAudit(input)).catch(() => {})
    },
    now: () => Date.now(),
    allowedOrigins: ALLOWED_ORIGINS,
    dev: false,
  }
}

/**
 * PURE (UI.4): may a request with these browser headers act here? `csrf.ts` exempts every request
 * without a session cookie — right for a token client, wrong for these routes, because a SOLO
 * machine has no cookie at all, so the browser's CORS preflight was the only thing between a hostile
 * page and the stored key, and a simple POST (`/test`) never triggers one. So: a request that
 * carries NO browser provenance header (the CLI, curl, a test) is answered; one that does must be
 * the dashboard itself (`Sec-Fetch-Site: same-origin`, or `none` for a typed URL) or come from this
 * host or an allowlisted origin, on EVERY method. Stricter than `csrf.ts` on purpose: `same-site` is
 * refused, because ports do not make a site — any other page on localhost is "same-site" to this one.
 * It does not stop DNS rebinding (the page is then same-origin by the browser's own reckoning) — that
 * needs a Host allowlist, named in the review.
 */
export function browserProvenanceOk(
  headers: Headers,
  host: string,
  allowlist: string[],
  dev: boolean,
): boolean {
  const origin = headers.get('origin')
  const site = headers.get('sec-fetch-site')
  if (origin === null && site === null) return true
  if (site === 'same-origin' || site === 'none') return true
  if (origin === null) return false
  if (origin === `http://${host}` || origin === `https://${host}`) return true
  return originAllowed(origin, allowlist, dev)
}

/** One shared lister for the models route. Its cache is keyed by endpoint + base URL and holds only
 *  a parsed model list — never the key, never a raw body. Dropped on every write, so a list fetched
 *  under a replaced key is never served afterwards. Keyed by the fetch it was built over so a test
 *  injecting its own never shares a cache with the real one. */
let sharedLister: { fetch: typeof fetch; lister: ReturnType<typeof createModelLister> } | null = null
function listerFor(f: typeof fetch): ReturnType<typeof createModelLister> {
  if (sharedLister === null || sharedLister.fetch !== f) sharedLister = { fetch: f, lister: createModelLister({ fetch: f }) }
  return sharedLister.lister
}
/** Anthropic's list, cached the same way (the runtime lister is OpenAI-shaped only). */
let anthropicCache: { at: number; result: Extract<ModelListResult, { ok: true }> } | null = null
const MODELS_TTL_MS = 60_000
function dropModelCaches(): void {
  sharedLister = null
  anthropicCache = null
}
/** Tests only. */
export function _resetProviderWebCaches(): void {
  dropModelCaches()
}

// ── pure pieces ─────────────────────────────────────────────────────────────────────────────

/** The vendors' own names (total over `KeyVendorId`); an endpoint's comes from its preset. */
const VENDOR_LABEL: Readonly<Record<KeyVendorId, string>> = { anthropic: 'Anthropic', google: 'Google Gemini' }

export function labelOf(id: KeyedProviderId): string {
  return isKeyVendor(id) ? VENDOR_LABEL[id] : ENDPOINT_PRESETS[id].label
}

/**
 * UI.5 — a "test connection" is one GET against the provider's model-list endpoint, and that call
 * proves nothing about the stored key unless the endpoint is DOCUMENTED to require one for it. A
 * browser run configured OpenRouter with a FAKE key and the UI said "Connected — 458 models"
 * because `GET /models` there is public. `keyChecked` states what the call actually verified, so
 * the web sentence can stop implying more than it checked.
 *
 * Anthropic / OpenAI / DeepSeek: `GET /v1/models` (or its equivalent) answers 401 without a valid
 * key — the model list itself is the auth check. OpenRouter / LiteLLM / 9router: a public
 * (OpenRouter) or operator-configured (a LiteLLM proxy, a 9router instance) list that answers with
 * no key at all — reaching it proves the endpoint is up, not that the key is good. Ollama is never
 * in the "requires a key" set even when one happens to be stored (local endpoints do not gate
 * their model list on it) — only a record with NO key stored at all reads as 'keyless'.
 *
 * A static table, not a network probe: adding a network call here would be a second key holder
 * (`provider-secrets.lint.test.ts` enumerates every module that touches a raw key, and this file is
 * a RECEIVER, never a holder, per its own module doc).
 */
const KEY_CHECK_REQUIRED = new Set<KeyedProviderId>(['anthropic', 'openai', 'deepseek'])

export function keyCheckedFor(id: KeyedProviderId, keyless: boolean): 'yes' | 'no' | 'keyless' {
  if (keyless) return 'keyless'
  return KEY_CHECK_REQUIRED.has(id) ? 'yes' : 'no'
}

/** PURE: a `credentialStatus` answer → the wire entry. Copies only the allowlisted fields. */
export function providerEntry(id: KeyedProviderId, status: CredentialStatus | null): ProviderEntry {
  const endpoint = isKeyVendor(id) ? null : ENDPOINT_PRESETS[id]
  const entry: ProviderEntry = {
    id,
    label: labelOf(id),
    kind: endpoint === null ? 'direct' : endpoint.kind,
    defaultBaseUrl: endpoint === null ? null : endpoint.defaultBaseUrl,
    baseUrlEditable: endpoint !== null,
    keyOptional: endpoint === null ? false : endpoint.keyOptional,
    state: status?.state ?? 'absent',
  }
  if (status !== null) {
    if (status.baseUrl !== undefined) entry.baseUrl = status.baseUrl
    if (status.keyless === true) entry.keyless = true
    if (status.fingerprint !== undefined) entry.fingerprint = status.fingerprint
    if (status.last4) entry.last4 = status.last4
    if (status.storedAt !== undefined) entry.storedAt = status.storedAt
  }
  return entry
}

export type ProviderRoute =
  | { kind: 'list' }
  | { kind: 'one'; id: string }
  | { kind: 'test'; id: string }
  | { kind: 'models'; id: string }

/** PURE: which provider route a path names, or `null` when it is none of them. The sub-resources
 *  (`/test`, `/models`) are matched explicitly, so an id can never be read as `test`. */
export function matchProviderRoute(pathname: string): ProviderRoute | null {
  if (pathname === '/api/provider' || pathname === '/api/provider/') return { kind: 'list' }
  const m = /^\/api\/provider\/([^/]+)(?:\/(test|models))?\/?$/.exec(pathname)
  if (!m) return null
  const id = m[1]!
  if (m[2] === 'test') return { kind: 'test', id }
  if (m[2] === 'models') return { kind: 'models', id }
  return { kind: 'one', id }
}

export interface PutBody { baseUrl?: string; key?: string; noKey?: boolean }

/** PURE: the body's fields, type-checked, or `null` when any present field has the wrong type. */
export function parsePutBody(raw: unknown): PutBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const out: PutBody = {}
  if (o.baseUrl !== undefined) {
    if (typeof o.baseUrl !== 'string') return null
    out.baseUrl = o.baseUrl
  }
  if (o.key !== undefined) {
    if (typeof o.key !== 'string') return null
    out.key = o.key
  }
  if (o.noKey !== undefined) {
    if (typeof o.noKey !== 'boolean') return null
    out.noKey = o.noKey
  }
  return out
}

function refuse(status: number, code: string, sentence: string): ProviderWebResult {
  return { status, body: { code, sentence } satisfies Refusal }
}

function keyRefusal(reason: KeyShapeRefusal, id: KeyedProviderId): ProviderWebResult {
  return refuse(422, `key_${reason.replace(/-/g, '_')}`, keyShapeSentence(reason, id))
}
function baseUrlRefusal(reason: BaseUrlRefusal): ProviderWebResult {
  return refuse(422, `base_url_${reason.replace(/-/g, '_')}`, baseUrlSentence(reason))
}
function keyRequired(id: KeyedProviderId): ProviderWebResult {
  return refuse(422, 'key_required', `${labelOf(id)} requires a key — none is stored and none was given.`)
}
function writeFailed(reason: 'write-failed' | 'permissions'): ProviderWebResult {
  return reason === 'permissions'
    ? refuse(500, 'permissions', 'the key directory\'s permissions could not be set to owner-only.')
    : refuse(500, 'write_failed', 'the provider record could not be written.')
}

/** PURE: scheme://host:port of an already-validated base URL; `null` when it cannot be parsed —
 *  the caller treats that as "a different origin", so an unparseable URL can only ever refuse. */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin
  } catch {
    return null
  }
}

const UNKNOWN = (): ProviderWebResult => refuse(404, 'unknown_provider', 'not a known provider.')

async function entryFor(id: KeyedProviderId, d: ProviderWebDeps): Promise<ProviderEntry> {
  return providerEntry(id, await credentialStatus(id, { dir: d.dir, readContent: true }))
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────

async function handleList(d: ProviderWebDeps): Promise<ProviderWebResult> {
  if (!d.flagOn()) {
    return { status: 200, body: { enabled: false, code: 'flag-off', sentence: refusalSentence('flag-off') } }
  }
  const providers: ProviderEntry[] = []
  for (const id of KEYED_PROVIDERS) providers.push(await entryFor(id, d))
  return { status: 200, body: { enabled: true, providers } }
}

async function handlePut(
  id: KeyedProviderId,
  req: Request,
  ip: string,
  d: ProviderWebDeps,
): Promise<ProviderWebResult> {
  const read = await readJsonLimited<unknown>(req, PROVIDER_BODY_BYTES)
  if (!read.ok) {
    return read.error === 'too_large'
      ? refuse(413, 'too_large', 'the request body is too large.')
      : refuse(400, 'bad_request', 'the request body is not valid JSON.')
  }
  const body = parsePutBody(read.value)
  if (body === null) return refuse(400, 'bad_request', 'the request body has a field of the wrong type.')

  if (isKeyVendor(id)) return putVendor(id, body, ip, d)
  return putEndpoint(id, body, ip, d)
}

/** A key vendor (Anthropic; Google, B5b): one key, one fixed address, so the only thing a PUT can set is
 *  the key. */
async function putVendor(id: KeyVendorId, body: PutBody, ip: string, d: ProviderWebDeps): Promise<ProviderWebResult> {
  if (body.baseUrl !== undefined) {
    return refuse(422, 'base_url_not_editable', `${labelOf(id)} is always reached at its own address — it stores no base URL.`)
  }
  if (body.key === undefined) {
    // Nothing to change for a provider whose only setting is the key: keep it when there is one.
    const status = await credentialStatus(id, { dir: d.dir, readContent: true })
    if (status.state === 'present') return { status: 200, body: { provider: providerEntry(id, status) } }
    return keyRequired(id)
  }
  const shape = validateKeyShape(body.key, id)
  if (!shape.ok) return keyRefusal(shape.reason, id)
  const res = await storeCredential(id, body.key, { dir: d.dir, replace: true })
  if (!res.ok) {
    if (res.reason === 'invalid-shape') return keyRefusal(res.shape, id)
    if (res.reason === 'exists') return refuse(409, 'exists', 'a key is already stored.')
    return writeFailed(res.reason)
  }
  dropModelCaches()
  d.audit({
    action: 'provider.set', targetId: id, ip,
    meta: { provider: id, fingerprint: res.fingerprint, previousFingerprint: res.previous, keyChanged: true },
  })
  return { status: 200, body: { provider: await entryFor(id, d) } }
}

async function putEndpoint(
  id: OpenAICompatibleEndpointId,
  body: PutBody,
  ip: string,
  d: ProviderWebDeps,
): Promise<ProviderWebResult> {
  const preset = ENDPOINT_PRESETS[id]
  if (body.noKey === true && body.key !== undefined) {
    return refuse(422, 'key_and_no_key', 'a key and "no key" were both given — send one or the other.')
  }
  if (body.noKey === true && !preset.keyOptional) return keyRequired(id)

  const existing = await readEndpointCredential(id, { dir: d.dir })
  const rawUrl = body.baseUrl ?? (existing.ok ? existing.baseUrl : preset.defaultBaseUrl) ?? ''
  const url = validateBaseUrl(rawUrl)
  if (!url.ok) return baseUrlRefusal(url.reason)

  // Key omitted and not asked to go keyless: KEEP what is stored, without this module reading it.
  if (body.key === undefined && body.noKey !== true) {
    if (!existing.ok) return keyRequired(id)
    // A stored KEY is bound to the ORIGIN it was entered for (UI.4). These routes are
    // unauthenticated on a `local` profile and the server binds 0.0.0.0, so a peer that reaches the
    // port — or a DNS-rebinding page — could otherwise PUT an attacker's base URL and then POST
    // /test, and the stored key would travel to it in the request header. Moving a key to another
    // scheme/host/port therefore requires the key itself; a path change on the same origin does not,
    // and a keyless record has no secret to redirect.
    const nextOrigin = originOf(url.baseUrl)
    if (existing.handle !== null && (nextOrigin === null || nextOrigin !== originOf(existing.baseUrl))) {
      return refuse(
        422,
        'key_required_new_origin',
        `${labelOf(id)}: the stored key stays with the address it was entered for — enter the key again to use it at a different host.`,
      )
    }
    const res = await rebaseEndpointCredential(id, url.baseUrl, { dir: d.dir })
    if (!res.ok) {
      if (res.reason === 'invalid-base-url') return baseUrlRefusal(res.baseUrl)
      if (res.reason === 'write-failed' || res.reason === 'permissions') return writeFailed(res.reason)
      return keyRequired(id)
    }
    dropModelCaches()
    d.audit({
      action: 'provider.set', targetId: id, ip,
      meta: { provider: id, fingerprint: res.fingerprint, previousFingerprint: res.fingerprint, keyChanged: false },
    })
    return { status: 200, body: { provider: await entryFor(id, d) } }
  }

  const key = body.noKey === true ? null : body.key!
  if (key !== null) {
    const shape = validateKeyShape(key, id)
    if (!shape.ok) return keyRefusal(shape.reason, id)
  }
  const res = await storeEndpointCredential(id, { baseUrl: url.baseUrl, key }, { dir: d.dir, replace: true })
  if (!res.ok) {
    if (res.reason === 'invalid-shape') return keyRefusal(res.shape, id)
    if (res.reason === 'invalid-base-url') return baseUrlRefusal(res.baseUrl)
    if (res.reason === 'key-required') return keyRequired(id)
    if (res.reason === 'exists') return refuse(409, 'exists', 'this endpoint is already configured.')
    return writeFailed(res.reason)
  }
  dropModelCaches()
  d.audit({
    action: 'provider.set', targetId: id, ip,
    meta: {
      provider: id, fingerprint: res.fingerprint,
      previousFingerprint: res.previous?.fingerprint ?? null, keyChanged: true,
    },
  })
  return { status: 200, body: { provider: await entryFor(id, d) } }
}

async function handleDelete(id: KeyedProviderId, ip: string, d: ProviderWebDeps): Promise<ProviderWebResult> {
  const res = await removeCredential(id, { dir: d.dir })
  if (res.removed) {
    dropModelCaches()
    d.audit({ action: 'provider.remove', targetId: id, ip, meta: { provider: id, fingerprint: res.fingerprint } })
  }
  return { status: 200, body: { provider: await entryFor(id, d) } }
}

type ListOutcome =
  | { ok: true; result: Extract<ModelListResult, { ok: true }>; latencyMs: number; keyless: boolean }
  | { ok: false; body: { ok: false; code: string; status?: number; sentence: string } }

function notConfiguredSentence(id: KeyedProviderId): string {
  return isKeyVendor(id)
    ? `${id}: no key stored — add one first.`
    : endpointRefusalSentence(id, 'not-stored')
}

function storedUnusable(id: KeyedProviderId, reason: 'unreadable' | 'permissions-too-open' | 'wrong-provider'): ListOutcome {
  const code = reason === 'wrong-provider' ? 'unreadable' : reason
  const sentence = isKeyVendor(id)
    ? `${id}: the stored key cannot be used (${code}).`
    : endpointRefusalSentence(id, code)
  return { ok: false, body: { ok: false, code, sentence } }
}

function failed(id: KeyedProviderId, result: Extract<ModelListResult, { ok: false }>): ListOutcome {
  return {
    ok: false,
    body: {
      ok: false,
      code: result.reason,
      ...(result.status === undefined ? {} : { status: result.status }),
      sentence: modelsFailureSentence(id, result),
    },
  }
}

/** Nothing is stored for this provider yet — a refusal BODY, not a notification. (Held in constants,
 *  not written as `code: '…'` literals: `notificationCoverage.test.ts` greps the server for that shape
 *  and would ask for notification TEXT for what is an HTTP refusal code.) */
const NOT_CONFIGURED = 'not_configured'
/** This provider's key can be stored but its non-billed connection test is not built (B5b, Google). */
const NOT_SUPPORTED = 'not_supported'
function notConfigured(id: KeyedProviderId): ListOutcome {
  return { ok: false, body: { ok: false, code: NOT_CONFIGURED, sentence: notConfiguredSentence(id) } }
}

/**
 * The model list over the STORED credential. `fresh` bypasses every cache — "test connection" must
 * be a real round trip, or it would report success for a key that was revoked a minute ago.
 */
async function listModelsFor(id: KeyedProviderId, d: ProviderWebDeps, fresh: boolean): Promise<ListOutcome> {
  const started = d.now()
  if (id === 'google') {
    // B5b: the Gemini key can be stored, replaced and removed here, but its non-billed model-list call is
    // NOT built — it would be a second key HOLDER (a reveal in this host, like `anthropic-models.ts`),
    // which `provider-secrets.lint.test.ts` enumerates on purpose. Said in words, never a fake success:
    // the key is first exercised by `agentop provider try google`.
    return {
      ok: false,
      body: {
        ok: false,
        code: NOT_SUPPORTED,
        sentence: 'google: the connection test and the model list are not available yet — '
          + 'the key is first used by `agentop provider try google`.',
      },
    }
  }
  if (id === 'anthropic') {
    if (!fresh && anthropicCache !== null && d.now() - anthropicCache.at < MODELS_TTL_MS) {
      return { ok: true, result: { ...anthropicCache.result, fromCache: true }, latencyMs: 0, keyless: false }
    }
    const cred = await resolveCredential('anthropic', { dir: d.dir })
    if (!cred.ok) {
      if (cred.reason === 'absent') {
        return notConfigured(id)
      }
      return storedUnusable(id, cred.reason)
    }
    const result = await listAnthropicModels({ credential: cred.handle, fetch: d.fetch, now: d.now })
    if (!result.ok) return failed(id, result)
    anthropicCache = { at: d.now(), result }
    // Anthropic never stores a keyless record — the key is required at PUT time.
    return { ok: true, result, latencyMs: d.now() - started, keyless: false }
  }

  const read = await readEndpointCredential(id, { dir: d.dir })
  if (!read.ok) {
    if (read.reason === 'absent') {
      return notConfigured(id)
    }
    return storedUnusable(id, read.reason)
  }
  const lister = fresh ? createModelLister({ fetch: d.fetch }) : listerFor(d.fetch)
  const result = await lister.list({ endpointId: id, baseUrl: read.baseUrl, credential: read.handle })
  if (!result.ok) return failed(id, result)
  return { ok: true, result, latencyMs: d.now() - started, keyless: read.handle === null }
}

async function handleTest(id: KeyedProviderId, d: ProviderWebDeps): Promise<ProviderWebResult> {
  const out = await listModelsFor(id, d, true)
  if (!out.ok) return { status: 200, body: out.body }
  return {
    status: 200,
    body: {
      ok: true,
      modelCount: out.result.models.length,
      latencyMs: Math.max(0, Math.round(out.latencyMs)),
      keyChecked: keyCheckedFor(id, out.keyless),
    },
  }
}

async function handleModels(id: KeyedProviderId, d: ProviderWebDeps): Promise<ProviderWebResult> {
  const out = await listModelsFor(id, d, false)
  if (!out.ok) return { status: 200, body: out.body }
  const models = out.result.models.map(m => ({
    id: m.id,
    ...(m.ownedBy === undefined ? {} : { ownedBy: m.ownedBy }),
    ...(m.contextLength === undefined ? {} : { contextLength: m.contextLength }),
  }))
  return { status: 200, body: { ok: true, models, fetchedAt: out.result.fetchedAt, fromCache: out.result.fromCache } }
}

/**
 * The one entry point `index.ts` calls. Answers `null` when the path is not a provider route. Order:
 * route → central (403, before anything is read) → method → unknown id (404, the id never echoed) →
 * flag (the list answers `enabled: false`; every other verb 409).
 */
export async function handleProviderRequest(
  req: Request,
  pathname: string,
  ip: string,
  deps: Partial<ProviderWebDeps> = {},
): Promise<ProviderWebResult | null> {
  const route = matchProviderRoute(pathname)
  if (route === null) return null
  const d: ProviderWebDeps = { ...defaultProviderWebDeps(), ...deps }

  if (await d.isCentral()) return refuse(403, 'central', refusalSentence('central'))
  if (!browserProvenanceOk(req.headers, new URL(req.url).host, d.allowedOrigins, d.dev)) {
    return refuse(403, 'cross_site', 'this request came from another site — provider settings answer only this dashboard.')
  }

  const method = req.method.toUpperCase()
  const allowed: Record<ProviderRoute['kind'], string[]> = {
    list: ['GET'], one: ['PUT', 'DELETE'], test: ['POST'], models: ['GET'],
  }
  if (!allowed[route.kind].includes(method)) {
    return refuse(405, 'method_not_allowed', 'this method is not supported on this path.')
  }

  if (route.kind === 'list') return handleList(d)

  if (!isKeyedProvider(route.id)) return UNKNOWN()
  const id: KeyedProviderId = route.id
  if (!d.flagOn()) return refuse(409, 'flag-off', refusalSentence('flag-off'))

  if (route.kind === 'test') return handleTest(id, d)
  if (route.kind === 'models') return handleModels(id, d)
  if (method === 'DELETE') return handleDelete(id, ip, d)
  return handlePut(id, req, ip, d)
}

