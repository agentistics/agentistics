/**
 * awayMode.ts — PURE. "Away mode": the owner is out (asleep, travelling) and the fleet should carry
 * on without asking them. The state is stored by the server (`server/away.ts`, preferences key
 * `away`); this module holds its shape, its validation and every word a session is told, so the
 * browser, the MCP door, the CLI and the spawn briefing cannot disagree.
 *
 * Expiry is LAZY: nothing rewrites the stored state when `until` passes — every reader asks
 * `awayActive(state, now)`, so an expired state simply reads as off.
 */

import { HARNESS_ORDER, type HarnessId } from './types'

/** The closed list of things the owner can pre-authorise while away. */
export const AWAY_AUTH_IDS = ['releases', 'workers', 'merges'] as const
export type AwayAuthId = (typeof AWAY_AUTH_IDS)[number]

export const isAwayAuthId = (v: unknown): v is AwayAuthId => (AWAY_AUTH_IDS as readonly unknown[]).includes(v)

export interface AwayState {
  on: boolean
  /** ISO instant the state was last switched on (or off). */
  since: string
  /** ISO instant the away period ends; `null` = until the owner says they are back. */
  until: string | null
  authorised: AwayAuthId[]
  /** Free text the owner adds (≤ `AWAY_NOTE_MAX`). */
  note?: string
  /** Ceiling of worker sessions running at once (a cap ABOVE plan_limits' cadence.parallel). */
  maxWorkers: number
  /**
   * Ceiling, PER PROVIDER (harness), of workers running on that provider's top model tier at once —
   * Claude's Opus, Codex's top GPT tier, Gemini Pro, … A harness with no entry takes
   * `AWAY_DEFAULT_TOP_CAP`, the same for every provider (no harness gets a default of its own).
   * Replaces the old Claude-only `maxOpus`, which `parseAwayState` migrates into `topCaps.claude`.
   */
  topCaps: AwayTopCaps
}

export type AwayTopCaps = Partial<Record<HarnessId, number>>

export const AWAY_NOTE_MAX = 500
/** Owner defaults (08/10: at most 6 workers, at most 2 on the top model); the activation dialog can change them. */
export const AWAY_DEFAULT_MAX_WORKERS = 6
/** The top-model ceiling of a provider with no entry of its own — equal for every harness. */
export const AWAY_DEFAULT_TOP_CAP = 2

/** What "the top model tier" means for each provider, as a person reads it (and the briefing names it). */
export const AWAY_TOP_MODEL: Record<HarnessId, { en: string; pt: string }> = {
  claude: { en: 'Opus / Fable', pt: 'Opus / Fable' },
  codex: { en: 'top GPT tier', pt: 'GPT de topo' },
  gemini: { en: 'Gemini Pro', pt: 'Gemini Pro' },
  copilot: { en: 'premium models', pt: 'modelos premium' },
  antigravity: { en: 'top model', pt: 'modelo de topo' },
  kimi: { en: 'top model', pt: 'modelo de topo' },
  opencode: { en: 'top model', pt: 'modelo de topo' },
}

const isHarness = (v: string): v is HarnessId => (HARNESS_ORDER as readonly string[]).includes(v)

/** The top-model ceiling `s` sets for `harness` (its own entry, else the shared default), never above `maxWorkers`. */
export function awayTopCap(s: Pick<AwayState, 'topCaps' | 'maxWorkers'>, harness: HarnessId): number {
  return Math.min(s.topCaps[harness] ?? AWAY_DEFAULT_TOP_CAP, s.maxWorkers)
}
export const AWAY_MAX_CEILING = 12
/** Below this much free RAM a leader pauses one worker (the machine crashed with 4 workers on 09/10). */
export const AWAY_MIN_FREE_RAM_GB = 2

/** The model-facing phrase for each authorisation (English: the model reads it). */
export const AWAY_AUTH_TEXT: Record<AwayAuthId, string> = {
  releases: 'publish releases the leader has approved (QA green)',
  workers: 'open worker sessions within the plan limits',
  merges: 'merge PRs the leader has reviewed',
}

/** The UI labels (a person reads them). */
export const AWAY_AUTH_LABEL: Record<AwayAuthId, { en: string; pt: string }> = {
  releases: { en: 'Releases the leader approves', pt: 'Releases que o líder aprovar' },
  workers: { en: 'Open worker sessions', pt: 'Abrir sessões de workers' },
  merges: { en: 'Merge PRs the leader reviewed', pt: 'Merge de PRs revisados pelo líder' },
}

export const AWAY_OFF: AwayState = { on: false, since: '', until: null, authorised: [], maxWorkers: AWAY_DEFAULT_MAX_WORKERS, topCaps: {} }

