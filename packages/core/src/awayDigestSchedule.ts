/**
 * When the away-mode summary is offered (`server/away-digest.ts`), as a machine preference
 * (`preferences.awayDigestSchedule`). Two numbers, both in minutes:
 *
 * - `firstAfterMin` — how long the owner must have been away (or since the last summary Nay
 *   delivered) before the first offer. `null` turns the offer off.
 * - `everyMin` — while an offer goes unanswered, it is offered again at this interval.
 *
 * The defaults are the behaviour before the setting existed (5 h, then every 15 min), so a machine
 * that never opens the setting changes nothing. A stored value outside the closed option lists reads
 * as the default for that half — the file is hand-editable and a typo must not mean "every minute".
 */

export interface AwayDigestSchedule {
  firstAfterMin: number | null
  everyMin: number
}

export const AWAY_DIGEST_FIRST_OPTIONS = [60, 120, 300, 720] as const
export const AWAY_DIGEST_EVERY_OPTIONS = [15, 30, 60, 180] as const
export const DEFAULT_AWAY_DIGEST_SCHEDULE: AwayDigestSchedule = { firstAfterMin: 300, everyMin: 15 }

export function parseAwayDigestSchedule(value: unknown): AwayDigestSchedule {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const first = raw.firstAfterMin === null
    ? null
    : (AWAY_DIGEST_FIRST_OPTIONS as readonly unknown[]).includes(raw.firstAfterMin) ? raw.firstAfterMin as number : DEFAULT_AWAY_DIGEST_SCHEDULE.firstAfterMin
  const every = (AWAY_DIGEST_EVERY_OPTIONS as readonly unknown[]).includes(raw.everyMin) ? raw.everyMin as number : DEFAULT_AWAY_DIGEST_SCHEDULE.everyMin
  return { firstAfterMin: first, everyMin: every }
}

/** "5 h", "30 min" — the label both the setting and the offer's own sentence use. */
export function awayDigestDurationLabel(min: number): string {
  return min % 60 === 0 ? `${min / 60} h` : `${min} min`
}
