# Sessions aside — grouping, collapsing, reordering and card color — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person sub-group the Sessions workspace's aside by Project (current default), Task
or Status; reorder those groups; collapse one by clicking its own heading; and choose how a
session's card shows its status — background tint (extended to all states), neutral background
with colored text, or a colored left stripe. Everything persists across reloads, per browser.

**Architecture:** Two new pure `lib/` modules (`sessionsAsidePrefs.ts` for the `localStorage`
model, `sessionCardStyle.ts` for the three card-color modes), one extended pure module
(`fleetGroups.ts`, generalized from project-only to project/task/status), one new presentational
component (`SessionsGroupMenu.tsx`, the discreet popover), and small, targeted edits to
`SessionsAside.tsx` and `SessionFacts.tsx` to wire it all in. No change to `packages/tui` or to
any other page — this is a Sessions-workspace-only feature.

**Tech Stack:** React + TypeScript (Vite), `bun:test` for unit tests, `lucide-react` icons,
`@agentistics/tui/control/session-fleet` for the shared grouping/ordering primitives.

## Global Constraints

- Everything here is a **per-viewer screen arrangement**, stored in `localStorage` under
  `agentistics-sessions-aside-v1` — never `/api/preferences`, for the exact reason
  `boardPrefs.ts` already states: on a central, `preferences.json` is shared by every signed-in
  user, and one person's collapsed groups must not collapse them for the whole team.
- The terminal cockpit (`packages/tui`) is never touched. Status grouping here shows all 7 raw
  states and is implemented web-only — it must never be built by widening the shared, tested
  `status` dimension in `session-dimensions.ts`, which deliberately collapses
  `exited`/`lost`/`closed` into one bucket for a different, already-shipped reason.
- A `selected` row's styling always wins over any card-color mode, in every mode — selection is a
  fact about where the reader is and must never compete with a fact about the session.
- Every read/write of the new `localStorage` key is guarded (try/catch) — a private window or
  blocked storage falls back to defaults, never throws.
- Follow `bun:test` conventions already in this package (see `fleetGroups.test.ts`,
  `sessionNotifications.test.ts`) — no new test framework, no DOM test runner.

---

### Task 1: `sessionsAsidePrefs.ts` — the persisted arrangement

**Files:**
- Create: `packages/web/src/lib/sessionsAsidePrefs.ts`
- Test: `packages/web/src/lib/sessionsAsidePrefs.test.ts`

**Interfaces:**
- Produces: `AsideGroupBy` (`'project' | 'task' | 'status'`), `ASIDE_GROUP_BY_VALUES`,
  `AsideCardColor` (`'wash' | 'neutral' | 'stripe'`), `ASIDE_CARD_COLOR_VALUES`, `AsideBandId`
  (`'active' | 'inactive'`), `AsideGroupPrefs`, `DEFAULT_ASIDE_GROUP_PREFS`,
  `collapseKey(band, groupBy, key): string`, `readAsideGroupPrefs(): AsideGroupPrefs`,
  `writeAsideGroupPrefs(patch: Partial<AsideGroupPrefs>): void` — every later task imports from
  here.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/sessionsAsidePrefs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ASIDE_GROUP_PREFS, collapseKey, readAsideGroupPrefs, writeAsideGroupPrefs,
} from './sessionsAsidePrefs'

/** A minimal localStorage, so the module runs outside a browser — same pattern
 *  `sessionNotifications.test.ts` uses. */
function installStorage(): void {
  const store = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
}

beforeEach(installStorage)
afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage })

describe('readAsideGroupPrefs', () => {
  test('nothing stored yields the defaults', () => {
    expect(readAsideGroupPrefs()).toEqual(DEFAULT_ASIDE_GROUP_PREFS)
  })

  test('corrupt JSON falls back to the defaults rather than throwing', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', '{not json')
    expect(readAsideGroupPrefs()).toEqual(DEFAULT_ASIDE_GROUP_PREFS)
  })

  test('an unrecognised groupBy falls back rather than rendering as-is', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ groupBy: 'repo' }))
    expect(readAsideGroupPrefs().groupBy).toBe('project')
  })

  test('an unrecognised cardColor falls back rather than rendering as-is', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ cardColor: 'rainbow' }))
    expect(readAsideGroupPrefs().cardColor).toBe('wash')
  })

  test('order keeps only known dimensions and string arrays', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({
      order: { status: ['working', 'lost'], repo: ['x'], task: 'not-an-array' },
    }))
    expect(readAsideGroupPrefs().order).toEqual({ status: ['working', 'lost'] })
  })

  test('collapsed drops non-string entries', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({
      collapsed: ['active:project:agentistics', 42, null],
    }))
    expect(readAsideGroupPrefs().collapsed).toEqual(['active:project:agentistics'])
  })
})

describe('writeAsideGroupPrefs', () => {
  test('round-trips a full write', () => {
    writeAsideGroupPrefs({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
    })
    expect(readAsideGroupPrefs()).toEqual({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
    })
  })

  test('a partial write merges over what is already stored', () => {
    writeAsideGroupPrefs({ groupBy: 'task' })
    writeAsideGroupPrefs({ cardColor: 'stripe' })
    const out = readAsideGroupPrefs()
    expect(out.groupBy).toBe('task')
    expect(out.cardColor).toBe('stripe')
  })
})

