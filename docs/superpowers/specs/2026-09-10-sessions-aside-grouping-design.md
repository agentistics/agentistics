# Sessions aside — grouping, collapsing, reordering and card color

## Problem

The Sessions workspace's aside (`SessionsAside.tsx`) sub-groups the fleet by **project only**,
hardcoded. There is no way to see "which sessions are filed under which delivery" or "which
sessions are working vs. waiting" as a grouping — only as a flat rank inside the Active/Inactive
bands. There is also no way to collapse a group, reorder groups, or change how a session's status
color renders on its own card (today it is an all-or-nothing wash, applied only to `working` and
`waiting`/`waiting-approval`).

## What this covers

A discreet control in the aside that lets a person:
1. Choose the sub-grouping: **Project** (current, default) / **Task** / **Status**.
2. Reorder the groups of whichever dimension is active.
3. Collapse a group by clicking its own heading.
4. Choose how a session's card shows its status color: **wash** (current, extended to all
   states) / **neutral background + colored text** / **colored left stripe**.

Everything is a per-viewer screen arrangement, saved in `localStorage` — never lost across
reloads, never shared across a central's several signed-in users.

## Out of scope

- The terminal cockpit (`packages/tui`) is untouched. Its own `status` dimension deliberately
  collapses `exited`/`lost`/`closed` into one `Off` bucket (the "3 desligadas, wtf" fix) — a
  decision this feature does not reopen. The web aside's Status grouping is a **separate,
  web-only** implementation that shows all 7 raw states, because that is what was asked here.
- The fixed **Ativas / Inativas** bands are untouched — they keep following the header's
  filters exactly as today. The new grouping controls apply **inside** each band.
- No change to which sessions are shown, only to how they are arranged and colored.

## Data model — `sessionsAsidePrefs.ts` (new, `localStorage`)

Mirrors `boardPrefs.ts`'s own pattern and its stated reason: on a central, `/api/preferences` is
shared by every signed-in user, so an arrangement of a list (as opposed to a fact about the work,
like a pin) must not live there — one person's collapsed groups must not collapse them for the
whole team viewing that central's relayed fleet.

```ts
export type AsideGroupBy = 'project' | 'task' | 'status'
export type AsideCardColor = 'wash' | 'neutral' | 'stripe'

export interface AsideGroupPrefs {
  groupBy: AsideGroupBy
  /** Manual order of group KEYS, per dimension. Absent = automatic (most-urgent-first). */
  order: Partial<Record<AsideGroupBy, string[]>>
  /** Collapsed groups, keyed `${bandId}:${groupBy}:${key}` — see "Collapsing" below. */
  collapsed: string[]
  cardColor: AsideCardColor
}

export const DEFAULT_ASIDE_GROUP_PREFS: AsideGroupPrefs = {
  groupBy: 'project', order: {}, collapsed: [], cardColor: 'wash',
}

export function readAsideGroupPrefs(): AsideGroupPrefs
export function writeAsideGroupPrefs(patch: Partial<AsideGroupPrefs>): void
```

Storage key: `agentistics-sessions-aside-v1`. Read/write guarded exactly like `boardPrefs.ts` —
a private window or blocked storage falls back to defaults rather than throwing.

An unrecognised `groupBy`/`cardColor` value (an older build, a hand-edited value) falls back to
its default rather than being rendered as-is — the same rule `boardPrefs.ts`'s `isView`/`isLane`
guards apply.

## Grouping — `fleetGroups.ts` (extended)

Replaces the current hardcoded `projectGroups`/`showsProjectHeadings` pair with a dimension-aware
version. The one existing caller (`SessionsAside.tsx`) is updated; nothing else imports these
today.

```ts
export function asideGroups(
  rows: readonly ControlSession[],
  by: AsideGroupBy,
  lang: Lang,
  order: readonly string[],
): SessionGroup[]

/** Same rule as before, generalized: a band holding ONE group draws no heading. */
export function showsGroupHeadings(groups: readonly SessionGroup[]): boolean
```

