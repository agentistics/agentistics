/**
 * vault/personal.ts — VAULT.PERSONAL's store, in the SERVICE (spec `2026-10-03-vault-personal.md`).
 *
 * Every record is sealed in the human scope under the one purpose `vault/personal`, with a NAME that
 * binds it to its id, version and part (`<id>/v000003/meta`). Metadata and value are separate files:
 * `list` opens only metadata; a value is opened by `revealField` (the one function whose result a route
 * may return) and, to carry a value forward into a new version, by the writers — never returned.
 *
 * Writes are append-only: version N+1 is written VALUE first, META second (a version exists once its
 * meta does), then the versions past the newest 10 are deleted. Every write carries the version it was
 * based on (`expectedVersion`) and is refused as `conflict` when the item has moved on — the
 * compare-and-set Cloud decision C36 enforces. NO gate lives here: gate.ts decides who may call what.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GROUP_ID, ITEM_ID, KIND_FIELDS, PERSONAL_DIR, PERSONAL_PURPOSE, isUseOnly, newPersonalId, parseImportText, parseVersionFile, recordName,
  trashExpired, versionTag, versionsToPrune,
  type PersonalGroup, type PersonalInput, type PersonalMeta, type PersonalValue,
} from '@agentistics/vault'
import { openFromFile, sealToFile, vaultDir } from './service'

let _now: () => number = () => Date.now()
const iso = () => new Date(_now()).toISOString()
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

export type StoreFail = { ok: false; code: 'not-found' | 'version-conflict' | 'locked' | 'record-unreadable' | 'clash' | 'no-import' | 'import-format'; version?: number; reason?: string }
export function personalRoot(): string { return join(vaultDir(), PERSONAL_DIR) }
const itemDir = (id: string) => join(personalRoot(), 'items', id)
const groupDir = (id: string) => join(personalRoot(), 'groups', id)
const file = (dir: string, v: number, part: 'meta' | 'value') => join(dir, `${versionTag(v)}.${part}.sealed`)

async function versionsIn(dir: string): Promise<number[]> {
  let names: string[] = []
  try { names = await readdir(dir) } catch { return [] }
  return [...new Set(names.map(parseVersionFile).filter(x => x?.part === 'meta').map(x => x!.version))].sort((a, b) => a - b)
}
async function idsIn(sub: 'items' | 'groups'): Promise<string[]> {
  try { return (await readdir(join(personalRoot(), sub))).filter(n => (sub === 'items' ? ITEM_ID : GROUP_ID).test(n)).sort() } catch { return [] }
}

async function openJson<T>(path: string, id: string, v: number, part: 'meta' | 'value'): Promise<T | null> {
  const r = await openFromFile(path, PERSONAL_PURPOSE, recordName(id, v, part))
  if (!r.ok) return null
  try { return JSON.parse(new TextDecoder().decode(r.plaintext)) as T } finally { r.plaintext.fill(0) }
}

async function readMeta(id: string, v: number): Promise<PersonalMeta | null> {
  const m = await openJson<PersonalMeta>(file(itemDir(id), v, 'meta'), id, v, 'meta')
  return m && m.id === id && m.version === v ? m : null
}
async function readValue(id: string, v: number): Promise<PersonalValue | null> {
  return openJson<PersonalValue>(file(itemDir(id), v, 'value'), id, v, 'value')
}
export async function latestMeta(id: string): Promise<PersonalMeta | null> {
  const vs = await versionsIn(itemDir(id))
  for (let i = vs.length - 1; i >= 0; i--) { const m = await readMeta(id, vs[i]!); if (m) return m }
  return null
}

async function writeVersion(meta: PersonalMeta, value: PersonalValue): Promise<void> {
  const dir = itemDir(meta.id)
  const bytes = enc(value)
  try { await sealToFile(file(dir, meta.version, 'value'), PERSONAL_PURPOSE, recordName(meta.id, meta.version, 'value'), bytes) } finally { bytes.fill(0) }
  await sealToFile(file(dir, meta.version, 'meta'), PERSONAL_PURPOSE, recordName(meta.id, meta.version, 'meta'), enc(meta))
  for (const v of versionsToPrune(await versionsIn(dir))) {
    await rm(file(dir, v, 'meta'), { force: true })
    await rm(file(dir, v, 'value'), { force: true })
  }
}

/** Every item's newest metadata — no value is opened. Expired trash is purged on the way. */
export async function listItems(): Promise<PersonalMeta[]> {
  const out: PersonalMeta[] = []
  for (const id of await idsIn('items')) {
    const m = await latestMeta(id)
    if (!m) continue
    if (trashExpired(m.deletedAt, _now())) { await rm(itemDir(id), { recursive: true, force: true }); continue }
    out.push(m)
  }
  return out
}

