import { test, expect, beforeEach } from 'bun:test'
import {
  getArtifacts,
  getArtifactsOf, getPanelFocusRequest, openArtifacts, resetArtifacts, setArtifactCount,
  setArtifactLive,
} from './artifactsStore'
import { resetUnsaved } from './unsavedBuffers'
import { getPanelLayout, isPanelShown, resetPanelSlots } from './panelSlots'

beforeEach(() => { resetArtifacts(); resetUnsaved(); resetPanelSlots() })

test('it starts knowing nothing — no session, no count', () => {
  expect(getArtifacts()).toEqual({ sessionId: null, count: 0 })
})

test('a count is recorded against the session it belongs to', () => {
  setArtifactCount('a', 3)
  expect(getArtifacts()).toMatchObject({ sessionId: 'a', count: 3 })
})

test('switching sessions resets the count', () => {
  setArtifactCount('a', 3)
  setArtifactCount('b', 1)
  // A count on the header of a different session would be a confident wrong answer.
  expect(getArtifacts()).toEqual({ sessionId: 'b', count: 1 })
})

test('an unchanged write keeps the SAME object, so no consumer re-renders', () => {
  // `useSyncExternalStore` compares by reference. The chat polls every few seconds and reports the
  // same count nearly every time; a fresh object each poll would re-render the header for nothing.
  setArtifactCount('a', 1)
  const before = getArtifacts()
  setArtifactCount('a', 1)
  expect(getArtifacts()).toBe(before)
})

/**
 * `openArtifacts(tab)` IS A COMPATIBILITY SHIM over `panelSlots.showPanel` — every one of the
 * fourteen panels now carries its own occupancy directly in `SlotLayout`, so there is nothing left
 * for THIS store to track about "which one is open".
 */
test('openArtifacts opens the named panel via panelSlots', () => {
  openArtifacts('skills')
  expect(isPanelShown(getPanelLayout(), 'skills')).toBe(true)
})

test('openArtifacts("studio") opens the Studio panel exactly like any other id — no special case left', () => {
  openArtifacts('studio')
  expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
})

test('an unrecognised or absent tab defaults to "live" — the historical default', () => {
  openArtifacts()
  expect(getPanelLayout().right).toBe('live')
})

test('opening one panel displaces whatever else occupied that slot', () => {
  openArtifacts('metrics')
  openArtifacts('skills')
  expect(getPanelLayout().right).toBe('skills')
  expect(isPanelShown(getPanelLayout(), 'metrics')).toBe(false)
})

// ---------------------------------------------------------------------------------------------
// The focus-ref side channel — the edge strip's "land on this row", now decoupled from "which tab
// is open" (panelSlots owns that alone).
// ---------------------------------------------------------------------------------------------

test('a ref names a row to focus once the tab is there', () => {
  openArtifacts('live', 'step-1')
  expect(getPanelFocusRequest()).toMatchObject({ tab: 'live', ref: 'step-1' })
})

test('asking for the same tab/ref twice is still two distinct requests — the stamp changes', () => {
  openArtifacts('live', 'step-1')
  const first = getPanelFocusRequest()
  openArtifacts('live', 'step-1')
  const second = getPanelFocusRequest()
  expect(second).not.toBe(first)
})

test('opening without a ref leaves any previous focus request as it was', () => {
  openArtifacts('live', 'step-1')
  const asked = getPanelFocusRequest()
  openArtifacts('live')
  expect(getPanelFocusRequest()).toBe(asked)
})

test('resetArtifacts clears both the count and the focus request', () => {
  setArtifactCount('a', 3)
  openArtifacts('live', 'step-1')
  resetArtifacts()
  expect(getArtifacts()).toEqual({ sessionId: null, count: 0 })
  expect(getPanelFocusRequest()).toBeNull()
})


test('what the session is doing is recorded against its session, and cleared by null', () => {
  setArtifactCount('a', 2)
  setArtifactLive('a', { kind: 'ran', text: 'bun test', ref: 'toolu_1' })
  expect(getArtifacts().live).toEqual({ kind: 'ran', text: 'bun test', ref: 'toolu_1' })
  setArtifactLive('a', null)
  expect('live' in getArtifacts()).toBe(false)
})

test('an unchanged live fact keeps its object, so a poll does not re-render its readers', () => {
  setArtifactCount('a', 2)
  setArtifactLive('a', { kind: 'ran', text: 'bun test', ref: 'toolu_1' })
  const first = getArtifacts()
  setArtifactLive('a', { kind: 'ran', text: 'bun test', ref: 'toolu_1' })
  expect(getArtifacts()).toBe(first)
  setArtifactLive('a', { kind: 'ran', text: 'bun test', ref: 'toolu_2' })
  expect(getArtifacts()).not.toBe(first)
})

test('a live fact belongs to ONE session: a second session never clears or borrows it (split view)', () => {
  setArtifactCount('a', 2)
  setArtifactLive('a', { kind: 'wrote', text: 'x.ts' })
  setArtifactCount('b', 0)
  expect('live' in getArtifactsOf('b')).toBe(false)
  expect(getArtifactsOf('a').live).toEqual({ kind: 'wrote', text: 'x.ts' })
  const bBefore = getArtifactsOf('b')
  setArtifactLive('a', null)
  expect('live' in getArtifactsOf('a')).toBe(false)
  expect(getArtifactsOf('b')).toBe(bBefore)
})

test('a new count for the same session keeps what it is doing', () => {
  setArtifactCount('a', 1)
  setArtifactLive('a', { kind: 'delegated', text: 'Explore', ref: 'r' })
  setArtifactCount('a', 5)
  expect(getArtifacts().live).toEqual({ kind: 'delegated', text: 'Explore', ref: 'r' })
})
