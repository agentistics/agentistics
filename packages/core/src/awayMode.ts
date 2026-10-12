/**
 * awayMode.ts — PURE. "Away mode": the owner is out (asleep, travelling) and the fleet should carry
 * on without asking them. The state is stored by the server (`server/away.ts`, preferences key
 * `away`); this module holds its shape, its validation and every word a session is told, so the
 * browser, the MCP door, the CLI and the spawn briefing cannot disagree.
 *
 * Expiry is LAZY: nothing rewrites the stored state when `until` passes — every reader asks
 * `awayActive(state, now)`, so an expired state simply reads as off.
 */

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
}

export const AWAY_NOTE_MAX = 500

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

export const AWAY_OFF: AwayState = { on: false, since: '', until: null, authorised: [] }

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
  return {
    on: o.on === true,
    since: typeof o.since === 'string' ? o.since : '',
    until,
    authorised,
    ...(note ? { note } : {}),
  }
}

export type AwayInputError = 'on_required' | 'bad_until' | 'until_in_past' | 'unknown_authorisation' | 'note_too_long'

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
  return { ok: true, state: { on: true, since, until, authorised, ...(note ? { note } : {}) } }
}

function untilText(s: AwayState): string {
  return s.until === null ? 'until they say they are back' : `until ${s.until}`
}

function authText(s: AwayState): string {
  const list = s.authorised.map(a => AWAY_AUTH_TEXT[a])
  const base = list.length > 0 ? list.join('; ') : 'nothing beyond the rules below'
  return s.note ? `${base}; owner's note: ${s.note}` : base
}

/**
 * The briefing line(s) for a session being started while the owner is away. Empty when inactive —
 * a session started after `until` is never told the owner is out.
 */
export function awayBriefingLines(s: AwayState | null | undefined, role: 'leader' | 'worker' | undefined, now: number): string[] {
  if (!s || !awayActive(s, now)) return []
  const head = `AWAY MODE — the owner is away ${untilText(s)}.`
  if (role === 'leader') {
    return [
      `${head} Pre-authorised: ${authText(s)}. These authorisations stand in for the owner's approval wherever the rules below ask for it. Never end a turn on a question to the owner: decide within them, record each decision (on the task or in your hand-off file) and keep going; anything outside them waits in the hand-off file for their return. At a hand-off, tell your successor the owner is away (agentistics tells it too).`,
    ]
  }
  if (role === 'worker') {
    return [
      `${head} Do not ask the owner anything: send questions, blocks and hand-backs to the session that started you (agentistics_session_message); with no such session, decide within your brief and record the decision.`,
    ]
  }
  return [
    `${head} Pre-authorised: ${authText(s)}. Do not ask the owner: if you lead, decide within these authorisations and record each decision; otherwise report to the session that started you.`,
  ]
}

/** Appended to the (Portuguese) hand-off hint while away is active; empty otherwise. */
export function awayHandoffNote(s: AwayState | null | undefined, now: number): string {
  if (!s || !awayActive(s, now)) return ''
  const ate = s.until === null ? 'até avisar que voltou' : `até ${s.until}`
  return ` O dono está fora (modo ausente) ${ate}: registre isso no handoff para o sucessor.`
}