/** The metadata of every version kept (newest first) — for "restore a version". No value. */
export async function listVersions(id: string): Promise<PersonalMeta[] | StoreFail> {
  if (!ITEM_ID.test(id)) return { ok: false, code: 'not-found' }
  const vs = await versionsIn(itemDir(id))
  if (vs.length === 0) return { ok: false, code: 'not-found' }
  const out: PersonalMeta[] = []
  for (const v of vs.reverse()) { const m = await readMeta(id, v); if (m) out.push(m) }
  return out
}

function metaFrom(input: PersonalInput, base: { id: string; version: number; createdAt: string; confirmEach?: boolean; useOnly?: boolean }, fields: string[], deletedAt: string | null = null): PersonalMeta {
  // "Só uso" is one-way: a record already sealed stays sealed whatever the edit says.
  const useOnly = base.useOnly === true || input.useOnly === true
  return {
    v: 1, id: base.id, kind: input.kind, name: input.name, groupId: input.groupId ?? null, tags: input.tags ?? [], notes: input.notes ?? '',
    url: input.url ?? '', fields, createdAt: base.createdAt, updatedAt: iso(), version: base.version, deletedAt,
    // Always written explicitly from here on; an older record without it still reads as ON (`needsConfirm`).
    confirmEach: input.confirmEach ?? base.confirmEach ?? true,
    ...(useOnly ? { useOnly: true } : {}),
  }
}
const presentFields = (kind: PersonalMeta['kind'], f: Record<string, string>) => KIND_FIELDS[kind].filter(k => typeof f[k] === 'string' && f[k] !== '')

export async function createItem(input: PersonalInput): Promise<{ ok: true; meta: PersonalMeta }> {
  const id = newPersonalId('it')
  const fields = input.fields ?? {}
  const meta = metaFrom(input, { id, version: 1, createdAt: iso() }, presentFields(input.kind, fields))
  await writeVersion(meta, { v: 1, fields })
  return { ok: true, meta }
}

async function current(id: string, expectedVersion: number): Promise<PersonalMeta | StoreFail> {
  if (!ITEM_ID.test(id)) return { ok: false, code: 'not-found' }
  const m = await latestMeta(id)
  if (!m) return { ok: false, code: 'not-found' }
  if (m.version !== expectedVersion) return { ok: false, code: 'version-conflict', version: m.version }
  return m
}

/** Version N+1 with the changes; fields not sent are carried forward (opened here, never returned). */
export async function editItem(id: string, expectedVersion: number, input: PersonalInput): Promise<{ ok: true; meta: PersonalMeta } | StoreFail> {
  const m = await current(id, expectedVersion)
  if ('ok' in m) return m
  const prev = await readValue(id, m.version)
  if (!prev) return { ok: false, code: 'record-unreadable' }
  const fields: Record<string, string> = {}
  for (const k of KIND_FIELDS[input.kind]) {
    const v = input.fields?.[k] ?? (input.kind === m.kind ? prev.fields[k] : undefined)
    if (typeof v === 'string') fields[k] = v
  }
  const meta = metaFrom(input, { id, version: m.version + 1, createdAt: m.createdAt, confirmEach: m.confirmEach !== false, useOnly: isUseOnly(m) }, presentFields(input.kind, fields), m.deletedAt)
  await writeVersion(meta, { v: 1, fields })
  return { ok: true, meta }
}

