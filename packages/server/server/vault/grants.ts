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
import { envNameFor, KIND_FIELDS, makeScrubber, needsConfirm, type PersonalMeta } from '@agentistics/vault'
import { broadcastNotification } from '../sse'
import { readRegistry } from '../sessions/registry'
import { onVaultLock, vaultAudit, vaultConfirmEachUse } from './service'
import { listItems, revealField } from './personal'

export interface GrantRef { itemId: string; field: string; ref: string; env: string; name: string }
export interface Grant { sessionId: string; refs: GrantRef[]; groups: string[]; createdAt: string }

let _grants = new Map<string, Grant>()
let _now: () => number = () => Date.now()
/** A compiled scrubber per granted session — holds the value FORMS while the grant lives; dropped with it. */
let _scrubbers = new Map<string, ReturnType<typeof makeScrubber>>()
// Test seam only; production reads the persisted vault.json setting through vaultConfirmEachUse().
let _confirmEachUseOverride: boolean | undefined
let _epoch = 0
let _requests = new Map<string, UseRequest>()
let _approvals = new Map<string, number>()
let _requestSeq = 0
let _useTtlMs = 90_000
export type UseCode = 'not-granted' | 'secret-gone' | 'use-denied' | 'use-pending' | 'use-busy' | 'vault-locked' | 'use-unsupported'
export interface UseContext { command: string | null; harness: string; callId?: string }
export interface UseRequest {
  id: string; epoch: number; sessionId: string; itemId: string; field: string; ref: string; name: string
  sessionTitle: string; harness: string; command: string | null; flags: ('persists' | 'background' | 'network')[]
  count: number; createdAt: number; expiresAt: number; state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
  waiters: Set<(ok: boolean) => void>
}
const requestKey = (sid: string, itemId: string, field: string, epoch = _epoch) => `${sid}\0${itemId}\0${field}\0${epoch}`
const cleanCommand = (command: string | null): string | null => command === null ? null : command
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200)
const commandFlags = (command: string | null): UseRequest['flags'] => {
  if (!command) return []
  const f: UseRequest['flags'] = []
  if (/(?:^|\s)(?:>>?|tee|export|set\s+-a|(?:cp|mv)\s+.*\S)/i.test(command)) f.push('persists')
  if (/(?:&\s*$|\b(?:nohup|setsid|disown|screen|tmux)\b)/i.test(command)) f.push('background')
  if (/\b(?:curl|wget|nc|ssh|scp|https?)\b/i.test(command)) f.push('network')
  return f
}
function cancelAll(code: UseCode): void {
  for (const r of _requests.values()) if (r.state === 'pending') { r.state = 'cancelled'; for (const w of r.waiters) w(false); r.waiters.clear(); vaultAudit({ type: 'vault.personal-use-cancelled', name: r.itemId, purpose: code }) }
  _requests = new Map(); _approvals = new Map(); _epoch++
}
onVaultLock(() => { _grants = new Map(); _scrubbers = new Map(); cancelAll('vault-locked') })

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
export function revokeGrant(sessionId: string): boolean {
  for (const r of _requests.values()) if (r.sessionId === sessionId && r.state === 'pending') { r.state = 'cancelled'; for (const w of r.waiters) w(false); r.waiters.clear() }
  for (const k of _approvals.keys()) if (k.startsWith(`${sessionId}\0`)) _approvals.delete(k)
  _scrubbers.delete(sessionId); return _grants.delete(sessionId)
}

export function confirmEachUseEnabled(): boolean { return _confirmEachUseOverride ?? vaultConfirmEachUse() }
export function __setConfirmEachUseForTests(enabled: boolean): void { _confirmEachUseOverride = enabled }
export function __setUseTtlForTests(ms: number): void { _useTtlMs = ms }
export function pendingUseRequests(): UseRequest[] { return [..._requests.values()].filter(r => r.state === 'pending').map(r => ({ ...r, waiters: new Set() })) }
export function useRequest(id: string): UseRequest | null { const r = _requests.get(id); return r ? { ...r, waiters: new Set() } : null }
function failUse(code: UseCode): { ok: false; code: UseCode } { return { ok: false, code } }
async function openAuthorized(r: GrantRef): Promise<{ ok: true; value: string } | { ok: false; code: UseCode }> {
  const v = await revealField(r.itemId, r.field)
  if (!v.ok || v.meta.deletedAt) return failUse('secret-gone')
  vaultAudit({ type: 'vault.personal-use', name: r.itemId }); return { ok: true, value: v.value }
}
async function titleForSession(sessionId: string): Promise<string> {
  if (sessionId.startsWith('native:')) return sessionId
  const row = (await readRegistry().catch(() => [])).find(x => x.id === sessionId)
  return row?.label || row?.harnessName || row?.task || sessionId
}
function waitFor(r: UseRequest): Promise<boolean> { return new Promise(resolve => { r.waiters.add(resolve); setTimeout(() => { if (r.state !== 'pending') return; r.state = 'expired'; for (const w of r.waiters) w(false); r.waiters.clear(); vaultAudit({ type: 'vault.personal-use-expired', name: r.itemId }) }, Math.max(0, r.expiresAt - _now())) }) }

