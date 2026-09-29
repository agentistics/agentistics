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