async function rewriteMeta(id: string, expectedVersion: number, change: (m: PersonalMeta) => Partial<PersonalMeta>, fromVersion?: number): Promise<{ ok: true; meta: PersonalMeta } | StoreFail> {
  const m = await current(id, expectedVersion)
  if ('ok' in m) return m
  const srcV = fromVersion ?? m.version
  const src = srcV === m.version ? m : await readMeta(id, srcV)
  if (!src) return { ok: false, code: 'not-found' }
  const value = await readValue(id, srcV)
  if (!value) return { ok: false, code: 'record-unreadable' }
  const meta: PersonalMeta = { ...src, ...change(src), id, version: m.version + 1, createdAt: m.createdAt, updatedAt: iso() }
  // Restoring a version from BEFORE the seal must not unseal: "só uso" follows the newest record.
  if (isUseOnly(m)) meta.useOnly = true
  await writeVersion(meta, value)
  return { ok: true, meta }
}

export const trashItem = (id: string, expectedVersion: number) => rewriteMeta(id, expectedVersion, () => ({ deletedAt: iso() }))
export const restoreItem = (id: string, expectedVersion: number) => rewriteMeta(id, expectedVersion, () => ({ deletedAt: null }))
/** An older version becomes the newest (N+1) — its meta AND its value; the history in between is kept. */
export const restoreVersion = (id: string, version: number, expectedVersion: number) =>
  rewriteMeta(id, expectedVersion, () => ({ deletedAt: null }), version)
export const moveItem = (id: string, expectedVersion: number, groupId: string | null) => rewriteMeta(id, expectedVersion, () => ({ groupId }))

export async function purgeItem(id: string): Promise<{ ok: true } | StoreFail> {
  if (!ITEM_ID.test(id) || (await versionsIn(itemDir(id))).length === 0) return { ok: false, code: 'not-found' }
  await rm(itemDir(id), { recursive: true, force: true })
  return { ok: true }
}

/** THE value path: one field of one version (default the newest). The caller is the reveal route, gated. */
export async function revealField(id: string, field: string, version?: number): Promise<{ ok: true; value: string; meta: PersonalMeta } | StoreFail> {
  if (!ITEM_ID.test(id)) return { ok: false, code: 'not-found' }
  const m = version === undefined ? await latestMeta(id) : await readMeta(id, version)
  if (!m || !m.fields.includes(field)) return { ok: false, code: 'not-found' }
  const v = await readValue(id, m.version)
  if (!v || typeof v.fields[field] !== 'string') return { ok: false, code: 'record-unreadable' }
  return { ok: true, value: v.fields[field]!, meta: m }
}

// ── groups ──────────────────────────────────────────────────────────────────────────────────

async function latestGroup(id: string): Promise<PersonalGroup | null> {
  const vs = await versionsIn(groupDir(id))
  const v = vs[vs.length - 1]
  if (v === undefined) return null
  const g = await openJson<PersonalGroup>(file(groupDir(id), v, 'meta'), id, v, 'meta')
  return g && g.id === id ? g : null
}
async function writeGroup(g: PersonalGroup): Promise<void> {
  const dir = groupDir(g.id)
  await sealToFile(file(dir, g.version, 'meta'), PERSONAL_PURPOSE, recordName(g.id, g.version, 'meta'), enc(g))
  for (const v of versionsToPrune(await versionsIn(dir))) await rm(file(dir, v, 'meta'), { force: true })
}
export async function listGroups(): Promise<PersonalGroup[]> {
  const out: PersonalGroup[] = []
  for (const id of await idsIn('groups')) { const g = await latestGroup(id); if (g) out.push(g) }
  return out
}
export async function createGroup(name: string): Promise<{ ok: true; group: PersonalGroup }> {
  const g: PersonalGroup = { v: 1, id: newPersonalId('gr'), name, createdAt: iso(), updatedAt: iso(), version: 1 }
  await writeGroup(g)
  return { ok: true, group: g }
}
export async function renameGroup(id: string, expectedVersion: number, name: string): Promise<{ ok: true; group: PersonalGroup } | StoreFail> {
  if (!GROUP_ID.test(id)) return { ok: false, code: 'not-found' }
  const g = await latestGroup(id)
  if (!g) return { ok: false, code: 'not-found' }
  if (g.version !== expectedVersion) return { ok: false, code: 'version-conflict', version: g.version }
  const next: PersonalGroup = { ...g, name, version: g.version + 1, updatedAt: iso() }
  await writeGroup(next)
  return { ok: true, group: next }
}
/** Deleting a group moves its items OUT (each gets a new version with no group) — never deletes them. */
export async function deleteGroup(id: string): Promise<{ ok: true; moved: number } | StoreFail> {
  if (!GROUP_ID.test(id) || !(await latestGroup(id))) return { ok: false, code: 'not-found' }
  let moved = 0
  for (const m of await listItems()) {
    if (m.groupId !== id) continue
    const r = await moveItem(m.id, m.version, null)
    if (r.ok) moved++
  }
  await rm(groupDir(id), { recursive: true, force: true })
  return { ok: true, moved }
}

