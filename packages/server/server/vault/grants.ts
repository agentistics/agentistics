/**
 * vault/grants.ts — VAULT.PERSONAL P2: which personal secrets a SESSION may use (spec §8).
 *
 * A grant names items (and optionally whole groups, expanded to the items they hold AT GRANT TIME — an
 * item added to the group later is not in an existing grant). It lives in MEMORY only: it dies when the
 * vault locks (auto-lock, sleep, SIGTERM, a restart — the service starts locked), when the person revokes
 * it, or when the session is told to forget it. A grant holds ids and reference names, never a value:
 * values are opened at the moment of use (`resolveGrant`) and handed to exactly two consumers — the env
 * of a process being spawned, and the scrubber that watches that session's output.
 */
import { envNameFor, KIND_FIELDS, makeScrubber, type PersonalMeta } from '@agentistics/vault'
import { onVaultLock } from './service'
import { listItems, revealField } from './personal'

export interface GrantRef { itemId: string; field: string; ref: string; env: string; name: string }
export interface Grant { sessionId: string; refs: GrantRef[]; groups: string[]; createdAt: string }

let _grants = new Map<string, Grant>()
let _now: () => number = () => Date.now()
/** A compiled scrubber per granted session — holds the value FORMS while the grant lives; dropped with it. */
let _scrubbers = new Map<string, ReturnType<typeof makeScrubber>>()
onVaultLock(() => { _grants = new Map(); _scrubbers = new Map() })

/** A reference key from a name: `Banco Itaú` → `banco-itau` (what `vault://` carries; unique per grant). */
export function refKey(name: string): string {
  const k = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  return (k || 'secret').slice(0, 100)
}

function refsFor(m: PersonalMeta, taken: Set<string>): GrantRef[] {
  let key = refKey(m.name)
  for (let i = 2; taken.has(key); i++) key = `${refKey(m.name)}-${i}`
  taken.add(key)
  const fields = m.fields.length ? m.fields : [...KIND_FIELDS[m.kind]]
  return fields.map(f => {
    const single = fields.length === 1
    return { itemId: m.id, field: f, ref: single ? `vault://${key}` : `vault://${key}/${f}`, env: envNameFor(key, single ? null : f), name: m.name }
  })
}

/** Grant (replacing any earlier grant of this session) — items by id plus every item of the named groups. */
export async function grantSession(sessionId: string, itemIds: readonly string[], groupIds: readonly string[]): Promise<{ ok: true; grant: Grant } | { ok: false; code: 'grant-empty' | 'not-found' }> {
  const live = (await listItems()).filter(m => !m.deletedAt)
  const chosen = live.filter(m => itemIds.includes(m.id) || (m.groupId !== null && groupIds.includes(m.groupId)))
  if (itemIds.some(id => !live.find(m => m.id === id))) return { ok: false, code: 'not-found' }
  if (chosen.length === 0) return { ok: false, code: 'grant-empty' }
  const taken = new Set<string>()
  const refs = chosen.sort((a, b) => a.name.localeCompare(b.name)).flatMap(m => refsFor(m, taken))
  const g: Grant = { sessionId, refs, groups: [...groupIds], createdAt: new Date(_now()).toISOString() }
  _grants.set(sessionId, g)
  _scrubbers.delete(sessionId)
  await warmScrubber(sessionId)
  return { ok: true, grant: g }
}

export function grantOf(sessionId: string): Grant | null { return _grants.get(sessionId) ?? null }
export function listGrants(): Grant[] { return [..._grants.values()] }
export function revokeGrant(sessionId: string): boolean { _scrubbers.delete(sessionId); return _grants.delete(sessionId) }

/** Is any session granted? (the served-copy scrubbers skip all work when none is) */
export function anyGrant(): boolean { return _grants.size > 0 }

/**
 * Scrub `text` for ONE session: its granted values and their encodings become «vault:NAME». A session
 * with no grant gets the text back untouched, with no vault work at all.
 */
export async function scrubFor(sessionId: string, text: string): Promise<string> {
  if (!text || !_grants.has(sessionId)) return text
  let s = _scrubbers.get(sessionId)
  if (!s) {
    const vals = await resolveGrant(sessionId)
    s = makeScrubber(vals.map(v => ({ name: v.ref.name, value: v.value })))
    _scrubbers.set(sessionId, s)
  }
  return s.scrub(text).text
}

/**
 * Open the values of a session's grant — for an env being built or a scrubber being made, never for a
 * reply. An item deleted or trashed since the grant is skipped (and said, by its absence in `refs`).
 */
