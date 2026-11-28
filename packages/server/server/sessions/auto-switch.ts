/**
 * auto-switch.ts — CONTA.AUTO, the POLICY (PURE). A managed session that stopped on a usage limit moves, by itself, to
 * another account of the SAME harness that has room — once per limit episode — instead of sitting there until the
 * window opens (the overnight the owner reported: every leader stopped while another account had room).
 *
 * What it decides, in this order — each a plain answer, never a throw:
 *
 *  1. off / harness cannot move a conversation (`switchSupported`, by capability, not by name) → nothing;
 *  2. not limit-blocked → nothing, and the episode is over (`clear`: a later limit is a NEW episode);
 *  3. the reset is within `AUTO_MIN_RESET_MS` → wait, a move costs more than the wait (an UNKNOWN reset counts as far:
 *     codex says only "usage limit exceeded", a hard stop, and a session blocked on no clock is exactly the stuck one);
 *  4. this episode already acted on this account (moved from it, or said there is nobody) → nothing, never twice;
 *  5. candidates = the accounts the switch itself would accept (`options`: same harness, agentic, signed in, not the
 *     current one) that ALSO pass the budget thresholds (5 h < 85 %, week < 95 %), have a FRESH reading, and are ON
 *     for agents right now (`agentUse.on`: inside the schedule, or the override on); minus every account that already
 *     limited this conversation in this episode (the loop guard); and minus every account whose login the harness
 *     refused (`expired`: no room, ever, until re-signed in). The router's `freeSlots` is NOT a rule for a move
 *     (CONTA.AUTO-TROCA-REAL): it counts the room for one MORE session, and a move adds none — the session already
 *     runs, its load only changes account. Judged by slots, every account read `freeSlots: 0` whenever the fleet's
 *     pace was "over" (the normal state of a busy machine), and 25 of 30 real episodes said "nobody has room";
 *  6. the plan router's own policy (`pickAccount`, the one place it lives) chooses among them.
 *
 * QA round 1 (F1–F9): a move writes `seenAt` = the move's own time, and a limit line that is not NEWER than it is the copy
 * of the OLD account's limit, not a new one (a resumed conversation's transcript still ends with it); an unknown current
 * account takes no action; a scoped (per-model) account is judged on the session's model, or not at all; the words carry
 * the time zone; and a "nobody has room" session is RESUMED once, at the reset + 1 minute, so the notice is true.
 *
 * Unknown capacity is never room: an account with no budget row, a stale row, or no reading is not a candidate.
 *
 * Per-account "cap": for a NEW session (a hand-off successor) it is the one the plan router computes — `freeSlots` (the
 * slots left after the live sessions' MEASURED burn); an account measured to have none is out. A MOVE (`{ move: true }`)
 * is judged on the account's own windows and its agent switch only, for the reason in step 5.
 */
import { accountName, noticeSubject, pickAccount, switchFailureSentence, type AccountBudget, type HarnessId, type SwitchFailureKind, type SwitchOutcome } from '@agentistics/core'
import type { SwitchOption } from './account-switch'

export const AUTO_MIN_RESET_MS = 10 * 60_000
/** A timestamp-less limit line is ignored this long after a move (the resumed session has not answered yet). */
export const SETTLE_MS = 5 * 60_000
/** The one resume after a "nobody has room" stop is sent this long after the window opens. */
export const RESUME_AFTER_RESET_MS = 60_000
export const FIVE_HOUR_MAX_PCT = 85
export const WEEK_MAX_PCT = 95

/** What the policy remembers about ONE conversation's current limit episode. */
export interface AutoEpisode {
  /** The account the conversation ran on when this record was written. */
  account: string
  /** Every account that limited this conversation in this episode (and the one it left): never a target again. */
  tried: string[]
  /** The policy already acted on `account` (it said nobody has room): do not repeat it. */
  handled: boolean
  at: number
  /** The newest limit entry this episode accounts for: the move's own time after a move, the handled entry's time after a "none". */
  seenAt?: number
  /** When the move happened (epoch ms). */
  movedAt?: number
  /** A "nobody has room" stop with a known reset: the instant the single resume is due (reset + 1 min). */
  resumeAt?: number
  /** The single resume was sent. */
  resumedAt?: number
  /** The last switch that FAILED in this episode, with the reason it gave: kept because a server log rotates. */
  failure?: { target: string; message: string; at: number }
}

