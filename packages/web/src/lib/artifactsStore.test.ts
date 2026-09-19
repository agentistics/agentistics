import { test, expect, beforeEach } from 'bun:test'
import {
  closeArtifacts, getArtifacts, openArtifacts, resetArtifacts, setArtifactCount, toggleArtifacts,
} from './artifactsStore'
import { answerUnsaved, getUnsaved, reportUnsaved, resetUnsaved } from './unsavedBuffers'
import { getPanelLayout, isPanelShown, resetPanelSlots, showPanel } from './panelSlots'

beforeEach(() => { resetArtifacts(); resetUnsaved(); resetPanelSlots() })

test('it starts knowing nothing — no session, no count, shut', () => {
  expect(getArtifacts()).toEqual({ sessionId: null, open: false, count: 0, dismissed: false, tabRequest: null })
})

test('a count is recorded against the session it belongs to', () => {
  setArtifactCount('a', 3)
  expect(getArtifacts()).toMatchObject({ sessionId: 'a', count: 3 })
})

test('switching sessions resets the panel AND the dismissal', () => {
  setArtifactCount('a', 3)
  openArtifacts()
  closeArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
  setArtifactCount('b', 1)
  // A decision about one conversation says nothing about the next, and a count on the header of a
  // different session would be a confident wrong answer.
  expect(getArtifacts()).toEqual({ sessionId: 'b', count: 1, open: false, dismissed: false, tabRequest: null })
})

test('a new count for the SAME session keeps the panel as it was', () => {
  setArtifactCount('a', 1)
  openArtifacts()
  setArtifactCount('a', 4)
  expect(getArtifacts()).toEqual({ sessionId: 'a', count: 4, open: true, dismissed: false, tabRequest: null })
})

test('closing is also a decision not to be reopened automatically', () => {
  setArtifactCount('a', 2)
  openArtifacts()
  closeArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
})

test('opening again after a close lifts nothing but the shutter — the dismissal was theirs', () => {
  // Re-opening by hand is a new decision to look; it does not need to pretend the close never
  // happened, and leaving `dismissed` set is what stops the panel re-opening by itself later.
  setArtifactCount('a', 2)
  closeArtifacts()
  openArtifacts()
  expect(getArtifacts()).toMatchObject({ open: true, dismissed: true })
})

test('toggle is the two actions, in the order the button uses them', () => {
  setArtifactCount('a', 1)
  toggleArtifacts()
  expect(getArtifacts().open).toBe(true)
  toggleArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
})

test('an unchanged write keeps the SAME object, so no consumer re-renders', () => {
  // `useSyncExternalStore` compares by reference. The chat polls every few seconds and reports the
  // same count nearly every time; a fresh object each poll would re-render the header and the page
  // for nothing.
  setArtifactCount('a', 1)
  const before = getArtifacts()
  setArtifactCount('a', 1)
  expect(getArtifacts()).toBe(before)
})

test('an opener may ask for a tab, and asking twice is two requests', () => {
  setArtifactCount('t', 0)
  openArtifacts('live')
  const first = getArtifacts().tabRequest
  expect(first?.tab).toBe('live')
  closeArtifacts()
  openArtifacts('live')
  const second = getArtifacts().tabRequest
  // The STAMP is what makes the panel obey a second time — the reader may have moved to Files in
  // between, and a prop that never changes could never bring them back.
  expect(second).not.toBe(first)
})

test('opening without naming a tab leaves the reader where they were', () => {
  setArtifactCount('u', 0)
  openArtifacts('live')
  const asked = getArtifacts().tabRequest
  openArtifacts()
  expect(getArtifacts().tabRequest).toBe(asked)
})

/**
 * CLOSING CONTENTS NO LONGER ASKS ABOUT THE STUDIO'S BUFFERS.
 *
 * This panel used to unmount the Studio along with itself — one DOM tree, one close — so a dirty
 * Monaco buffer held the WHOLE panel's close. The Studio is now its own panel (`panelSlots.ts`),
 * placed in its own slot independently of Contents: closing this one no longer touches it, so a
 * dirty Studio must not hold a close that drops nothing of the Studio's. The hold moved with the
 * buffers — `panelSlots.ts`'s `showPanel` / `hidePanel` ask before the Studio itself is displaced or
 * closed, exhaustively covered by `panelSlots.test.ts`.
 */
test('closing Contents with a dirty Studio buffer reported is immediate — that buffer is not this panel’s', () => {
  setArtifactCount('a', 0)
  openArtifacts()
  reportUnsaved('studio', ['x.ts'])
  closeArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
  expect(getUnsaved().question).toBeNull()
})

test('with nothing unsaved anywhere a close is immediate and asks nothing', () => {
  setArtifactCount('a', 0)
  openArtifacts()
  closeArtifacts()
  expect(getArtifacts().open).toBe(false)
  expect(getUnsaved().question).toBeNull()
})

/**
 * `openArtifacts('studio')` IS A COMPATIBILITY SHIM: it delegates to `panelSlots.showPanel`, and
 * touches nothing of THIS store — a request for the Studio must not light up the Contents button,
 * which is the one-open-flag defect this whole feature exists to fix.
 */
test('openArtifacts("studio") opens the STUDIO panel via panelSlots, and never this panel', () => {
  setArtifactCount('a', 0)
  openArtifacts('studio')
  expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
  expect(getArtifacts()).toMatchObject({ open: false, tabRequest: null })
})

