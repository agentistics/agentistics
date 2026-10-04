/**
 * native-fleet.ts — NATIVE.LIFE: the NATIVE Agentistics sessions as rows of THIS machine's fleet, for
 * every surface the host serves — the cockpit's sessions tab, `agentop session ls|list`, and
 * `/api/fleet` (read by the web workspace and the VS Code extension) — and their lifecycle verbs
 * (end, reopen, rename, archive, delete) routed to the engine's own routes.
 *
 * A native session has no tmux pane and no registry record: the engine owns it
 * (`GET /api/runtime/sessions`, `engine/src/runtime-sessions-web.ts`). So the poller never sees it,
 * and before this every host surface acted as if it did not exist — the owner could not END a native
 * session from anywhere. This module only MAPS the engine's list and FORWARDS the verbs; it decides
 * nothing the engine has not said:
 *
 *   - The state is the engine's MEASURED activity, derived from the real run state (`activityOf`):
 *     `working` / `waiting-approval` / `waiting`. An open session the engine has not measured is
 *     `unknown` with the word "open" — active, never working or needing you on a guess. Any other
 *     status is `closed` (ended, failed), which is reopenable.
 *   - A refusal is the ENGINE's own sentence, passed through. An engine that is absent, older than
 *     the lifecycle routes, or gated off answers a sentence too — never a silent no-op.
 *   - Gated like every native surface (`native-gate.ts`): flag off, or a central, and there is no
 *     native row at all.
 *
 * The pure half is `nativeControlSessions` / `nativeVerbCall`; the rest is the one I/O seam
 * (`engineFetch`), injected so the tests need no engine.
 */
import type { ControlSession, SessionState } from '@agentistics/tui/control'
import type { CliLang } from '../cli-lang'
import { cliStrings } from '../cli-i18n'

/** The engine's native session id (`ses_` + 32 hex). Nothing else on this machine has that shape. */
export function isNativeSessionId(id: string | undefined | null): id is string {
  return typeof id === 'string' && /^ses_[0-9a-f]{32}$/.test(id)
}

/** One record of the engine's list — the fields this file reads; only the id is required. */
export interface NativeListRecord {
  sessionId: string
  title?: string
  model?: string
  provider?: string
  status?: string
  cwd?: string
  createdAt?: string
  updatedAt?: string
  archivedAt?: string
  /** The engine's measured activity: `working` / `waiting-approval` / `waiting`. */
  activity?: string
}

export const NATIVE_HARNESS = 'agentistics'
export const NATIVE_LIST_PATH = '/api/runtime/sessions'
/** How many the fleet carries — the engine's newest, like the web workspace reads. */
export const NATIVE_LIST_LIMIT = 50

const OPEN_WORD: Record<CliLang, string> = { en: 'open', pt: 'aberta' }

/** PURE. The fleet's own state for a native record. */
export function nativeState(r: Pick<NativeListRecord, 'status' | 'activity'>): SessionState {
  if (r.status !== undefined && r.status !== 'open') return 'closed'
  if (r.activity === 'working') return 'working'
  if (r.activity === 'waiting-approval') return 'waiting-approval'
  if (r.activity === 'waiting') return 'waiting'
  return 'unknown'
}