/** The sole gate through which a personal value is returned to an agent process. */
export async function authorizeUse(sessionId: string, ref: string, ctx: UseContext): Promise<{ ok: true; value: string } | { ok: false; code: UseCode }> {
  const g = _grants.get(sessionId), r = g?.refs.find(x => x.ref === ref)
  if (!r) return failUse('not-granted')
  if (!confirmEachUseEnabled()) return openAuthorized(r)
  const meta = (await listItems()).find(x => x.id === r.itemId)
  if (!meta || meta.deletedAt) return failUse('secret-gone')
  if (!needsConfirm(meta)) return openAuthorized(r)
  const key = requestKey(sessionId, r.itemId, r.field)
  const until = _approvals.get(key)
  if (until !== undefined && until > _now()) return openAuthorized(r)
  _approvals.delete(key)
  let pending = [..._requests.values()].find(x => x.state === 'pending' && requestKey(x.sessionId, x.itemId, x.field, x.epoch) === key)
  if (!pending && ([..._requests.values()].filter(x => x.state === 'pending' && x.sessionId === sessionId).length >= 3 || [..._requests.values()].filter(x => x.state === 'pending').length >= 10)) return failUse('use-busy')
  if (!pending) {
    const command = cleanCommand(ctx.command)
    pending = { id: `use-${++_requestSeq}`, epoch: _epoch, sessionId, itemId: r.itemId, field: r.field, ref: r.ref, name: r.name, sessionTitle: sessionId, harness: ctx.harness, command, flags: commandFlags(command), count: 1, createdAt: _now(), expiresAt: _now() + _useTtlMs, state: 'pending', waiters: new Set() }
    _requests.set(pending.id, pending) // registered BEFORE any await: concurrent calls for this reference must find it
    const made = pending; void titleForSession(sessionId).then(t => { made.sessionTitle = t })
    vaultAudit({ type: 'vault.personal-use-asked', name: r.itemId, purpose: ctx.harness }); broadcastNotification({ type: 'warning', code: 'vault.use-request', meta: { requestId: pending.id, name: r.name } })
  } else pending.count++
  const approved = await waitFor(pending)
  if (!approved || pending.state !== 'approved' || pending.epoch !== _epoch || !_grants.has(sessionId)) return failUse(pending.state === 'denied' ? 'use-denied' : 'use-pending')
  return openAuthorized(r)
}
export function decideUse(id: string, approve: boolean, windowMin = 10): { ok: true } | { ok: false; code: 'use-not-pending' | 'not-found' } {
  const r = _requests.get(id)
  if (!r) return { ok: false, code: 'not-found' }
  if (r.state !== 'pending' || r.expiresAt <= _now() || r.epoch !== _epoch) return { ok: false, code: 'use-not-pending' }
  r.state = approve ? 'approved' : 'denied'
  if (approve) { _approvals.set(requestKey(r.sessionId, r.itemId, r.field), _now() + Math.max(0, Math.min(60, windowMin)) * 60_000); vaultAudit({ type: 'vault.personal-use-approved', name: r.itemId }) } else { revokeRef(r.sessionId, r.itemId, r.field); vaultAudit({ type: 'vault.personal-use-denied', name: r.itemId }) }
  for (const w of r.waiters) w(approve); r.waiters.clear(); return { ok: true }
}
function revokeRef(sessionId: string, itemId: string, field: string): void { const g = _grants.get(sessionId); if (g) g.refs = g.refs.filter(r => !(r.itemId === itemId && r.field === field)) }

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
async function resolveGrant(sessionId: string): Promise<{ ref: GrantRef; value: string }[]> {
  const g = _grants.get(sessionId)
  if (!g) return []
  const out: { ref: GrantRef; value: string }[] = []
  for (const r of g.refs) {
    const v = await revealField(r.itemId, r.field)
    if (v.ok && !v.meta.deletedAt) out.push({ ref: r, value: v.value })
  }
  return out
}

/**
 * The env a NATIVE session gets (legacy `vaultRefs.env`). With confirm-each-use ON, a confirmable secret
 * is never opened here at all — the filter runs BEFORE any value is read. Its replacement, `vaultRefs.use`
 * (an approval per use), belongs to the engine.
 * TODO(E1/E2): the engine adds `vaultRefs.use` → `authorizeUse`; until then a native session has no path to
 * a confirmable secret with the setting ON (fails closed). Do not touch engine-api/runtime from here.
 */
async function legacyNativeEnv(sessionId: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  const g = _grants.get(sessionId)
  if (!g) return env
  const confirm = confirmEachUseEnabled()
  const metas = confirm ? await listItems() : []
  for (const r of g.refs) {
    if (confirm) {
      const meta = metas.find(x => x.id === r.itemId)
      if (!meta || meta.deletedAt || needsConfirm(meta)) continue
    }
    const v = await revealField(r.itemId, r.field)
    if (v.ok && !v.meta.deletedAt) env[r.env] = v.value
  }
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

export function __resetGrantsForTests(now?: () => number): void { _grants = new Map(); _scrubbers = new Map(); _requests = new Map(); _approvals = new Map(); _epoch = 0; _requestSeq = 0; _useTtlMs = 90_000; _confirmEachUseOverride = undefined; _now = now ?? (() => Date.now()) }

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
export async function useRef(sessionId: string, ref: string, ctx: UseContext = { command: null, harness: 'legacy' }): Promise<{ ok: true; value: string } | { ok: false; code: UseCode }> { return authorizeUse(sessionId, ref, ctx) }

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
  env: (sessionId: string) => legacyNativeEnv(`native:${sessionId}`),
  scrub: (sessionId: string, text: string) => scrubFor(`native:${sessionId}`, text),
}