export async function resolveGrant(sessionId: string): Promise<{ ref: GrantRef; value: string }[]> {
  const g = _grants.get(sessionId)
  if (!g) return []
  const out: { ref: GrantRef; value: string }[] = []
  for (const r of g.refs) {
    const v = await revealField(r.itemId, r.field)
    if (v.ok && !v.meta.deletedAt) out.push({ ref: r, value: v.value })
  }
  return out
}

/** The env a process of this session gets: `VAULT_<KEY>[_<FIELD>]=value`. */
export async function grantEnv(sessionId: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const { ref, value } of await resolveGrant(sessionId)) env[ref.env] = value
  return env
}

/** The one execution instruction shared by non-hook harnesses. It contains no value or phantom env var. */
export const VAULT_REF_INSTRUCTION = "Use this secret inside a shell command as $(agentop vault ref 'vault://<key>') — the value is fetched at run time for this session only; never print it, never write it to a file or the conversation."

/** What the MODEL is told: names and references — never a value. */
export function grantBriefing(g: Grant, lang: 'en' | 'pt' = 'en'): string {
  const lines = g.refs.map(r => `- ${r.name}${r.field !== 'value' ? ` (${r.field})` : ''}: ${r.ref}`)
  return lang === 'pt'
    ? `Segredos do cofre liberados para esta sessão (você NÃO vê os valores):\n${lines.join('\n')}\n${VAULT_REF_INSTRUCTION}\nQualquer valor que aparecer numa saída será trocado por «vault:NOME». Nunca peça para o usuário colar um segredo.`
    : `Vault secrets granted to this session (you do NOT see the values):\n${lines.join('\n')}\n${VAULT_REF_INSTRUCTION}\nAny value that shows up in an output is replaced by «vault:NAME». Never ask for a secret to be pasted.`
}

export function __resetGrantsForTests(now?: () => number): void { _grants = new Map(); _scrubbers = new Map(); _now = now ?? (() => Date.now()) }

/** A reference as typed (`vault://key` or `vault://key/field`) → the granted ref it names, or null. */
export function grantedRef(sessionId: string, ref: string): GrantRef | null {
  const g = _grants.get(sessionId)
  if (!g) return null
  return g.refs.find(r => r.ref === ref) ?? null
}

/**
 * VAULT.PERSONAL §8.3 — THE one place a personal value leaves the service for a process that is not a
 * page: `agentop vault ref`, run INSIDE a granted session's command at the moment it executes. Only a ref
 * the session was granted; every use audited as the act (never the value).
 */
export async function useRef(sessionId: string, ref: string): Promise<{ ok: true; value: string } | { ok: false; code: 'not-granted' | 'secret-gone' }> {
  const r = grantedRef(sessionId, ref)
  if (!r) return { ok: false, code: 'not-granted' }
  const v = await revealField(r.itemId, r.field)
  if (!v.ok || v.meta.deletedAt) return { ok: false, code: 'secret-gone' }
  return { ok: true, value: v.value }
}

/** The cached scrubber for a session, if it is granted and warm — the synchronous paths (a terminal frame) use this. */
export function scrubSync(sessionId: string, text: string): string {
  if (!text) return text
  const s = _scrubbers.get(sessionId)
  return s ? s.scrub(text).text : text
}
/** Warm a granted session's scrubber (called when the grant is made, so the synchronous paths have it). */
export async function warmScrubber(sessionId: string): Promise<void> { await scrubFor(sessionId, ' ') }

/**
 * Every string inside a served value (chat turns: text, tool names, tool inputs and outputs, anything a
 * reader added) through the session's scrubber. Untouched — same object, no work — for a session with
 * no grant. Used where a copy LEAVES agentop: the chat view, the pending-prompt list, the fleet tails.
 */
export async function scrubDeep<T>(sessionId: string, value: T): Promise<T> {
  if (!_grants.has(sessionId)) return value
  await warmScrubber(sessionId)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubSync(sessionId, v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/**
 * A terminal line, with its colours. A value printed plainly is replaced in place; a value whose
 * characters an SGR sequence happens to split is caught on the de-coloured line, and that ONE line is
 * served without colour — losing a line's colour is the cost, never the value.
 */
export function scrubTerminalLine(sessionId: string, line: string): string {
  const direct = scrubSync(sessionId, line)
  if (direct !== line) return direct
  const plain = line.replace(ANSI, '')
  if (plain === line) return line
  const p = scrubSync(sessionId, plain)
  return p !== plain ? p : line
}

/**
 * engine-api 1.8 `vaultRefs` (VAULT.PERSONAL §8.3) — what the host hands an engine for its NATIVE
 * sessions. Grant keys are namespaced `native:<id>`; the engine passes its own session id.
 */
export const nativeVaultRefs = {
  env: (sessionId: string) => grantEnv(`native:${sessionId}`),
  scrub: (sessionId: string, text: string) => scrubFor(`native:${sessionId}`, text),
}