- `by === 'project'` — unchanged: `groupSessions(rows, 'project', wordBook(lang), [], DEFAULT_ORDER)`.
- `by === 'task'` — `groupSessions(rows, 'task', wordBook(lang), [], DEFAULT_ORDER)`. Reuses the
  existing `task` dimension verbatim (its `UNFILED` bucket already reads "no delivery"/"sem
  entrega", matching `SessionFacts`'s own wording for an unfiled row).
- `by === 'status'` — **new, web-only**. Buckets by the raw `session.state` (all 7 values:
  `working`, `waiting`, `waiting-approval`, `exited`, `lost`, `closed`, `unknown`), each its own
  group. Ordered by `sessionRank` of each group's first (already-sorted) member, same rule
  `groupSessions` applies elsewhere. Labels and colors come from a small local EN/PT table
  (below) rather than the shared `session-dimensions.ts` word book, because that module's
  `status` dimension is deliberately collapsed and reusing its `values` map would either mislabel
  a merged bucket or require changing a shared, tested dimension for a web-only requirement.

Both branches finish through the same pure step:

```ts
/** Manually-ordered keys first (in that order), then every other group in its existing order. */
export function applyManualOrder(groups: SessionGroup[], order: readonly string[]): SessionGroup[]
```

A key in `order` that no longer exists is simply absent from `groups` and drops out on its own —
nothing to reconcile. A group not yet in `order` (a brand new task, a status nobody has seen
before) is appended after every manually-placed group, in whatever order the automatic
urgency-first sort already gave it — so a new group is never lost, only unpositioned until moved.

The manual order is **not** banded — one order per dimension, shared between the Active and
Inactive sub-lists. A task's relative position is a statement about that task, not about which
band it currently happens to render in.

## Status word/color table (new, in `fleetGroups.ts`)

```ts
const STATUS_GROUP_WORDS: Record<SessionState, { en: string; pt: string }> = {
  working: { en: 'Working', pt: 'Trabalhando' },
  waiting: { en: 'Needs you', pt: 'Precisa de você' },
  'waiting-approval': { en: 'Needs approval', pt: 'Precisa de aprovação' },
  exited: { en: 'Finished', pt: 'Encerradas' },
  lost: { en: 'Lost', pt: 'Desconectadas' },
  closed: { en: 'Closed', pt: 'Fechadas' },
  unknown: { en: 'External', pt: 'Externas' },
}
```

Mirrors the vocabulary already used elsewhere (`board.ts`'s `SESSION_STATE` for EN, `cli-i18n.ts`'s
per-row PT words) rather than inventing new terms.

The group heading gets a small color dot (reusing the row's own state-dot convention) when
`groupBy === 'status'` — free, consistent, and not part of the card-color preference below (that
one is about the row cards, per your screenshot).

## Card color — `sessionCardStyle.ts` (new, pure)

Centralizes what is today inlined as `STATE_COLOR`/`STATE_WASH` in `SessionsAside.tsx`, so the
group-heading dot and every row (including the pinned band) read the same colors, and so the
three modes are one tested function:

```ts
export interface CardStyle {
  background: string
  /** The left-edge indicator (inset box-shadow), or undefined for none. */
  edge?: string
  /** Only set in `neutral` mode — the meta line's state-word color. */
  stateTextColor?: string
}

export function sessionCardStyle(
  state: SessionState,
  mode: AsideCardColor,
  selected: boolean,
): CardStyle
```

Rules, all three modes:
- **`selected` always wins** — the existing neutral selection style (lifted background, full
  white/text-primary edge) is untouched in every mode; status color never competes with "this is
  the row you're on".
- **`wash`** (default, current behavior extended): background is a 10–12% color-mix of the
  state's color for **all seven states** (today only `working`/`waiting`/`waiting-approval` get
  one; `exited`/`lost`/`closed`/`unknown` will now get their own, mostly-gray tint too — a real
  color always means the same thing).
- **`neutral`**: background stays the row's plain hover/transparent background; no wash. The meta
  line's state word (already rendered by `SessionFacts`, currently tertiary-or-orange-if-wants)
  takes the state's color instead.
- **`stripe`**: background stays plain like `neutral`, plus a colored left edge
  (`inset 3px 0 0 <state color>`) — the same visual language `TaskBoard`'s cards already use for
  their status stripe.

`STATE_COLOR` gains an explicit `lost: 'var(--accent-red)'` entry (today it falls through to
tertiary) so a Status group and a `stripe`/`wash` row can tell "lost" apart from "exited"/"closed",
matching `board.ts`'s own `SESSION_STATE.lost` color.

## Collapsing groups

Clicking a group's own heading (the sub-heading line under a band, e.g. "agentistics · 3")
toggles it collapsed — chevron flips (`ChevronRight`/`ChevronDown`, same icons `TaskTable` already
uses for its own fold), sessions hide, the count stays. The **band** headings (Ativas/Inativas)
are not affected — only the dimension sub-group is clickable, per your instruction.

Persisted key: `${bandId}:${groupBy}:${key}` (`bandId` is `'active' | 'inactive'`, not the
localized label, so PT/EN never split one preference in two). A band holding exactly one group
draws no heading at all (existing rule, `showsGroupHeadings`) — such a group is therefore never
collapsible, same as it is never headed today.

## The discreet control — `SessionsGroupMenu.tsx` (new)

One icon-only trigger (`SlidersHorizontal`, 13px) in the aside's existing top icon row, beside
search / new / send — always visible (unlike "send to several", which only appears when it would
do something). `title`/`aria-label`: "Arrange list" / "Organizar lista".

Its popover — `position: fixed` in a portal, clamped to viewport, closes on scroll, same contract
`PickerMenu`/`BoardArrange`'s panels already follow — carries three sections:

1. **GROUP BY** — three rows, single-select: Project · Task · Status.
2. **GROUP ORDER** — shown only when the current dimension has 2+ groups. A draggable list
   (drag handle + ▲▼, no checkboxes — nothing here is hidden, only reordered) of that dimension's
   current groups, by label. Dragging or pressing an arrow writes the new key order to
   `order[groupBy]` immediately.
3. **CARD COLOR** — three rows, single-select: "Background follows status" / "Neutral background,
   colored text" / "Colored left stripe".

Every change writes through `writeAsideGroupPrefs` immediately (no separate "save").

## `SessionsAside.tsx` changes

- Seed `groupBy` / `order` / `cardColor` from `readAsideGroupPrefs()` once (`useMemo`), same
  pattern `TaskList` uses for `readBoardPrefs()`.
- The `bands` memo's two `projectGroups(...)` calls become
  `asideGroups(rest, groupBy, lang, order[groupBy] ?? [])`.
- `SessionBand` gains `collapsed: ReadonlySet<string>` and `onToggleCollapse(key: string)`; its
  per-group heading becomes a button with a chevron, matching `TaskTable`'s fold row.
- `SessionRow` (and the pinned band, which renders the same component) takes a `cardColor` prop
  and calls `sessionCardStyle(session.state, cardColor, selected)` instead of inlining
  `STATE_COLOR`/`STATE_WASH` lookups.
- `SessionsGroupMenu` is rendered once, near the search/new/send row.

## Testing

- `fleetGroups.test.ts` (new): `applyManualOrder` (known keys ordered, unknown keys appended
  preserving relative order, empty order is a no-op), `asideGroups('status', …)` produces exactly
  the 7-state buckets with the right labels/counts and no `session-dimensions.ts` collapsing,
  `asideGroups('task'|'project', …)` unchanged from today's behavior, `showsGroupHeadings`
  unchanged rule.
- `sessionCardStyle.test.ts` (new): all three modes × all seven states × selected/not — a pure
  table, easy to pin exactly.
- `sessionsAsidePrefs.test.ts` (new): read/write round-trip, corrupt JSON falls back to defaults,
  an unrecognised `groupBy`/`cardColor` value falls back rather than rendering as-is.

## Files touched

- `packages/web/src/lib/sessionsAsidePrefs.ts` — new
- `packages/web/src/lib/sessionCardStyle.ts` — new
- `packages/web/src/lib/fleetGroups.ts` — extended (drops `projectGroups`/`showsProjectHeadings`
  in favor of `asideGroups`/`showsGroupHeadings`, adds `applyManualOrder` and the status word
  table)
- `packages/web/src/components/nav/SessionsGroupMenu.tsx` — new
- `packages/web/src/components/sessions/SessionFacts.tsx` — extended with an optional
  `metaColor` override, for the `neutral` card-color mode's colored state word
- `packages/web/src/components/nav/SessionsAside.tsx` — wires all of the above in
