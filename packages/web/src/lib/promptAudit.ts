/**
 * promptAudit.ts — the write channel's audit trail, kept in the browser on purpose.
 *
 * Sending a prompt into a live session is the one thing this dashboard does that CHANGES another
 * process, so the PE's condition for allowing it was that every send leaves a record: who sent it,
 * to which session, what, and when. This module is that record.
 *
 * WHY IT LIVES HERE, not on the server. The only audit trail the server has (`server/audit.ts`) is a
 * Mongo-backed, team-security log — its actions are logins, account/token/team changes — and
 * `writeAudit` no-ops entirely when there is no Mongo. The fleet write channel runs on a solo /
 * machine install where that database does not exist, and its accountable actor is not an IAM
 * account but whoever is at THIS browser driving the local dashboard. Extending the server's log to
 * cover local session writes is a `packages/server` change and outside this package. So the honest
 * place for the record is the browser that performed the send: a persisted, VISIBLE log rendered
 * next to the terminal, so a send can never vanish in silence and its outcome is always on the
 * record — which is also the "feedback of what happened" the same requirement asks for.
 *
 * The content is stored as typed (only length-capped): this is the operator's own log of their own
 * sends on their own machine, and redacting "what did I send?" would defeat the record's whole
 * purpose — unlike the server log, which is shared and therefore scrubs secret-shaped fields.
 *
 * The pure half (`buildAuditEntry` / `appendAudit` / `resolveAuthor`) is tested; the localStorage
 * store is guarded exactly like `terminalZoom.ts` (private mode is a missing log, never a throw).
 */

const KEY = 'agentistics-prompt-audit-v1'
const OPERATOR_KEY = 'agentistics-operator-id'

/** Bound the log so one busy afternoon cannot grow it without limit — newest kept, oldest dropped. */
export const MAX_AUDIT_ENTRIES = 200
/** A prompt is one line; cap defensively so a pasted blob cannot bloat storage. */
export const MAX_AUDIT_TEXT = 2000

/** One recorded send of text into a session. */
export interface PromptAuditEntry {
  /** Unique within the log, so React keys and de-dup are stable. */
  id: string
  /** ISO-8601, UTC. `parseISO`-friendly, like every other timestamp on the wire. */
  at: string
  /** Who performed the send — an IAM display name where the dashboard has one, else this browser's
   *  stable operator id. Never invented: see `resolveAuthor`. */
  author: string
  /** The fleet/tmux id the text was written to — the unambiguous target, not the display title. */
  sessionId: string
  /** The session's human title at the moment of the send, so the log reads without a fleet lookup. */
  sessionTitle: string
  harness: string
  /** The exact text submitted into the session. */
  text: string
  /** The server's answer: true = accepted, false = refused/failed. A record is written either way. */
  ok: boolean
  /** The already-localized sentence the server returned, kept verbatim for the record. */
  message: string
}

export interface PromptAuditInput {
  author: string
  sessionId: string
  sessionTitle: string
  harness: string
  text: string
  ok: boolean
  message: string
}

/** Trim and cap the recorded text; a prompt is a line, not a document. */
function clampText(text: string): string {
  const t = text.trim()
  return t.length > MAX_AUDIT_TEXT ? t.slice(0, MAX_AUDIT_TEXT) : t
}

/**
 * Build one record from a completed send. `now` and `id` are injected so the builder is pure and the
 * test is deterministic; the store passes `new Date()` and a real id.
 */
export function buildAuditEntry(input: PromptAuditInput, now: Date, id: string): PromptAuditEntry {
  return {
    id,
    at: now.toISOString(),
    author: input.author.trim() || 'unknown',
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    harness: input.harness,
    text: clampText(input.text),
    ok: input.ok,
    message: input.message,
  }
}

/**
 * Prepend a record (newest first) and cap the log. Returns a NEW array so an external store can swap
 * the reference and `useSyncExternalStore` re-renders; never mutates the input.
 */
export function appendAudit(
  list: readonly PromptAuditEntry[],
  entry: PromptAuditEntry,
  max = MAX_AUDIT_ENTRIES,
): PromptAuditEntry[] {
  return [entry, ...list].slice(0, Math.max(1, max))
}

/** The records for one session, newest first (the input is already newest-first). */
export function auditForSession(
  list: readonly PromptAuditEntry[],
  sessionId: string,
): PromptAuditEntry[] {
  return list.filter(e => e.sessionId === sessionId)
}

/**
 * Who the send is attributed to. An IAM display name wins where the dashboard knows one (
 * IAM login); otherwise this browser's stable operator id, which at least tells two people sharing
 * one local dashboard apart. Never invents a name it does not have — an empty account name falls
 * through to the operator id rather than being recorded as blank.
 */
export function resolveAuthor(opts: { accountName?: string | null; operatorId: string }): string {
  const name = (opts.accountName ?? '').trim()
  return name || opts.operatorId
}

// ---- the persisted store (guarded; a store failure is a missing log, never a throw) --------------

function isEntry(v: unknown): v is PromptAuditEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.id === 'string'
    && typeof e.at === 'string'
    && typeof e.author === 'string'
    && typeof e.sessionId === 'string'
    && typeof e.sessionTitle === 'string'
    && typeof e.harness === 'string'
    && typeof e.text === 'string'
    && typeof e.ok === 'boolean'
    && typeof e.message === 'string'
}

/** Parse a stored log defensively: a corrupt or foreign value reads as an empty log, not a crash. */
export function parseStoredAudit(raw: string | null): PromptAuditEntry[] {
  if (raw == null) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(isEntry).slice(0, MAX_AUDIT_ENTRIES)
  } catch {
    return []
  }
}

function readInitial(): PromptAuditEntry[] {
  try {
    return parseStoredAudit(localStorage.getItem(KEY))
  } catch {
    return []
  }
}

let current: PromptAuditEntry[] = readInitial()
const subscribers = new Set<() => void>()

export function getPromptAudit(): PromptAuditEntry[] {
  return current
}

export function subscribePromptAudit(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* storage may be unavailable (private mode); the in-memory log still drives this session */
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Record one completed send and notify every reader. Returns the entry it wrote so the caller can
 * show it immediately. Called AFTER the server answered, so `ok`/`message` are the real outcome.
 */
export function recordPromptSend(input: PromptAuditInput): PromptAuditEntry {
  const entry = buildAuditEntry(input, new Date(), newId())
  current = appendAudit(current, entry)
  persist()
  for (const fn of subscribers) fn()
  return entry
}

export function clearPromptAudit(): void {
  if (current.length === 0) return
  current = []
  persist()
  for (const fn of subscribers) fn()
}

/**
 * This browser's stable operator id — generated once and kept, so the same person's sends carry a
 * consistent author across reloads and two people on one local dashboard are told apart. It is a
 * pseudonymous handle, not a claim of a real name; when the dashboard has an IAM login,
 * `resolveAuthor` prefers that.
 */
export function operatorId(): string {
  try {
    const existing = localStorage.getItem(OPERATOR_KEY)
    if (existing && existing.trim()) return existing
    const id = `op-${newId().slice(0, 8)}`
    localStorage.setItem(OPERATOR_KEY, id)
    return id
  } catch {
    return 'this-browser'
  }
}
