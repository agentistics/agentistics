/**
 * nativeFleetRow.ts — PURE (UI.UNIFY): a NATIVE Agentistics session as an ordinary FLEET row.
 *
 * Owner, 2026-10-03: the native session "should never have been different" — it had its own aside
 * section ("AGENTISTICS"), its own row (orange mark, model on the right, no state, no time, no cost)
 * and its own page. A native session is a session: it belongs in the same list, under the same
 * grouping, with the same state chip, the same menu and the same counts, and opens in the same
 * shell. The harness is said ONCE, by the standard `HarnessMark`, like every other harness.
 *
 * So this file maps the engine's list (`GET /api/runtime/sessions`) plus the board's filings
 * (`GET /api/tasks/native-filings`) into the two shapes the fleet already carries — `FleetRow` (the
 * panel's) and `ControlSession` (the arrangement's, read by `session-fleet.ts`) — and `fleet.ts`
 * appends them to the poll. Nothing downstream has a branch for "native": that is the point.
 *
 * WHAT IS SAID, AND WHAT IS NOT INVENTED:
 *   - The state is the engine's MEASURED activity (H17): `working`, `waiting-approval`, `waiting`.
 *     An open session this engine process has not measured is `unknown`, labelled "open" — the very
 *     rule `nativeSummaryState` applies to the summary line: active, never working or needing you on
 *     a guess. Any other status (ended) is `closed`.
 *   - Cost and tokens come from the engine's own snapshot on the board, and ONLY for a filed session.
 *     An unfiled one carries no figure — absent, never a confident `$0`.
 *   - The verbs are the fleet's own: rename / stop / reopen go to the engine's lifecycle routes
 *     (`nativeFleet.ts`), `task` opens `SessionFiling` (which already routes a native id to the
 *     engine's filing), and the one the runtime has no notion of (`note`) is LISTED disabled WITH
 *     its reason, exactly as a fleet row's refused verbs are — a menu that drops verbs reads as broken.
 */
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetRow, FleetVerb } from './fleet'
import { NATIVE_HARNESS_ID } from './nativeSession'

/** One record of the engine's list — the fields this file reads, all of them optional but the id. */
export interface NativeListRecord {
  sessionId: string
  title?: string
  model?: string
  provider?: string
  status?: string
  cwd?: string
  createdAt?: string
  updatedAt?: string
  /** H17: `working` / `waiting-approval` / `waiting`, once the engine has seen a run of it. */
  activity?: string
}

/** Where a native session is filed, with the engine's own usage snapshot when it reported one. */
export interface NativeFilingFacts {
  taskId: string
  taskTitle: string
  subtaskId?: string
  costUSD?: number
  tokens?: number
}

type State = FleetRow['state']

const STATE_WORD: Record<'pt' | 'en', Record<State, string>> = {
  en: { working: 'working', 'waiting-approval': 'needs approval', waiting: 'needs you', exited: 'off', lost: 'off', closed: 'off', unknown: 'external' },
  pt: { working: 'trabalhando', 'waiting-approval': 'precisa de aprovação', waiting: 'precisa de você', exited: 'encerrada', lost: 'desconectada', closed: 'fechada', unknown: 'externa' },
}

const VERB_WORD: Record<'pt' | 'en', Record<'rename' | 'note' | 'task' | 'resume' | 'kill' | 'interrupt', string>> = {
  en: { rename: 'Rename', note: 'Note', task: 'Task', resume: 'Reopen', kill: 'Stop session', interrupt: 'Stop what it is doing' },
  pt: { rename: 'Renomear', note: 'Nota', task: 'Tarefa', resume: 'Reabrir', kill: 'Encerrar sessão', interrupt: 'Parar o que está fazendo' },
}

const NOT_YET: Record<'pt' | 'en', string> = {
  en: 'The native Agentistics runtime does not offer this yet.',
  pt: 'O runtime nativo do Agentistics ainda não oferece isto.',
}

const OPEN_ALREADY = { en: 'This session is open — there is nothing to reopen.', pt: 'Esta sessão está aberta — não há o que reabrir.' } as const
const ENDED_ALREADY = { en: 'This session has already ended.', pt: 'Esta sessão já foi encerrada.' } as const

const OPEN_WORD: Record<'pt' | 'en', string> = { en: 'open', pt: 'aberta' }

/** The fleet's own state for a native record. */
export function nativeState(r: Pick<NativeListRecord, 'status' | 'activity'>): State {
  if (r.status !== undefined && r.status !== 'open') return 'closed'
  if (r.activity === 'working') return 'working'
  if (r.activity === 'waiting-approval') return 'waiting-approval'
  if (r.activity === 'waiting') return 'waiting'
  // Open, and this engine process has not measured it (H17's `unknown`, `nativeSummaryState`): it
  // counts as active, never as working or as needing you — nothing measured either.
  return 'unknown'
}

