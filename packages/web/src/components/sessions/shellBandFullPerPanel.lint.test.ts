/**
 * shellBandFullPerPanel.lint.test.ts — `ShellBand` reads/writes ONLY its own panel's full-screen
 * entry, never the shared `agentistics-shell-band` record's `full` flag as a bare boolean.
 *
 * Companion to `sessionPanel.lint.test.ts`'s own describe block of the same name, for the third
 * consumer of `BandPrefs.full` (`StudioBand` and `SimpleDockedBand` are the other two, both in
 * `SessionPanel.tsx`). `ShellBand` shows either the session's `cli` pane or its `shell` one, chosen
 * by its own `target` state — so "this panel's entry" is `target` itself, read through
 * `bandPanelFull(prefs, target)` and written through `withBandPanelFull(merged, target, ...)`,
 * never a bare `prefs.full`.
 *
 * Not reachable by rendering: `ShellBand` needs a live tmux session and `packages/web` has no
 * jsdom. The SHAPE is what went wrong (one flat boolean, shared by whichever panel next reads it —
 * drag the Studio to fill the column, move Contents into the same band, and Contents read as full
 * too), so the shape is what is asserted, over comment-free source, with the old shape planted back
 * in to prove the scan still catches it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const RAW = readFileSync(join(import.meta.dir, 'ShellBand.tsx'), 'utf-8')
const SRC = stripComments(RAW)

test('no bare `prefs.full` read survives anywhere in this file', () => {
  // `bandPanelFull(prefs, target)` and `prefs.full?.[...]`-style lookups are fine; a raw
  // `prefs.full` — the shared boolean the old shape was — is not.
  expect(SRC).not.toMatch(/prefs\.full\b(?!\?)/)
})

test('every full-screen read goes through `bandPanelFull`, scoped to `target`', () => {
  const occurrences = [...SRC.matchAll(/bandPanelFull\(prefs, target\)/g)]
  expect(occurrences.length).toBeGreaterThanOrEqual(3)
})

test('the write path merges through `withBandPanelFull`, never a bare `full` field on the merge', () => {
  expect(SRC).toContain('merged = withBandPanelFull(merged, target, next.full)')
  // The OLD write shape this replaces — spreading `next` (which can carry `full: boolean`) straight
  // onto the persisted record.
  expect(SRC).not.toMatch(/const merged: BandPrefs = \{ \.\.\.p, \.\.\.next \}/)
})

test('the scan still sees the old bare read reintroduced', () => {
  const planted = SRC.replace(
    'const renderedHeight = bandPanelFull(prefs, target)',
    'const renderedHeight = prefs.full',
  )
  expect(planted).toMatch(/prefs\.full\b(?!\?)/)
})

test('the scan still sees the old spread-merge write reintroduced', () => {
  const planted = `${SRC}\n  const merged: BandPrefs = { ...p, ...next }\n`
  expect(planted).toMatch(/const merged: BandPrefs = \{ \.\.\.p, \.\.\.next \}/)
})

/**
 * `open` MOUNTS SEEDED FROM `slotLayout.bottomOpen` — the sibling bug to the one above, found by
 * the same agent: with the band open on the Studio, picking Claude Code or Shell minimized it
 * instead of switching, needing a second click. `ShellBand` mounts fresh whenever it swaps in for
 * `StudioBand`/`SimpleDockedBand`, and `useState(() => readBandPrefs())` used to read the shared
 * record's `open` field cold, ignoring the `bottomOpen: true` `panelSlots.ts`'s own `openPanel` had
 * just set for the panel now mounting. `seedBandOpen` (`shellBand.ts`, pure — its own tests cover
 * the arithmetic) is the fix; this file owns only the WIRING — that the seed actually reaches the
 * `useState` initializer and the shell-resolution reducer's own mount-time read.
 */
describe('this band\'s own `open` state is seeded from the slot, not read cold from storage', () => {
  test('the prefs state is seeded through `seedBandOpen`, not a bare `readBandPrefs()`', () => {
    // Read for THIS band's pane of a split view (`bandPane`), still seeded through `seedBandOpen`.
    expect(SRC).toContain('const [prefs, setPrefs] = useState(() => seedBandOpen(readBandPrefs(undefined, bandPane), openSeed))')
  })

  test('the shell-resolution reducer reads the ALREADY-seeded `prefs.open`, never a second cold read', () => {
    expect(SRC).toContain('dedicated || prefs.open ? shellBandReducer(init, { type: \'openBand\' }) : init)')
    // The old shape this replaces — a SECOND, independent `readBandPrefs()` call at the reducer's
    // own init, which could disagree with the (correctly seeded) `prefs` state declared above it.
    expect(SRC).not.toMatch(/dedicated \|\| readBandPrefs\(\)\.open \?/)
  })

  test('a change to `open` after mount is reported back through `onOpenChange`', () => {
    expect(SRC).toContain('if (next.open !== undefined) onOpenChange?.(next.open)')
  })

  test('the scan still sees the seed dropped from the prefs state', () => {
    const planted = SRC.replace(
      'const [prefs, setPrefs] = useState(() => seedBandOpen(readBandPrefs(), openSeed))',
      'const [prefs, setPrefs] = useState(() => readBandPrefs())',
    )
    expect(planted).not.toContain('useState(() => seedBandOpen(readBandPrefs(), openSeed))')
  })

  test('the scan still sees the reducer init reverted to a cold second read', () => {
    const planted = SRC.replace(
      "dedicated || prefs.open ? shellBandReducer(init, { type: 'openBand' }) : init)",
      "dedicated || readBandPrefs().open ? shellBandReducer(init, { type: 'openBand' }) : init)",
    )
    expect(planted).toMatch(/dedicated \|\| readBandPrefs\(\)\.open \?/)
  })
})
