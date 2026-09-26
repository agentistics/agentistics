# Idle Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notice managed sessions the user stopped talking to, notify once per batch, and let the user file-and-end / end / keep them from a modal (with a persistent banner while the suggestion still applies); plus put the notification bell in the Sessions workspace header.

**Architecture:** The server adds three facts to the `/api/fleet` row (`lastUserMessageAt`, `taskId`, from exact conversation links only). A pure module in `@agentistics/core` decides candidates, ordering, group suggestion and batch-notification dedupe. The web derives everything live from the fleet poll and executes confirmations through the existing group store and `POST /api/fleet/act`.

**Tech Stack:** Bun, TypeScript (strict), React, `bun test`.

Spec: `docs/superpowers/specs/2026-09-25-idle-sessions-design.md`.

## Global Constraints

- Everything in English: code, comments, commits (Conventional Commits). UI copy EN + PT.
- `lastUserMessageAt` only from EXACT conversation links (`metricsOf` in `session-view.ts`) — never the harness-and-directory inference. Absent = unknown = never a candidate.
- The machine→central relay row (`reduceMachineFleetRow`) is an allowlist and gains NOTHING.
- Default X = 120 min, under RAM pressure = 30 min. `preferences.idleSessions` absent reads as enabled with those values.
- Nothing is ended without the user's confirmation in the modal.
- Mobile: modal full-screen < 768px, touch targets ≥ 44px, inputs ≥ 16px, no horizontal page scroll at 390px.
- Disabled on a central (the watch never runs when `isCentral`).
- Spec deviation (deliberate): the "unsent draft" warning from spec §6 is DROPPED — the composer's draft is not persisted anywhere another component can read, and inventing a store for it is out of scope. Last prompt text comes from the row's `chatTurns` (Claude only); other harnesses show none.

---

### Task 1: Pure idle rules in core

**Files:**
- Create: `packages/core/src/idleSessions.ts`
- Create: `packages/core/src/idleSessions.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './idleSessions'`)

**Interfaces:**
- Produces:
  - `interface IdleRowInput { id: string; conversationId?: string; state: string; managed: boolean; lastUserMessageAt?: number; taskId?: string; taskDone?: boolean; rssBytes?: number | null; cpuPercent?: number | null; contextFraction?: number | null }`
  - `interface IdleOptions { now: number; thresholdMs: number; pressureThresholdMs: number; underPressure: boolean; openSessionId?: string | null; kept: Readonly<Record<string, number>> }`
  - `interface IdleCandidate { row: IdleRowInput; key: string; idleMs: number; reasons: ('task-delivered' | 'context-full')[] }`
  - `idleCandidates(rows: readonly IdleRowInput[], o: IdleOptions): IdleCandidate[]`
  - `type GroupSuggestion = { kind: 'existing'; groupId: string; name: string } | { kind: 'new'; name: string }`
  - `suggestGroup(c: IdleCandidate, groups: readonly { id: string; name: string; sessionKeys: string[] }[], rows: readonly IdleRowInput[], taskName: string | undefined, today: string): GroupSuggestion`
  - `idleNotifyStep(prevNotified: ReadonlySet<string>, candidates: readonly IdleCandidate[]): { notify: boolean; next: Set<string> }`
  - `freedBytes(candidates: readonly IdleCandidate[]): number | null`
- Consumes: `sessionIdentityKey` from `./sessionGroups`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/idleSessions.test.ts
import { describe, expect, it } from 'bun:test'
import { freedBytes, idleCandidates, idleNotifyStep, suggestGroup, type IdleRowInput } from './idleSessions'

const H = 3_600_000
const NOW = 1_800_000_000_000
const row = (o: Partial<IdleRowInput> = {}): IdleRowInput => ({
  id: 'a', state: 'waiting', managed: true, lastUserMessageAt: NOW - 3 * H, ...o,
})
const opts = { now: NOW, thresholdMs: 2 * H, pressureThresholdMs: 0.5 * H, underPressure: false, openSessionId: null, kept: {} }

describe('idleCandidates', () => {
  it('takes a waiting managed session past the threshold', () => {
    expect(idleCandidates([row()], opts).map(c => c.row.id)).toEqual(['a'])
  })
  it('never takes working, waiting-approval or ended rows', () => {
    for (const state of ['working', 'waiting-approval', 'exited', 'lost', 'closed', 'unknown']) {
      expect(idleCandidates([row({ state })], opts)).toEqual([])
    }
  })
  it('never takes an external row', () => {
    expect(idleCandidates([row({ managed: false })], opts)).toEqual([])
  })
  it('never takes a row whose last message is unknown', () => {
    expect(idleCandidates([row({ lastUserMessageAt: undefined })], opts)).toEqual([])
  })
  it('respects the threshold, and the shorter one under pressure', () => {
    const r = row({ lastUserMessageAt: NOW - 1 * H })
    expect(idleCandidates([r], opts)).toEqual([])
    expect(idleCandidates([r], { ...opts, underPressure: true })).toHaveLength(1)
  })
  it('skips the session open on screen, matched by id or conversation id', () => {
    expect(idleCandidates([row()], { ...opts, openSessionId: 'a' })).toEqual([])
    expect(idleCandidates([row({ conversationId: 'c1' })], { ...opts, openSessionId: 'c1' })).toEqual([])
  })
  it('a keep silences until a newer message', () => {
    const r = row({ conversationId: 'c1' })
    expect(idleCandidates([r], { ...opts, kept: { c1: NOW - 1 * H } })).toEqual([])
    const later = row({ conversationId: 'c1', lastUserMessageAt: NOW - 2.5 * H })
    expect(idleCandidates([later], { ...opts, kept: { c1: NOW - 3 * H } })).toHaveLength(1)
  })
  it('orders delivered tasks first, then heaviest, then longest idle', () => {
    const out = idleCandidates([
      row({ id: 'light', rssBytes: 1 }),
      row({ id: 'heavy', rssBytes: 9 }),
      row({ id: 'done', rssBytes: 0, taskDone: true }),
      row({ id: 'unknownMem', rssBytes: null }),
    ], opts).map(c => c.row.id)
    expect(out).toEqual(['done', 'heavy', 'light', 'unknownMem'])
  })
  it('flags reasons', () => {
    const [c] = idleCandidates([row({ taskDone: true, contextFraction: 0.9 })], opts)
    expect(c!.reasons).toEqual(['task-delivered', 'context-full'])
  })
})

