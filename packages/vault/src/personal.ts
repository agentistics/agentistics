/**
 * personal.ts — VAULT.PERSONAL: the user's OWN secrets in the human scope. PURE (ids, shapes,
 * validation, file names, the `.env` parser, version retention). The IO is the service's
 * (packages/server/server/vault/personal.ts); the design is the engine repo's spec
 * `2026-10-03-vault-personal.md`, sync-ready against Cloud decision C36:
 *
 *  - opaque ids — a disk, a backup or a future Cloud sees ids, sizes, version counters and times, never a name;
 *  - metadata and value are SEPARATE sealed records, so listing never decrypts a value;
 *  - versions are append-only with a counter (`expectedVersion` = the compare-and-set C36 asks for).
 */
import { randomBytes } from 'node:crypto'

export const PERSONAL_PURPOSE = 'vault/personal' as const
export const PERSONAL_DIR = 'personal'
/** Owner decision: the newest 10 versions of each secret are kept. */
export const PERSONAL_KEEP_VERSIONS = 10
/** Owner decision: the trash keeps an item for 30 days. */
export const PERSONAL_TRASH_MS = 30 * 24 * 60 * 60_000

export type PersonalKind = 'password' | 'login' | 'api-key' | 'env' | 'note'
export const PERSONAL_KINDS: readonly PersonalKind[] = ['password', 'login', 'api-key', 'env', 'note']

/** Which value fields each kind carries, in display order. */
export const KIND_FIELDS: Readonly<Record<PersonalKind, readonly string[]>> = {
  password: ['password'],
  login: ['login', 'password'],
  'api-key': ['value'],
  env: ['value'],
  note: ['value'],
}

export interface PersonalMeta {
  v: 1
  id: string
  kind: PersonalKind
  name: string
  groupId: string | null
  tags: string[]
  notes: string
  url: string
  fields: string[]
  createdAt: string
  updatedAt: string
  version: number
  deletedAt: string | null
  /**
   * "Sempre confirmar" (owner, 2026-10-04): ask Windows Hello / the phone's biometrics on EVERY reveal and
   * every send to a session, even with the vault open. ABSENT READS AS ON — every existing secret has it
   * and every new one starts with it; only an explicit `false` goes without the prompt (and writing that
   * `false` is itself an edit, which asks the gesture).
   */
  confirmEach?: boolean
}
/** One reading of the flag, so "absent" can never be interpreted two ways. */
export const needsConfirm = (m: Pick<PersonalMeta, 'confirmEach'>): boolean => m.confirmEach !== false
export interface PersonalValue { v: 1; fields: Record<string, string> }
export interface PersonalGroup { v: 1; id: string; name: string; createdAt: string; updatedAt: string; version: number }

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function b32(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = ''
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}
export function newPersonalId(prefix: 'it' | 'gr'): string { return `${prefix}_${b32(new Uint8Array(randomBytes(20)))}` }
export const ITEM_ID = /^it_[a-z2-7]{32}$/
export const GROUP_ID = /^gr_[a-z2-7]{32}$/

/** `v000007` — zero-padded so a directory listing sorts in version order. */
export function versionTag(n: number): string { return `v${String(n).padStart(6, '0')}` }
export function parseVersionFile(file: string): { version: number; part: 'meta' | 'value' } | null {
  const m = /^v(\d{6})\.(meta|value)\.sealed$/.exec(file)
  return m ? { version: Number(m[1]), part: m[2] as 'meta' | 'value' } : null
}
/** The sealed NAME of one record — binds the file to its id, version and part (a swapped file fails to open). */
export function recordName(id: string, version: number, part: 'meta' | 'value'): string { return `${id}/${versionTag(version)}/${part}` }

/** Of the versions on disk, which to delete so the newest `keep` remain. */
export function versionsToPrune(versions: readonly number[], keep = PERSONAL_KEEP_VERSIONS): number[] {
  const s = [...new Set(versions)].sort((a, b) => b - a)
  return s.slice(keep).sort((a, b) => a - b)
}

/** Has a trashed item outlived the trash? */
export function trashExpired(deletedAt: string | null, nowMs: number, ttlMs = PERSONAL_TRASH_MS): boolean {
  if (!deletedAt) return false
  const t = Date.parse(deletedAt)
  return Number.isFinite(t) && nowMs - t >= ttlMs
}

// ── validation of what a page sends ───────────────────────────────────────────────────────────

export const LIMITS = { name: 120, notes: 4000, tag: 40, tags: 20, url: 500, field: 64 * 1024 } as const

export interface PersonalInput {
  kind: PersonalKind
  name: string
  groupId?: string | null
  tags?: string[]
  notes?: string
  url?: string
  fields?: Record<string, string>
  confirmEach?: boolean
}

export type Invalid = { ok: false; field: string; reason: 'required' | 'too-long' | 'bad-kind' | 'bad-field' | 'bad-group' | 'too-many' }

