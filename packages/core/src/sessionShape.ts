import type { SessionMeta } from './types'

/**
 * sessionShape.ts — PURE: the list-typed fields of a `SessionMeta` read back as the lists the type
 * promises, whatever the stored record actually holds.
 *
 * A consolidate store may hold records written by an older version or by hand, not by the parser.
 * One session with `languages: {}` (a hand-built probe record, measured 2026-09-25) made the
 * dashboard throw `object is not iterable` inside `useDerivedStats` on its first render — the whole
 * UI down, for one field on one document out of 1865. The dashboard iterates these fields, so a
 * record that is not a list must become one at the boundary it crossed, never inside a render.
 *
 * `languages` has a second legitimate shape: Claude's own session-meta files carry
 * `Record<language, count>`, and `data.ts` already reads that as its KEYS. That rule lives here now,
 * so every reader agrees about it.
 */

/** A language list from whatever was stored: a list is kept (strings only), a map yields its keys. */
export function coerceLanguages(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (value && typeof value === 'object') return Object.keys(value)
  return []
}

/** An hour-of-day list: numbers only, anything else is an empty list rather than a throw. */
export function coerceHours(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : []
}

/**
 * The same session with its list-typed fields guaranteed to be lists. Returns the input untouched
 * when nothing needed fixing, so the common case allocates nothing.
 */
export function coerceSessionLists<T extends Pick<SessionMeta, 'languages' | 'message_hours'>>(s: T): T {
  const languagesOk = Array.isArray(s.languages) && s.languages.every(v => typeof v === 'string')
  const hoursOk = Array.isArray(s.message_hours) && s.message_hours.every(v => typeof v === 'number')
  if (languagesOk && hoursOk) return s
  return {
    ...s,
    languages: languagesOk ? s.languages : coerceLanguages(s.languages),
    message_hours: hoursOk ? s.message_hours : coerceHours(s.message_hours),
  }
}