function ceiling(v: unknown, fallback: number): number | null {
  if (v === undefined || v === null) return fallback
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= AWAY_MAX_CEILING ? v : null
}

/**
 * Reads a `topCaps` map, plus the legacy Claude-only `maxOpus`. `strict` refuses (null) an unknown
 * harness or an out-of-range value; otherwise those entries are dropped. Every value is clamped to
 * `maxWorkers`. A legacy `maxOpus` fills `claude` only when `topCaps` does not already name it.
 */
function readTopCaps(raw: unknown, legacyMaxOpus: unknown, maxWorkers: number, strict: boolean): AwayTopCaps | null {
  const out: AwayTopCaps = {}
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) return strict ? null : {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = ceiling(v, AWAY_DEFAULT_TOP_CAP)
      if (!isHarness(k) || n === null || v === undefined || v === null) {
        if (strict) return null
        continue
      }
      if (strict && n > maxWorkers) return null
      out[k] = Math.min(n, maxWorkers)
    }
  }
  if (out.claude === undefined && legacyMaxOpus !== undefined && legacyMaxOpus !== null) {
    const n = ceiling(legacyMaxOpus, AWAY_DEFAULT_TOP_CAP)
    if (n === null || (strict && n > maxWorkers)) { if (strict) return null }
    else out.claude = Math.min(n, maxWorkers)
  }
  return out
}

/** True while the owner is away: switched on and not past `until`. */
export function awayActive(s: AwayState | null | undefined, now: number): boolean {
  if (!s || s.on !== true) return false
  if (s.until === null) return true
  const t = Date.parse(s.until)
  return Number.isFinite(t) && t > now
}

/** Reads a stored value defensively (preferences.json is hand-editable). Anything malformed reads as off. */
export function parseAwayState(v: unknown): AwayState {
  if (!v || typeof v !== 'object') return AWAY_OFF
  const o = v as Record<string, unknown>
  const until = typeof o.until === 'string' && Number.isFinite(Date.parse(o.until)) ? o.until : null
  const authorised = Array.isArray(o.authorised) ? [...new Set(o.authorised.filter(isAwayAuthId))] : []
  const note = typeof o.note === 'string' && o.note.trim() !== '' ? o.note.trim().slice(0, AWAY_NOTE_MAX) : undefined
  const maxWorkers = ceiling(o.maxWorkers, AWAY_DEFAULT_MAX_WORKERS) ?? AWAY_DEFAULT_MAX_WORKERS
  const topCaps = readTopCaps(o.topCaps, o.maxOpus, maxWorkers, false) ?? {}
  return {
    on: o.on === true,
    since: typeof o.since === 'string' ? o.since : '',
    until,
    authorised,
    ...(note ? { note } : {}),
    maxWorkers,
    topCaps,
  }
}

export type AwayInputError = 'on_required' | 'bad_until' | 'until_in_past' | 'unknown_authorisation' | 'note_too_long' | 'bad_ceiling'

/**
 * Validates a write. `on` is required; turning OFF keeps nothing else. `until` is an ISO instant in
 * the future or null/absent ("until I'm back"); an unknown authorisation is REFUSED, never dropped —
 * a caller that thinks it granted something must learn it did not.
 */
export function normalizeAwayInput(body: unknown, now: number): { ok: true; state: AwayState } | { ok: false; error: AwayInputError; detail?: string } {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof o.on !== 'boolean') return { ok: false, error: 'on_required' }
  const since = new Date(now).toISOString()
  if (!o.on) return { ok: true, state: { ...AWAY_OFF, since } }
  let until: string | null = null
  if (o.until !== undefined && o.until !== null && o.until !== '') {
    if (typeof o.until !== 'string' || !Number.isFinite(Date.parse(o.until))) return { ok: false, error: 'bad_until', detail: String(o.until) }
    const t = Date.parse(o.until)
    if (t <= now) return { ok: false, error: 'until_in_past', detail: o.until }
    until = new Date(t).toISOString()
  }
  const raw = o.authorised === undefined ? [] : Array.isArray(o.authorised) ? o.authorised : [o.authorised]
  const bad = raw.find(a => !isAwayAuthId(a))
  if (bad !== undefined) return { ok: false, error: 'unknown_authorisation', detail: String(bad) }
  const authorised = AWAY_AUTH_IDS.filter(id => raw.includes(id))
  const note = typeof o.note === 'string' ? o.note.trim() : ''
  if (note.length > AWAY_NOTE_MAX) return { ok: false, error: 'note_too_long' }
  const maxWorkers = ceiling(o.maxWorkers, AWAY_DEFAULT_MAX_WORKERS)
  if (maxWorkers === null) return { ok: false, error: 'bad_ceiling' }
  // `maxOpus` is still accepted from an older client and lands in `topCaps.claude`.
  const topCaps = readTopCaps(o.topCaps, o.maxOpus, maxWorkers, true)
  if (topCaps === null) return { ok: false, error: 'bad_ceiling' }
  return { ok: true, state: { on: true, since, until, authorised, ...(note ? { note } : {}), maxWorkers, topCaps } }
}

