/**
 * VAULT.PERSONAL — the page's door onto `/api/vault/personal*` and its pure rules (search, filters,
 * paging, the `.env` import choices, the clipboard timer). What is NOT here: any decision about what an
 * action asks — the server's gate decides and answers `stepup-required` when it wants the code; the page
 * then asks for it and retries. Values exist in this module only in the return of `reveal`, and the
 * page drops them after 30 seconds.
 */
import { vaultGet, vaultPost, type Reply } from './vaultApi'

export type PersonalKind = 'password' | 'login' | 'api-key' | 'env' | 'note'
export const PERSONAL_KINDS: readonly PersonalKind[] = ['login', 'password', 'api-key', 'env', 'note']
export const KIND_FIELDS: Record<PersonalKind, readonly string[]> = { password: ['password'], login: ['login', 'password'], 'api-key': ['value'], env: ['value'], note: ['value'] }

export interface PersonalMeta {
  id: string; kind: PersonalKind; name: string; groupId: string | null; tags: string[]; notes: string; url: string
  fields: string[]; createdAt: string; updatedAt: string; version: number; deletedAt: string | null
}
export interface PersonalGroup { id: string; name: string; version: number; createdAt: string; updatedAt: string }
export interface PersonalItemInput { kind: PersonalKind; name: string; groupId?: string | null; tags?: string[]; notes?: string; url?: string; fields?: Record<string, string> }
export interface ImportKey { key: string; clash: { id: string; version: number } | null; empty: boolean }
export type ImportAction = 'import' | 'skip' | 'replace' | 'rename'
export interface ImportChoice { key: string; action: ImportAction; name?: string }

const P = '/api/vault/personal'
const withCode = (b: Record<string, unknown>, code?: string) => (code ? { ...b, code } : b)
/** A phone's single-use gesture token (§7), when the action was confirmed with a passkey. */
const tok = (t?: string) => (t ? { gestureToken: t } : {})

export const listPersonal = () => vaultGet<{ items: PersonalMeta[]; groups: PersonalGroup[] }>(P)
export const listVersions = (id: string) => vaultGet<{ versions: PersonalMeta[] }>(`${P}/versions?id=${encodeURIComponent(id)}`)
export const createPersonal = (item: PersonalItemInput, code?: string) => vaultPost<{ meta: PersonalMeta }>(P, withCode({ item }, code))
export const editPersonal = (id: string, expectedVersion: number, item: PersonalItemInput, code?: string, gestureToken?: string) => vaultPost<{ meta: PersonalMeta }>(`${P}/edit`, withCode({ id, expectedVersion, item, ...tok(gestureToken) }, code))
export const revealPersonal = (id: string, field: string, code?: string, version?: number, gestureToken?: string) => vaultPost<{ value: string; field: string; version: number }>(`${P}/reveal`, withCode({ id, field, ...(version ? { version } : {}), ...tok(gestureToken) }, code))
export const trashPersonal = (id: string, expectedVersion: number, code?: string, gestureToken?: string) => vaultPost<{ meta: PersonalMeta }>(`${P}/trash`, withCode({ id, expectedVersion, ...tok(gestureToken) }, code))
export const restorePersonal = (id: string, expectedVersion: number, code?: string, gestureToken?: string) => vaultPost<{ meta: PersonalMeta }>(`${P}/restore`, withCode({ id, expectedVersion, ...tok(gestureToken) }, code))
export const restoreVersion = (id: string, version: number, expectedVersion: number, code?: string, gestureToken?: string) => vaultPost<{ meta: PersonalMeta }>(`${P}/restore-version`, withCode({ id, version, expectedVersion, ...tok(gestureToken) }, code))
export const purgePersonal = (id: string, code?: string, gestureToken?: string) => vaultPost(`${P}/purge`, withCode({ id, ...tok(gestureToken) }, code))
export const movePersonal = (id: string, expectedVersion: number, groupId: string | null, code?: string) => vaultPost<{ meta: PersonalMeta }>(`${P}/move`, withCode({ id, expectedVersion, groupId }, code))
export const createGroup = (name: string, code?: string) => vaultPost<{ group: PersonalGroup }>(`${P}/groups`, withCode({ name }, code))
export const renameGroup = (id: string, expectedVersion: number, name: string, code?: string) => vaultPost<{ group: PersonalGroup }>(`${P}/groups/rename`, withCode({ id, expectedVersion, name }, code))
export const deleteGroup = (id: string, code?: string, gestureToken?: string) => vaultPost<{ moved: number }>(`${P}/groups/delete`, withCode({ id, ...tok(gestureToken) }, code))
export const importPreview = (text: string, code?: string) => vaultPost<{ token: string; keys: ImportKey[]; skipped: number }>(`${P}/import/preview`, withCode({ text }, code))
export const importCommit = (token: string, choices: ImportChoice[], groupId: string | null, code?: string) => vaultPost<{ created: number; replaced: number; skipped: number }>(`${P}/import/commit`, withCode({ token, choices, groupId }, code))

