/**
 * checkinNotify.ts — the RULES behind the Nay alert a check-in round raises (CONTRACT §5).
 *
 * PURE: no DOM, no clock, no storage. `checkinAlerts.ts` feeds it the SSE event and the store, and
 * `nayNotifyStore.ts` keeps the memory; what they have to DECIDE is here, so a test can pin it:
 *  - "once per subject": a subject is announced again only if it got WORSE (same subject, now
 *    critical) or its text changed and an hour went by;
 *  - quiet hours (default 23h–8h, crossing midnight): everything but `critical` is held back;
 *  - the morning summary: at the end of the silence, and when the app is opened after >= 2 h away.
 */

import type { CheckinNeedWire } from './checkin'

export type CheckinNeed = CheckinNeedWire

/** What the store remembers about a subject it already announced. */
export interface SubjectMemory { text: string; critical: boolean; at: number }

export const RE_ALERT_TEXT_MS = 3_600_000

/**
 * Is this need NEWS? Never seen: yes. Seen: only when it got worse (it is critical now and was not),
 * or its text is new and at least an hour passed since it was announced. The same text again — the
 * leader repeating itself every 30 minutes — is never news.
 */
export function needIsNews(need: CheckinNeed, prev: SubjectMemory | undefined, now: number): boolean {
  if (!prev) return true
  if (need.critical === true && !prev.critical) return true
  return need.text !== prev.text && now - prev.at >= RE_ALERT_TEXT_MS
}

export function remember(need: CheckinNeed, now: number): SubjectMemory {
  return { text: need.text, critical: need.critical === true, at: now }
}

// --- quiet hours ---------------------------------------------------------------------------------

export interface QuietHours { enabled: boolean; fromHour: number; toHour: number }
export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: true, fromHour: 23, toHour: 8 }

export function readQuietHours(raw: unknown): QuietHours {
  const o = (raw ?? {}) as Partial<QuietHours>
  const hour = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : d)
  return {
    enabled: o.enabled !== false,
    fromHour: hour(o.fromHour, DEFAULT_QUIET_HOURS.fromHour),
    toHour: hour(o.toHour, DEFAULT_QUIET_HOURS.toHour),
  }
}

/** Is the local hour of `nowMs` inside the silence? A window may cross midnight; from === to is empty. */
export function inQuietHours(q: QuietHours, nowMs: number): boolean {
  if (!q.enabled || q.fromHour === q.toHour) return false
  const h = new Date(nowMs).getHours()
  return q.fromHour < q.toHour ? h >= q.fromHour && h < q.toHour : h >= q.fromHour || h < q.toHour
}

/** What to do with a round's needs right now: raise them at once, or hold them for the summary. */
export function splitForSilence<T extends { critical?: boolean }>(needs: readonly T[], quiet: boolean): { now: T[]; held: T[] } {
  if (!quiet) return { now: [...needs], held: [] }
  return { now: needs.filter(n => n.critical === true), held: needs.filter(n => n.critical !== true) }
}

// --- the summary ---------------------------------------------------------------------------------

export const AWAY_SUMMARY_MS = 2 * 3_600_000

export interface SummaryState {
  /** When the silence last ended with a summary, or the page last closed/hid: epoch ms. */
  lastSeenAt: number
  /** The local date key (yyyy-MM-dd) of the last end-of-silence summary, so it fires once a day. */
  lastSummaryDay: string | null
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Should a summary be raised NOW? Never while the silence is on, and never with nothing held.
 * Otherwise when the app was away >= 2 h, or when the silence has ended and today's summary has not
 * been given yet (the morning one, even if the page was open all night).
 */
export function summaryDue(o: { q: QuietHours; nowMs: number; held: number; state: SummaryState }): 'away' | 'morning' | null {
  if (o.held <= 0 || inQuietHours(o.q, o.nowMs)) return null
  if (o.nowMs - o.state.lastSeenAt >= AWAY_SUMMARY_MS) return 'away'
  if (o.q.enabled && o.q.fromHour !== o.q.toHour && o.state.lastSummaryDay !== dayKey(o.nowMs)) return 'morning'
  return null
}

export function markSummaryGiven(state: SummaryState, nowMs: number): SummaryState {
  return { lastSeenAt: nowMs, lastSummaryDay: dayKey(nowMs) }
}

// --- wording -------------------------------------------------------------------------------------

export function needsTitle(n: number, lang: 'pt' | 'en'): string {
  if (lang === 'pt') return n === 1 ? '1 coisa espera você' : `${n} coisas esperam você`
  return n === 1 ? '1 thing is waiting for you' : `${n} things are waiting for you`
}

export function summaryTitle(lang: 'pt' | 'en'): string {
  return lang === 'pt' ? 'Enquanto você estava fora…' : 'While you were away…'
}

// --- one round -----------------------------------------------------------------------------------

export interface RoundPlan {
  /** Needs to put on a card right now. */
  raise: CheckinNeed[]
  /** News that arrived inside the silence: kept for the summary. */
  held: CheckinNeed[]
  /** The subject memory after this round. */
  memory: Record<string, SubjectMemory>
}

/**
 * What a `needs_you` round does: drop what was already announced (dedup by subject), then split what
 * is left by the silence. Every news subject is REMEMBERED here, raised or held — a held one must not
 * be held again by the next round, nor raised again once the summary has shown it.
 */
export function planRound(o: {
  needs: readonly CheckinNeed[]
  memory: Record<string, SubjectMemory>
  quiet: boolean
  now: number
}): RoundPlan {
  const memory = { ...o.memory }
  const news: CheckinNeed[] = []
  for (const n of o.needs) {
    if (!needIsNews(n, memory[n.subject], o.now)) continue
    memory[n.subject] = remember(n, o.now)
    news.push(n)
  }
  const { now, held } = splitForSilence(news, o.quiet)
  return { raise: now, held, memory }
}

/** Held needs, newest text per subject — the summary lists a subject once. */
export function mergeHeld(held: readonly CheckinNeed[], more: readonly CheckinNeed[]): CheckinNeed[] {
  const by = new Map<string, CheckinNeed>()
  for (const n of [...held, ...more]) by.set(n.subject, n)
  return [...by.values()]
}
