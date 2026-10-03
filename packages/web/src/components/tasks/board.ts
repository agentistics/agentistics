/**
 * board.ts — the board's visual vocabulary, in one place.
 *
 * Styles live here rather than inline in the page because a board is a grid of the SAME card
 * repeated: a card, a column, a chip and a status cell defined once are what make it read as one
 * surface instead of a stack of boxes. It also keeps the page file about behaviour.
 *
 * Every colour is a token from `index.css` — `--text-primary`, `--bg-card`, `--bg-elevated` and
 * friends. An earlier draft of this screen invented `--text` and `--bg`, which do not exist, so half
 * its colours silently fell back to the browser default and the whole thing read as unstyled.
 */

import type { CSSProperties } from 'react'
import { HARNESS_COLORS } from '../../lib/harness'
import { sortTaskStatuses, type HarnessId, type TaskStatusDef, type TaskTypeDef } from '@agentistics/core'

/**
 * A status id. Used to be a closed seven-value union (`backlog | todo | in_progress | blocked |
 * in_review | done | abandoned`) before the status list became editable
 * (`@agentistics/core`'s `taskStatus.ts`) — widened to a plain string for the same reason
 * `lib/tasks.ts`'s `TaskStatus` was: it is kept as its own name, rather than inlined as `string`
 * everywhere, so the ~20 call sites across this tree that cast `as BoardStatus` or declare
 * `BoardStatus[]` state keep reading as "a status id" to a reader, without a mechanical rename.
 */
export type BoardStatus = string

/**
 * The table's columns, named HERE rather than in `TaskTable`.
 *
 * `boardPrefs` stores which of them are shown, so it needs the name — and importing it from
 * `TaskTable`, which imports `boardPrefs` back, made the two modules a CYCLE. Today it is erased
 * (the import is `import type`, so nothing of it survives the bundle), but that safety rests
 * entirely on one keyword: the day somebody imports a VALUE across it, `boardPrefs`'s module-scope
 * `DEFAULT_PREFS` can be evaluated before the constants it reads, which is a temporal-dead-zone
 * crash at load with no clue in it pointing here. `board.ts` imports nothing local, so a name that
 * lives here can never close a loop.
 */
export type ColumnId =
  | 'status' | 'priority' | 'due' | 'claim' | 'progress' | 'attempts' | 'sessions'
  | 'rounds' | 'tokens' | 'cost' | 'harnesses' | 'subtasks' | 'comments' | 'files' | 'links'
  | 'blockedBy' | 'created' | 'updated' | 'type'

/**
 * The fixed seven-status vocabulary the board shipped with — now the LOADING-STATE fallback and
 * the legacy-migration reference only. Real rendering resolves a status id against the LIVE list
 * instead (`statusStyle`/`liveStatusMap`/`liveStatusOrder` below, fed by `lib/tasks.ts`'s
 * `useTaskStatuses`); this map is what those functions fall back to for the brief window before
 * that fetch resolves, so nothing on screen is unstyled while it is in flight. A status has a
 * colour and it is the SAME colour everywhere — the column header, the card's stripe and the
 * table's status cell — which is now a fact about the SERVER's stored `TaskStatusDef.color`, not
 * about this table.
 */
export const STATUS: Record<BoardStatus, { label: string; color: string; dim: string }> = {
  backlog: { label: 'Backlog', color: 'var(--text-tertiary)', dim: 'var(--border)' },
  todo: { label: 'To do', color: 'var(--accent-blue)', dim: 'var(--accent-blue-dim)' },
  in_progress: { label: 'In progress', color: 'var(--anthropic-orange)', dim: 'var(--anthropic-orange-dim)' },
  // Red, and the only red on the board. Blocked is the one column somebody has to go and act on.
  blocked: { label: 'Blocked', color: 'var(--accent-red)', dim: 'var(--accent-red-dim)' },
  in_review: { label: 'In review', color: 'var(--accent-purple)', dim: 'rgba(139, 92, 246, 0.14)' },
  done: { label: 'Done', color: 'var(--accent-green)', dim: 'var(--accent-green-dim)' },
  abandoned: { label: 'Abandoned', color: 'var(--text-tertiary)', dim: 'var(--border)' },
}

/**
 * Priority reads as a COLOUR and a word, and `none` is deliberately grey and last.
 *
 * `none` means "nobody has said", which is not the same as `low` — a board full of `medium` because
 * something had to be the default is a board where priority means nothing. Only `urgent` gets the
 * alarm colour, and it is the same red `blocked` uses: both mean somebody has to act.
 */