/**
 * I2 — CONTENTS AND THE STUDIO SHARE THE RIGHT SLOT, SO OPENING ONE DISPLACES THE OTHER.
 *
 * Before this fix, `openArtifacts()` set `open: true` unconditionally: the header's Contents
 * button, a note chip's `openArtifacts('live', ref)` and `openArtifacts('metrics')` all lit
 * Contents as "open" while `rightSlotContent` (`SessionsPage.tsx`) kept showing the Studio, because
 * nothing had told `panelSlots` to let go of it. A clean Studio must be displaced outright; a dirty
 * one must ask first, through the SAME `unsavedBuffers.ts` question `panelSlots.hidePanel` already
 * asks — and Contents may only open once that question is settled with "discard".
 */
test('opening Contents displaces a CLEAN right-slot Studio outright', () => {
  showPanel('studio', 'right')
  openArtifacts()
  expect(getPanelLayout().right).toBeNull()
  expect(getArtifacts().open).toBe(true)
})

test('opening Contents over a DIRTY right-slot Studio asks first, and does not open until answered', () => {
  showPanel('studio', 'right')
  reportUnsaved('studio', ['README.md'])
  openArtifacts()
  // Held: neither side has moved yet.
  expect(getPanelLayout().right).toBe('studio')
  expect(getArtifacts().open).toBe(false)
  expect(getUnsaved().question).toEqual({ cause: 'close' })
  answerUnsaved(true)
  expect(getPanelLayout().right).toBeNull()
  expect(getArtifacts().open).toBe(true)
})

test('"keep editing" leaves the Studio in place AND Contents unopened — the reverse of I2\'s repro', () => {
  showPanel('studio', 'right')
  reportUnsaved('studio', ['README.md'])
  openArtifacts()
  answerUnsaved(false)
  expect(getPanelLayout().right).toBe('studio')
  expect(getArtifacts().open).toBe(false)
})

test('a Studio parked at the BOTTOM is untouched by opening Contents — they do not share that slot', () => {
  showPanel('studio', 'bottom')
  openArtifacts()
  expect(getPanelLayout().bottom).toBe('studio')
  expect(getArtifacts().open).toBe(true)
})

test('a tab/ref request survives the displacement — the note chip’s own repro', () => {
  showPanel('studio', 'right')
  openArtifacts('live', 'step-1')
  expect(getPanelLayout().right).toBeNull()
  expect(getArtifacts().tabRequest).toMatchObject({ tab: 'live', ref: 'step-1' })
})

/**
 * C2 — THE SAME DEFECT I2 FIXED FOR THE STUDIO REOPENED THE MOMENT `cli`/`shell` COULD REACH THE
 * RIGHT SLOT. `openArtifacts()`'s displacement check named `'studio'` literally, so with `cli` or
 * `shell` sitting at `right`, every caller that can reach Contents — the header button, the right
 * switcher's own "Conteúdo" tab, a note chip, `openArtifacts('metrics')` — lit `open: true` while the
 * slot kept showing the terminal, unmoved. Unlike the Studio, displacing `cli`/`shell` asks NOTHING
 * — there is no buffer of theirs to lose by leaving the slot, only `panelSlots.hidePanel`'s own
 * studio-only hold applies.
 */
test('opening Contents displaces a right-slot `cli` pane outright, asking nothing', () => {
  showPanel('cli', 'right')
  openArtifacts()
  expect(getPanelLayout().right).toBeNull()
  expect(getArtifacts().open).toBe(true)
  expect(getUnsaved().question).toBeNull()
})

test('opening Contents displaces a right-slot `shell` pane outright, asking nothing', () => {
  showPanel('shell', 'right')
  openArtifacts()
  expect(getPanelLayout().right).toBeNull()
  expect(getArtifacts().open).toBe(true)
  expect(getUnsaved().question).toBeNull()
})

test('a `cli`/`shell` pane parked at the BOTTOM is untouched by opening Contents — they do not share that slot', () => {
  showPanel('cli', 'bottom')
  openArtifacts()
  expect(getPanelLayout().bottom).toBe('cli')
  expect(getArtifacts().open).toBe(true)
})

/**
 * C2, THE SECOND HALF — live-found while verifying the fix above: `toggleArtifacts` used to read
 * only THIS store's own `open` flag, which the right switcher's own "Claude Code"/"Shell" tabs never
 * touch (they call `panelSlots.openPanel` directly). So opening Contents, then picking `cli` from
 * the switcher — leaving `open === true` behind while the slot showed `cli` — made the header
 * button's NEXT press call `closeArtifacts()` (it read `open` as still true) instead of displacing
 * `cli`: visibly nothing happened, and a second press was needed to actually reach Contents.
 */
test('the header button toggles off what is ACTUALLY shown, not this store\'s own stale flag', () => {
  openArtifacts() // Contents opens; `state.open` becomes true.
  showPanel('cli', 'right') // the switcher's own tab — bypasses this store entirely.
  expect(getPanelLayout().right).toBe('cli')
  toggleArtifacts() // the header button, pressed once more.
  // Contents is not what is shown (cli is) — must DISPLACE it, never merely flip `open` to false.
  expect(getPanelLayout().right).toBeNull()
  expect(getArtifacts().open).toBe(true)
})

test('the header button closes Contents in one press when Contents really is what is shown', () => {
  openArtifacts()
  toggleArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
})