describe('suggestGroup', () => {
  const rows = [row({ id: 'a', taskId: 't1' }), row({ id: 'b', taskId: 't1' }), row({ id: 'c', taskId: 't1' })]
  const [cand] = idleCandidates([rows[0]!], opts)
  it('prefers the group holding the most sessions of the same task', () => {
    const groups = [
      { id: 'g1', name: 'one', sessionKeys: ['b'] },
      { id: 'g2', name: 'two', sessionKeys: ['b', 'c'] },
    ]
    // 'b' can only be in one group in reality; the pure function counts what it is given.
    expect(suggestGroup(cand!, groups, rows, 'Task one', '2026-09-25')).toEqual({ kind: 'existing', groupId: 'g2', name: 'two' })
  })
  it('falls back to a new group named after the task', () => {
    expect(suggestGroup(cand!, [], rows, 'Task one', '2026-09-25')).toEqual({ kind: 'new', name: 'Task one' })
  })
  it('falls back to a dated group, reusing it when it exists', () => {
    const [plain] = idleCandidates([row({ id: 'z' })], opts)
    expect(suggestGroup(plain!, [], [], undefined, '2026-09-25')).toEqual({ kind: 'new', name: 'Idle · 2026-09-25' })
    expect(suggestGroup(plain!, [{ id: 'gd', name: 'Idle · 2026-09-25', sessionKeys: [] }], [], undefined, '2026-09-25'))
      .toEqual({ kind: 'existing', groupId: 'gd', name: 'Idle · 2026-09-25' })
  })
})

describe('idleNotifyStep', () => {
  const cs = idleCandidates([row({ id: 'a' }), row({ id: 'b' })], opts)
  it('notifies when a session joins, not on a repeat', () => {
    const first = idleNotifyStep(new Set(), cs)
    expect(first.notify).toBe(true)
    expect(idleNotifyStep(first.next, cs).notify).toBe(false)
  })
  it('does not notify when the batch only shrinks, and forgets the ones gone', () => {
    const r = idleNotifyStep(new Set(['a', 'b']), cs.slice(0, 1))
    expect(r.notify).toBe(false)
    expect([...r.next]).toEqual(['a'])
  })
})