export const PRIORITY: Record<string, { label: string; short: string; color: string; dim: string }> = {
  urgent: { label: 'Urgent', short: 'U', color: 'var(--accent-red)', dim: 'var(--accent-red-dim)' },
  high: { label: 'High', short: 'H', color: 'var(--anthropic-orange)', dim: 'var(--anthropic-orange-dim)' },
  medium: { label: 'Medium', short: 'M', color: 'var(--accent-blue)', dim: 'var(--accent-blue-dim)' },
  low: { label: 'Low', short: 'L', color: 'var(--text-tertiary)', dim: 'var(--border)' },
  none: { label: 'Unset', short: '—', color: 'var(--text-tertiary)', dim: 'transparent' },
}

/**
 * How long a claim has left, in words — or that it has run out.
 *
 * An EXPIRED lease is said out loud rather than hidden: the task is available again, and a card
 * that simply stopped showing a holder would read as one nobody ever took.
 */
export function claimLeft(expiresAt: string, nowMs: number): { text: string; expired: boolean } {
  const ms = Date.parse(expiresAt) - nowMs
  // An unparseable expiry reads as expired, matching `claimState` on the server: a claim nobody can
  // date is a claim nobody can revoke.
  if (!Number.isFinite(ms)) return { text: 'lease unknown', expired: true }
  if (ms <= 0) return { text: 'lease expired', expired: true }
  const mins = Math.round(ms / 60000)
  if (mins < 60) return { text: `${Math.max(1, mins)}m left`, expired: false }
  return { text: `${Math.round(mins / 60)}h left`, expired: false }
}

/** Left to right, the way work moves — the LOADING-STATE fallback order; see `STATUS`'s own note.
 *  Real rendering orders the LIVE list instead (`liveStatusOrder`). */
export const COLUMN_ORDER: BoardStatus[] =
  ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned']

const UNKNOWN_STATUS_COLOR = 'var(--text-tertiary)'
const UNKNOWN_STATUS_DIM = 'var(--border)'

/**
 * An alpha-tinted background from a status's own stored hex colour. The fixed seven-status palette
 * hardcoded a `dim` design token per entry (`--accent-blue-dim` and friends, ~14-16% tints); a
 * status a user creates or repaints has no such token — only the hex it was given — so its tint is
 * computed instead of looked up. A malformed value (should not happen; colours are validated at
 * write time by `isValidStatusColor`) falls back to the neutral border tint rather than crashing.
 */