function lastSegment(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

/** PURE. The engine's list → cockpit rows. Archived sessions are left out (the engine's own list hides them by default). */
export function nativeControlSessions(list: readonly NativeListRecord[], lang: CliLang, opts: { includeArchived?: boolean } = {}): ControlSession[] {
  const words = cliStrings(lang).sessState
  const out: ControlSession[] = []
  const seen = new Set<string>()
  for (const r of list) {
    if (!r || !isNativeSessionId(r.sessionId) || seen.has(r.sessionId) || (r.archivedAt && !opts.includeArchived)) continue
    seen.add(r.sessionId)
    const state = nativeState(r)
    const stateLabel = state === 'unknown' ? OPEN_WORD[lang]
      : state === 'working' ? words.working
      : state === 'waiting-approval' ? words.waitingApproval
      : state === 'waiting' ? words.waiting
      : words.closed
    const cwd = r.cwd ?? ''
    const project = cwd ? lastSegment(cwd) : ''
    const named = !!r.title?.trim()
    const title = r.title?.trim() || r.model || 'Agentistics'
    const started = ms(r.createdAt)
    const ended = state === 'closed' ? ms(r.updatedAt) : undefined
    out.push({
      id: r.sessionId,
      title,
      harness: NATIVE_HARNESS,
      cwd,
      project,
      ...(project ? { projectGroup: project } : {}),
      ...(named ? { named: true } : {}),
      ...(r.model ? { model: r.model } : {}),
      // A native session IS its conversation: the chat reads the session's own id.
      conversationId: r.sessionId,
      searchFields: { name: title, folder: cwd, harness: NATIVE_HARNESS, note: '', task: '', prompt: '' },
      state,
      stateLabel,
      // `actionable` = this machine hosts the row and its verbs apply. A closed native session is still
      // the engine's, and reopening it is one of those verbs.
      actionable: true,
      attached: false,
      ...(started !== undefined ? { startedAt: started } : {}),
      ...(ended !== undefined ? { endedAt: ended } : {}),
      // A closed native session reopens in place — the engine keeps its id (`resumeSession` routes it).
      ...(state === 'closed' ? { resume: { sessionId: r.sessionId, title } } : {}),
    })
  }
  return out
}

/** The lifecycle verbs a native session takes. `kill` is the fleet's word for END. */
export type NativeVerb = 'kill' | 'resume' | 'rename' | 'archive' | 'unarchive' | 'delete'

/** PURE. A verb → the engine call that performs it. */
export function nativeVerbCall(id: string, verb: NativeVerb, title?: string): { path: string; init: RequestInit } {
  const base = `${NATIVE_LIST_PATH}/${encodeURIComponent(id)}`
  const post = (p: string) => ({ path: `${base}/${p}`, init: { method: 'POST' } })
  switch (verb) {
    case 'kill': return post('end')
    case 'resume': return post('reopen')
    case 'archive': return post('archive')
    case 'unarchive': return post('unarchive')
    case 'delete': return { path: base, init: { method: 'DELETE' } }
    case 'rename': return {
      path: base,
      init: { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title ?? '' }) },
    }
  }
}

const SENTENCES = {
  en: {
    absent: 'The native Agentistics runtime is not available on this machine.',
    gated: 'The native Agentistics harness is experimental — turn it on with `agentop experimental enable`.',
    central: 'Native sessions do not run on a central.',
    ended: 'Session ended.',
    reopened: 'Session reopened.',
    renamed: 'Session renamed.',
    archived: 'Session archived.',
    unarchived: 'Session restored from the archive.',
    deleted: 'Session deleted.',
    refused: (status: number) => `The native runtime refused this (HTTP ${status}).`,
    noTitle: 'A name is required.',
  },
  pt: {
    absent: 'O runtime nativo do Agentistics não está disponível nesta máquina.',
    gated: 'O harness nativo do Agentistics é experimental — ative com `agentop experimental enable`.',
    central: 'Sessões nativas não rodam num central.',
    ended: 'Sessão encerrada.',
    reopened: 'Sessão reaberta.',
    renamed: 'Sessão renomeada.',
    archived: 'Sessão arquivada.',
    unarchived: 'Sessão restaurada do arquivo.',
    deleted: 'Sessão apagada.',
    refused: (status: number) => `O runtime nativo recusou isto (HTTP ${status}).`,
    noTitle: 'Um nome é obrigatório.',
  },
} as const

const DONE: Record<NativeVerb, keyof (typeof SENTENCES)['en']> = {
  kill: 'ended', resume: 'reopened', rename: 'renamed', archive: 'archived', unarchive: 'unarchived', delete: 'deleted',
}

/** PURE. The engine's answer → the host's `ActionResult`. An idempotent no-op (`ended: false`) is the engine's sentence, still `ok`. */
export function nativeVerbResult(verb: NativeVerb, status: number, body: unknown, lang: CliLang): { ok: boolean; message: string } {
  const t = SENTENCES[lang]
  const rec = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const sentence = typeof rec.sentence === 'string' && rec.sentence ? rec.sentence : ''
  if (status >= 200 && status < 300) return { ok: true, message: sentence || (t[DONE[verb]] as string) }
  if (status === 403 && rec.error === 'experimental') return { ok: false, message: t.gated }
  return { ok: false, message: sentence || t.refused(status) }
}