describe('freedBytes', () => {
  it('sums the known and is null when none is known', () => {
    expect(freedBytes(idleCandidates([row({ rssBytes: 2 }), row({ id: 'b', rssBytes: 3 })], opts))).toBe(5)
    expect(freedBytes(idleCandidates([row({ rssBytes: null })], opts))).toBe(null)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/core/src/idleSessions.test.ts`
Expected: FAIL — cannot find module `./idleSessions`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/idleSessions.ts
/**
 * idleSessions.ts — which sessions the user has stopped talking to. PURE.
 *
 * "Idle" is the person's silence, not the process's: X time since the user's LAST MESSAGE and the
 * session stopped waiting on them. A session working on its own for hours is not idle, and one
 * asking for approval is BLOCKED on the user, which is a different notice. An unknown last message
 * is never a candidate — suggesting to end a session on a guessed clock is suggesting to end work.
 */
import { sessionIdentityKey } from './sessionGroups'

export interface IdleRowInput {
  id: string
  conversationId?: string
  state: string
  managed: boolean
  /** Epoch ms of the user's last message; absent = unknown. */
  lastUserMessageAt?: number
  taskId?: string
  taskDone?: boolean
  rssBytes?: number | null
  cpuPercent?: number | null
  contextFraction?: number | null
}

export interface IdleOptions {
  now: number
  thresholdMs: number
  pressureThresholdMs: number
  underPressure: boolean
  openSessionId?: string | null
  /** sessionIdentityKey -> epoch ms the user chose "keep". */
  kept: Readonly<Record<string, number>>
}

export type IdleReason = 'task-delivered' | 'context-full'

export interface IdleCandidate {
  row: IdleRowInput
  key: string
  idleMs: number
  reasons: IdleReason[]
}

export const CONTEXT_FULL_FRACTION = 0.85

export function idleCandidates(rows: readonly IdleRowInput[], o: IdleOptions): IdleCandidate[] {
  const threshold = o.underPressure ? o.pressureThresholdMs : o.thresholdMs
  const out: IdleCandidate[] = []
  for (const row of rows) {
    if (!row.managed || row.state !== 'waiting') continue
    if (typeof row.lastUserMessageAt !== 'number' || !Number.isFinite(row.lastUserMessageAt)) continue
    const idleMs = o.now - row.lastUserMessageAt
    if (idleMs < threshold) continue
    if (o.openSessionId && (o.openSessionId === row.id || o.openSessionId === row.conversationId)) continue
    const key = sessionIdentityKey(row)
    const keptAt = o.kept[key]
    if (typeof keptAt === 'number' && row.lastUserMessageAt <= keptAt) continue
    const reasons: IdleReason[] = []
    if (row.taskDone) reasons.push('task-delivered')
    if (typeof row.contextFraction === 'number' && row.contextFraction >= CONTEXT_FULL_FRACTION) reasons.push('context-full')
    out.push({ row, key, idleMs, reasons })
  }
  const mem = (c: IdleCandidate) => (typeof c.row.rssBytes === 'number' ? c.row.rssBytes : -1)
  return out.sort((a, b) =>
    Number(Boolean(b.row.taskDone)) - Number(Boolean(a.row.taskDone))
    || mem(b) - mem(a)
    || b.idleMs - a.idleMs,
  )
}

export type GroupSuggestion =
  | { kind: 'existing'; groupId: string; name: string }
  | { kind: 'new'; name: string }

export function suggestGroup(
  c: IdleCandidate,
  groups: readonly { id: string; name: string; sessionKeys: string[] }[],
  rows: readonly IdleRowInput[],
  taskName: string | undefined,
  today: string,
): GroupSuggestion {
  const taskId = c.row.taskId
  if (taskId) {
    const taskKeys = new Set(rows.filter(r => r.taskId === taskId).map(r => sessionIdentityKey(r)))
    let best: { id: string; name: string; n: number; i: number } | null = null
    groups.forEach((g, i) => {
      const n = g.sessionKeys.filter(k => taskKeys.has(k)).length
      // Ties go to the later group (groups are stored in creation order).
      if (n > 0 && (!best || n > best.n || (n === best.n && i > best.i))) best = { id: g.id, name: g.name, n, i }
    })
    if (best) return { kind: 'existing', groupId: (best as { id: string }).id, name: (best as { name: string }).name }
    if (taskName && taskName.trim()) return { kind: 'new', name: taskName.trim() }
  }
  const dated = `Idle · ${today}`
  const existing = groups.find(g => g.name === dated)
  return existing ? { kind: 'existing', groupId: existing.id, name: existing.name } : { kind: 'new', name: dated }
}

/** One notification per BATCH: fire only when a session not already announced joins. */
export function idleNotifyStep(
  prevNotified: ReadonlySet<string>,
  candidates: readonly IdleCandidate[],
): { notify: boolean; next: Set<string> } {
  const now = new Set(candidates.map(c => c.key))
  const notify = [...now].some(k => !prevNotified.has(k))
  return { notify, next: now }
}

/** Memory the batch holds, or null when no candidate's memory is known (never a confident 0). */
export function freedBytes(candidates: readonly IdleCandidate[]): number | null {
  const known = candidates.map(c => c.row.rssBytes).filter((b): b is number => typeof b === 'number')
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}
```

Check `sessionIdentityKey`'s signature in `packages/core/src/sessionGroups.ts:135` — it takes `{ id; conversationId? }`, which `IdleRowInput` satisfies.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/src/idleSessions.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Export + typecheck + commit**

Append `export * from './idleSessions'` to `packages/core/src/index.ts`, then:
Run: `bunx tsc --noEmit` → no errors.

```bash
git add packages/core/src/idleSessions.ts packages/core/src/idleSessions.test.ts packages/core/src/index.ts
git commit -m "feat(core): idle-session rules — candidates, group suggestion, batch dedupe"
```

---

### Task 2: Server — last user message and task id on the fleet row

**Files:**
- Modify: `packages/server/server/sessions/conversations.ts` (`Conversation`, `toConversation`)
- Modify: `packages/server/server/sessions/session-view.ts` (`SessionView`, managed-row mapping near line 583)
- Modify: `packages/tui/src/control/types.ts` (`ControlSession`, after `rssBytes`)
- Modify: `packages/server/server/sessions/control-session.ts` (`toControlSession`, near line 161)
- Test: `packages/server/server/sessions/session-view.test.ts`, `packages/server/server/sessions/control-session.test.ts`, and the relay allowlist test (`grep -rln reduceMachineFleetRow packages --include=*.test.ts`)

**Interfaces:**
- Produces: `ControlSession.lastUserMessageAt?: number` (epoch ms) and `ControlSession.taskId?: string`.

- [ ] **Step 1: Failing tests**

In `session-view.test.ts`, following the file's existing fixtures for a managed row with an exact conversation link, add:

```ts
it('carries the last user message time from the EXACT conversation link only', () => {
  // Build the view with a managed row whose ManagedSession.conversationId is 'c1' and taskId 't1',
  // and o.conversations = [{ ...conversation fixture, sessionId: 'c1', lastUserMessageMs: 1234 }].
  // expect(view.lastUserMessageMs).toBe(1234); expect(view.taskId).toBe('t1')
})
it('has no last user message time when the row has no exact link', () => {
  // Same managed row with no conversationId and no harness session file:
  // expect(view.lastUserMessageMs).toBeUndefined()
})
```

Write these concretely using the fixture helpers already present at the top of `session-view.test.ts` (read them first; do not invent new helpers when one exists).

In `control-session.test.ts`:

```ts
it('maps lastUserMessageMs and taskId onto the row', () => {
  const row = toControlSession({ ...baseView, lastUserMessageMs: 99, taskId: 't1' }, strings)
  expect(row.lastUserMessageAt).toBe(99)
  expect(row.taskId).toBe('t1')
})
```

(`baseView` / `strings`: reuse the file's existing fixtures.) In the relay allowlist test, add `lastUserMessageAt` and `taskId` to the input row and assert both are ABSENT from the reduced output.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/server/sessions/session-view.test.ts packages/server/server/sessions/control-session.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

`conversations.ts` — in `Conversation` add:

```ts
  /** Epoch ms of the person's last message (`user_message_timestamps`); absent when unknown. */
  lastUserMessageMs?: number
```

and in `toConversation`'s returned object:

```ts
    ...(() => {
      const t = Date.parse(s.user_message_timestamps?.at(-1) ?? '')
      return Number.isFinite(t) ? { lastUserMessageMs: t } : {}
    })(),
```

`session-view.ts` — in `SessionView` add `lastUserMessageMs?: number` and `taskId?: string`; in the managed-row object (after the `conversationId` spread, near line 616):

```ts
      ...(conv?.lastUserMessageMs !== undefined ? { lastUserMessageMs: conv.lastUserMessageMs } : {}),
      ...(r.managed?.taskId ? { taskId: r.managed.taskId } : {}),
```

(`conv` is already `metricsOf(r.managed, own?.sessionId)` — the exact-link reader. Do NOT read it anywhere else.)

`types.ts` — in `ControlSession` after `rssBytes`:

```ts
  /** Epoch ms of the user's last message, from an EXACT conversation link. Absent = unknown. */
  lastUserMessageAt?: number
  /** The task id behind `task` (the label). */
  taskId?: string
```

`control-session.ts` — beside the `startedAt` spread (line ~161):

```ts
    ...(v.lastUserMessageMs !== undefined ? { lastUserMessageAt: v.lastUserMessageMs } : {}),
    ...(v.taskId ? { taskId: v.taskId } : {}),
```

Confirm `reduceMachineFleetRow` builds its output from an explicit field list (it is an allowlist); if so it needs no change and the test proves it.

- [ ] **Step 4: Run**

Run: `bun test packages/server/server/sessions/ packages/core` then `bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/conversations.ts packages/server/server/sessions/session-view.ts packages/tui/src/control/types.ts packages/server/server/sessions/control-session.ts packages/server/server/sessions/*.test.ts
git commit -m "feat(server): expose last user message time and task id on the fleet row"
```

---

### Task 3: Notification bell in the Sessions header

**Files:**
- Modify: `packages/web/src/App.tsx` (the magnifier `div` inside `sessionTopBar`, ~line 3418)
- Modify: `packages/web/src/pages/SessionsPage.tsx` (beside `magnifierButton`, defined ~line 1571 and placed ~2097 / ~2260)

- [ ] **Step 1: Desktop** — in `sessionTopBar`, inside the flex `div` holding `<MagnifierButton ctx={appCtx} />` and `<HideLensesButton ctx={appCtx} />`, append:

```tsx
        <NotificationBell lang={lang} buttonStyle={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: 8,
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-tertiary)', cursor: 'pointer', position: 'relative',
        }} />
```

- [ ] **Step 2: Mobile** — in `SessionsPage.tsx`, render `NotificationBell` wherever `{magnifierButton}` is placed, with a 44×44 button style (import from `../components/NotificationBell`; read `lang` from the page's existing `pt` flag: `lang={pt ? 'pt' : 'en'}`).

- [ ] **Step 3: Verify** — `bunx tsc --noEmit -p packages/web` clean. Headless check (Task 7) confirms the bell renders on `/sessions` at 1440 and 390.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): notification bell in the Sessions workspace header"
```

---

### Task 4: Idle-sessions preferences (store + Settings)

**Files:**
- Create: `packages/web/src/lib/idleSessionsPrefs.ts`
- Create: `packages/web/src/lib/idleSessionsPrefs.test.ts`
- Modify: `packages/server/server/preferences.ts` (`Preferences` type)
- Modify: `packages/web/src/pages/settings/SessionsSettings.tsx` (a new section)

**Interfaces:**
- Produces:
  - `interface IdleSessionsPrefs { enabled: boolean; thresholdMin: number; pressureThresholdMin: number; kept: Record<string, number> }`
  - `DEFAULT_IDLE_PREFS: IdleSessionsPrefs` = `{ enabled: true, thresholdMin: 120, pressureThresholdMin: 30, kept: {} }`
  - `parseIdlePrefs(raw: unknown): IdleSessionsPrefs | null`
  - `useIdlePrefs(): IdleSessionsPrefs`, `setIdlePrefs(patch: Partial<IdleSessionsPrefs>): void`, `keepSessions(keys: string[], at: number): void`, `pruneKept(liveKeys: ReadonlySet<string>): void`

- [ ] **Step 1: Failing test**

```ts
// packages/web/src/lib/idleSessionsPrefs.test.ts
import { describe, expect, it } from 'bun:test'
import { DEFAULT_IDLE_PREFS, parseIdlePrefs } from './idleSessionsPrefs'

describe('parseIdlePrefs', () => {
  it('absent reads as the defaults (enabled, 120/30)', () => {
    expect(parseIdlePrefs(undefined)).toEqual(DEFAULT_IDLE_PREFS)
  })
  it('keeps valid values and repairs invalid ones field by field', () => {
    expect(parseIdlePrefs({ enabled: false, thresholdMin: 60, pressureThresholdMin: -5, kept: { a: 1, b: 'x' } }))
      .toEqual({ enabled: false, thresholdMin: 60, pressureThresholdMin: 30, kept: { a: 1 } })
  })
})
```

- [ ] **Step 2: Run** — `bun test packages/web/src/lib/idleSessionsPrefs.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/web/src/lib/idleSessionsPrefs.ts
/**
 * The idle-sessions switch, its two thresholds and the "keep" marks. SERVER-SIDE through
 * `createSharedPref` (like session groups): a keep is a fact about the work, and must read the same
 * from a phone. Absent reads as ENABLED — the feature only suggests; nothing ends unconfirmed.
 */
import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'

export interface IdleSessionsPrefs {
  enabled: boolean
  thresholdMin: number
  pressureThresholdMin: number
  kept: Record<string, number>
}

export const DEFAULT_IDLE_PREFS: IdleSessionsPrefs = { enabled: true, thresholdMin: 120, pressureThresholdMin: 30, kept: {} }

const posInt = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : fallback

export function parseIdlePrefs(raw: unknown): IdleSessionsPrefs | null {
  if (raw === undefined || raw === null) return { ...DEFAULT_IDLE_PREFS, kept: {} }
  if (typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kept: Record<string, number> = {}
  if (r.kept && typeof r.kept === 'object') {
    for (const [k, v] of Object.entries(r.kept as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) kept[k] = v
    }
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_IDLE_PREFS.enabled,
    thresholdMin: posInt(r.thresholdMin, DEFAULT_IDLE_PREFS.thresholdMin),
    pressureThresholdMin: posInt(r.pressureThresholdMin, DEFAULT_IDLE_PREFS.pressureThresholdMin),
    kept,
  }
}

const store = createSharedPref<IdleSessionsPrefs>({
  key: 'agentistics-idle-sessions',
  prefKey: 'idleSessions',
  fallback: DEFAULT_IDLE_PREFS,
  parse: parseIdlePrefs,
})

export function useIdlePrefs(): IdleSessionsPrefs {
  return useSyncExternalStore(store.subscribe, store.get, store.serverSnapshot)
}

export function setIdlePrefs(patch: Partial<IdleSessionsPrefs>): void {
  store.set({ ...store.get(), ...patch })
}

export function keepSessions(keys: string[], at: number): void {
  const cur = store.get()
  store.set({ ...cur, kept: { ...cur.kept, ...Object.fromEntries(keys.map(k => [k, at])) } })
}

/** Drop keep marks for sessions no longer in the fleet, so the document does not grow forever. */
export function pruneKept(liveKeys: ReadonlySet<string>): void {
  const cur = store.get()
  const kept = Object.fromEntries(Object.entries(cur.kept).filter(([k]) => liveKeys.has(k)))
  if (Object.keys(kept).length !== Object.keys(cur.kept).length) store.set({ ...cur, kept })
}
```

Before using them, read `packages/web/src/lib/sharedPref.ts` and confirm the returned store exposes `get`, `set`, `subscribe`, `serverSnapshot` (they are used exactly this way by `sessionUserGroups.ts`); adjust names only if they differ.

- [ ] **Step 4: Server type** — in `Preferences` (`preferences.ts`, beside `sessionGroups`):

```ts
  /** Idle-session suggestions — see `web/src/lib/idleSessionsPrefs.ts`. Written only by the web. */
  idleSessions?: { enabled?: boolean; thresholdMin?: number; pressureThresholdMin?: number; kept?: Record<string, number> }
```

- [ ] **Step 5: Settings section** — in `SessionsSettings.tsx`, add a section "Idle sessions / Sessões ociosas" using the file's existing primitives (read it and reuse its row/switch/number-input components from `./primitives`): a switch bound to `enabled`, and two number inputs (minutes) bound to `thresholdMin` and `pressureThresholdMin` via `setIdlePrefs`. Copy: EN "Suggest ending sessions you have not messaged in a while" / PT "Sugerir encerrar sessões sem mensagem sua há um tempo"; "After (minutes)" / "Depois de (minutos)"; "Under memory pressure (minutes)" / "Com a memória apertada (minutos)". Inputs keep the global ≥16px mobile rule (no inline font-size).

- [ ] **Step 6: Run + commit**

Run: `bun test packages/web/src/lib/idleSessionsPrefs.test.ts && bunx tsc --noEmit` → PASS.

```bash
git add packages/web/src/lib/idleSessionsPrefs.ts packages/web/src/lib/idleSessionsPrefs.test.ts packages/server/server/preferences.ts packages/web/src/pages/settings/SessionsSettings.tsx
git commit -m "feat(web): idle-session preferences and settings section"
```

---

### Task 5: Watch hook, notification code and click-through

**Files:**
- Create: `packages/web/src/lib/idleRows.ts` (pure adapter ControlSession → IdleRowInput)
- Create: `packages/web/src/lib/idleRows.test.ts`
- Create: `packages/web/src/hooks/useIdleSessions.ts`
- Modify: `packages/web/src/lib/notifications.ts` (`NOTIFICATION_TEXT['sessions.idle']`)
- Modify: `packages/web/src/components/NotificationBell.tsx` (click for `sessions.idle`)

**Interfaces:**
- Consumes: Task 1 (`idleCandidates`, `idleNotifyStep`, `freedBytes`), Task 2 (`ControlSession.lastUserMessageAt`, `taskId`), Task 4 (`useIdlePrefs`, `pruneKept`).
- Produces:
  - `toIdleRow(r: ControlSession, finishedTasks: readonly string[]): IdleRowInput`
  - `lastPromptOf(r: ControlSession): string | null`
  - `useIdleSessions(args: { rows: ControlSession[]; finishedTasks: string[]; openSessionId: string | null; lang: 'pt' | 'en'; enabled: boolean }): { candidates: IdleCandidate[]; underPressure: boolean }`
  - window event `'agentistics:open-idle-sessions'` (no detail) opens the modal.

- [ ] **Step 1: Failing test**

```ts
// packages/web/src/lib/idleRows.test.ts
import { describe, expect, it } from 'bun:test'
import { lastPromptOf, toIdleRow } from './idleRows'

const base = { id: 'a', title: 't', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: '', actionable: true, attached: false, searchFields: {} } as never

describe('toIdleRow', () => {
  it('a row that is not external/closed is managed; task done comes from finishedTasks by label', () => {
    const r = toIdleRow({ ...(base as object), task: 'T', taskId: 't1', lastUserMessageAt: 5, rssBytes: 7 } as never, ['T'])
    expect(r).toMatchObject({ id: 'a', managed: true, taskId: 't1', taskDone: true, lastUserMessageAt: 5, rssBytes: 7 })
  })
  it('external rows are not managed', () => {
    expect(toIdleRow({ ...(base as object), state: 'unknown' } as never, []).managed).toBe(false)
  })
})

describe('lastPromptOf', () => {
  it('is the last user turn, trimmed to 200 chars, else null', () => {
    const r = { ...(base as object), chatTurns: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'x' }, { role: 'user', text: 'y'.repeat(300) }] } as never
    expect(lastPromptOf(r)).toHaveLength(200)
    expect(lastPromptOf(base)).toBe(null)
  })
})
```

- [ ] **Step 2: Run** — `bun test packages/web/src/lib/idleRows.test.ts` → FAIL.

- [ ] **Step 3: Implement `idleRows.ts`**

```ts
// packages/web/src/lib/idleRows.ts
import type { IdleRowInput } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/types'

/** `unknown` is the external (not agentop-started) state; `closed` is a stored conversation. */
const UNMANAGED = new Set(['unknown', 'closed'])

export function toIdleRow(r: ControlSession, finishedTasks: readonly string[]): IdleRowInput {
  return {
    id: r.id,
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    state: r.state,
    managed: !UNMANAGED.has(r.state),
    ...(r.lastUserMessageAt !== undefined ? { lastUserMessageAt: r.lastUserMessageAt } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
    taskDone: Boolean(r.task && finishedTasks.includes(r.task)),
    rssBytes: r.rssBytes ?? null,
    cpuPercent: r.cpuPercent ?? null,
    contextFraction: r.context?.fraction ?? null,
  }
}

export function lastPromptOf(r: ControlSession): string | null {
  const turn = [...(r.chatTurns ?? [])].reverse().find(t => t.role === 'user' && t.text.trim())
  return turn ? turn.text.trim().slice(0, 200) : null
}
```

(Check the import path of `ControlSession` used by `packages/web/src/lib/fleet.ts` and use the same one.)

- [ ] **Step 4: Notification copy** — add to `NOTIFICATION_TEXT`:

```ts
  'sessions.idle': {
    pt: { title: 'Sessões ociosas', message: '{count} sessão(ões) sem mensagem sua há um tempo: {names}. {freed}Clique para revisar.' },
    en: { title: 'Idle sessions', message: '{count} session(s) you have not messaged in a while: {names}. {freed}Click to review.' },
  },
```

(`freed` is pre-formatted by the hook, e.g. `"Frees ~2.1 GB. "`, or `""`.)

- [ ] **Step 5: Click-through** — in `NotificationBell.tsx`, beside `isUpdate`:

```ts
              const isIdle = n.code === 'sessions.idle'
              const clickable = link !== null || isUpdate || isIdle
              const go = () => {
                setOpen(false)
                if (isUpdate) { window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')); return }
                if (isIdle) { navigate('/sessions'); window.dispatchEvent(new CustomEvent('agentistics:open-idle-sessions')); return }
                if (link) navigate(link)
              }
```

- [ ] **Step 6: The hook**

```ts
// packages/web/src/hooks/useIdleSessions.ts
/**
 * Derives idle candidates from the LIVE fleet on every poll and announces each new batch once.
 * Local machine only — the caller passes `enabled: false` on a central.
 */
import { useEffect, useMemo, useRef } from 'react'
import { freedBytes, idleCandidates, idleNotifyStep, sessionIdentityKey, type IdleCandidate } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/types'
import { useHardwareSnapshot } from '../components/HardwareModal'
import { resourcesPressure } from '../lib/hardwarePressure'
import { pushNotification } from '../lib/notifications'
import { pruneKept, useIdlePrefs } from '../lib/idleSessionsPrefs'
import { toIdleRow } from '../lib/idleRows'

export function fmtGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function useIdleSessions(args: {
  rows: ControlSession[]; finishedTasks: string[]; openSessionId: string | null; lang: 'pt' | 'en'; enabled: boolean
}): { candidates: IdleCandidate[]; underPressure: boolean } {
  const prefs = useIdlePrefs()
  const { hardware } = useHardwareSnapshot(args.lang)
  const underPressure = useMemo(
    () => (hardware ? resourcesPressure(hardware).some(p => p.resource === 'ram' && p.level !== 'ok') : false),
    [hardware],
  )
  const inputs = useMemo(() => args.rows.map(r => toIdleRow(r, args.finishedTasks)), [args.rows, args.finishedTasks])
  const candidates = useMemo(() => (!args.enabled || !prefs.enabled) ? [] : idleCandidates(inputs, {
    now: Date.now(),
    thresholdMs: prefs.thresholdMin * 60_000,
    pressureThresholdMs: prefs.pressureThresholdMin * 60_000,
    underPressure,
    openSessionId: args.openSessionId,
    kept: prefs.kept,
  }), [inputs, prefs, underPressure, args.openSessionId, args.enabled])

  const notified = useRef<Set<string>>(new Set())
  useEffect(() => {
    const step = idleNotifyStep(notified.current, candidates)
    notified.current = step.next
    if (!step.notify) return
    const pt = args.lang === 'pt'
    const names = candidates.slice(0, 3).map(c => args.rows.find(r => r.id === c.row.id)?.title ?? c.row.id).join(', ')
      + (candidates.length > 3 ? (pt ? ` e mais ${candidates.length - 3}` : ` and ${candidates.length - 3} more`) : '')
    const freed = freedBytes(candidates)
    pushNotification({
      type: 'info', code: 'sessions.idle',
      meta: { count: candidates.length, names, freed: freed === null ? '' : (pt ? `Libera ~${fmtGB(freed)}. ` : `Frees ~${fmtGB(freed)}. `) },
    })
  }, [candidates, args.lang, args.rows])

  // Keep marks for sessions that no longer exist are dropped.
  useEffect(() => {
    if (args.rows.length === 0) return
    pruneKept(new Set(args.rows.map(r => sessionIdentityKey(r))))
  }, [args.rows])

  return { candidates, underPressure }
}
```

Confirm `useHardwareSnapshot(lang)` returns `{ hardware }` whose shape satisfies `HardwarePressureInput` — `useHardwarePressureWatch.ts` already passes it to `resourcesPressure`, so it does.

- [ ] **Step 7: Run + commit**

Run: `bun test packages/web/src/lib/idleRows.test.ts && bunx tsc --noEmit` → PASS.

```bash
git add packages/web/src/lib/idleRows.ts packages/web/src/lib/idleRows.test.ts packages/web/src/hooks/useIdleSessions.ts packages/web/src/lib/notifications.ts packages/web/src/components/NotificationBell.tsx
git commit -m "feat(web): watch idle sessions and notify once per batch"
```

---

### Task 6: Review modal, execution and banner

**Files:**
- Create: `packages/web/src/lib/idleExecution.ts` (pure-ish runner with injected effects)
- Create: `packages/web/src/lib/idleExecution.test.ts`
- Create: `packages/web/src/components/sessions/IdleSessionsModal.tsx`
- Create: `packages/web/src/components/sessions/IdleSessionsBanner.tsx`
- Modify: `packages/web/src/pages/SessionsPage.tsx` (mount hook, banner, modal)

**Interfaces:**
- Consumes: Tasks 1, 4, 5; `createSessionGroup`, `moveSessionToGroup`, `getSessionGroups` from `lib/sessionUserGroups.ts`; `act` from `useFleet`.
- Produces:
  - `type IdleAction = 'file-end' | 'end' | 'keep'`
  - `interface IdlePlanItem { id: string; key: string; title: string; action: IdleAction; group: GroupSuggestion }`
  - `type IdleOutcome = { id: string; title: string; result: 'ended' | 'kept' | 'skipped' | 'failed'; message?: string }`
  - `runIdlePlan(items: IdlePlanItem[], fx: IdleEffects): Promise<IdleOutcome[]>` with
    `interface IdleEffects { stillIdle(id: string): Promise<boolean>; ensureGroup(g: GroupSuggestion): string | null; fileInto(groupId: string, key: string): void; end(id: string): Promise<{ ok: boolean; message: string }>; keep(keys: string[]): void }`
  - `bannerVisible(args: { candidates: number; modalOpen: boolean; snoozedUntil: number | null; now: number }): boolean`

- [ ] **Step 1: Failing tests**

```ts
// packages/web/src/lib/idleExecution.test.ts
import { describe, expect, it } from 'bun:test'
import { bannerVisible, runIdlePlan, type IdleEffects, type IdlePlanItem } from './idleExecution'

const item = (id: string, action: IdlePlanItem['action']): IdlePlanItem => ({
  id, key: id, title: id.toUpperCase(), action, group: { kind: 'new', name: 'G' },
})
const fx = (over: Partial<IdleEffects> = {}): IdleEffects & { log: string[] } => {
  const log: string[] = []
  return {
    log,
    stillIdle: async () => true,
    ensureGroup: g => { log.push(`group:${g.name}`); return 'g1' },
    fileInto: (g, k) => { log.push(`file:${g}:${k}`) },
    end: async id => { log.push(`end:${id}`); return { ok: true, message: 'ok' } },
    keep: keys => { log.push(`keep:${keys.join(',')}`) },
    ...over,
  }
}

describe('runIdlePlan', () => {
  it('files THEN ends for file-end; only ends for end; only keeps for keep', async () => {
    const f = fx()
    const out = await runIdlePlan([item('a', 'file-end'), item('b', 'end'), item('c', 'keep')], f)
    expect(f.log).toEqual(['group:G', 'file:g1:a', 'end:a', 'end:b', 'keep:c'])
    expect(out.map(o => o.result)).toEqual(['ended', 'ended', 'kept'])
  })
  it('a failed end is reported with the server sentence and does not stop the others', async () => {
    const f = fx({ end: async id => (id === 'a' ? { ok: false, message: 'not confirmed' } : { ok: true, message: 'ok' }) })
    const out = await runIdlePlan([item('a', 'file-end'), item('b', 'end')], f)
    expect(out[0]).toMatchObject({ result: 'failed', message: 'not confirmed' })
    expect(out[1]!.result).toBe('ended')
  })
  it('a session no longer idle is skipped, untouched', async () => {
    const f = fx({ stillIdle: async id => id !== 'a' })
    const out = await runIdlePlan([item('a', 'file-end')], f)
    expect(out[0]!.result).toBe('skipped')
    expect(f.log).toEqual([])
  })
  it('a group that cannot be made fails that session before ending it', async () => {
    const f = fx({ ensureGroup: () => null })
    const out = await runIdlePlan([item('a', 'file-end')], f)
    expect(out[0]!.result).toBe('failed')
    expect(f.log).toEqual([])
  })
})

describe('bannerVisible', () => {
  it('shows with candidates while the modal is closed and not snoozed', () => {
    expect(bannerVisible({ candidates: 2, modalOpen: false, snoozedUntil: null, now: 10 })).toBe(true)
    expect(bannerVisible({ candidates: 0, modalOpen: false, snoozedUntil: null, now: 10 })).toBe(false)
    expect(bannerVisible({ candidates: 2, modalOpen: true, snoozedUntil: null, now: 10 })).toBe(false)
    expect(bannerVisible({ candidates: 2, modalOpen: false, snoozedUntil: 20, now: 10 })).toBe(false)
    expect(bannerVisible({ candidates: 2, modalOpen: false, snoozedUntil: 5, now: 10 })).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — `bun test packages/web/src/lib/idleExecution.test.ts` → FAIL.

- [ ] **Step 3: Implement `idleExecution.ts`**

```ts
// packages/web/src/lib/idleExecution.ts
/**
 * Executing a confirmed idle review. Each session runs its own sequence and stops at ITS first
 * failure; the others continue. The effects are injected so the order and the stop rule are tested
 * without a server. A session is re-checked first: the user may have messaged it since the modal
 * opened, and ending it then would end live work.
 */
import type { GroupSuggestion } from '@agentistics/core'

export type IdleAction = 'file-end' | 'end' | 'keep'

export interface IdlePlanItem { id: string; key: string; title: string; action: IdleAction; group: GroupSuggestion }

export type IdleOutcome = { id: string; title: string; result: 'ended' | 'kept' | 'skipped' | 'failed'; message?: string }

export interface IdleEffects {
  stillIdle(id: string): Promise<boolean>
  /** Returns the group id to file into (creating it when `kind: 'new'` or when it vanished), or null. */
  ensureGroup(g: GroupSuggestion): string | null
  fileInto(groupId: string, key: string): void
  end(id: string): Promise<{ ok: boolean; message: string }>
  keep(keys: string[]): void
}

export async function runIdlePlan(items: IdlePlanItem[], fx: IdleEffects): Promise<IdleOutcome[]> {
  const out: IdleOutcome[] = []
  const keep = items.filter(i => i.action === 'keep')
  for (const it of items) {
    if (it.action === 'keep') continue
    if (!(await fx.stillIdle(it.id))) { out.push({ id: it.id, title: it.title, result: 'skipped' }); continue }
    if (it.action === 'file-end') {
      const gid = fx.ensureGroup(it.group)
      if (!gid) { out.push({ id: it.id, title: it.title, result: 'failed', message: 'group' }); continue }
      fx.fileInto(gid, it.key)
    }
    const r = await fx.end(it.id)
    out.push(r.ok
      ? { id: it.id, title: it.title, result: 'ended' }
      : { id: it.id, title: it.title, result: 'failed', message: r.message })
  }
  if (keep.length > 0) {
    fx.keep(keep.map(k => k.key))
    for (const k of keep) out.push({ id: k.id, title: k.title, result: 'kept' })
  }
  // Report in the order the user saw.
  const order = new Map(items.map((it, i) => [it.id, i]))
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export function bannerVisible(a: { candidates: number; modalOpen: boolean; snoozedUntil: number | null; now: number }): boolean {
  if (a.candidates === 0 || a.modalOpen) return false
  return a.snoozedUntil === null || a.now >= a.snoozedUntil
}
```

(The `'group'` failure message is rendered by the modal as "could not create the group / não foi possível criar o grupo".)

- [ ] **Step 4: Run** — `bun test packages/web/src/lib/idleExecution.test.ts` → PASS.

- [ ] **Step 5: The modal** — `IdleSessionsModal.tsx`, props:

```ts
interface Props {
  lang: 'pt' | 'en'
  candidates: IdleCandidate[]
  rows: ControlSession[]          // to read title, lastPromptOf, task label
  underPressure: boolean
  onClose: () => void
  act: FleetState['act']
  refresh: () => Promise<ControlSession[]> | void
}
```

Behaviour (follow an existing modal in `components/sessions/` for the overlay/`esc`/focus-return conventions — read one first, e.g. whichever the `ConfirmModal` import in `SessionsPage.tsx` points to):
- Header: EN "Idle sessions" / PT "Sessões ociosas"; a line "{n} sessions · frees ~X GB" when `freedBytes` is not null; when `underPressure`, add "memory is under pressure — threshold lowered" / "memória apertada — limite reduzido".
- One row per candidate: title; idle time (`Math.floor(idleMs/60000)` → "3 h 12 min"); `lastPromptOf(row)` in a muted line when non-null; memory (`fmtGB`) and CPU% when known; reason chips from `c.reasons` ("task already delivered" / "tarefa já entregue"; "context nearly full — reopening is cheaper" / "contexto quase cheio — reabrir sai mais barato").
- Action `<select>`: File & end (default) / End only / Keep. Group `<select>` shown only for File & end, pre-filled from `suggestGroup(c, getSessionGroups().groups, allIdleRows, row.task, todayYmd)` plus every existing group and "New group…" (which reveals a text input).
- Footer: Cancel and a confirm button "Apply" / "Aplicar". On confirm build `IdlePlanItem[]` and call `runIdlePlan` with:
  - `stillIdle`: fetch fresh rows via the fleet `refresh()` if it returns them; otherwise `GET /api/fleet` and check the row still has `state === 'waiting'` and the same `lastUserMessageAt`.
  - `ensureGroup`: `existing` → the id if `getSessionGroups().groups` still has it, else `createSessionGroup(name)`; `new` → `createSessionGroup(name)`.
  - `fileInto`: `moveSessionToGroup(groupId, key)`.
  - `end`: `act({ id, action: 'kill' })`.
  - `keep`: `keepSessions(keys, Date.now())`.
- After the run, the modal switches to a result list (ended / kept / skipped + "you messaged it or it resumed" / failed + message) with a Close button.
- `isMobile` (`useIsMobile`): full-screen, 44px targets.

- [ ] **Step 6: The banner** — `IdleSessionsBanner.tsx`: a slim bar with the text "{n} idle sessions could be ended" / "{n} sessões ociosas podem ser encerradas", buttons Review / Revisar and Snooze 1 h / Adiar 1h. Snooze writes `Date.now() + 3_600_000` to `sessionStorage['agentistics-idle-snooze']` inside try/catch.

- [ ] **Step 7: Wire into SessionsPage** — near `useFleet(...)` (~line 293):

```tsx
  const { candidates, underPressure } = useIdleSessions({
    rows: fleet.rows, finishedTasks: fleet.finishedTasks,
    openSessionId: sessionId ?? null, lang: pt ? 'pt' : 'en', enabled: !isCentral && !pollUnsupported,
  })
  const [idleOpen, setIdleOpen] = useState(false)
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(() => {
    try { const v = Number(sessionStorage.getItem('agentistics-idle-snooze')); return Number.isFinite(v) && v > 0 ? v : null } catch { return null }
  })
  useEffect(() => {
    const open = () => setIdleOpen(true)
    window.addEventListener('agentistics:open-idle-sessions', open)
    return () => window.removeEventListener('agentistics:open-idle-sessions', open)
  }, [])
```

(`isCentral` from the page's outlet context — it is already read in this file or add it to the destructuring of `useOutletContext<AppContext>()`.) Render the banner at the top of the workspace body when `bannerVisible({ candidates: candidates.length, modalOpen: idleOpen, snoozedUntil, now: Date.now() })`, and the modal when `idleOpen && candidates.length > 0`. The notification click already navigates to `/sessions` and dispatches the event (Task 5); the listener also covers a click while already on the page.

- [ ] **Step 8: Run + commit**

Run: `bun test packages/web/src/lib && bunx tsc --noEmit` → PASS.

```bash
git add packages/web/src/lib/idleExecution.ts packages/web/src/lib/idleExecution.test.ts packages/web/src/components/sessions/IdleSessionsModal.tsx packages/web/src/components/sessions/IdleSessionsBanner.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): idle sessions review modal, execution and banner"
```

---

### Task 7: Verify in a real browser + docs

**Files:**
- Modify: `CLAUDE.md` (one short entry under the Sessions workspace notes: idle rule lives in `core/idleSessions.ts`; exact-link only; relay row gains nothing)

- [ ] **Step 1: Full suite** — `bun test` → 0 fail; `bunx tsc --noEmit` → clean.
- [ ] **Step 2: Isolated preview server** — build and run a preview against an isolated data dir (never the production store): see memory "Preview agentop needs an isolated data dir". Temporarily set `thresholdMin: 1` in that preview's `preferences.json` `idleSessions` so a throwaway PROBE session (spawned for this purpose — never the user's live sessions) becomes a candidate after one minute of no messages.
- [ ] **Step 3: Headless check at 1440px and 390px** (playwright with the local chromium at `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`): the bell is in the Sessions header; the notification appears once; clicking it opens the modal; "Apply" with File & end files the probe session into the suggested group and ends it; the banner disappears; at 390px `document.documentElement.scrollWidth <= window.innerWidth`.
- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: record the idle-sessions rules"
```