describe('collapseKey', () => {
  test('bands the same key/dimension apart, so one band folding never folds the other', () => {
    expect(collapseKey('active', 'project', 'agentistics'))
      .not.toBe(collapseKey('inactive', 'project', 'agentistics'))
  })

  test('is stable and readable', () => {
    expect(collapseKey('active', 'status', 'working')).toBe('active:status:working')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/web/src/lib/sessionsAsidePrefs.test.ts`
Expected: FAIL — `Cannot find module './sessionsAsidePrefs'`

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/sessionsAsidePrefs.ts`:

```ts
/**
 * sessionsAsidePrefs.ts — how the Sessions workspace's aside arranges its own list.
 *
 * `localStorage`, deliberately not `/api/preferences` — the same rule and the same reason
 * `boardPrefs.ts` states: on a central, `preferences.json` is shared by every signed-in user, and
 * this is a per-viewer arrangement of a list (which grouping, in what order, which groups are
 * folded, how a card shows its status), not a fact about the work like a pin. One person's
 * collapsed groups must not collapse them for the whole team looking at that central's relayed
 * fleet.
 *
 * Every read and write is guarded: a private window, cleared site data, or blocked storage makes
 * the accessor throw, and an aside that will not render because it could not remember its
 * arrangement is worse than one that opens on the defaults.
 */

const KEY = 'agentistics-sessions-aside-v1'

/** The sub-grouping inside each Active/Inactive band. */
export type AsideGroupBy = 'project' | 'task' | 'status'

export const ASIDE_GROUP_BY_VALUES: readonly AsideGroupBy[] = ['project', 'task', 'status']

/** How a session's card shows its state — see `sessionCardStyle.ts`. */
export type AsideCardColor = 'wash' | 'neutral' | 'stripe'

export const ASIDE_CARD_COLOR_VALUES: readonly AsideCardColor[] = ['wash', 'neutral', 'stripe']

/** The band a group lives under — never the localized label, or PT/EN would split one
 *  preference in two. */
export type AsideBandId = 'active' | 'inactive'

export interface AsideGroupPrefs {
  groupBy: AsideGroupBy
  /** Manual order of group KEYS, per dimension. An absent dimension is fully automatic. */
  order: Partial<Record<AsideGroupBy, string[]>>
  /** Collapsed groups, keyed `${band}:${groupBy}:${key}` — see `collapseKey`. */
  collapsed: string[]
  cardColor: AsideCardColor
}

export const DEFAULT_ASIDE_GROUP_PREFS: AsideGroupPrefs = {
  groupBy: 'project', order: {}, collapsed: [], cardColor: 'wash',
}

/** The stable key one group's collapsed state is stored under. */
export function collapseKey(band: AsideBandId, groupBy: AsideGroupBy, key: string): string {
  return `${band}:${groupBy}:${key}`
}

const isGroupBy = (v: unknown): v is AsideGroupBy =>
  typeof v === 'string' && (ASIDE_GROUP_BY_VALUES as readonly string[]).includes(v)

const isCardColor = (v: unknown): v is AsideCardColor =>
  typeof v === 'string' && (ASIDE_CARD_COLOR_VALUES as readonly string[]).includes(v)

function readOrder(v: unknown): Partial<Record<AsideGroupBy, string[]>> {
  if (!v || typeof v !== 'object') return {}
  const out: Partial<Record<AsideGroupBy, string[]>> = {}
  for (const by of ASIDE_GROUP_BY_VALUES) {
    const list = (v as Record<string, unknown>)[by]
    if (Array.isArray(list)) out[by] = list.filter((x): x is string => typeof x === 'string')
  }
  return out
}

export function readAsideGroupPrefs(): AsideGroupPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_ASIDE_GROUP_PREFS
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      groupBy: isGroupBy(p.groupBy) ? p.groupBy : DEFAULT_ASIDE_GROUP_PREFS.groupBy,
      order: readOrder(p.order),
      collapsed: Array.isArray(p.collapsed)
        ? p.collapsed.filter((x): x is string => typeof x === 'string')
        : [],
      cardColor: isCardColor(p.cardColor) ? p.cardColor : DEFAULT_ASIDE_GROUP_PREFS.cardColor,
    }
  } catch { return DEFAULT_ASIDE_GROUP_PREFS }
}

export function writeAsideGroupPrefs(patch: Partial<AsideGroupPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAsideGroupPrefs(), ...patch }))
  } catch { /* storage unavailable — the arrangement lasts this visit and no longer */ }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/web/src/lib/sessionsAsidePrefs.test.ts`
Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/sessionsAsidePrefs.ts packages/web/src/lib/sessionsAsidePrefs.test.ts
git commit -m "feat(web): persist the sessions aside's grouping arrangement

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `sessionCardStyle.ts` — the three card-color modes

**Files:**
- Create: `packages/web/src/lib/sessionCardStyle.ts`
- Test: `packages/web/src/lib/sessionCardStyle.test.ts`

**Interfaces:**
- Consumes: `AsideCardColor` from `./sessionsAsidePrefs` (Task 1); `SessionState` from
  `@agentistics/tui/control/session-fleet`.
- Produces: `STATE_COLOR: Record<SessionState, string>`, `CardStyle { background: string; edge?:
  string; stateTextColor?: string }`, `sessionCardStyle(state, mode, selected): CardStyle` —
  consumed by Task 6 (`SessionsAside.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/sessionCardStyle.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { SessionState } from '@agentistics/tui/control/session-fleet'
import { STATE_COLOR, sessionCardStyle } from './sessionCardStyle'

const STATES: SessionState[] =
  ['working', 'waiting', 'waiting-approval', 'exited', 'lost', 'closed', 'unknown']

describe('sessionCardStyle — selected always wins', () => {
  test('every state, every mode, selected renders the same neutral style', () => {
    for (const state of STATES) {
      for (const mode of ['wash', 'neutral', 'stripe'] as const) {
        const out = sessionCardStyle(state, mode, true)
        expect(out.background).toBe('var(--bg-elevated)')
        expect(out.edge).toContain('var(--text-primary)')
        expect(out.stateTextColor).toBeUndefined()
      }
    }
  })
})

describe('sessionCardStyle — wash', () => {
  test('every one of the seven states gets its own tint and edge', () => {
    for (const state of STATES) {
      const out = sessionCardStyle(state, 'wash', false)
      expect(out.background).toContain(STATE_COLOR[state])
      expect(out.edge).toBe(`inset 2px 0 0 ${STATE_COLOR[state]}`)
      expect(out.stateTextColor).toBeUndefined()
    }
  })

  test('the two states that need a person keep their existing 12% figure', () => {
    expect(sessionCardStyle('waiting', 'wash', false).background).toContain('12%')
    expect(sessionCardStyle('waiting-approval', 'wash', false).background).toContain('12%')
    expect(sessionCardStyle('working', 'wash', false).background).toContain('10%')
  })
})

describe('sessionCardStyle — neutral', () => {
  test('no background tint and no edge — the state word carries the color instead', () => {
    for (const state of STATES) {
      const out = sessionCardStyle(state, 'neutral', false)
      expect(out.background).toBe('transparent')
      expect(out.edge).toBeUndefined()
      expect(out.stateTextColor).toBe(STATE_COLOR[state])
    }
  })
})

describe('sessionCardStyle — stripe', () => {
  test('no background tint, a colored left edge, no text override', () => {
    for (const state of STATES) {
      const out = sessionCardStyle(state, 'stripe', false)
      expect(out.background).toBe('transparent')
      expect(out.edge).toBe(`inset 3px 0 0 ${STATE_COLOR[state]}`)
      expect(out.stateTextColor).toBeUndefined()
    }
  })
})

describe('STATE_COLOR', () => {
  test('lost is its own color, no longer sharing the tertiary fallback with exited/closed', () => {
    expect(STATE_COLOR.lost).toBe('var(--accent-red)')
    expect(STATE_COLOR.lost).not.toBe(STATE_COLOR.exited)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/web/src/lib/sessionCardStyle.test.ts`
Expected: FAIL — `Cannot find module './sessionCardStyle'`

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/sessionCardStyle.ts`:

```ts
/**
 * sessionCardStyle.ts — how ONE session's card shows its state — PURE.
 *
 * Three modes, chosen by the person and stored in `sessionsAsidePrefs.ts`:
 *  - `wash`    — the card's whole background is tinted by the state's color, for all seven
 *    states. Before this module existed only `working`/`waiting`/`waiting-approval` got a tint
 *    and everything else read as plain, which made "the background follows the status" describe
 *    two different things depending on which status a row happened to be in.
 *  - `neutral` — the background stays plain; the state WORD (in the row's meta line) takes the
 *    state's color instead.
 *  - `stripe`  — the background stays plain, plus a colored left edge — the same visual language
 *    `TaskBoard`'s cards already use for their own status stripe.
 *
 * `selected` always wins, in every mode: a selected row's neutral, full-height edge is a fact
 * about where the READER is, and it must never compete with a fact about the SESSION — the same
 * rule `SessionsAside.tsx` states for why selection is not colored orange.
 */

import type { SessionState } from '@agentistics/tui/control/session-fleet'
import type { AsideCardColor } from './sessionsAsidePrefs'

/** The color a state is said in, everywhere this feature draws one. `working` is its own token,
 *  never `success` (which reads teal on a terminal and sits within a hair of a harness color). */
export const STATE_COLOR: Record<SessionState, string> = {
  working: 'var(--accent-green)',
  waiting: 'var(--anthropic-orange)',
  'waiting-approval': 'var(--anthropic-orange)',
  exited: 'var(--text-tertiary)',
  lost: 'var(--accent-red)',
  closed: 'var(--text-tertiary)',
  unknown: 'var(--text-tertiary)',
}

/** How much of the state's color the `wash` background carries, in percent. The three states
 *  that already had a wash keep their exact figures; the four newly-covered ones take the same
 *  figure `working` always used. */
const WASH_PCT: Record<SessionState, number> = {
  working: 10, waiting: 12, 'waiting-approval': 12,
  exited: 10, lost: 10, closed: 10, unknown: 10,
}

export interface CardStyle {
  background: string
  /** The left-edge indicator (an inset box-shadow), or undefined for none. */
  edge?: string
  /** Set only in `neutral` mode — the meta line's state-word color. */
  stateTextColor?: string
}

const SELECTED: CardStyle = {
  background: 'var(--bg-elevated)',
  edge: 'inset 3px 0 0 var(--text-primary), inset 0 0 0 1px var(--border)',
}

export function sessionCardStyle(
  state: SessionState,
  mode: AsideCardColor,
  selected: boolean,
): CardStyle {
  if (selected) return SELECTED
  const color = STATE_COLOR[state]
  switch (mode) {
    case 'wash':
      return {
        background: `color-mix(in srgb, ${color} ${WASH_PCT[state]}%, transparent)`,
        edge: `inset 2px 0 0 ${color}`,
      }
    case 'stripe':
      return { background: 'transparent', edge: `inset 3px 0 0 ${color}` }
    case 'neutral':
      return { background: 'transparent', stateTextColor: color }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/web/src/lib/sessionCardStyle.test.ts`
Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/sessionCardStyle.ts packages/web/src/lib/sessionCardStyle.test.ts
git commit -m "feat(web): the three session-card color modes, as a pure function

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `fleetGroups.ts` — Project / Task / Status grouping, and manual order

**Files:**
- Modify: `packages/web/src/lib/fleetGroups.ts` (full rewrite — the file is 84 lines)
- Modify: `packages/web/src/lib/fleetGroups.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `AsideGroupBy` from `./sessionsAsidePrefs` (Task 1).
- Produces: `asideGroups(rows, by, lang, order?): SessionGroup[]`,
  `applyManualOrder(groups, order): SessionGroup[]`, `showsGroupHeadings(groups): boolean` —
  consumed by Task 6. **Replaces** `projectGroups`/`showsProjectHeadings`, whose only caller
  (`SessionsAside.tsx`) is updated in Task 6.

Note: this task also changes the Task-grouping "unfiled" wording from "No task"/"Sem tarefa" to
"No delivery"/"Sem entrega" — matching the exact words `SessionFacts.tsx` already prints on every
row's own delivery chip. That entry of the word book was written but never actually rendered
before this feature (only `project` was ever grouped), so this is the first time it reaches a
screen — fixing the mismatch now, rather than shipping a new inconsistency, is deliberate.

- [ ] **Step 1: Write the failing tests**

Replace `packages/web/src/lib/fleetGroups.test.ts` in full:

```ts
import { expect, test, describe } from 'bun:test'
import { GONE_PROJECT_KEY, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { applyManualOrder, asideGroups, showsGroupHeadings } from './fleetGroups'

function row(o: Partial<ControlSession> & { id: string }): ControlSession {
  return {
    title: o.id, harness: 'claude', cwd: '/w', project: 'w',
    searchFields: {} as ControlSession['searchFields'],
    state: 'working', stateLabel: 'working', actionable: true, attached: false,
    ...o,
  } as ControlSession
}

describe('asideGroups — project', () => {
  test('one band per project, named by the project', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'aipe' }),
      row({ id: 'c', project: 'agentistics' }),
    ], 'project', 'en')
    expect(out.map(g => g.label).sort()).toEqual(['agentistics', 'aipe'])
    expect(out.find(g => g.label === 'agentistics')!.sessions).toHaveLength(2)
  })

  test('the band holding the most urgent session comes first', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'project', 'en')
    expect(out[0]!.label).toBe('blocked')
  })

  test('a session with no project gets a band said in WORDS, never a blank heading', () => {
    const en = asideGroups([row({ id: 'a', project: '' })], 'project', 'en')
    const pt = asideGroups([row({ id: 'a', project: '' })], 'project', 'pt')
    expect(en[0]!.label).toBe('No project')
    expect(pt[0]!.label).toBe('Sem projeto')
  })

  test('a directory that is GONE is its own band, not the no-project one', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'x', dirGone: 'the folder is gone' }),
      row({ id: 'b', project: '' }),
    ], 'project', 'en')
    const labels = out.map(g => g.label)
    expect(labels).toContain('Folder is gone')
    expect(labels).toContain('No project')
    expect(new Set(labels).size).toBe(2)
  })

  test('an empty fleet yields no bands', () => {
    expect(asideGroups([], 'project', 'en')).toEqual([])
  })

  test('projectGroup outranks the directory name, and GONE has its own key', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'worktree-x', projectGroup: 'agentistics' }),
      row({ id: 'b', project: 'worktree-y', projectGroup: 'agentistics' }),
    ], 'project', 'en')
    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('agentistics')
    expect(out[0]!.key).not.toBe(GONE_PROJECT_KEY)
  })
})

describe('asideGroups — task', () => {
  test('one band per delivery, and an unfiled session gets the same word the row chip uses', () => {
    const out = asideGroups([
      row({ id: 'a', task: 'ALM board' }),
      row({ id: 'b' }),
    ], 'task', 'en')
    expect(out.map(g => g.label).sort()).toEqual(['ALM board', 'No delivery'])
  })

  test('PT names the same unfiled bucket "sem entrega"', () => {
    const out = asideGroups([row({ id: 'a' })], 'task', 'pt')
    expect(out[0]!.label).toBe('Sem entrega')
  })
})

describe('asideGroups — status', () => {
  test('seven raw states are seven distinct groups, never collapsed', () => {
    const out = asideGroups([
      row({ id: 'a', state: 'exited' }),
      row({ id: 'b', state: 'lost' }),
      row({ id: 'c', state: 'closed' }),
    ], 'status', 'en')
    expect(out).toHaveLength(3)
    expect(out.map(g => g.label).sort()).toEqual(['Closed', 'Finished', 'Lost'])
  })

  test('the most urgent state leads', () => {
    const out = asideGroups([
      row({ id: 'a', state: 'working' }),
      row({ id: 'b', state: 'waiting-approval' }),
    ], 'status', 'en')
    expect(out[0]!.label).toBe('Needs approval')
  })

  test('PT labels match the vocabulary used elsewhere in the product', () => {
    const out = asideGroups([row({ id: 'a', state: 'waiting' })], 'status', 'pt')
    expect(out[0]!.label).toBe('Precisa de você')
  })

  test('a session is counted once, under its OWN state — no state absorbs another', () => {
    const out = asideGroups([
      row({ id: 'a', state: 'exited' }),
      row({ id: 'b', state: 'exited' }),
      row({ id: 'c', state: 'lost' }),
    ], 'status', 'en')
    expect(out.find(g => g.label === 'Finished')!.sessions).toHaveLength(2)
    expect(out.find(g => g.label === 'Lost')!.sessions).toHaveLength(1)
  })
})

describe('showsGroupHeadings', () => {
  test('one group draws no heading', () => {
    expect(showsGroupHeadings(asideGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'agentistics' }),
    ], 'project', 'en'))).toBe(false)
  })

  test('two groups draw headings', () => {
    expect(showsGroupHeadings(asideGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'aipe' }),
    ], 'project', 'en'))).toBe(true)
  })

  test('nothing at all draws no heading', () => {
    expect(showsGroupHeadings([])).toBe(false)
  })
})

describe('applyManualOrder', () => {
  test('empty order leaves the automatic order untouched', () => {
    const groups = asideGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'project', 'en')
    expect(applyManualOrder(groups, [])).toEqual(groups)
  })

  test('known keys come first, in the given order, overriding the automatic one', () => {
    const groups = asideGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'project', 'en')
    // Automatic order puts "blocked" first (waiting-approval outranks working) — manual order
    // overrides it.
    const out = applyManualOrder(groups, ['quiet', 'blocked'])
    expect(out.map(g => g.key)).toEqual(['quiet', 'blocked'])
  })

  test('a key with no group is simply absent — nothing to reconcile', () => {
    const groups = asideGroups([row({ id: 'a', project: 'quiet' })], 'project', 'en')
    const out = applyManualOrder(groups, ['gone-project', 'quiet'])
    expect(out.map(g => g.key)).toEqual(['quiet'])
  })

  test('a group not yet in the manual order is appended after every placed one', () => {
    const groups = asideGroups([
      row({ id: 'a', project: 'x' }),
      row({ id: 'b', project: 'y' }),
      row({ id: 'c', project: 'z' }),
    ], 'project', 'en')
    // Only "z" has been manually placed — "x" and "y" fall in after it.
    const out = applyManualOrder(groups, ['z'])
    expect(out[0]!.key).toBe('z')
    expect(new Set(out.map(g => g.key))).toEqual(new Set(['x', 'y', 'z']))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/web/src/lib/fleetGroups.test.ts`
Expected: FAIL — `asideGroups`/`applyManualOrder`/`showsGroupHeadings` are not exported yet.

- [ ] **Step 3: Write the implementation**

Replace `packages/web/src/lib/fleetGroups.ts` in full:

```ts
/**
 * fleetGroups.ts — which sub-group a fleet row belongs to, for the sessions aside — PURE.
 *
 * Project and Task reuse `groupSessions` in `@agentistics/tui/control/session-fleet` — the very
 * function the terminal cockpit and `agentop session ls` resolve their bands with. A second
 * implementation of "which band does this row belong to" is exactly the defect that module exists
 * to remove.
 *
 * Status is the one exception, and it is web-only on purpose. The shared `status` dimension in
 * `session-dimensions.ts` deliberately collapses `exited`/`lost`/`closed` into one `Off` bucket —
 * the "3 desligadas, wtf" fix, a decision made for the terminal's filter menu and tested there.
 * This aside groups by the raw `session.state` instead (seven distinct buckets), because that is
 * a different, purely visual arrangement question, and reusing the collapsed dimension would
 * either mislabel a merged bucket or reopen a decision this feature has no reason to touch.
 *
 * What lives here besides the grouping itself: the WORDS (this module deliberately owns none of
 * `groupSessions`'s own vocabulary, but Status needs its own, since it does not go through that
 * function), the rule that a band holding one group draws no heading, and the manual reordering a
 * person can apply on top of the automatic (most-urgent-first) order.
 */

import {
  DEFAULT_ORDER, dimensionWordBook, groupSessions, sessionRank, sortSessions,
  type ControlSession, type DimensionWordBook, type SessionGroup, type SessionState,
} from '@agentistics/tui/control/session-fleet'
import type { AsideGroupBy } from './sessionsAsidePrefs'

type Lang = 'pt' | 'en'

/**
 * The word book, built for Project and Task — the two dimensions that still go through
 * `groupSessions`. Status never reads this: see `STATUS_GROUP_WORDS` below.
 *
 * `DimensionWordBook` is a `Record` over every dimension because `groupSessions` takes the whole
 * book; this aside only ever asks for one of them at a time. The other entries carry their real
 * names so nothing reads as a placeholder, but only `project` needs a `values` map — a project,
 * repo, model or task key IS its name.
 */
function wordBook(lang: Lang): DimensionWordBook {
  const pt = lang === 'pt'
  return dimensionWordBook({
    labels: {
      day: pt ? 'Dia' : 'Day',
      status: pt ? 'Estado' : 'Status',
      harness: pt ? 'Assistente' : 'Assistant',
      model: pt ? 'Modelo' : 'Model',
      project: pt ? 'Projeto' : 'Project',
      repo: pt ? 'Repositório' : 'Repository',
      task: pt ? 'Tarefa' : 'Task',
      marked: pt ? 'Marcadas' : 'Marked',
    },
    // Each absence is its OWN sentence: "the folder was never recorded" and "no delivery filed"
    // are different facts, and one blank heading shared between them is how a list starts lying.
    unfiled: {
      day: pt ? 'Sem data' : 'No date',
      status: pt ? 'Sem estado' : 'No status',
      harness: pt ? 'Assistente desconhecido' : 'Unknown assistant',
      model: pt ? 'Sem modelo' : 'No model',
      project: pt ? 'Sem projeto' : 'No project',
      repo: pt ? 'Fora de um repositório' : 'Outside a repository',
      // The same word `SessionFacts.tsx` already prints on a row's own delivery chip — a group
      // heading calling this "no task" while the row underneath it says "no delivery" is one
      // feature disagreeing with itself about its own vocabulary.
      task: pt ? 'Sem entrega' : 'No delivery',
      marked: pt ? 'Não marcadas' : 'Not marked',
    },
    states: {},
    goneProject: pt ? 'Pasta removida' : 'Folder is gone',
    marked: pt ? 'Marcadas' : 'Marked',
  })
}

/** The seven raw states, in the words this aside heads a Status group with. */
const STATUS_GROUP_WORDS: Record<SessionState, { en: string; pt: string }> = {
  working: { en: 'Working', pt: 'Trabalhando' },
  waiting: { en: 'Needs you', pt: 'Precisa de você' },
  'waiting-approval': { en: 'Needs approval', pt: 'Precisa de aprovação' },
  exited: { en: 'Finished', pt: 'Encerradas' },
  lost: { en: 'Lost', pt: 'Desconectadas' },
  closed: { en: 'Closed', pt: 'Fechadas' },
  unknown: { en: 'External', pt: 'Externas' },
}

/**
 * One group per raw state — never through `bucketKey`/`groupSessions`, and never collapsed.
 *
 * Ordered the same way `groupSessions` orders every other dimension: by each group's most urgent
 * member, ties broken by label.
 */
function statusGroups(rows: readonly ControlSession[], lang: Lang): SessionGroup[] {
  const groups = new Map<SessionState, SessionGroup>()
  for (const s of rows) {
    const found = groups.get(s.state)
    if (found) found.sessions.push(s)
    else groups.set(s.state, { key: s.state, label: STATUS_GROUP_WORDS[s.state][lang], sessions: [s] })
  }
  return [...groups.values()]
    .map(g => ({ ...g, sessions: sortSessions(g.sessions, DEFAULT_ORDER) }))
    .sort((a, b) => {
      const byRank = sessionRank(a.sessions[0]!) - sessionRank(b.sessions[0]!)
      return byRank !== 0 ? byRank : a.label.localeCompare(b.label)
    })
}

/**
 * Reorder groups by a person's manual choice — PURE.
 *
 * A key in `order` that no longer has a group (a deleted task, a status nobody has right now)
 * simply is not in `groups` and drops out on its own — nothing to reconcile. A group not yet in
 * `order` (a brand new task, a status nobody has seen before) is appended after every
 * manually-placed group, in whatever order the automatic urgency-first sort already gave it — so
 * a new group is never lost, only unpositioned until somebody moves it.
 */
export function applyManualOrder(
  groups: readonly SessionGroup[],
  order: readonly string[],
): SessionGroup[] {
  if (order.length === 0) return [...groups]
  const byKey = new Map(groups.map(g => [g.key, g]))
  const known = order
    .map(k => byKey.get(k))
    .filter((g): g is SessionGroup => g !== undefined)
  const knownKeys = new Set(known.map(g => g.key))
  const rest = groups.filter(g => !knownKeys.has(g.key))
  return [...known, ...rest]
}

/**
 * The fleet as groups of the chosen dimension — most urgent group first, and the rows inside each
 * in `DEFAULT_ORDER` — with the person's manual order applied on top.
 */
export function asideGroups(
  rows: readonly ControlSession[],
  by: AsideGroupBy,
  lang: Lang,
  order: readonly string[] = [],
): SessionGroup[] {
  if (rows.length === 0) return []
  const raw = by === 'status'
    ? statusGroups(rows, lang)
    : groupSessions(rows, by, wordBook(lang), [], DEFAULT_ORDER)
  return applyManualOrder(raw, order)
}

/** Whether these bands are worth heading at all — a band holding ONE group repeats what the band
 *  above it already said and costs a row, the same reason the cockpit's cascade drops its root
 *  when the grouping is already the project. */
export function showsGroupHeadings(groups: readonly SessionGroup[]): boolean {
  return groups.length > 1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/web/src/lib/fleetGroups.test.ts`
Expected: PASS (all tests green)

- [ ] **Step 5: Confirm nothing else references the old names**

Run: `grep -rn "projectGroups\|showsProjectHeadings" packages/web/src`
Expected: no matches outside this task's own files (they were rewritten above) — the one caller,
`SessionsAside.tsx`, is updated in Task 6, so a transient reference there is fine and expected
until that task lands.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/fleetGroups.ts packages/web/src/lib/fleetGroups.test.ts
git commit -m "feat(web): group the sessions aside by task or status, not just project

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `SessionFacts.tsx` — an overridable meta-line color

**Files:**
- Modify: `packages/web/src/components/sessions/SessionFacts.tsx`

**Interfaces:**
- Produces: `SessionFactsProps.metaColor?: string` — consumed by Task 6.

- [ ] **Step 1: Read the current file to confirm line numbers before editing**

Run: `grep -n "SessionFactsProps\|export function SessionFacts\|color: wants" packages/web/src/components/sessions/SessionFacts.tsx`

Expected output includes the `SessionFactsProps` interface, the `SessionFacts` function
declaration, and one line reading:
`color: wants ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',`

- [ ] **Step 2: Add the `metaColor` prop and use it**

In `packages/web/src/components/sessions/SessionFacts.tsx`, change:

```ts
export interface SessionFactsProps {
  session: ControlSession
  /**
   * File this session under a delivery. Absent = this surface has no picker (the collapsed rail's
   * tooltip), and the cell is then plain text rather than a control that goes nowhere.
   */
  onFile?: () => void
  lang?: 'pt' | 'en'
}

export function SessionFacts({ session, selected = false, onFile, lang = 'en' }: SessionFactsProps) {
```

to:

```ts
export interface SessionFactsProps {
  session: ControlSession
  /**
   * File this session under a delivery. Absent = this surface has no picker (the collapsed rail's
   * tooltip), and the cell is then plain text rather than a control that goes nowhere.
   */
  onFile?: () => void
  lang?: 'pt' | 'en'
  /**
   * Overrides the meta line's color — set by the Sessions aside's "neutral background" card-color
   * mode. Absent keeps the current wants-driven color (orange when the session wants a person,
   * tertiary otherwise), which is what the collapsed rail's tooltip still gets: this is a
   * Sessions-aside preference, not a fact about the row itself.
   */
  metaColor?: string
}

export function SessionFacts({ session, selected = false, onFile, lang = 'en', metaColor }: SessionFactsProps) {
```

(The `selected` line already exists two lines above `onFile` in the interface — only the block
shown is inserted/changed; leave `selected?: boolean` where it is.)

Then change:

```ts
      <span style={{
        display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
        fontSize: 10.5, color: wants ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
      }}>
```

to:

```ts
      <span style={{
        display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
        fontSize: 10.5, color: metaColor ?? (wants ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'),
      }}>
```

- [ ] **Step 3: Typecheck**

Run: `bun tsc --noEmit`
Expected: no new errors (this is a backward-compatible optional prop; `SessionsRail.tsx`'s call
site, which does not pass `metaColor`, keeps compiling and keeps its current behavior).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/sessions/SessionFacts.tsx
git commit -m "feat(web): let a session row's meta-line color be overridden

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `SessionsGroupMenu.tsx` — the discreet popover

**Files:**
- Create: `packages/web/src/components/nav/SessionsGroupMenu.tsx`

**Interfaces:**
- Consumes: `AsideGroupBy`, `AsideCardColor`, `ASIDE_GROUP_BY_VALUES`, `ASIDE_CARD_COLOR_VALUES`
  from `../../lib/sessionsAsidePrefs` (Task 1).
- Produces: `SessionsGroupMenuProps`, `SessionsGroupMenu` component — consumed by Task 6.

- [ ] **Step 1: Create the component**

Create `packages/web/src/components/nav/SessionsGroupMenu.tsx`:

```tsx
/**
 * SessionsGroupMenu — the aside's one discreet control for how its list is arranged.
 *
 * Three questions, one popover, because they are all "how does this list organize and look":
 * which dimension the sessions are sub-grouped by, in what order those groups appear, and how a
 * session's own card shows its status color. Reordering lives inside the SAME item that picks the
 * grouping — the reorder list only makes sense once a dimension is chosen, and it always shows
 * exactly what THAT dimension is currently drawing.
 *
 * Follows the settings screens' popover contract — `position: fixed` in a portal, measured from
 * the trigger, clamped to the viewport, closing on scroll — the same contract `PickerMenu` and
 * `BoardArrange`'s panels already keep, because a menu that opens inside a scrolling list gets
 * clipped by it.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, GripVertical, SlidersHorizontal } from 'lucide-react'
import {
  ASIDE_CARD_COLOR_VALUES, ASIDE_GROUP_BY_VALUES,
  type AsideCardColor, type AsideGroupBy,
} from '../../lib/sessionsAsidePrefs'

const GROUP_BY_LABEL: Record<AsideGroupBy, { en: string; pt: string }> = {
  project: { en: 'Project', pt: 'Projeto' },
  task: { en: 'Task', pt: 'Tarefa' },
  status: { en: 'Status', pt: 'Status' },
}

const CARD_COLOR_LABEL: Record<AsideCardColor, { en: string; pt: string }> = {
  wash: { en: 'Background follows status', pt: 'Fundo acompanha o status' },
  neutral: { en: 'Neutral background, colored text', pt: 'Fundo neutro, texto colorido' },
  stripe: { en: 'Colored left stripe', pt: 'Barra lateral colorida' },
}

export interface SessionsGroupMenuProps {
  lang: 'pt' | 'en'
  groupBy: AsideGroupBy
  onGroupBy: (v: AsideGroupBy) => void
  /** The current dimension's groups, across both bands, deduped by key, in their EFFECTIVE order
   *  (manual order already applied) — what the reorder list edits and shows. */
  groups: readonly { key: string; label: string }[]
  /** The full new key order, every time a drag or a step button moves one. */
  onReorder: (next: string[]) => void
  cardColor: AsideCardColor
  onCardColor: (v: AsideCardColor) => void
}

export function SessionsGroupMenu(p: SessionsGroupMenuProps) {
  const pt = p.lang === 'pt'
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const width = 240

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const move = (from: string, to: string) => {
    if (from === to) return
    const keys = p.groups.map(g => g.key)
    const without = keys.filter(k => k !== from)
    const at_ = without.indexOf(to)
    if (at_ === -1) return
    without.splice(at_, 0, from)
    p.onReorder(without)
  }

  const step = (key: string, by: 1 | -1) => {
    const keys = p.groups.map(g => g.key)
    const from = keys.indexOf(key)
    const to = from + by
    if (from === -1 || to < 0 || to >= keys.length) return
    const next = [...keys]
    next.splice(to, 0, ...next.splice(from, 1))
    p.onReorder(next)
  }

  const rowStyle = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left',
    width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit',
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
  })

  const sectionLabel: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-tertiary)', padding: '6px 8px 3px',
  }

  return (
    <>
      <button
        ref={trigger}
        onClick={() => {
          if (open) { setOpen(false); return }
          const r = trigger.current?.getBoundingClientRect()
          if (!r) return
          setAt({ left: Math.min(r.left, window.innerWidth - width - 12), top: r.bottom + 6 })
          setOpen(true)
        }}
        aria-label={pt ? 'Organizar lista' : 'Arrange list'}
        title={pt ? 'Organizar lista' : 'Arrange list'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          width: 34, padding: 0, borderRadius: 9, cursor: 'pointer',
          border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
          color: open ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', fontFamily: 'inherit',
        }}
      >
        <SlidersHorizontal size={14} />
      </button>

      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div style={{
            position: 'fixed', left: at.left, top: at.top, width, zIndex: 1200,
            borderRadius: 12, border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 2,
            boxShadow: 'var(--ag-shadow-menu)', maxHeight: 420, overflowY: 'auto',
          }}>
            <div style={sectionLabel}>{pt ? 'Agrupamento por' : 'Group by'}</div>
            {ASIDE_GROUP_BY_VALUES.map(v => (
              <button key={v} onClick={() => p.onGroupBy(v)} style={rowStyle(p.groupBy === v)}>
                {GROUP_BY_LABEL[v][p.lang]}
              </button>
            ))}

            {p.groups.length > 1 && (
              <>
                <div style={sectionLabel}>{pt ? 'Ordem dos grupos' : 'Group order'}</div>
                {p.groups.map((g, i) => (
                  <div
                    key={g.key}
                    draggable
                    onDragStart={() => setDrag(g.key)}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); if (drag) move(drag, g.key); setDrag(null) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                      borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
                      opacity: drag === g.key ? 0.45 : 1,
                    }}
                  >
                    <GripVertical
                      size={12}
                      style={{ flexShrink: 0, color: 'var(--text-tertiary)', cursor: 'grab' }}
                    />
                    <span style={{
                      flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{g.label}</span>
                    <button
                      onClick={() => step(g.key, -1)} disabled={i === 0}
                      aria-label={pt ? 'Mover para cima' : 'Move up'}
                      style={{
                        background: 'none', border: 'none', padding: 0, width: 18, height: 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: i === 0 ? 'var(--border)' : 'var(--text-tertiary)',
                        cursor: i === 0 ? 'default' : 'pointer',
                      }}
                    ><ChevronUp size={13} /></button>
                    <button
                      onClick={() => step(g.key, 1)} disabled={i === p.groups.length - 1}
                      aria-label={pt ? 'Mover para baixo' : 'Move down'}
                      style={{
                        background: 'none', border: 'none', padding: 0, width: 18, height: 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: i === p.groups.length - 1 ? 'var(--border)' : 'var(--text-tertiary)',
                        cursor: i === p.groups.length - 1 ? 'default' : 'pointer',
                      }}
                    ><ChevronDown size={13} /></button>
                  </div>
                ))}
              </>
            )}

            <div style={sectionLabel}>{pt ? 'Cor dos cards' : 'Card color'}</div>
            {ASIDE_CARD_COLOR_VALUES.map(v => (
              <button key={v} onClick={() => p.onCardColor(v)} style={rowStyle(p.cardColor === v)}>
                {CARD_COLOR_LABEL[v][p.lang]}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun tsc --noEmit`
Expected: no errors (this file is not imported anywhere yet, so it must compile standalone but
produces no other change).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/nav/SessionsGroupMenu.tsx
git commit -m "feat(web): the sessions aside's group-by/order/color popover

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire it all into `SessionsAside.tsx`

**Files:**
- Modify: `packages/web/src/components/nav/SessionsAside.tsx`

**Interfaces:**
- Consumes: everything produced by Tasks 1–5.

This task has more, smaller steps because it touches one large file in several places. Read the
file once at the start so line numbers below are current for your checkout — if a previous task
in this plan already changed unrelated lines above, re-run the `grep -n` in Step 1 rather than
trusting a stale line number.

- [ ] **Step 1: Confirm current anchors**

Run:
```bash
grep -n "^import\|^const STATE_COLOR\|^const STATE_WASH\|function pinKeyOf\|export function SessionsAside\|const bands = useMemo\|function SessionBand\|function SessionRow" packages/web/src/components/nav/SessionsAside.tsx
```

You should see the import block, the `STATE_COLOR`/`STATE_WASH` consts, `pinKeyOf`, the
`SessionsAside` function, the `bands` memo, `SessionBand`, and `SessionRow`. Use these as anchors
for the edits below rather than the line numbers printed here, since the file may have shifted by
a few lines from the tasks above.

- [ ] **Step 2: Update the import block**

Find:

```ts
import {
  ACTIVE_STATES, filterSessions, sessionNotify,
  type ControlSession, type SessionGroup,
} from '@agentistics/tui/control/session-fleet'
import { projectGroups, showsProjectHeadings } from '../../lib/fleetGroups'
```

Replace with:

```ts
import {
  ACTIVE_STATES, filterSessions, sessionNotify,
  type ControlSession, type SessionGroup, type SessionState,
} from '@agentistics/tui/control/session-fleet'
import { asideGroups, showsGroupHeadings } from '../../lib/fleetGroups'
import {
  collapseKey, readAsideGroupPrefs, writeAsideGroupPrefs,
  type AsideBandId, type AsideCardColor, type AsideGroupBy,
} from '../../lib/sessionsAsidePrefs'
import { sessionCardStyle, STATE_COLOR } from '../../lib/sessionCardStyle'
import { SessionsGroupMenu } from './SessionsGroupMenu'
```

Also find the `lucide-react` import line near the top:

```ts
import { Clock, Pin, PinOff, Plus, RotateCcw, Search, Send, X } from 'lucide-react'
```

Replace with:

```ts
import { ChevronDown, ChevronRight, Clock, Pin, PinOff, Plus, RotateCcw, Search, Send, X } from 'lucide-react'
```

- [ ] **Step 3: Remove the now-superseded `STATE_WASH` const, and the local `STATE_COLOR`**

Find and delete these two blocks entirely (both their doc comments and bodies):

```ts
/** The colour a state is said in. `running` is its own token, not `success`, which reads teal. */
const STATE_COLOR: Record<string, string> = {
  working: 'var(--accent-green)',
  waiting: 'var(--anthropic-orange)',
  'waiting-approval': 'var(--anthropic-orange)',
  exited: 'var(--text-tertiary)',
  lost: 'var(--text-tertiary)',
  closed: 'var(--text-tertiary)',
  unknown: 'var(--text-tertiary)',
}
```

and:

```ts
/**
 * The wash behind a LIVE row, so its state is readable without reading the word.
 *
 * Only the two active states get one. A tint on every row is a list with no contrast left, and the
 * point of the wash is that the handful of rows doing something stand out from the history under
 * them. It is a WASH, never the row's whole background: the selected row's own highlight has to
 * stay distinguishable from it, or selection stops being visible on exactly the rows you select
 * most.
 */
const STATE_WASH: Record<string, string> = {
  working: 'color-mix(in srgb, #22c55e 10%, transparent)',
  waiting: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
  'waiting-approval': 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
}
```

(`STATE_COLOR` is now imported from `sessionCardStyle.ts` instead — Step 2 already added that
import. `STATE_WASH` has no replacement to import: `sessionCardStyle()` computes its equivalent.)

- [ ] **Step 4: Seed the new state, inside `SessionsAside`**

Find:

```ts
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
```

Replace with:

```ts
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  /**
   * The aside's own arrangement — which dimension it sub-groups by, the manual order per
   * dimension, which groups are folded, and how a card shows its status. Read once on mount, like
   * `TaskList` seeds `readBoardPrefs()` — see `sessionsAsidePrefs.ts` for why this is
   * `localStorage` and not `/api/preferences`.
   */
  const storedGroupPrefs = useMemo(readAsideGroupPrefs, [])
  const [groupBy, setGroupByState] = useState<AsideGroupBy>(storedGroupPrefs.groupBy)
  const setGroupBy = (v: AsideGroupBy) => { setGroupByState(v); writeAsideGroupPrefs({ groupBy: v }) }
  const [groupOrder, setGroupOrderState] =
    useState<Partial<Record<AsideGroupBy, string[]>>>(storedGroupPrefs.order)
  const setGroupOrder = (by: AsideGroupBy, keys: string[]) => {
    const next = { ...groupOrder, [by]: keys }
    setGroupOrderState(next)
    writeAsideGroupPrefs({ order: next })
  }
  const [foldedGroups, setFoldedGroupsState] = useState<Set<string>>(new Set(storedGroupPrefs.collapsed))
  const toggleGroupFold = (key: string) => {
    const next = new Set(foldedGroups)
    next.has(key) ? next.delete(key) : next.add(key)
    setFoldedGroupsState(next)
    writeAsideGroupPrefs({ collapsed: [...next] })
  }
  const [cardColor, setCardColorState] = useState<AsideCardColor>(storedGroupPrefs.cardColor)
  const setCardColor = (v: AsideCardColor) => { setCardColorState(v); writeAsideGroupPrefs({ cardColor: v }) }
```

- [ ] **Step 5: Update the `bands` memo**

Find:

```ts
  const bands = useMemo((): { label: string; groups: SessionGroup[] }[] => {
    const rest = matched.filter(r => !pinned.has(pinKeyOf(r)))
    return [
      { label: pt ? 'Ativas' : 'Active', groups: projectGroups(rest.filter(r => active.has(r.state)), lang) },
      // Never computed while activeOnly is on — those rows are the ones the switch is withholding,
      // not a second list to render beside it.
      { label: pt ? 'Inativas' : 'Inactive', groups: activeOnly ? [] : projectGroups(rest.filter(r => !active.has(r.state)), lang) },
    ]
  }, [matched, pinned, active, activeOnly, pt, lang])
```

Replace with:

```ts
  const bands = useMemo((): { id: AsideBandId; label: string; groups: SessionGroup[] }[] => {
    const rest = matched.filter(r => !pinned.has(pinKeyOf(r)))
    const order = groupOrder[groupBy] ?? []
    return [
      {
        id: 'active',
        label: pt ? 'Ativas' : 'Active',
        groups: asideGroups(rest.filter(r => active.has(r.state)), groupBy, lang, order),
      },
      // Never computed while activeOnly is on — those rows are the ones the switch is withholding,
      // not a second list to render beside it.
      {
        id: 'inactive',
        label: pt ? 'Inativas' : 'Inactive',
        groups: activeOnly ? [] : asideGroups(rest.filter(r => !active.has(r.state)), groupBy, lang, order),
      },
    ]
  }, [matched, pinned, active, activeOnly, pt, lang, groupBy, groupOrder])

  /** The current dimension's groups, across both bands, deduped by key, in their effective
   *  order — what the popover's reorder list edits. */
  const groupOrderCandidates = useMemo(() => {
    const seen = new Map<string, string>()
    for (const b of bands) for (const g of b.groups) if (!seen.has(g.key)) seen.set(g.key, g.label)
    return [...seen.entries()].map(([key, label]) => ({ key, label }))
  }, [bands])
```

- [ ] **Step 6: Render the `SessionsGroupMenu` trigger, beside "New session" and "Send"**

Find the closing of the send button's conditional block, which reads:

```ts
        {showSend && (
          <button
            onClick={() => setPicking('send')}
            aria-label={pt ? 'Enviar prompt em massa' : 'Send a prompt to several'}
            title={pt ? 'Enviar prompt em massa' : 'Send a prompt to several'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: tap ?? 34, padding: 0, borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
              color: 'var(--text-tertiary)', fontFamily: 'inherit',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--anthropic-orange)'
              e.currentTarget.style.color = 'var(--anthropic-orange)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--border-subtle)'
              e.currentTarget.style.color = 'var(--text-tertiary)'
            }}
          >
            <Send size={14} />
          </button>
        )}
      </div>
```

Replace the final two lines (the closing `)}` and `</div>`) with:

```ts
            <Send size={14} />
          </button>
        )}
        <SessionsGroupMenu
          lang={lang}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          groups={groupOrderCandidates}
          onReorder={keys => setGroupOrder(groupBy, keys)}
          cardColor={cardColor}
          onCardColor={setCardColor}
        />
      </div>
```

(i.e. the new component is inserted as one more child of the same flex row, right after the
"send" button's conditional, always rendered — unlike "send", which only appears when it would do
something.)

- [ ] **Step 7: Pass `bandId`/`groupBy`/fold state/`cardColor` into `SessionBand`**

Find:

```ts
            {bands.map((b, i) => (
              <SessionBand
                // The label is not unique — two dimensions can legitimately produce one word, and
                // an empty band still holds its place in the order.
                key={`${i}-${b.label}`}
                label={b.label} groups={b.groups} pinned={pinned}
                sessionId={sessionId} tap={tap} onPin={flip}
                onOpen={s => (onOpenRow ? onOpenRow(s) : navigate(sessionPath(s.id)))}
                {...(rowsById ? { rowsById } : {})}
                onOpenMenu={openMenu}
                onFile={(s, x, y) => setLinking({ id: s.id, x, y })}
                lang={lang}
              />
            ))}
```

Replace with:

```ts
            {bands.map((b, i) => (
              <SessionBand
                // The label is not unique — two dimensions can legitimately produce one word, and
                // an empty band still holds its place in the order.
                key={`${i}-${b.label}`}
                bandId={b.id}
                label={b.label} groups={b.groups} groupBy={groupBy} pinned={pinned}
                sessionId={sessionId} tap={tap} onPin={flip}
                onOpen={s => (onOpenRow ? onOpenRow(s) : navigate(sessionPath(s.id)))}
                {...(rowsById ? { rowsById } : {})}
                onOpenMenu={openMenu}
                onFile={(s, x, y) => setLinking({ id: s.id, x, y })}
                lang={lang}
                foldedGroups={foldedGroups}
                onToggleGroupFold={toggleGroupFold}
                cardColor={cardColor}
              />
            ))}
```

- [ ] **Step 8: Add `cardColor` to the pinned band's `SessionRow` calls**

Find (inside the "Pinned" block):

```ts
                  <SessionRow
                    session={s}
                    selected={rowSelected(s, sessionId)}
                    pinned
                    {...(tap ? { tap } : {})}
                    onPin={() => flip(s)}
                    onOpen={() => (onOpenRow ? onOpenRow(s) : navigate(sessionPath(s.id)))}
                    onMoveBy={d => movePinnedSession(i, i + d)}
                    {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                    onOpenMenu={(x, y, verbs) => openMenu(s, x, y, verbs)}
                    onFile={(x, y) => setLinking({ id: s.id, x, y })}
                    lang={lang}
                  />
```

Replace with:

```ts
                  <SessionRow
                    session={s}
                    selected={rowSelected(s, sessionId)}
                    pinned
                    {...(tap ? { tap } : {})}
                    onPin={() => flip(s)}
                    onOpen={() => (onOpenRow ? onOpenRow(s) : navigate(sessionPath(s.id)))}
                    onMoveBy={d => movePinnedSession(i, i + d)}
                    {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                    onOpenMenu={(x, y, verbs) => openMenu(s, x, y, verbs)}
                    onFile={(x, y) => setLinking({ id: s.id, x, y })}
                    lang={lang}
                    cardColor={cardColor}
                  />
```

- [ ] **Step 9: Rewrite `SessionBand`**

Find the whole `SessionBand` function (from its doc comment through its closing `}`):

```ts
/** One band of the two-way (active/inactive) split. Absent when it would be empty — an empty
 *  band with a heading and no rows under it is a label pretending to be information. */
function SessionBand({ label, groups, pinned, sessionId, tap, onPin, onOpen, rowsById, onOpenMenu, onFile, lang }: {
  label: string
  /** The band's rows, already grouped by project and ordered — see `lib/fleetGroups.ts`. */
  groups: readonly SessionGroup[]
  pinned: ReadonlySet<string>
  sessionId?: string
  tap?: number
  onPin: (row: ControlSession) => void
  onOpen: (row: ControlSession) => void
  rowsById?: Map<string, { verbs: RowVerb[] }>
  onOpenMenu: (session: ControlSession, x: number, y: number, verbs: RowVerb[]) => void
  /** File a row under a delivery — the visible half of the gesture the menu also offers. */
  onFile: (session: ControlSession, x: number, y: number) => void
  lang: 'pt' | 'en'
}) {
  const count = groups.reduce((n, g) => n + g.sessions.length, 0)
  if (count === 0) return null
  // One project under this band names it twice — the band heading is directly above. See the rule
  // in `fleetGroups.ts`; it is the same one the cockpit's cascade applies to its own root.
  const headings = showsProjectHeadings(groups)
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 6,
        padding: '6px 9px 7px', fontSize: 10.5, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)',
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.75 }}>{count}</span>
      </div>
      {groups.map(g => (
        <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: headings ? 10 : 0 }}>
          {headings && (
            // Deliberately quieter than the band above it — lowercase, no letter-spacing — so the
            // two headings read as a hierarchy rather than as two lists.
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 9px 2px',
              fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
            }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
              <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{g.sessions.length}</span>
            </div>
          )}
          {g.sessions.map(s => (
            <SessionRow
              key={s.id}
              session={s}
              selected={rowSelected(s, sessionId)}
              pinned={pinned.has(pinKeyOf(s))}
              {...(tap ? { tap } : {})}
              onPin={() => onPin(s)}
              onOpen={() => onOpen(s)}
              {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
              onOpenMenu={(x, y, verbs) => onOpenMenu(s, x, y, verbs)}
              onFile={(x, y) => onFile(s, x, y)}
              lang={lang}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
```

Replace it in full with:

```ts
/** One band of the two-way (active/inactive) split. Absent when it would be empty — an empty
 *  band with a heading and no rows under it is a label pretending to be information. */
function SessionBand({
  bandId, label, groups, groupBy, pinned, sessionId, tap, onPin, onOpen, rowsById, onOpenMenu,
  onFile, lang, foldedGroups, onToggleGroupFold, cardColor,
}: {
  bandId: AsideBandId
  label: string
  /** The band's rows, already grouped by the chosen dimension and ordered — see
   *  `lib/fleetGroups.ts`. */
  groups: readonly SessionGroup[]
  groupBy: AsideGroupBy
  pinned: ReadonlySet<string>
  sessionId?: string
  tap?: number
  onPin: (row: ControlSession) => void
  onOpen: (row: ControlSession) => void
  rowsById?: Map<string, { verbs: RowVerb[] }>
  onOpenMenu: (session: ControlSession, x: number, y: number, verbs: RowVerb[]) => void
  /** File a row under a delivery — the visible half of the gesture the menu also offers. */
  onFile: (session: ControlSession, x: number, y: number) => void
  lang: 'pt' | 'en'
  /** Collapse keys already toggled shut — see `collapseKey` in `sessionsAsidePrefs.ts`. */
  foldedGroups: ReadonlySet<string>
  onToggleGroupFold: (key: string) => void
  cardColor: AsideCardColor
}) {
  const count = groups.reduce((n, g) => n + g.sessions.length, 0)
  if (count === 0) return null
  // One group under this band names it twice — the band heading is directly above. See the rule
  // in `fleetGroups.ts`; it is the same one the cockpit's cascade applies to its own root.
  const headings = showsGroupHeadings(groups)
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 6,
        padding: '6px 9px 7px', fontSize: 10.5, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)',
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.75 }}>{count}</span>
      </div>
      {groups.map(g => {
        const ck = collapseKey(bandId, groupBy, g.key)
        const folded = foldedGroups.has(ck)
        // A small dot naming the state's own color, ONLY when grouping by status — free, and
        // consistent with the dot every row already wears. Not part of the card-color preference
        // below, which is about the ROW cards, not this heading.
        const dotColor = groupBy === 'status' ? STATE_COLOR[g.key as SessionState] : undefined
        return (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: headings ? 10 : 0 }}>
            {headings && (
              // Deliberately quieter than the band above it — lowercase, no letter-spacing — so
              // the two headings read as a hierarchy rather than as two lists. Clicking it folds
              // this group, per your instruction — the click target is the heading itself.
              <button
                onClick={() => onToggleGroupFold(ck)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  padding: '4px 9px 2px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
                  minHeight: tap,
                }}
              >
                {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                {dotColor && (
                  <span aria-hidden style={{
                    width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: dotColor,
                  }} />
                )}
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.label}
                </span>
                <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{g.sessions.length}</span>
              </button>
            )}
            {!folded && g.sessions.map(s => (
              <SessionRow
                key={s.id}
                session={s}
                selected={rowSelected(s, sessionId)}
                pinned={pinned.has(pinKeyOf(s))}
                {...(tap ? { tap } : {})}
                onPin={() => onPin(s)}
                onOpen={() => onOpen(s)}
                {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                onOpenMenu={(x, y, verbs) => onOpenMenu(s, x, y, verbs)}
                onFile={(x, y) => onFile(s, x, y)}
                lang={lang}
                cardColor={cardColor}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 10: Update `SessionRow`'s signature and its style computation**

Find:

```ts
function SessionRow({ session, selected, pinned, tap, onPin, onOpen, onMoveBy, verbs, onOpenMenu, onFile, lang }: {
  session: ControlSession; selected: boolean
  /** Minimum row height on mobile — 44px, and undefined on desktop. */
  tap?: number
  pinned?: boolean
  onPin?: () => void
  onOpen: () => void
  /** Reorder this pinned row by `delta` places. Only ever passed for a row in the Pinned band. */
  onMoveBy?: (delta: number) => void
  /** This row's own verbs, for the context menu (Task 6). Absent where the caller has none to offer. */
  verbs?: RowVerb[]
  /** Opens the context menu at a point, carrying the verbs it was opened with. */
  onOpenMenu?: (x: number, y: number, verbs: RowVerb[]) => void
  /** File this row under a delivery — the visible half of the gesture the menu also offers. */
  onFile?: (x: number, y: number) => void
  lang?: 'pt' | 'en'
}) {
  const wants = sessionNotify(session)
  const color = STATE_COLOR[session.state] ?? 'var(--text-tertiary)'
```

Replace with:

```ts
function SessionRow({ session, selected, pinned, tap, onPin, onOpen, onMoveBy, verbs, onOpenMenu, onFile, lang, cardColor }: {
  session: ControlSession; selected: boolean
  /** Minimum row height on mobile — 44px, and undefined on desktop. */
  tap?: number
  pinned?: boolean
  onPin?: () => void
  onOpen: () => void
  /** Reorder this pinned row by `delta` places. Only ever passed for a row in the Pinned band. */
  onMoveBy?: (delta: number) => void
  /** This row's own verbs, for the context menu (Task 6). Absent where the caller has none to offer. */
  verbs?: RowVerb[]
  /** Opens the context menu at a point, carrying the verbs it was opened with. */
  onOpenMenu?: (x: number, y: number, verbs: RowVerb[]) => void
  /** File this row under a delivery — the visible half of the gesture the menu also offers. */
  onFile?: (x: number, y: number) => void
  lang?: 'pt' | 'en'
  /** How this card shows its state — see `sessionCardStyle.ts`. */
  cardColor: AsideCardColor
}) {
  const wants = sessionNotify(session)
  const cardStyle = sessionCardStyle(session.state, cardColor, selected)
  const color = STATE_COLOR[session.state] ?? 'var(--text-tertiary)'
```

- [ ] **Step 11: Simplify the row's `background`/`boxShadow`, and its hover-restore**

Find:

```ts
        background: selected ? 'var(--bg-elevated)' : (STATE_WASH[session.state] ?? 'transparent'),
        // Two different edges, and they never collide: the STATE edge is the left rule a live row
        // carries, and SELECTION replaces it with a brighter, full one plus an outline. The wash
        // alone is faint by design, and an edge survives a light theme and a colour-blind reader
        // where a 10% tint does not.
        boxShadow: selected
          ? 'inset 3px 0 0 var(--text-primary), inset 0 0 0 1px var(--border)'
          : (STATE_WASH[session.state]
            ? `inset 2px 0 0 ${STATE_COLOR[session.state] ?? 'transparent'}`
            : undefined),
```

Replace with:

```ts
        background: cardStyle.background,
        // Two different edges, and they never collide: the STATE edge is the left rule a live row
        // carries in `wash`/`stripe` mode, and SELECTION replaces it with a brighter, full one
        // plus an outline — `sessionCardStyle` already resolves that precedence.
        boxShadow: cardStyle.edge,
```

Then find:

```ts
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.background = STATE_WASH[session.state] ?? 'transparent'
      }}
```

Replace with:

```ts
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.background = cardStyle.background
      }}
```

- [ ] **Step 12: Pass the neutral-mode text color to `SessionFacts`**

Find:

```ts
      <SessionFacts
        session={session}
        selected={selected}
        {...(lang ? { lang } : {})}
        {...(onFile
          // Anchored where the click landed, like the menu's own picker — the gesture stays where
          // the reader's eye already is.
          ? { onFile: () => onFile(lastPoint.current.x, lastPoint.current.y) }
          : {})}
      />
```

Replace with:

```ts
      <SessionFacts
        session={session}
        selected={selected}
        {...(lang ? { lang } : {})}
        {...(cardStyle.stateTextColor ? { metaColor: cardStyle.stateTextColor } : {})}
        {...(onFile
          // Anchored where the click landed, like the menu's own picker — the gesture stays where
          // the reader's eye already is.
          ? { onFile: () => onFile(lastPoint.current.x, lastPoint.current.y) }
          : {})}
      />
```

- [ ] **Step 13: Typecheck**

Run: `bun tsc --noEmit`
Expected: no errors. If TypeScript complains about an unused `SessionState` import or a leftover
reference to `STATE_WASH`/`projectGroups`/`showsProjectHeadings`, that step's find/replace was
missed — re-run `grep -n "STATE_WASH\|projectGroups\|showsProjectHeadings" packages/web/src/components/nav/SessionsAside.tsx`
and confirm zero matches.

- [ ] **Step 14: Run the full unit test suite**

Run: `bun test`
Expected: PASS — every existing test still green, plus the new ones from Tasks 1–3.

- [ ] **Step 15: Commit**

```bash
git add packages/web/src/components/nav/SessionsAside.tsx
git commit -m "feat(web): wire task/status grouping, folding, reorder and card color into the sessions aside

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Manual verification

**Files:** none — this task runs the app and looks at it.

**Interfaces:** none.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Expected: API on port 47291, UI on port 47292 (per `CLAUDE.md`'s "Development" section).

- [ ] **Step 2: Open the Sessions workspace and confirm the trigger is there**

Navigate to `http://localhost:47292/sessions`. Confirm a small icon button (a slider glyph) sits
in the top row of the aside, beside the search field, always visible.

- [ ] **Step 3: Confirm each grouping mode**

Click the trigger. Under "Group by", select **Task**: confirm the Active/Inactive bands now
sub-group by delivery name, with a "No delivery"/unfiled bucket for sessions with none. Select
**Status**: confirm up to 7 distinct sub-groups appear across the two bands (Working / Needs you /
Needs approval under Active; Finished / Lost / Closed under Inactive), each with its own colored
dot beside the heading. Select **Project** again and confirm it matches the pre-existing behavior
exactly (one heading per project, none when there is only one).

- [ ] **Step 4: Confirm folding**

With Status selected, click directly on a group's heading (e.g. "Needs approval · N"). Confirm its
sessions hide and the chevron flips to a right-pointing arrow, while the heading and count stay
visible. Click again to unfold. Reload the page: confirm the fold state survived.

- [ ] **Step 5: Confirm reordering**

Open the popover again. Under "Group order", drag one group above another (or use the ▲/▼
buttons). Close the popover and confirm the aside's groups now render in the new order. Reload the
page: confirm the order survived. Start a new session in a brand-new project not seen before (or
simulate by switching grouping to Task and filing a session under a brand-new delivery name):
confirm the new group appears, unpositioned, after every manually-ordered one, rather than being
lost.

- [ ] **Step 6: Confirm the three card-color modes**

Under "Card color", select each of the three options in turn and confirm on screen:
  - **Background follows status**: every row (in every state, not only working/waiting) carries a
    faint background tint and a thin left edge in its state's color.
  - **Neutral background, colored text**: rows lose their background tint; the small state word
    in each row's meta line (e.g. "needs approval") is now colored instead of gray/orange-only.
  - **Colored left stripe**: rows have a plain background and a solid colored left edge matching
    the state.

In every mode, click a row to select it and confirm the SELECTED row always shows the same neutral
highlight (lifted background, full white/text-primary left edge) regardless of which card-color
mode is active. Reload the page: confirm the chosen mode survived.

- [ ] **Step 7: Confirm the pinned band respects card color too**

Pin a session (the pin icon on hover, or via its row menu). Confirm the pinned row, in its own band
above everything else, also reflects whichever card-color mode is currently selected.

- [ ] **Step 8: Confirm nothing else regressed**

Toggle the header's "Active only" switch and the harness/project/repo/model filters: confirm the
Active/Inactive split still follows them exactly as before (this feature only changed the
sub-grouping inside each band, never which rows are in it). Confirm search still works across
every grouping mode.

- [ ] **Step 9: Final typecheck and full test run**

Run: `bun tsc --noEmit && bun test`
Expected: both clean.

This task has no commit of its own — it is a verification pass over Tasks 1–6's already-committed
work. If it surfaces a defect, fix it as an amendment to the relevant task's commit (or a small
follow-up commit) before considering the feature done.
