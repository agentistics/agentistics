import { describe, expect, test } from 'bun:test'
import {
  bandBarCompact, bottomBandFor, gatedBottomOccupant, panelBarEntries, resolvePanelBarPick,
  type PanelBarGates,
} from './panelBar'

const OPEN: PanelBarGates = {
  editorEnabled: true, shellEnabled: true, relayed: false, hardwareOffered: true,
}

describe('panelBarEntries — the bottom band’s own tab strip', () => {
  test('lists exactly the bottomIds it is given, in that order', () => {
    const entries = panelBarEntries(['shell', 'cli'], 'cli', OPEN)
    expect(entries.map(e => e.id)).toEqual(['shell', 'cli'])
  })

  test('marks the active bottom occupant as lit, and only that one', () => {
    const entries = panelBarEntries(['shell', 'cli'], 'cli', OPEN)
    expect(entries.find(e => e.id === 'shell')?.on).toBe(false)
    expect(entries.find(e => e.id === 'cli')?.on).toBe(true)
  })

  test('a gate-closed panel is ABSENT, never greyed', () => {
    const entries = panelBarEntries(['cli', 'shell'], 'cli', { ...OPEN, shellEnabled: false })
    expect(entries.map(e => e.id)).toEqual(['cli'])
  })

  test('studio is gated by editorEnabled', () => {
    expect(panelBarEntries(['studio'], null, { ...OPEN, editorEnabled: false })).toEqual([])
    expect(panelBarEntries(['studio'], null, OPEN).map(e => e.id)).toEqual(['studio'])
  })

  test('cli/shell are gated by relayed', () => {
    expect(panelBarEntries(['cli', 'shell'], null, { ...OPEN, relayed: true })).toEqual([])
  })

  test('hardware is gated by hardwareOffered', () => {
    expect(panelBarEntries(['hardware'], null, { ...OPEN, hardwareOffered: false })).toEqual([])
  })

  test('the ten former Contents tabs carry no gate of their own', () => {
    const ids = ['live', 'gallery', 'skills', 'agents', 'forks', 'workflows', 'mcps', 'prs', 'tasks', 'metrics'] as const
    const entries = panelBarEntries([...ids], null, { editorEnabled: false, shellEnabled: false, relayed: true, hardwareOffered: false })
    expect(entries.map(e => e.id)).toEqual([...ids])
  })
})

describe('gatedBottomOccupant', () => {
  test('a stale "shell" reads as "cli" when the shell switch is off', () => {
    expect(gatedBottomOccupant('shell', false)).toBe('cli')
  })

  test('otherwise passes through unchanged', () => {
    expect(gatedBottomOccupant('shell', true)).toBe('shell')
    expect(gatedBottomOccupant('skills', false)).toBe('skills')
    expect(gatedBottomOccupant(null, true)).toBeNull()
  })
})

describe('bottomBandFor', () => {
  test('bottomOccupant wins whenever it names anything', () => {
    expect(bottomBandFor({ bottomOccupant: 'skills', relayed: false, isMobile: false, bottomHasPanels: true })).toBe('skills')
    expect(bottomBandFor({ bottomOccupant: 'studio', relayed: false, isMobile: false, bottomHasPanels: true })).toBe('studio')
  })

  // EMPTY IS EMPTY on a desktop. The old floor drew a bar with no tabs and one orange `−` once
  // every panel could be moved to the rail — reported twice. See `bottomBandFor`'s own header.
  test('a local DESKTOP session with nothing docked renders no band at all', () => {
    expect(bottomBandFor({ bottomOccupant: null, relayed: false, isMobile: false, bottomHasPanels: false })).toBe('none')
  })

  // COLLAPSED is not EMPTY, the case the first draft of this fix got wrong: panels PLACED at the
  // bottom with none of them open keep their band, tabs and all.
  test('a local DESKTOP session with panels placed but none open keeps its band', () => {
    expect(bottomBandFor({ bottomOccupant: null, relayed: false, isMobile: false, bottomHasPanels: true })).toBe('shell')
  })

  // A PHONE keeps the floor: it has no rail, and ShellBand's segment is its only route to the
  // session's terminal.
  test('a local PHONE session with nothing docked keeps ShellBand as the floor', () => {
    expect(bottomBandFor({ bottomOccupant: null, relayed: false, isMobile: true, bottomHasPanels: false })).toBe('shell')
  })

  // COLLAPSED is not EMPTY: a docked panel keeps its band (and the chevron that reopens it)
  // whatever its open state — the band's presence is decided by occupancy alone.
  test('a docked panel keeps its band, so a collapsed one can still be reopened', () => {
    expect(bottomBandFor({ bottomOccupant: 'shell', relayed: false, isMobile: false, bottomHasPanels: true })).toBe('shell')
    expect(bottomBandFor({ bottomOccupant: 'studio', relayed: false, isMobile: false, bottomHasPanels: true })).toBe('studio')
    expect(bottomBandFor({ bottomOccupant: 'hardware', relayed: false, isMobile: false, bottomHasPanels: true })).toBe('hardware')
  })

  test('a relayed session with nothing docked gets bar-only on desktop, none on a phone', () => {
    expect(bottomBandFor({ bottomOccupant: null, relayed: true, isMobile: false, bottomHasPanels: false })).toBe('bar-only')
    expect(bottomBandFor({ bottomOccupant: null, relayed: true, isMobile: true, bottomHasPanels: false })).toBe('none')
  })
})

describe('bandBarCompact', () => {
  test('0 (unmeasured) reads as wide, never compact', () => {
    expect(bandBarCompact(0)).toBe(false)
  })

  test('below the breakpoint is compact', () => {
    expect(bandBarCompact(1099)).toBe(true)
    expect(bandBarCompact(1100)).toBe(false)
  })
})

describe('resolvePanelBarPick', () => {
  test('a panel that is not the active bottom tab: open', () => {
    expect(resolvePanelBarPick({ id: 'cli', activeBottom: 'shell', bottomOpen: true }))
      .toEqual({ kind: 'open' })
  })

  test('the active tab, collapsed band: restore', () => {
    expect(resolvePanelBarPick({ id: 'cli', activeBottom: 'cli', bottomOpen: false }))
      .toEqual({ kind: 'restore' })
  })

  test('the active tab, expanded band: minimize — the right rail own second-click behaviour', () => {
    expect(resolvePanelBarPick({ id: 'cli', activeBottom: 'cli', bottomOpen: true }))
      .toEqual({ kind: 'minimize' })
  })

  test('minimize then pick again: restore — the round trip lands where it started', () => {
    expect(resolvePanelBarPick({ id: 'studio', activeBottom: 'studio', bottomOpen: true }).kind).toBe('minimize')
    expect(resolvePanelBarPick({ id: 'studio', activeBottom: 'studio', bottomOpen: false }).kind).toBe('restore')
  })
})

describe('panelBarEntries — a session with no SCREEN (UI.UNIFY, native)', () => {
  test('the cli tab is absent, the shell and every other panel stay', () => {
    const ids = panelBarEntries(['cli', 'shell'], 'shell', { ...OPEN, screen: false }).map(e => e.id)
    expect(ids).toEqual(['shell'])
  })
  test('absent `screen` reads as a session that has one — the CLI path is unchanged', () => {
    expect(panelBarEntries(['cli', 'shell'], 'cli', OPEN).map(e => e.id)).toEqual(['cli', 'shell'])
  })
})