export interface AutoInput {
  enabled: boolean
  now: number
  harness: HarnessId
  supported: boolean
  /** The account the session runs on now (registry id), when known. */
  currentAccount?: string
  /** `null`: the conversation is NOT limit-blocked. `resetsAt` is epoch ms, when the harness said; `at` is the limit entry's own time. */
  limit: { resetsAt?: number; at?: number } | null
  /** The session's model (registry), for a per-model limit: a scoped account is judged on the group that holds it. */
  model?: string
  /** Accounts already given a session THIS tick (the budgets were read once): at most one entry per account per tick. */
  takenThisTick?: ReadonlySet<string>
  /** The accounts the switch would accept as a target (`listSwitchTargets(..., agentCaller: true).options`). */
  options: readonly SwitchOption[]
  /** The agent-visible plan budgets (`planLimitsPayload().budgets`), one row per account. */
  budgets: readonly AccountBudget[]
  /**
   * Accounts whose login the harness refused (HOTFIX.LOGIN-EXPIRADO). Never a target, whatever their
   * budget says: a meter read before the token expired still shows room, and a move onto one ends the
   * session for a pane that can only print "Please run /login". `options` already leaves them out;
   * this is the policy's own guard, so the rule holds even when a caller's options are stale.
   */
  expired?: ReadonlySet<string>
  episode?: AutoEpisode | undefined
}

export type AutoWhy = 'disabled' | 'unsupported' | 'reset_soon' | 'already_handled' | 'stale_limit' | 'unknown_account'
export type AutoDecision =
  | { kind: 'skip'; why: AutoWhy }
  | { kind: 'clear' }
  | { kind: 'move'; target: SwitchOption; resetsAt?: number; episode: AutoEpisode }
  | { kind: 'none'; resetsAt?: number; episode: AutoEpisode }

/** The budget row as `planLimitsPayload` serves it: the agent switch's live verdict rides along (schedule / override). */
type BudgetRow = AccountBudget & { agentUse?: { on: boolean } }

/** How a row is judged: a NEW session needs a free slot; a `move` carries a running session and adds none. */
export interface RoomOpts { move?: boolean }

/**
 * PURE. May a budget row take work now for `model`? Fresh, registered, startable, on for agents (schedule or override),
 * not yielding to a fresher reading, under both thresholds — and, for a NEW session only, a slot left.
 */
export function hasRoom(b: BudgetRow, model?: string, opts: RoomOpts = {}): boolean {
  if (b.stale || b.spawnable === false || b.plan === 'unregistered' || b.status === 'hold') return false
  if (b.agentUse?.on === false || b.yieldsTo !== undefined) return false
  if (!Number.isFinite(b.fiveHourPct) || !Number.isFinite(b.weekPct)) return false
  if (b.fiveHourPct >= FIVE_HOUR_MAX_PCT) return false
  let weekPct = b.weekPct
  let freeSlots = b.freeSlots
  let measured = b.freeSlotsMeasured
  if (b.scopes?.length) {
    // A per-model limit (Opus weekly, a Gemini group…): the number that counts is the model's own group. Without the
    // session's model there is no number for it, so the account is NOT room for that model.
    const m = model?.toLowerCase()
    const sb = m ? b.scopes.find(x => x.scope.models.some(n => n.toLowerCase() === m || m.includes(n.toLowerCase()) || n.toLowerCase().includes(m))) : undefined
    if (!sb || sb.status === 'hold' || !Number.isFinite(sb.weekPct)) return false
    weekPct = sb.weekPct
    freeSlots = sb.freeSlots
    measured = typeof sb.freeSlots === 'number' ? b.freeSlotsMeasured : undefined
  }
  if (weekPct >= WEEK_MAX_PCT) return false
  if (!opts.move && measured === true && typeof freeSlots === 'number' && freeSlots < 1) return false
  return true
}

/** PURE. The row of an account (an unscoped record; a scoped one carries its top-level numbers). */
const rowOf = (budgets: readonly AccountBudget[], harness: HarnessId, id: string): AccountBudget | undefined =>
  budgets.find(b => b.harness === harness && b.account === id)

/** PURE. The account the router would put a new worker on, among `ids` that have room — or none. */
export function bestAccount(harness: HarnessId, ids: readonly string[], budgets: readonly AccountBudget[], model?: string, opts: RoomOpts = {}): string | undefined {
  const rows = ids.map(id => rowOf(budgets, harness, id)).filter((r): r is AccountBudget => !!r && hasRoom(r, model, opts))
  return pickAccount(rows)?.account
}

