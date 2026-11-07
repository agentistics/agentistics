/**
 * opencode-auth.ts — the credentials OpenCode keeps in `auth.json`, and the ONE place this product
 * writes them.
 *
 * OpenCode has no `auth status --json` and no account object: a connection is a top-level key of
 * `<data dir>/auth.json` named after the PROVIDER (`opencode-go`, `opencode`, `anthropic`, …) whose
 * value is `{ type: 'api', key }` (or an OAuth record `opencode auth login` wrote for another
 * provider). WHICH key a subscription belongs under is the whole trap: `opencode auth login` files
 * the OpenCode Go key under `opencode` (the pay-as-you-go Zen provider), and the Go models only
 * exist under `opencode-go` — so a perfectly valid key listed nothing but the free models.
 *
 * SECRETS: the key arrives from a paste field, goes straight into the file and nowhere else. It is
 * never logged, never returned, never copied to a backup, and `listConnected` carries ids only. The
 * file is written 0600 through a temp file + rename in the same directory, so a reader (opencode
 * itself) sees the old file or the new one, never half of one.
 *
 * Everything but `writeAuth`/`readAuth` is PURE.
 */

import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { HOME_DIR } from './config'
import { opencodePaths } from './opencode-paths'

export interface OpencodeProvider {
  id: string
  label: string
  /** Where the person creates the key. */
  url: string
  /** `go` / `zen` are OpenCode's own two products; `byo` is a provider's own key. */
  kind: 'go' | 'zen' | 'byo'
}

/** The providers worth naming first. The rest come from OpenCode's own catalog (`catalogProviders`). */
export const OPENCODE_PROVIDERS: readonly OpencodeProvider[] = [
  { id: 'opencode-go', label: 'OpenCode Go', url: 'https://opencode.ai/console', kind: 'go' },
  { id: 'opencode', label: 'OpenCode Zen', url: 'https://opencode.ai/console', kind: 'zen' },
  { id: 'anthropic', label: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', kind: 'byo' },
  { id: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', kind: 'byo' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/keys', kind: 'byo' },
  { id: 'google', label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey', kind: 'byo' },
]

export type AuthDoc = Record<string, unknown>

/** A provider id as OpenCode names it: lowercase tokens, never a path or a prototype key. */
export function isProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype'
}

export type KeyCheck = { ok: true; key: string } | { ok: false; reason: 'empty' | 'whitespace' | 'too_long' | 'control' }

/** One token: pasting from a console tends to carry a newline or a stray space. Trimmed, never repaired inside. */
export function checkKey(raw: unknown): KeyCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const key = raw.trim()
  if (!key) return { ok: false, reason: 'empty' }
  if (key.length > 1024) return { ok: false, reason: 'too_long' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return { ok: false, reason: 'control' }
  if (/\s/.test(key)) return { ok: false, reason: 'whitespace' }
  return { ok: true, key }
}

/** The parsed document, or `{}` for a missing/garbled one (a file we cannot read is replaced only by an explicit write). */
export function parseAuth(text: string | null): AuthDoc {
  if (text === null) return {}
  try {
    const doc: unknown = JSON.parse(text)
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? { ...(doc as AuthDoc) } : {}
  } catch { return {} }
}

/** The document with `provider` set to an API key. Every other entry (including OAuth records) is kept as it was. */
export function withKey(doc: AuthDoc, provider: string, key: string): AuthDoc {
  return { ...doc, [provider]: { type: 'api', key } }
}

export function withoutProvider(doc: AuthDoc, provider: string): AuthDoc {
  const next = { ...doc }
  delete next[provider]
  return next
}

export interface ConnectedProvider { id: string; label: string; type: string }

/** Which providers hold a credential — ids and the credential's TYPE only, never a value. */
export function listConnected(doc: AuthDoc, labels: ReadonlyMap<string, string> = new Map()): ConnectedProvider[] {
  const known = new Map(OPENCODE_PROVIDERS.map(p => [p.id, p.label]))
  return Object.entries(doc).flatMap(([id, v]) => {
    if (!isProviderId(id) || !v || typeof v !== 'object') return []
    const type = typeof (v as { type?: unknown }).type === 'string' ? (v as { type: string }).type : 'api'
    return [{ id, label: known.get(id) ?? labels.get(id) ?? id, type }]
  })
}

/** The key under `provider`, for a probe. Never exposed past this module's callers. */
export function keyOf(doc: AuthDoc, provider: string): string | null {
  const v = doc[provider]
  const key = v && typeof v === 'object' ? (v as { key?: unknown }).key : undefined
  return typeof key === 'string' && key ? key : null
}

/** The catalog's key-based providers (`~/.cache/opencode/models.json`), as picker entries after the curated ones. */
export function catalogProviders(json: string | null): OpencodeProvider[] {
  if (json === null) return []
  let doc: unknown
  try { doc = JSON.parse(json) } catch { return [] }
  if (!doc || typeof doc !== 'object') return []
  const curated = new Set(OPENCODE_PROVIDERS.map(p => p.id))
  return Object.entries(doc as Record<string, unknown>).flatMap(([id, v]) => {
    if (curated.has(id) || !isProviderId(id) || !v || typeof v !== 'object') return []
    const p = v as { name?: unknown; doc?: unknown; env?: unknown }
    if (!Array.isArray(p.env) || p.env.length === 0) return []
    const url = typeof p.doc === 'string' && /^https:\/\//.test(p.doc) ? p.doc : 'https://opencode.ai/docs/providers/'
    return [{ id, label: typeof p.name === 'string' && p.name ? p.name : id, url, kind: 'byo' as const }]
  }).sort((a, b) => a.label.localeCompare(b.label))
}

// ── IO ──────────────────────────────────────────────────────────────────────────────────────────

/** Data directories OpenCode may use, default first. macOS is a fallback only when the default is absent. */
export function authDirCandidates(env: Readonly<Record<string, string | undefined>>, home: string, platform: string = process.platform): string[] {
  const main = opencodePaths(env, home).dir
  return platform === 'darwin' ? [main, join(home, 'Library', 'Application Support', 'opencode')] : [main]
}

/** The directory whose `auth.json` exists, else the default one (where a first key is written). */
export function authDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = HOME_DIR, platform: string = process.platform): string {
  const list = authDirCandidates(env, home, platform)
  return list.find(d => existsSync(join(d, 'auth.json'))) ?? list[0]!
}