/** Total and strict: anything not exactly the shape is refused with the field it stopped at. */
export function validateInput(x: unknown, opts: { requireFields: boolean }): { ok: true; value: PersonalInput } | Invalid {
  if (!x || typeof x !== 'object') return { ok: false, field: 'body', reason: 'required' }
  const o = x as Record<string, unknown>
  if (typeof o.kind !== 'string' || !(PERSONAL_KINDS as readonly string[]).includes(o.kind)) return { ok: false, field: 'kind', reason: 'bad-kind' }
  const kind = o.kind as PersonalKind
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return { ok: false, field: 'name', reason: 'required' }
  if (name.length > LIMITS.name) return { ok: false, field: 'name', reason: 'too-long' }
  let groupId: string | null = null
  if (o.groupId !== undefined && o.groupId !== null) {
    if (typeof o.groupId !== 'string' || !GROUP_ID.test(o.groupId)) return { ok: false, field: 'groupId', reason: 'bad-group' }
    groupId = o.groupId
  }
  const tags: string[] = []
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) return { ok: false, field: 'tags', reason: 'bad-field' }
    for (const t of o.tags) {
      if (typeof t !== 'string') return { ok: false, field: 'tags', reason: 'bad-field' }
      const s = t.trim()
      if (!s) continue
      if (s.length > LIMITS.tag) return { ok: false, field: 'tags', reason: 'too-long' }
      if (!tags.includes(s)) tags.push(s)
    }
    if (tags.length > LIMITS.tags) return { ok: false, field: 'tags', reason: 'too-many' }
  }
  const notes = typeof o.notes === 'string' ? o.notes : ''
  if (notes.length > LIMITS.notes) return { ok: false, field: 'notes', reason: 'too-long' }
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  if (url.length > LIMITS.url) return { ok: false, field: 'url', reason: 'too-long' }
  let fields: Record<string, string> | undefined
  if (o.fields !== undefined) {
    if (!o.fields || typeof o.fields !== 'object') return { ok: false, field: 'fields', reason: 'bad-field' }
    fields = {}
    for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
      if (!KIND_FIELDS[kind].includes(k)) return { ok: false, field: `fields.${k}`, reason: 'bad-field' }
      if (typeof v !== 'string') return { ok: false, field: `fields.${k}`, reason: 'bad-field' }
      if (v.length > LIMITS.field) return { ok: false, field: `fields.${k}`, reason: 'too-long' }
      fields[k] = v
    }
  }
  if (opts.requireFields) {
    const f = fields ?? {}
    const main = kind === 'login' ? ['password'] : KIND_FIELDS[kind]
    for (const k of main) if (!f[k]) return { ok: false, field: `fields.${k}`, reason: 'required' }
  }
  if (o.confirmEach !== undefined && typeof o.confirmEach !== 'boolean') return { ok: false, field: 'confirmEach', reason: 'bad-field' }
  return { ok: true, value: { kind, name, groupId, tags, notes, url, ...(fields ? { fields } : {}), ...(typeof o.confirmEach === 'boolean' ? { confirmEach: o.confirmEach } : {}) } }
}

export function validGroupName(x: unknown): string | null {
  if (typeof x !== 'string') return null
  const s = x.trim()
  return s && s.length <= LIMITS.name ? s : null
}

// ── the `.env` parser ─────────────────────────────────────────────────────────────────────────

/**
 * A `.env` file → ordered KEY/value pairs. Handles comments (whole-line and ` #` after an unquoted
 * value), an `export ` prefix, single quotes (literal), double quotes (with `\n \r \t \" \\` escapes)
 * and multi-line double- or single-quoted values. A line that is not `KEY=…` is skipped and counted.
 * A key that repeats keeps its LAST value (what a shell would do) and is reported once.
 */
export function parseDotEnv(text: string): { pairs: { key: string; value: string }[]; skipped: number } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const out = new Map<string, string>()
  let skipped = 0
  let i = 0
  const n = src.length
  while (i < n) {
    // one logical line
    let lineEnd = src.indexOf('\n', i)
    if (lineEnd === -1) lineEnd = n
    const raw = src.slice(i, lineEnd)
    const t = raw.trim()
    if (t === '' || t.startsWith('#')) { i = lineEnd + 1; continue }
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*/.exec(raw)
    if (!m) { skipped++; i = lineEnd + 1; continue }
    const key = m[1]!
    let j = i + m[0].length
    let value = ''
    const q = src[j]
    if (q === '"' || q === "'") {
      j++
      let buf = ''
      let closed = false
      while (j < n) {
        const c = src[j]!
        if (q === '"' && c === '\\' && j + 1 < n) {
          const e = src[j + 1]!
          buf += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e
          j += 2; continue
        }
        if (c === q) { closed = true; j++; break }
        buf += c; j++
      }
      if (!closed) { skipped++; i = lineEnd + 1; continue }
      value = buf
      const rest = src.indexOf('\n', j)
      i = rest === -1 ? n : rest + 1
    } else {
      let v = src.slice(j, lineEnd)
      const hash = v.search(/\s#/)
      if (hash !== -1) v = v.slice(0, hash)
      value = v.trim()
      i = lineEnd + 1
    }
    out.delete(key)
    out.set(key, value)
  }
  return { pairs: [...out].map(([key, value]) => ({ key, value })), skipped }
}

// ── reveal: what the gesture/code policy asks (spec §3) ──────────────────────────────────────

/**
 * Reveal asks the gesture every time; the code too when the unlock policy is `always`; with no presence,
 * the code alone, fresh. With NEITHER there is nothing to ask, and a reveal that asks nothing is refused
 * (`blocked`) — the page sends the person to set up the authenticator first.
 */
export function revealAsks(o: { hasPresence: boolean; hasAuthenticator: boolean; unlockMode: 'always' | 'hello-only' | 'daily' }): { code: boolean; gesture: boolean; blocked: boolean } {
  if (!o.hasPresence) return { code: o.hasAuthenticator, gesture: false, blocked: !o.hasAuthenticator }
  return { code: o.hasAuthenticator && o.unlockMode === 'always', gesture: true, blocked: false }
}