export function dimFromHex(hex: string, alpha = 0.16): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return UNKNOWN_STATUS_DIM
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * The board's LIVE status vocabulary, as the same `{ label, color, dim }` shape `STATUS` used to
 * hand out for the fixed seven — every existing consumer of that shape (`ChipSelect`'s
 * `statusOptions`, a pill's border/background) keeps working unchanged, fed a live record instead
 * of the frozen one. `list: null` (still loading — see `useTaskStatuses`) resolves through the
 * fixed `STATUS` map so nothing renders unstyled during the fetch.
 */
export function liveStatusMap(
  list: readonly TaskStatusDef[] | null,
): Record<string, { label: string; color: string; dim: string }> {
  if (!list) return STATUS
  return Object.fromEntries(
    list.map(s => [s.id, { label: s.label, color: s.color, dim: dimFromHex(s.color) }]),
  )
}

/** Left-to-right column/group order from the LIVE list (`sortTaskStatuses`, `@agentistics/core`) —
 *  `list: null` falls back to the fixed `COLUMN_ORDER` while the fetch is in flight. A custom status
 *  a person creates gets its own slot here, in the position its `order` puts it. */
export function liveStatusOrder(list: readonly TaskStatusDef[] | null): string[] {
  return list ? sortTaskStatuses(list).map(s => s.id) : [...COLUMN_ORDER]
}

/**
 * Resolve ONE status id against the live list — the single call most pill/chip rendering needs.
 * An id absent from a LOADED list (a stale reference, or a status deleted since — should not
 * normally happen, writes are validated against the live list server-side) renders as the bare id
 * in a neutral colour nobody chose, rather than crashing or inventing a colour for it. Never a
 * confident substitute (the old code's `?? STATUS.backlog`/`?? STATUS.todo` fallbacks silently
 * relabelled an unrecognised status as a real one).
 */
export function statusStyle(
  list: readonly TaskStatusDef[] | null, id: string,
): { label: string; color: string; dim: string } {
  const found = liveStatusMap(list)[id]
  return found ?? { label: id, color: UNKNOWN_STATUS_COLOR, dim: UNKNOWN_STATUS_DIM }
}

/** The id the table's "No type" band is filed under — a real group key, never a type id. */
export const NO_TYPE_KEY = '__none__'

/**
 * Resolve ONE type id against the live type list — `statusStyle`'s sibling. A task with no type
 * (`id` absent) and a type deleted since both read as neutral rather than being relabelled; the
 * caller says "No type" for the first in the reader's own words.
 */
export function typeStyle(
  list: readonly TaskTypeDef[] | null, id: string | undefined,
): { label: string; color: string; dim: string } {
  const found = id ? list?.find(t => t.id === id) : undefined
  if (found) return { label: found.label, color: found.color, dim: dimFromHex(found.color) }
  return { label: id ?? '', color: UNKNOWN_STATUS_COLOR, dim: UNKNOWN_STATUS_DIM }
}

/** How a live session reads on a task's row — the fleet's own vocabulary, not a second one. */
export const SESSION_STATE: Record<string, { label: string; color: string }> = {
  working: { label: 'working', color: 'var(--accent-green)' },
  waiting: { label: 'waiting', color: 'var(--accent-blue)' },
  // The one that must catch the eye: a person is blocking this session right now.
  'waiting-approval': { label: 'needs you', color: 'var(--anthropic-orange)' },
  exited: { label: 'finished', color: 'var(--text-tertiary)' },
  closed: { label: 'closed', color: 'var(--text-tertiary)' },
  lost: { label: 'lost', color: 'var(--accent-red)' },
  unknown: { label: 'unknown', color: 'var(--text-tertiary)' },
}

export const harnessColor = (h: string): string =>
  HARNESS_COLORS[h as HarnessId] ?? 'var(--text-tertiary)'

export const surface: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
}

export const cardStyle: CSSProperties = {
  ...surface,
  padding: 12,
  display: 'grid',
  gap: 8,
  textAlign: 'left',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  width: '100%',
  transition: 'background 0.12s, transform 0.12s',
}

/** The micro-label the whole dashboard uses over a number. */
export const microLabel: CSSProperties = {
  fontSize: 9.5,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

export const numeric: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  fontVariantNumeric: 'tabular-nums',
}

export const pill = (color?: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 10.5,
  lineHeight: 1.6,
  whiteSpace: 'nowrap',
  background: 'var(--bg-elevated)',
  border: `1px solid ${color ?? 'var(--border)'}`,
  color: color ?? 'var(--text-tertiary)',
})

/**
 * An input, in the shape every other form in this app draws one.
 *
 * It used to be its own thing — `--bg-surface`, a different radius, no focus treatment — which is
 * why the board's fields read as a different product from the settings screens beside them. The
 * typeface was never the problem (`index.css` makes controls inherit it); the BOX was.
 *
 * `boxSizing: border-box` is load-bearing rather than tidy: `width: 100%` plus padding plus a
 * border is WIDER than the column that holds it, which is exactly how a date field ends up hanging
 * out of the rail it lives in.
 */
export const field = (mobile: boolean): CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  padding: mobile ? '10px 11px' : '7px 10px',
  borderRadius: 7,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  // 16px on mobile or iOS Safari zooms the viewport and breaks the sticky header.
  fontSize: mobile ? 16 : 13,
  // …and 44px tall, the touch target every control on a phone owes a thumb. The padding alone gave
  // 38px, which is a miss you feel rather than see.
  minHeight: mobile ? 44 : undefined,
  outline: 'none',
})