/** "on the top model of each provider at once: claude (Opus / Fable) ≤ 1, codex (top GPT tier) ≤ 2; any other provider ≤ 2". */
export function topCapsText(s: Pick<AwayState, 'topCaps' | 'maxWorkers'>): string {
  const named = HARNESS_ORDER.filter(h => s.topCaps[h] !== undefined).map(h => `${h} (${AWAY_TOP_MODEL[h].en}) ≤ ${awayTopCap(s, h)}`)
  const rest = `${named.length > 0 ? 'any other provider' : 'every provider'} ≤ ${Math.min(AWAY_DEFAULT_TOP_CAP, s.maxWorkers)}`
  return `at most this many of them on a provider's top model tier at once: ${[...named, rest].join(', ')}`
}

function untilText(s: AwayState): string {
  return s.until === null ? 'until they say they are back' : `until ${s.until}`
}

function authText(s: AwayState): string {
  const list = s.authorised.map(a => AWAY_AUTH_TEXT[a])
  const base = list.length > 0 ? list.join('; ') : 'nothing beyond the rules below'
  return s.note ? `${base}; owner's note: ${s.note}` : base
}

export interface AwayBriefingOptions {
  /** True when the briefing already carries the plan-limits rule (agentistics_plan_limits is
   *  available): the away line then POINTS at it instead of repeating it. */
  planLimitsInBriefing?: boolean
}

/** The plan-limits rule, worded as the base briefing words it (`briefing.ts`) — used only when the
 *  base briefing could not print it, so it is never said twice. */
const PLAN_LIMITS_RULE = 'before opening sessions read agentistics_plan_limits and follow its recommendation: keep cadence.parallel workers running; if paceStatus is under, pull work from the queue; hold only when the 5-hour window is at least 85% (short pause until renewal); the weekly quota is not a brake unless it is at least 95%'

/**
 * The briefing line(s) for a session being started while the owner is away. Empty when inactive —
 * a session started after `until` is never told the owner is out. A LEADER gets four lines (scope,
 * pacing, quality, communication): away mode must make a leader run the fleet at least as carefully
 * as when the owner is watching — never burn tokens without producing.
 */
export function awayBriefingLines(
  s: AwayState | null | undefined,
  role: 'leader' | 'worker' | undefined,
  now: number,
  o: AwayBriefingOptions = {},
): string[] {
  if (!s || !awayActive(s, now)) return []
  const head = `AWAY MODE — the owner is away ${untilText(s)}.`
  if (role === 'leader') {
    const pacing = o.planLimitsInBriefing
      ? 'apply the agentistics_plan_limits rule above (cadence.parallel, paceStatus, 85% / 95%) before EVERY dispatch, not only the first'
      : PLAN_LIMITS_RULE
    const releases = s.authorised.includes('releases')
      ? 'release only work that passed QA and that you approved, bundled into one release per batch'
      : 'releases wait for the owner'
    return [
      `${head} Pre-authorised: ${authText(s)}. These authorisations stand in for the owner's approval wherever the rules below ask for it; anything outside them waits in the hand-off file for their return.`,
      `Away pacing (do not burn tokens without producing): ${pacing}. Never run more than ${s.maxWorkers} workers at once; ${topCapsText(s)}; pause one worker when free RAM drops under ${AWAY_MIN_FREE_RAM_GB} GB. Pick each model by the task, per the model-balance rule (strongest tier: design, coordination, hard bugs; mid tier: scoped implementation; light tier: probes), on whichever provider has room.`,
      `Away quality: QA by a different model from the author, tests only in throwaway runs (agentop run --rm); ${releases}.`,
      "Away communication: never end a turn on a question to the owner — decide within the authorisations, record each decision (task comment or hand-off file) and keep going. A warning or decision that cannot wait goes to the owner as a notice (agentistics_session_away with `notice`, shown in their bell and Nay), never as a question that blocks the turn. At a hand-off, write in the hand-off file and in the successor's prompt that the owner is away and what is authorised (agentistics tells the successor too).",
    ]
  }
  if (role === 'worker') {
    return [
      `${head} Do not ask the owner anything: send questions, blocks and hand-backs to the session that started you (agentistics_session_message); with no such session, decide within your brief and record the decision.`,
    ]
  }
  return [
    `${head} Pre-authorised: ${authText(s)}. Do not ask the owner: if you lead, decide within these authorisations, pace by agentistics_plan_limits and record each decision; otherwise report to the session that started you.`,
  ]
}