/** The last path segment — the "by project" key, the same rule the host's `projectName` applies. */
export function projectOf(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

/** `0.42` -> `$0.42`, the compact shape the fleet's `cost` cell carries. */
function costText(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

function tokensText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

/** The pair the fleet carries for ONE native session. */
export function nativeFleetEntry(
  r: NativeListRecord,
  filing: NativeFilingFacts | undefined,
  lang: 'pt' | 'en',
): { row: FleetRow; session: ControlSession } {
  const state = nativeState(r)
  // `unknown` here is not "external" (that word belongs to the CLI fleet): it is open and unmeasured.
  const stateLabel = state === 'unknown' ? OPEN_WORD[lang] : STATE_WORD[lang][state]
  const cwd = r.cwd ?? ''
  const project = cwd ? projectOf(cwd) : ''
  const title = r.title?.trim() || r.model || 'Agentistics'
  const open = state !== 'closed'
  const words = VERB_WORD[lang]
  const off = (action: FleetVerb['action'], label: string): FleetVerb => ({ action, label, enabled: false, reason: NOT_YET[lang] })
  // The engine's lifecycle (`PATCH /:id`, `POST /:id/end|reopen`) — `fleet.ts` routes a native id
  // there. On an engine that predates those routes the refusal comes back as the engine's own
  // sentence, which is what any refused verb says.
  const verbs: FleetVerb[] = [
    { action: 'rename', label: words.rename, enabled: true },
    off('note', words.note),
    { action: 'task', label: words.task, enabled: true },
    open ? { action: 'resume', label: words.resume, enabled: false, reason: OPEN_ALREADY[lang] } : { action: 'resume', label: words.resume, enabled: true },
    open ? { action: 'kill', label: words.kill, enabled: true } : { action: 'kill', label: words.kill, enabled: false, reason: ENDED_ALREADY[lang] },
    // Stopping a TURN is something the native runtime does (cancel the run) — through the chat's
    // own stop button, which knows the run id. The row's verb would have none to name.
    off('interrupt', words.interrupt),
  ]
  const row: FleetRow = {
    id: r.sessionId,
    title,
    harness: NATIVE_HARNESS_ID,
    cwd,
    project,
    state,
    stateLabel,
    actionable: open,
    ...(filing ? { task: filing.taskTitle } : {}),
    ...(r.model ? { model: r.model } : {}),
    // A native session IS its conversation: the id the chat reads is the session's own.
    conversationId: r.sessionId,
    attachCommand: '',
    verbs,
  }
  const started = ms(r.createdAt)
  const session: ControlSession = {
    id: r.sessionId,
    title,
    harness: NATIVE_HARNESS_ID,
    cwd,
    project,
    ...(project ? { projectGroup: project } : {}),
    ...(r.title?.trim() ? { named: true } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(filing ? { task: filing.taskTitle, taskId: filing.taskId } : {}),
    conversationId: r.sessionId,
    ...(filing?.tokens !== undefined ? { tokens: tokensText(filing.tokens) } : {}),
    ...(filing?.costUSD !== undefined ? { cost: costText(filing.costUSD) } : {}),
    searchFields: {
      name: title,
      folder: cwd,
      harness: NATIVE_HARNESS_ID,
      note: '',
      task: filing?.taskTitle ?? '',
      prompt: '',
    },
    state,
    stateLabel,
    actionable: open,
    attached: false,
    ...(started !== undefined ? { startedAt: started } : {}),
    ...(!open && ms(r.updatedAt) !== undefined ? { endedAt: ms(r.updatedAt)! } : {}),
  }
  return { row, session }
}

/** Every native session, in the engine's order (newest first). */
export function nativeFleetEntries(
  list: readonly NativeListRecord[],
  filings: Readonly<Record<string, NativeFilingFacts>>,
  lang: 'pt' | 'en',
): { rows: FleetRow[]; sessions: ControlSession[]; measuredWaiting: string[] } {
  const rows: FleetRow[] = []
  const sessions: ControlSession[] = []
  const measuredWaiting: string[] = []
  for (const r of list) {
    if (typeof r?.sessionId !== 'string' || r.sessionId === '') continue
    const e = nativeFleetEntry(r, filings[r.sessionId], lang)
    rows.push(e.row)
    sessions.push(e.session)
    if (e.session.state === 'waiting' || e.session.state === 'waiting-approval') measuredWaiting.push(r.sessionId)
  }
  return { rows, sessions, measuredWaiting }
}

/**
 * The fleet with the native sessions folded in. An id the fleet already carries wins (it cannot
 * happen today — a native id is `ses_…` and a fleet id is not — but a row must never appear twice).
 */
export function withNativeSessions<P extends { sessions: FleetRow[]; rows: ControlSession[]; attention: number }>(
  payload: P,
  native: { rows: FleetRow[]; sessions: ControlSession[]; measuredWaiting: string[] },
): P {
  if (native.rows.length === 0) return payload
  const have = new Set(payload.sessions.map(s => s.id))
  const rows = native.rows.filter(r => !have.has(r.id))
  const sessions = native.sessions.filter(s => !have.has(s.id))
  // Only a MEASURED wait counts toward "N waiting on you" — an unmeasured open session is `unknown`.
  const attention = native.measuredWaiting.filter(id => !have.has(id)).length
  return {
    ...payload,
    sessions: [...payload.sessions, ...rows],
    rows: [...payload.rows, ...sessions],
    attention: payload.attention + attention,
  }
}