export function decideAutoSwitch(i: AutoInput): AutoDecision {
  if (!i.enabled) return { kind: 'skip', why: 'disabled' }
  if (!i.supported) return { kind: 'skip', why: 'unsupported' }
  if (!i.limit) return { kind: 'clear' }
  // With no known current account the policy cannot tell the session's own account from another: no action (QA F4).
  if (!i.currentAccount) return { kind: 'skip', why: 'unknown_account' }
  const current = i.currentAccount
  const resetsAt = i.limit.resetsAt
  if (resetsAt !== undefined && resetsAt - i.now <= AUTO_MIN_RESET_MS) return { kind: 'skip', why: 'reset_soon' }
  const ep = i.episode
  if (ep && ep.account === current) {
    // A limit entry that is not NEWER than what the episode already accounts for is the same stop, or the copy of the old
    // account's limit in a resumed transcript (QA F1) — never a new limit.
    if (i.limit.at !== undefined && ep.seenAt !== undefined) {
      if (i.limit.at <= ep.seenAt) return { kind: 'skip', why: ep.handled ? 'already_handled' : 'stale_limit' }
    } else if (ep.handled) return { kind: 'skip', why: 'already_handled' }
    else if (ep.movedAt !== undefined && i.now - ep.movedAt < SETTLE_MS) return { kind: 'skip', why: 'stale_limit' }
  }
  const tried = new Set([...(ep?.tried ?? []), current])
  const candidates = i.options.filter(o => o.harness === i.harness && !tried.has(o.id) && !i.takenThisTick?.has(o.id) && !i.expired?.has(o.id))
  const pick = bestAccount(i.harness, candidates.map(o => o.id), i.budgets, i.model, { move: true })
  const target = candidates.find(o => o.id === pick)
  const when = resetsAt !== undefined ? { resetsAt } : {}
  if (target) {
    return { kind: 'move', target, ...when, episode: { account: target.id, tried: [...tried], handled: false, at: i.now, seenAt: i.now, movedAt: i.now } }
  }
  // Nobody has room: stay, and (reset known) resume the session ONCE when its window opens.
  const episode: AutoEpisode = {
    account: current, tried: [...tried], handled: true, at: i.now,
    // The failed switch's own words outlive the tick that runs out of targets: it is the only durable record of them.
    ...(ep?.failure ? { failure: ep.failure } : {}),
    ...(i.limit.at !== undefined ? { seenAt: i.limit.at } : {}),
    ...(resetsAt !== undefined ? { resumeAt: resetsAt + RESUME_AFTER_RESET_MS } : {}),
  }
  return { kind: 'none', ...when, episode }
}

/** PURE. Is the single resume of a "nobody has room" stop due now? */
export function resumeDue(ep: AutoEpisode | undefined, now: number): boolean {
  return !!ep && ep.handled && ep.resumeAt !== undefined && ep.resumedAt === undefined && now >= ep.resumeAt
}

// ── The words (owner-facing, plain, pt + en) ───────────────────────────────────────────────────────────

/** `15:00 BRT`: the time WITH its zone (the server's own; there is no zone preference). `tz` is for tests and a future preference. */
export function clock(ms: number | undefined, lang: 'en' | 'pt', tz?: string): string {
  if (ms === undefined) return lang === 'pt' ? 'sem previsão' : 'no reset time given'
  return new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', ...(tz ? { timeZone: tz } : {}),
  }).format(new Date(ms)).replace(/^(\d{2}:\d{2}) /, '$1 ')
}

export interface AutoWords { title: string; message: string; comment?: string }

/**
 * The notice (and, for a move, the board comment) — `from`/`to` are account labels. A "none" notice promises only what the
 * policy does: with a known reset the session is resumed once (reset + 1 min); without one it says nobody can tell when.
 */