/** Appended to the (Portuguese) hand-off hint while away is active; empty otherwise. */
export function awayHandoffNote(s: AwayState | null | undefined, now: number): string {
  if (!s || !awayActive(s, now)) return ''
  const ate = s.until === null ? 'até avisar que voltou' : `até ${s.until}`
  const ok = s.authorised.length > 0 ? s.authorised.join(', ') : 'nada além das regras'
  const tops = HARNESS_ORDER.filter(h => s.topCaps[h] !== undefined).map(h => `${h} ${awayTopCap(s, h)}`)
  const top = `${tops.length > 0 ? `${tops.join(', ')}, demais ` : ''}${Math.min(AWAY_DEFAULT_TOP_CAP, s.maxWorkers)}`
  return ` O dono está fora (modo ausente) ${ate}; autorizado: ${ok}; teto ${s.maxWorkers} workers / modelo de topo por provedor: ${top}. Escreva isso no handoff e no prompt do sucessor, e siga o ritmo do agentistics_plan_limits.`
}

export const AWAY_NOTICE_MAX = 500

/** Validates a leader's notice to the owner. */
export function normalizeAwayNotice(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' || t.length > AWAY_NOTICE_MAX ? null : t
}

// ─── Per-session away ─────────────────────────────────────────────────────────────────────────
//
// The global switch above covers EVERY session; a session can also be put in away mode on its own
// (`ManagedSession.away`, recorded in the registry so it survives a restart). The effective state
// of one session is the global one while that is active, else its own flag.

/** What a spawn may ask for: on, off, or "do what my parent does" (absent = inherit). */
export type AwaySpawnRequest = boolean | 'inherit'

/** Reads a spawn's `away` field off the wire: `undefined` when absent, `null` when malformed (refuse it). */
export function readAwaySpawn(v: unknown): AwaySpawnRequest | undefined | null {
  if (v === undefined || v === null || v === '') return undefined
  if (v === true || v === false || v === 'inherit') return v
  return null
}

/**
 * Whether a session being spawned is recorded as away. An explicit `true`/`false` wins; otherwise a
 * child of a VERIFIED parent that is itself in per-session away inherits it. Only the parent's OWN
 * flag is inherited, never the global switch — that one already covers the child while it is on,
 * and copying it would keep the child away after the owner switched the global off.
 */
export function resolveSpawnAway(req: AwaySpawnRequest | undefined, parent: { away?: boolean; verified: boolean } | undefined): boolean {
  if (req === true || req === false) return req
  return parent?.verified === true && parent.away === true
}

/**
 * What a session-only away state authorises when the global switch is off: opening workers within
 * the plan limits, nothing else. A session the owner put in away mode on purpose must be able to
 * keep going; releases and merges still wait for the owner (or the global switch).
 */
export const SESSION_AWAY_AUTHORISED: AwayAuthId[] = ['workers']

/**
 * The away state ONE session is briefed with, or null when it is not away. The global state while
 * it is active (it is the owner's fuller statement), else — when the session's own flag is on — an
 * open-ended state carrying the global's ceilings.
 */
export function sessionAwayState(global: AwayState | null | undefined, sessionAway: boolean | undefined, now: number): AwayState | null {
  if (global && awayActive(global, now)) return global
  if (sessionAway !== true) return null
  const base = global ?? AWAY_OFF
  return { on: true, since: '', until: null, authorised: [...SESSION_AWAY_AUTHORISED], maxWorkers: base.maxWorkers, topCaps: { ...base.topCaps } }
}

/**
 * The text typed into a RUNNING session when its own away flag is switched — the same send path a
 * session message uses. Null when the session's effective state did not change (the global switch
 * still covers it), so nothing is typed for nothing.
 */
export function sessionAwayNotice(
  global: AwayState | null | undefined,
  before: boolean | undefined,
  after: boolean,
  role: 'leader' | 'worker' | undefined,
  now: number,
  o: AwayBriefingOptions = {},
): string | null {
  const was = sessionAwayState(global, before, now) !== null
  const next = sessionAwayState(global, after, now)
  if (was === (next !== null)) return null
  if (next) return ['[agentistics · away mode is now ON for this session]', ...awayBriefingLines(next, role, now, o)].join('\n')
  return '[agentistics · away mode is now OFF for this session] The owner is back for this session: the away-mode instructions no longer apply — ask the owner as usual when a decision is theirs.'
}
