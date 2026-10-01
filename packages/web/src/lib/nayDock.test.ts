import { describe, expect, test } from 'bun:test'
import {
  clampPanelSize, closeWindow, detachSession, dockSession, minimizeWindow, openSession,
  parseDockState, pruneDock, resizePanel, PANEL_MIN, type DockState,
} from './nayDock'

const vp = { w: 1440, h: 900 }
const empty: DockState = { open: false, panelSession: null, windows: [] }

describe('panel size', () => {
  test('clamped between the minimum and what the viewport holds', () => {
    expect(clampPanelSize({ w: 100, h: 100 }, vp)).toEqual(PANEL_MIN)
    expect(clampPanelSize({ w: 5000, h: 5000 }, vp)).toEqual({ w: 1400, h: 804 })
  })
  test('pulling the left edge left widens; pulling the top up heightens', () => {
    expect(resizePanel({ w: 440, h: 620 }, -100, -50, { left: true, top: true }, vp)).toEqual({ w: 540, h: 670 })
    expect(resizePanel({ w: 440, h: 620 }, -100, -50, { left: false, top: true }, vp)).toEqual({ w: 440, h: 670 })
  })
})

describe('where a session opens', () => {
  test('into the panel when no window holds it', () => {
    expect(openSession(empty, 's1')).toEqual({ open: true, panelSession: 's1', windows: [] })
  })
  test('a detached session is RAISED and restored, never opened twice', () => {
    let s = detachSession(openSession(empty, 's1'), 's1', vp)
    s = detachSession(s, 's2', vp)
    s = minimizeWindow(s, 's1')
    const after = openSession(s, 's1')
    const w1 = after.windows.find(w => w.id === 's1')!
    expect(w1.minimized).toBe(false)
    expect(w1.z).toBeGreaterThan(after.windows.find(w => w.id === 's2')!.z)
    expect(after.panelSession).toBeNull()
  })
  test('detaching takes the session out of the panel; docking puts it back', () => {
    const d = detachSession(openSession(empty, 's1'), 's1', vp)
    expect(d.panelSession).toBeNull()
    expect(d.windows.map(w => w.id)).toEqual(['s1'])
    const back = dockSession(d, 's1')
    expect(back).toEqual({ open: true, panelSession: 's1', windows: [] })
  })
  test('closing a window forgets it', () => {
    expect(closeWindow(detachSession(empty, 's1', vp), 's1').windows).toEqual([])
  })
  test('a vanished session leaves neither a window nor the panel', () => {
    const s = detachSession({ open: true, panelSession: 'gone', windows: [] }, 's1', vp)
    const pruned = pruneDock({ ...s, panelSession: 'gone' }, id => id === 's1')
    expect(pruned.panelSession).toBeNull()
    expect(pruned.windows.map(w => w.id)).toEqual(['s1'])
  })
})

describe('parseDockState', () => {
  test('keeps well-formed windows and drops junk', () => {
    expect(parseDockState({ windows: [{ id: 'a', x: 1, y: 2, w: 3, h: 4, z: 5, minimized: true }, { id: 3 }, null] }))
      .toEqual({ windows: [{ id: 'a', x: 1, y: 2, w: 3, h: 4, z: 5, minimized: true }] })
    expect(parseDockState('nope')).toEqual({ windows: [] })
  })
})

import { minimizedBadge, menuPlacement } from './nayDock'

describe('minimized list', () => {
  test('the badge says nothing at zero and caps past nine', () => {
    expect(minimizedBadge(0)).toBeNull()
    expect(minimizedBadge(-1)).toBeNull()
    expect(minimizedBadge(3)).toBe('3')
    expect(minimizedBadge(12)).toBe('9+')
  })
  test('opens above and leftward from the default bottom-right button', () => {
    expect(menuPlacement({ top: 800, bottom: 856, left: 1360, right: 1416 }, { w: 1440, h: 900 }, 320))
      .toEqual({ vertical: 'above', horizontal: 'right' })
  })
  test('flips below near the top and rightward near the left edge', () => {
    expect(menuPlacement({ top: 20, bottom: 76, left: 20, right: 76 }, { w: 1440, h: 900 }, 320))
      .toEqual({ vertical: 'below', horizontal: 'left' })
  })
})

import { anchorDock, DOCK_GAP, DOCK_MARGIN, resizeAnchored } from './nayDock'