// ── `.env` import: preview (keys only) → commit ──────────────────────────────────────────────

const IMPORT_TTL_MS = 10 * 60_000
let _imports = new Map<string, { session: string; until: number; pairs: { key: string; value: string }[] }>()
function dropExpiredImports(): void { for (const [k, v] of _imports) if (_now() >= v.until) { v.pairs.forEach(p => { p.value = '' }); _imports.delete(k) } }

export interface ImportPreviewKey { key: string; clash: { id: string; version: number } | null; empty: boolean }

/**
 * Parse the file text and hold the pairs in memory under a token for THIS session; answer the KEYS
 * only (with the existing item of the same name, if any), never a value. The text is the caller's
 * string and is dropped with the request.
 */
export async function importPreview(text: string, session: string): Promise<{ ok: true; token: string; keys: ImportPreviewKey[]; skipped: number } | StoreFail> {
  dropExpiredImports()
  const parsed = parseImportText(text)
  if (!parsed.ok) return { ok: false, code: 'import-format', reason: parsed.reason }
  const live = (await listItems()).filter(m => !m.deletedAt)
  const keys = parsed.pairs.map(p => {
    const c = live.find(m => m.name === p.key)
    return { key: p.key, clash: c ? { id: c.id, version: c.version } : null, empty: p.value === '' }
  })
  const token = newPersonalId('it').slice(3)
  _imports.set(token, { session, until: _now() + IMPORT_TTL_MS, pairs: parsed.pairs })
  return { ok: true, token, keys, skipped: parsed.skipped }
}

export type ImportChoice = { key: string; action: 'import' | 'skip' | 'replace' | 'rename'; name?: string }

export async function importCommit(token: string, session: string, choices: ImportChoice[], groupId: string | null, tags: string[]):
  Promise<{ ok: true; created: number; replaced: number; skipped: number } | StoreFail> {
  dropExpiredImports()
  const held = _imports.get(token)
  if (!held || held.session !== session) return { ok: false, code: 'no-import' }
  _imports.delete(token)
  let created = 0, replaced = 0, skipped = 0
  try {
    const live = (await listItems()).filter(m => !m.deletedAt)
    for (const p of held.pairs) {
      const c = choices.find(x => x.key === p.key)
      if (!c || c.action === 'skip') { skipped++; continue }
      const clash = live.find(m => m.name === p.key)
      if (c.action === 'replace' && clash) {
        const r = await editItem(clash.id, clash.version, { kind: 'env', name: clash.name, groupId: clash.groupId, tags: clash.tags, notes: clash.notes, url: clash.url, fields: { value: p.value } })
        if (r.ok) replaced++; else skipped++
        continue
      }
      const name = c.action === 'rename' && c.name ? c.name : p.key
      if (c.action === 'import' && clash) { skipped++; continue } // a clash must be decided, never overwritten by default
      await createItem({ kind: 'env', name, groupId, tags, notes: '', url: '', fields: { value: p.value } })
      created++
    }
  } finally { held.pairs.forEach(p => { p.value = '' }) }
  return { ok: true, created, replaced, skipped }
}

export function __resetPersonalForTests(now?: () => number): void {
  _now = now ?? (() => Date.now())
  _imports = new Map()
}