/** A gated call: try with the live grant; when the server wants the code, ask once and retry with it. */
export async function withStepUp<T>(run: (code?: string) => Promise<Reply<T>>, askCode: () => Promise<string | null>): Promise<Reply<T>> {
  const r = await run()
  if (r.ok || r.code !== 'stepup-required') return r
  const code = await askCode()
  if (!code) return r
  return run(code)
}

// ── pure rules ───────────────────────────────────────────────────────────────────────────────

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export interface PersonalFilter { q: string; kind: PersonalKind | 'all'; groupId: string | 'all' | 'none'; trash: boolean }

/**
 * PURE. The reactive search: every term must match one of name, group name, tags, notes, url or kind
 * (accent- and case-insensitive). METADATA ONLY — a value is never in this list to match against.
 * Ordered by name. Fast enough for a few thousand rows on every keystroke (one pass, no regex).
 */
export function filterPersonal(items: readonly PersonalMeta[], groups: readonly PersonalGroup[], f: PersonalFilter, kindLabel: (k: PersonalKind) => string = k => k): PersonalMeta[] {
  const gName = new Map(groups.map(g => [g.id, g.name]))
  const terms = fold(f.q).split(/\s+/).filter(Boolean)
  return items.filter(m => {
    if (f.trash !== (m.deletedAt !== null)) return false
    if (f.kind !== 'all' && m.kind !== f.kind) return false
    if (f.groupId === 'none' ? m.groupId !== null : f.groupId !== 'all' && m.groupId !== f.groupId) return false
    if (terms.length === 0) return true
    const hay = fold([m.name, m.groupId ? gName.get(m.groupId) ?? '' : '', m.tags.join(' '), m.notes, m.url, m.kind, kindLabel(m.kind)].join('\n'))
    return terms.every(t => hay.includes(t))
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** PURE. A clash defaults to SKIP (never overwritten by default); everything else to import. */
export function defaultImportChoices(keys: readonly ImportKey[]): ImportChoice[] {
  return keys.map(k => ({ key: k.key, action: k.clash ? 'skip' : 'import' }))
}
/** PURE. Can the import be sent as chosen? (a rename needs a non-empty name; nothing chosen is nothing to send) */
export function importReady(choices: readonly ImportChoice[]): boolean {
  return choices.some(c => c.action !== 'skip') && choices.every(c => c.action !== 'rename' || Boolean(c.name?.trim()))
}

/** PURE. Tags typed as "a, b ,c" → ['a','b','c'], deduplicated. */
export function parseTags(s: string): string[] {
  return [...new Set(s.split(',').map(t => t.trim()).filter(Boolean))].slice(0, 20)
}

export const CLIPBOARD_CLEAR_MS = 30_000
export const REVEAL_HIDE_MS = 30_000

/**
 * Copy, then overwrite the clipboard with "" after 30 s (owner rule). Returns a cancel. The overwrite
 * happens whether or not the page is still open on this screen — the timer is the page's, so leaving
 * the page early runs it now.
 */
export function copyWithAutoClear(text: string, clip: Pick<Clipboard, 'writeText'> = navigator.clipboard, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): { done: Promise<boolean>; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null
  const done = clip.writeText(text).then(() => {
    t = timers.set(() => { void clip.writeText('').catch(() => {}) }, CLIPBOARD_CLEAR_MS)
    return true
  }).catch(() => false)
  return { done, cancel: () => { if (t !== null) { timers.clear(t); void clip.writeText('').catch(() => {}) } } }
}

export interface GrantAnswer { refs: { ref: string; env: string; name: string; field: string }[]; briefing: string }
/** Grant a session the chosen items/groups (gate `personal-grant`: the gesture, fresh). The answer: references + briefing, never a value. */
export const grantSession = (sessionId: string, itemIds: string[], groupIds: string[], code?: string, gestureToken?: string) =>
  vaultPost<GrantAnswer>(`${P}/grants`, withCode({ sessionId, itemIds, groupIds, ...tok(gestureToken) }, code))