export const button = (mobile: boolean, kind: 'ghost' | 'primary' = 'ghost'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0 13px',
  // 44px is the MOBILE number. Applying it on desktop turns a control row into a toolbar.
  height: mobile ? 44 : 32,
  borderRadius: 'var(--radius-sm)',
  border: `1px solid ${kind === 'primary' ? 'transparent' : 'var(--border)'}`,
  background: kind === 'primary' ? 'var(--anthropic-orange)' : 'transparent',
  color: kind === 'primary' ? '#1a1008' : 'var(--text-secondary)',
  fontWeight: kind === 'primary' ? 600 : 500,
  fontSize: 12.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

/** `null` is `N/A` in the muted colour — never a `0`, which reads as a measurement. */
export const NA = 'N/A'
export const fmtInt = (n: number | null | undefined): string =>
  (n === null || n === undefined ? NA : n.toLocaleString())
// Money is NOT formatted here: it depends on the reader's currency and on the cached rate, so it
// lives in `money.ts` behind `useMoney()`. A `$`-hardcoding helper in this file is exactly how the
// board came to answer in dollars on a dashboard set to BRL.
export const fmtBytes = (n: number): string =>
  (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/**
 * `startedAt`/`deliveredAt` (`Task`/`Subtask`) are SYSTEM facts, not a date somebody typed — so
 * they are read as a full MOMENT (date and time), never as a bare `yyyy-MM-dd` day. Lives here
 * rather than on `DeliveryDetail.tsx` specifically so `SubtaskTable.tsx` and `TaskTable.tsx` (both
 * imported BY `DeliveryDetail.tsx`) can read it too without a circular import — this file imports
 * nothing local, so a name that lives here can never close a loop (see this file's own header).
 */
export function fmtStamp(iso: string | undefined, lang: 'pt' | 'en'): string {
  if (!iso) return NA
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return NA
  return d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The compact half of `fmtStamp` — DATE and TIME, one line, locale-aware: PT `DD/MM HH:mm` (24h),
 * EN `MM/DD h:mm AM/PM`. The YEAR is shown only when `iso` falls in a DIFFERENT calendar year from
 * `nowMs` (owner refinement, 2026-09-27: "nothing huge and nothing that breaks lines" — a board read
 * day to day names the year on almost no row, so carrying it always was pure width for no
 * information) — PT `DD/MM/AAAA HH:mm`, EN `MM/DD/YYYY h:mm AM/PM`.
 *
 * `startedAt`/`deliveredAt` used to render through `fmtStamp` alone ("25 de set. de 2026, 16:31"),
 * which wraps onto three lines in a table cell that has room for one, then through a date-only
 * `fmtDateOnly` that dropped the TIME half the owner asked to see back. The full moment is never
 * thrown away either way — every call site keeps it as the cell's `title` tooltip (`fmtStamp`, same
 * language) — this is only what is PAINTED, and the caller is responsible for `white-space: nowrap`
 * on whatever it paints it into. Manual digits rather than `toLocaleDateString`'s own default:
 * `en-US` prints the month with no leading zero ("9/25/2026"), and the brief's own EN example
 * ("09/25/2026") needs one. `nowMs` is a parameter rather than a read of the clock so the "same
 * year" test is deterministic under a fixed value. Invalid or absent input renders the board's
 * existing N/A convention, never "Invalid Date" — the same guard `fmtStamp` already applies to the
 * same two fields.
 */
export function fmtDateTime(iso: string | undefined, lang: 'pt' | 'en', nowMs: number): string {
  if (!iso) return NA
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return NA
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const showYear = yyyy !== new Date(nowMs).getFullYear()
  const hh24 = d.getHours()
  const min = String(d.getMinutes()).padStart(2, '0')
  if (lang === 'pt') {
    const hh = String(hh24).padStart(2, '0')
    return showYear ? `${dd}/${mm}/${yyyy} ${hh}:${min}` : `${dd}/${mm} ${hh}:${min}`
  }
  const h12 = hh24 % 12 === 0 ? 12 : hh24 % 12
  const ampm = hh24 < 12 ? 'AM' : 'PM'
  return showYear
    ? `${mm}/${dd}/${yyyy} ${h12}:${min} ${ampm}`
    : `${mm}/${dd} ${h12}:${min} ${ampm}`
}

/**
 * Cap a list for display, truthfully: `shown` is what fits, `extra` is what does not — never
 * silently dropped. A row filed under many harnesses (or any other unbounded per-row list) grows
 * without limit otherwise, one badge at a time, and a table column stops being a column.
 */
export function capList<T>(items: readonly T[], max: number): { shown: T[]; extra: number } {
  const limit = Math.max(1, Math.floor(max))
  if (items.length <= limit) return { shown: [...items], extra: 0 }
  const shown = items.slice(0, limit)
  return { shown, extra: items.length - shown.length }
}

/** Compact token counts, because these reach the billions and a full number breaks every column. */
export function fmtTokens(n: number | null): string {
  if (n === null) return NA
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}