export type EngineAsk = (path: string, init?: RequestInit) => Promise<Response | null>

async function defaultAsk(path: string, init?: RequestInit): Promise<Response | null> {
  return (await import('../engine/load')).engineFetch(path, init)
}

async function gateOpen(opts: { central?: boolean; on?: boolean }): Promise<boolean> {
  if (opts.central) return false
  if (opts.on !== undefined) return opts.on
  const { nativeExperimentalOn } = await import('../native-gate')
  return nativeExperimentalOn()
}

/**
 * The native sessions as cockpit rows, or `[]`. Never throws: a failed read is an empty native half,
 * and the managed fleet beside it is untouched — one source failing must not blank the other.
 */
export async function loadNativeFleet(
  lang: CliLang,
  opts: { central?: boolean; on?: boolean; ask?: EngineAsk; includeArchived?: boolean } = {},
): Promise<ControlSession[]> {
  const central = opts.central ?? (await import('../config')).TEAM_CENTRAL
  if (!(await gateOpen({ central, ...(opts.on !== undefined ? { on: opts.on } : {}) }))) return []
  try {
    const res = await (opts.ask ?? defaultAsk)(`${NATIVE_LIST_PATH}?limit=${NATIVE_LIST_LIMIT}${opts.includeArchived ? '&archived=all' : ''}`)
    if (!res || !res.ok) return []
    const body = await res.json() as { sessions?: unknown }
    return Array.isArray(body?.sessions)
      ? nativeControlSessions(body.sessions as NativeListRecord[], lang, opts.includeArchived ? { includeArchived: true } : {})
      : []
  } catch {
    return []
  }
}

/** Perform a lifecycle verb on a native session. Always a sentence: the engine's, or why it could not be asked. */
export async function runNativeVerb(
  id: string,
  verb: NativeVerb,
  lang: CliLang,
  opts: { title?: string; central?: boolean; on?: boolean; ask?: EngineAsk } = {},
): Promise<{ ok: boolean; message: string }> {
  const t = SENTENCES[lang]
  const central = opts.central ?? (await import('../config')).TEAM_CENTRAL
  if (central) return { ok: false, message: t.central }
  if (!(await gateOpen({ ...(opts.on !== undefined ? { on: opts.on } : {}) }))) return { ok: false, message: t.gated }
  if (verb === 'rename' && !(opts.title ?? '').trim()) return { ok: false, message: t.noTitle }
  const call = nativeVerbCall(id, verb, opts.title?.trim())
  try {
    const res = await (opts.ask ?? defaultAsk)(call.path, call.init)
    if (!res) return { ok: false, message: t.absent }
    const body = await res.json().catch(() => null)
    return nativeVerbResult(verb, res.status, body, lang)
  } catch {
    return { ok: false, message: t.absent }
  }
}

/**
 * PURE. A CLI reference (`agentop session kill ses_6dc8`) → the one native session it names. Only a
 * reference that starts with the native prefix is a native one, so a managed handle can never be
 * captured here; a prefix shared by two sessions is AMBIGUOUS and names neither.
 */
export function resolveNativeRef(
  rows: readonly Pick<ControlSession, 'id' | 'title'>[],
  ref: string,
): { ok: true; id: string; title: string } | { ok: false; reason: 'not-native' | 'not-found' | 'ambiguous'; matches: string[] } {
  if (!ref.startsWith('ses_')) return { ok: false, reason: 'not-native', matches: [] }
  const exact = rows.find(r => r.id === ref)
  if (exact) return { ok: true, id: exact.id, title: exact.title }
  const hits = rows.filter(r => r.id.startsWith(ref))
  if (hits.length === 1) return { ok: true, id: hits[0]!.id, title: hits[0]!.title }
  return { ok: false, reason: hits.length === 0 ? 'not-found' : 'ambiguous', matches: hits.map(r => r.id) }
}