export async function readAuth(dir: string = authDir()): Promise<AuthDoc> {
  try { return parseAuth(await readFile(join(dir, 'auth.json'), 'utf8')) } catch { return {} }
}

/** Atomic and private: temp file (0600) beside the target, fsync, rename. */
export async function writeAuth(doc: AuthDoc, dir: string = authDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, 'auth.json')
  const tmp = join(dir, `.auth.json.${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(JSON.stringify(doc, null, 2) + '\n')
    await fh.sync()
  } finally { await fh.close() }
  try {
    await chmod(tmp, 0o600)
    await rename(tmp, target)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

export type SaveOutcome =
  | { ok: true; savedAs: string; movedFrom?: string }
  | { ok: false; reason: 'bad_provider' | 'empty' | 'whitespace' | 'too_long' | 'control' }

/** Which endpoint a key is a Go key for: the authoritative way to tell Go from Zen, since both are opaque. */
export const GO_PROBE_URL = 'https://opencode.ai/inference/go/openai/v1/models'

export type Probe = (key: string) => Promise<boolean | null>

/** `true`: the Go endpoint accepted it. `false`: it refused. `null`: could not tell (offline) — never treated as "no". */
export const probeGoKey: Probe = async key => {
  try {
    const res = await fetch(GO_PROBE_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) })
    if (res.ok) return true
    return res.status === 401 || res.status === 403 ? false : null
  } catch { return null }
}

/**
 * Save a pasted key. A key pasted for Zen that the Go endpoint accepts is a GO key filed under the
 * wrong name (the very mistake `opencode auth login` makes), so it is filed under `opencode-go`;
 * when the probe cannot tell, the person's choice stands.
 */
export async function saveKey(provider: unknown, rawKey: unknown, deps: { dir?: string; probe?: Probe } = {}): Promise<SaveOutcome> {
  if (!isProviderId(provider)) return { ok: false, reason: 'bad_provider' }
  const checked = checkKey(rawKey)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const dir = deps.dir ?? authDir()
  let target = provider
  if (provider === 'opencode' && (await (deps.probe ?? probeGoKey)(checked.key)) === true) target = 'opencode-go'
  await writeAuth(withKey(await readAuth(dir), target, checked.key), dir)
  return target === provider ? { ok: true, savedAs: target } : { ok: true, savedAs: target, movedFrom: provider }
}

export async function removeKey(provider: unknown, dir: string = authDir()): Promise<boolean> {
  if (!isProviderId(provider)) return false
  const doc = await readAuth(dir)
  if (!(provider in doc)) return false
  await writeAuth(withoutProvider(doc, provider), dir)
  return true
}

/**
 * The repair for a Go key already sitting under `opencode`: moves it to `opencode-go` when the Go
 * endpoint accepts it and `opencode-go` holds nothing. Returns whether anything moved.
 */
export async function fixMisfiledGoKey(deps: { dir?: string; probe?: Probe } = {}): Promise<boolean> {
  const dir = deps.dir ?? authDir()
  const doc = await readAuth(dir)
  const key = keyOf(doc, 'opencode')
  if (!key || keyOf(doc, 'opencode-go')) return false
  if ((await (deps.probe ?? probeGoKey)(key)) !== true) return false
  await writeAuth(withKey(withoutProvider(doc, 'opencode'), 'opencode-go', key), dir)
  return true
}