export function autoSwitchWords(o: { kind: 'move' | 'none' | 'deferred' | 'failed'; lang: 'en' | 'pt'; /** The session's NAME, empty when nobody named it (never an id). */ session: string; harness?: string; from: string; to?: string; resetsAt?: number; tz?: string; /** `failed`: which sentence, and what became of the session. Raw error text never comes here. */ failure?: { kind: SwitchFailureKind; outcome: SwitchOutcome } }): AutoWords {
  const pt = o.lang === 'pt'
  const until = clock(o.resetsAt, o.lang, o.tz)
  const who = noticeSubject(o.lang, o.session, o.harness)
  const from = accountName(o.lang, o.from)
  const to = accountName(o.lang, o.to)
  if (o.kind === 'failed') {
    const reason = switchFailureSentence(o.lang, o.failure?.kind, o.failure?.outcome)
    return pt
      ? { title: 'Troca de conta falhou', message: `${who} parou no limite da conta ${from} e a troca para ${to} falhou. ${reason}`, comment: `Troca de conta de ${from} para ${to} falhou: ${reason}` }
      : { title: 'Account switch failed', message: `${who} stopped at the limit of account ${from} and the switch to ${to} failed. ${reason}`, comment: `Account switch from ${from} to ${to} failed: ${reason}` }
  }
  if (o.kind === 'move') {
    return pt
      ? { title: 'Conta trocada', message: `${who} parou no limite da conta ${from} (volta às ${until}) e continua na conta ${to}, de onde parou.`, comment: `Conta trocada de ${from} para ${to}: limite até ${until}` }
      : { title: 'Account switched', message: `${who} stopped at the limit of account ${from} (back at ${until}) and carries on with account ${to}, where it left off.`, comment: `Account switched from ${from} to ${to}: limit until ${until}` }
  }
  if (o.kind === 'deferred') {
    return pt
      ? { title: 'Troca de conta adiada', message: `${who} está no limite da conta ${from}, mas ela está em uso agora: a troca de conta espera terminar, para não cortar o que a usa.` }
      : { title: 'Account switch deferred', message: `${who} is at the limit of account ${from}, but it is in use right now: the account switch waits until that ends, so nothing in use is cut off.` }
  }
  if (o.resetsAt === undefined) {
    return pt
      ? { title: 'Sessão parada no limite', message: `${who} parou no limite da conta ${from} e nenhuma outra conta tem folga agora. Não há previsão de quando a conta volta: ela só continua quando você mandar uma mensagem.` }
      : { title: 'Session stopped at the limit', message: `${who} stopped at the limit of account ${from} and no other account has room right now. There is no sign of when the account comes back: it only carries on when you send it a message.` }
  }
  return pt
    ? { title: 'Sessão parada no limite', message: `${who} parou no limite da conta ${from} e nenhuma outra conta tem folga agora. A janela abre às ${until}; um minuto depois o agentistics reenvia a última mensagem, uma única vez.` }
    : { title: 'Session stopped at the limit', message: `${who} stopped at the limit of account ${from} and no other account has room right now. The window opens at ${until}; a minute later agentistics re-sends the last message, once.` }
}

// ── The hand-off's account (B) ─────────────────────────────────────────────────────────────────────────

/**
 * PURE. The account a leader's hand-off successor starts on when no `--account` was given: the router's pick among the
 * accounts of the harness that have room — NEVER the predecessor's own while it is limit-blocked. When NOBODY has room it is
 * the usable account whose window reopens soonest (`room: false`, the caller says so): a hand-off is never left on the
 * limited predecessor account by default. `undefined`: no usable account but the predecessor's (the ordinary rule decides).
 */
export function handoffAccount(o: {
  harness: HarnessId
  /** The ids a fresh spawn would accept (`decideSpawnAccount` would not refuse them): agentic, signed in, not retired. */
  usable: readonly string[]
  budgets: readonly AccountBudget[]
  predecessor?: { account?: string; limited: boolean }
  model?: string
}): { id: string; room: boolean; resetsAt?: number } | undefined {
  const pred = o.predecessor
  const out = o.usable.filter(id => !(pred?.limited && id === pred.account))
  const best = bestAccount(o.harness, out, o.budgets, o.model)
  if (best) return { id: best, room: true }
  const rows = out.map(id => rowOf(o.budgets, o.harness, id)).filter((r): r is AccountBudget => !!r && !r.stale && r.plan !== 'unregistered' && r.spawnable !== false)
  const soonest = [...rows].sort((a, b) => (a.weekResetsAt > 0 ? a.weekResetsAt : Infinity) - (b.weekResetsAt > 0 ? b.weekResetsAt : Infinity))[0]
  return soonest?.account ? { id: soonest.account, room: false, ...(soonest.weekResetsAt > 0 ? { resetsAt: soonest.weekResetsAt } : {}) } : undefined
}
