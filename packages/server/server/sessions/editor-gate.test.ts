import { describe, expect, test } from 'bun:test'
import { editorAllowed } from './editor-gate'
import { routeCapability } from '../capability-guard'

describe('editorAllowed', () => {
  // Owner decision, 2026-09-14: Studio ships on by default — an absent preference now reads as ON.
  test('absent preference reads as ON when capable', () => {
    expect(editorAllowed(true, undefined)).toBe(true)
  })
  test('preference true but not capable is still OFF — the preference only narrows', () => {
    expect(editorAllowed(false, true)).toBe(false)
  })
  test('capable and explicitly on is ON', () => {
    expect(editorAllowed(true, true)).toBe(true)
  })
  test('preference explicitly false is OFF even when capable — the explicit opt-out is respected', () => {
    expect(editorAllowed(true, false)).toBe(false)
  })
  test('absent preference on an incapable profile is still OFF — the security gate is unchanged', () => {
    expect(editorAllowed(false, undefined)).toBe(false)
  })

  // Plant: the OLD strict rule (`preference === true`) — this must now FAIL, proving the reversal
  // actually shipped rather than merely being asserted above.
  test('plant: the old strict reading no longer matches this module\'s behaviour', () => {
    const oldStrictReading = (capable: boolean, preference: boolean | undefined) => capable && preference === true
    expect(editorAllowed(true, undefined)).not.toBe(oldStrictReading(true, undefined))
  })
})

describe('the /api/fleet/tree routes ride the existing /api/fleet prefix', () => {
  test('every route this feature defines is guarded', () => {
    expect(routeCapability('/api/fleet/tree')).toBe('localShell')
    expect(routeCapability('/api/fleet/tree/search')).toBe('localShell')
    expect(routeCapability('/api/fleet/tree/file')).toBe('localShell')
    expect(routeCapability('/api/fleet/tree/entry')).toBe('localShell')
  })
  test('and so is a fleet-tree route that does not exist yet — the PREFIX is what guards it', () => {
    expect(routeCapability('/api/fleet/tree/whatever-comes-next')).toBe('localShell')
  })
})