describe('the dock opens anchored to the button', () => {
  const VP = { w: 1440, h: 900 }
  const WANT = { w: 480, h: 720 }
  const overlaps = (p: { left: number; top: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    p.left < b.x + b.w && p.left + p.w > b.x && p.top < b.y + b.h && p.top + p.h > b.y
  const onScreen = (p: { left: number; top: number; w: number; h: number }) =>
    p.left >= DOCK_MARGIN && p.top >= DOCK_MARGIN && p.left + p.w <= VP.w - DOCK_MARGIN && p.top + p.h <= VP.h - DOCK_MARGIN

  test('from the default bottom-right button it opens up and to the left, as before', () => {
    const btn = { x: VP.w - 56 - 24, y: VP.h - 56 - 24, w: 56, h: 56 }
    const p = anchorDock(btn, WANT, VP)
    expect(p.grow).toEqual({ x: 'left', y: 'up' })
    expect(p.left + p.w).toBe(btn.x + btn.w)
    expect(p.top + p.h).toBe(btn.y - DOCK_GAP)
    expect(overlaps(p, btn)).toBe(false)
    expect(onScreen(p)).toBe(true)
  })
  test('from a top-left button it opens down and to the right', () => {
    const btn = { x: 16, y: 16, w: 56, h: 56 }
    const p = anchorDock(btn, WANT, VP)
    expect(p.grow).toEqual({ x: 'right', y: 'down' })
    expect(p.left).toBe(16)
    expect(p.top).toBe(16 + 56 + DOCK_GAP)
    expect(overlaps(p, btn)).toBe(false)
    expect(onScreen(p)).toBe(true)
  })
  test('the height is shrunk to the room there is, never the stored size', () => {
    const btn = { x: 16, y: 16, w: 56, h: 56 }
    const p = anchorDock(btn, { w: 480, h: 2000 }, VP)
    expect(p.h).toBe(VP.h - (16 + 56) - DOCK_GAP - DOCK_MARGIN)
    expect(onScreen(p)).toBe(true)
  })
  test('a button in the middle of a short window opens the panel beside it', () => {
    const vp = { w: 1440, h: 700 }
    const btn = { x: 700, y: 322, w: 56, h: 56 }
    const p = anchorDock(btn, WANT, vp)
    expect(overlaps(p, btn)).toBe(false)
    expect(p.left + p.w <= btn.x - DOCK_GAP || p.left >= btn.x + btn.w + DOCK_GAP).toBe(true)
    expect(p.top >= DOCK_MARGIN && p.top + p.h <= vp.h - DOCK_MARGIN).toBe(true)
  })
  test('never covers the button and stays on screen wherever the button is', () => {
    for (const x of [16, 300, 700, 1100, VP.w - 72]) {
      for (const y of [16, 200, 420, 650, VP.h - 72]) {
        const btn = { x, y, w: 56, h: 56 }
        const p = anchorDock(btn, WANT, VP)
        expect(overlaps(p, btn)).toBe(false)
        expect(onScreen(p)).toBe(true)
      }
    }
  })
  test('resizing grows away from the button', () => {
    expect(resizeAnchored({ w: 480, h: 600 }, 40, 30, { x: 'right', y: 'down' }, VP)).toEqual({ w: 520, h: 630 })
    expect(resizeAnchored({ w: 480, h: 600 }, -40, -30, { x: 'left', y: 'up' }, VP)).toEqual({ w: 520, h: 630 })
  })
})

import { dockZIndex, windowZIndex } from './nayDock'

describe('the open dock stacks above detached windows', () => {
  test('a window never outranks the dock, however far it was raised', () => {
    const windows = [{ z: 1 }, { z: 7 }, { z: 3 }]
    const dock = dockZIndex(windows)
    for (const w of windows) expect(dock).toBeGreaterThan(windowZIndex(w))
  })
  test('with no windows the dock still sits above where the first one would', () => {
    expect(dockZIndex([])).toBeGreaterThan(windowZIndex({ z: 0 }))
  })
  test('raising a window re-ranks the dock above it', () => {
    const before = dockZIndex([{ z: 2 }])
    const after = dockZIndex([{ z: 2 }, { z: 3 }])
    expect(after).toBeGreaterThan(windowZIndex({ z: 3 }))
    expect(after).toBeGreaterThan(before)
  })
})

import { dockActiveOnly } from './nayDock'
import { folderCountLabel, listNarrowed } from './sessionUserGroups'
import { folderFold } from './folderFold'

describe("the dock's Sessões tab draws folders under the workspace's rules", () => {
  test('outside the workspace it takes the workspace default (active only)', () => {
    expect(dockActiveOnly(false, false)).toBe(true)
  })
  test('inside the workspace it follows the switch the person set there', () => {
    expect(dockActiveOnly(true, false)).toBe(false)
    expect(dockActiveOnly(true, true)).toBe(true)
  })
  test('so a folder reads active/total and is dimmed when nothing in it is active', () => {
    const narrowing = listNarrowed({ activeOnly: dockActiveOnly(false, false), query: '', valueFiltered: 10, total: 10 })
    expect(folderCountLabel(0, 87, narrowing)).toBe('0/87')
    expect(folderFold({ storedFolded: false, openedDimmed: false, narrowing, searching: false, shownCount: 0 }).dimmed).toBe(true)
  })
})
