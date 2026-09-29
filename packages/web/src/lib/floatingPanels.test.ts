import { describe, expect, test } from 'bun:test'
import {
  bringToFront, clampRect, defaultRect, dockOut, EMPTY_BOOK, floatIn, MAX_SESSIONS, MIN_FLOAT_SIZE,
  moveRect, parseBook, resizeRect, restoreRect, stackOrder, topZ, writeEntry,
  type FloatingSet,
} from './floatingPanels'
import {
  applyFloating, bottomPanels, dockedShowsTarget, EMPTY_SLOT_LAYOUT, hiddenPanels, isPanelShown,
  openPanel, railPanels, setPlacement,
} from './panelSlots'

const AREA = { w: 1000, h: 700 }

describe('clampRect', () => {
  test('a rect inside the area is untouched', () => {
    expect(clampRect({ x: 10, y: 20, w: 400, h: 300 }, AREA)).toEqual({ x: 10, y: 20, w: 400, h: 300 })
  })
  test('a rect past the right/bottom edge is pulled back inside', () => {
    expect(clampRect({ x: 900, y: 650, w: 400, h: 300 }, AREA)).toEqual({ x: 600, y: 400, w: 400, h: 300 })
  })
  test('a negative position clamps to the origin', () => {
    expect(clampRect({ x: -50, y: -9, w: 400, h: 300 }, AREA)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })
  test('a window larger than the area shrinks to it', () => {
    expect(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, AREA)).toEqual({ x: 0, y: 0, w: 1000, h: 700 })
  })
  test('never below the minimum size, even in a tiny area — the top-left stays reachable', () => {
    const r = clampRect({ x: 50, y: 50, w: 10, h: 10 }, { w: 200, h: 100 })
    expect(r.w).toBe(MIN_FLOAT_SIZE.w)
    expect(r.h).toBe(MIN_FLOAT_SIZE.h)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
  })
  test('non-finite input never leaks out', () => {
    const r = clampRect({ x: Number.NaN, y: Infinity, w: Number.NaN, h: 300 }, AREA)
    for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('moveRect', () => {
  test('translates and clamps', () => {
    const start = { x: 100, y: 100, w: 400, h: 300 }
    expect(moveRect(start, 50, -20, AREA)).toEqual({ x: 150, y: 80, w: 400, h: 300 })
    expect(moveRect(start, 5000, 5000, AREA)).toEqual({ x: 600, y: 400, w: 400, h: 300 })
    expect(moveRect(start, -5000, -5000, AREA)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })
})

describe('resizeRect', () => {
  const start = { x: 200, y: 200, w: 400, h: 300 }
  test('east/south grow the size and keep the origin', () => {
    expect(resizeRect(start, 'se', 100, 50, AREA)).toEqual({ x: 200, y: 200, w: 500, h: 350 })
  })
  test('east/south stop at the area edge', () => {
    expect(resizeRect(start, 'se', 5000, 5000, AREA)).toEqual({ x: 200, y: 200, w: 800, h: 500 })
  })
  test('west/north move the origin and keep the opposite edge', () => {
    const r = resizeRect(start, 'nw', -50, -30, AREA)
    expect(r).toEqual({ x: 150, y: 170, w: 450, h: 330 })
    expect(r.x + r.w).toBe(start.x + start.w)
    expect(r.y + r.h).toBe(start.y + start.h)
  })
  test('west/north stop at the area origin', () => {
    expect(resizeRect(start, 'nw', -5000, -5000, AREA)).toEqual({ x: 0, y: 0, w: 600, h: 500 })
  })
  test('shrinking stops at the minimum size and the opposite edge does not move', () => {
    const east = resizeRect(start, 'e', -5000, 0, AREA)
    expect(east.w).toBe(MIN_FLOAT_SIZE.w)
    expect(east.x).toBe(200)
    const west = resizeRect(start, 'w', 5000, 0, AREA)
    expect(west.w).toBe(MIN_FLOAT_SIZE.w)
    expect(west.x + west.w).toBe(start.x + start.w)
    const north = resizeRect(start, 'n', 0, 5000, AREA)
    expect(north.h).toBe(MIN_FLOAT_SIZE.h)
    expect(north.y + north.h).toBe(start.y + start.h)
  })
  test('measured from the start, so a detour past the floor does not drift', () => {
    const back = resizeRect(start, 'e', 10, 0, AREA)
    expect(back).toEqual(resizeRect(start, 'e', 10, 0, AREA))
    expect(back.w).toBe(410)
  })
})

describe('z-order', () => {
  const set: FloatingSet = {
    cli: { x: 0, y: 0, w: 300, h: 200, z: 1 },
    tasks: { x: 0, y: 0, w: 300, h: 200, z: 2 },
  }
  test('bringToFront puts a window above every other', () => {
    const next = bringToFront(set, 'cli')
    expect(next.cli!.z).toBe(3)
    expect(stackOrder(next)).toEqual(['tasks', 'cli'])
  })
  test('the window already on top is a no-op (same object)', () => {
    expect(bringToFront(set, 'tasks')).toBe(set)
  })
  test('an unknown panel is a no-op', () => {
    expect(bringToFront(set, 'studio')).toBe(set)
  })
  test('topZ of an empty set is 0', () => {
    expect(topZ({})).toBe(0)
  })
})

describe('floatIn / dockOut', () => {
  test('floating opens on top, cascaded from the previous window', () => {
    const a = floatIn({}, 'cli', AREA)
    const b = floatIn(a, 'tasks', AREA)
    expect(b.tasks!.z).toBeGreaterThan(b.cli!.z)
    expect(b.tasks!.x).toBeGreaterThan(b.cli!.x)
  })
  test('floating a panel that already floats only raises it', () => {
    const a = floatIn(floatIn({}, 'cli', AREA), 'tasks', AREA)
    const again = floatIn(a, 'cli', AREA)
    expect(again.cli!.x).toBe(a.cli!.x)
    expect(again.cli!.z).toBeGreaterThan(a.tasks!.z)
  })
  test('docking removes it, and docking what does not float is a no-op', () => {
    const a = floatIn({}, 'cli', AREA)
    expect(dockOut(a, 'cli')).toEqual({})
    expect(dockOut(a, 'studio')).toBe(a)
  })
  test('the default rect fits the area', () => {
    const r = defaultRect({ w: 400, h: 300 }, 0)
    expect(r.x + r.w).toBeLessThanOrEqual(400)
    expect(r.y + r.h).toBeLessThanOrEqual(300)
  })
})

describe('restoreRect', () => {
  test('a window left off a narrower area comes back inside, keeping its z', () => {
    const stored = { x: 1500, y: 900, w: 500, h: 400, z: 7 }
    expect(restoreRect(stored, AREA)).toEqual({ x: 500, y: 300, w: 500, h: 400, z: 7 })
  })
  test('the stored value itself is not touched', () => {
    const stored = { x: 1500, y: 900, w: 500, h: 400, z: 7 }
    restoreRect(stored, AREA)
    expect(stored.x).toBe(1500)
  })
})

describe('persistence', () => {
  test('round-trips through JSON', () => {
    const book = writeEntry(EMPTY_BOOK, 'conv-1', { cli: { x: 1, y: 2, w: 300, h: 200, z: 1 } }, 10)
    expect(parseBook(JSON.stringify(book))).toEqual(book)
  })
  test('garbage reads as empty, never throws', () => {
    expect(parseBook(null)).toEqual(EMPTY_BOOK)
    expect(parseBook('not json')).toEqual(EMPTY_BOOK)
    expect(parseBook('[]')).toEqual(EMPTY_BOOK)
    expect(parseBook('{"sessions":5}')).toEqual(EMPTY_BOOK)
  })
  test('a corrupt window or unknown panel is dropped alone', () => {
    const raw = JSON.stringify({
      v: 1,
      sessions: {
        a: { at: 1, windows: { cli: { x: 1, y: 1, w: 300, h: 200, z: 1 }, nope: { x: 1, y: 1, w: 1, h: 1, z: 1 }, tasks: { x: 'x' } } },
        b: { at: 2, windows: { tasks: { x: 1, y: 1, w: 0, h: 200, z: 1 } } },
      },
    })
    const book = parseBook(raw)
    expect(Object.keys(book.sessions)).toEqual(['a'])
    expect(Object.keys(book.sessions.a!.windows)).toEqual(['cli'])
  })
  test('an empty set forgets the session', () => {
    const book = writeEntry(EMPTY_BOOK, 'a', { cli: { x: 1, y: 1, w: 300, h: 200, z: 1 } }, 1)
    expect(writeEntry(book, 'a', {}, 2).sessions).toEqual({})
  })
  test('beyond MAX_SESSIONS the least recently touched are forgotten', () => {
    let book = EMPTY_BOOK
    const win = { cli: { x: 1, y: 1, w: 300, h: 200, z: 1 } }
    for (let i = 0; i < MAX_SESSIONS + 5; i++) book = writeEntry(book, `s${i}`, win, i)
    expect(Object.keys(book.sessions).length).toBe(MAX_SESSIONS)
    expect(book.sessions.s0).toBeUndefined()
    expect(book.sessions[`s${MAX_SESSIONS + 4}`]).toBeDefined()
  })
})

describe('applyFloating — a floating panel leaves its docked place', () => {
  test('it stops occupying its slot and leaves the rail/bottom lists; placement is untouched', () => {
    let layout = openPanel(EMPTY_SLOT_LAYOUT, 'tasks')
    layout = openPanel(layout, 'cli')
    const floated = applyFloating(layout, ['tasks', 'cli'])
    expect(isPanelShown(floated, 'tasks')).toBe(false)
    expect(isPanelShown(floated, 'cli')).toBe(false)
    expect(floated.bottomOpen).toBe(false)
    expect(railPanels(floated)).not.toContain('tasks')
    expect(bottomPanels(floated)).not.toContain('cli')
    expect(floated.placement.tasks).toBe('rail')
    expect(floated.placement.cli).toBe('bottom')
  })
  test('the docked terminal does not also draw a floating cli/shell', () => {
    const floated = applyFloating(EMPTY_SLOT_LAYOUT, ['shell'])
    expect(dockedShowsTarget(floated, 'shell')).toBe(false)
    expect(dockedShowsTarget(floated, 'cli')).toBe(true)
  })
  test('a floating panel is not listed as hidden either', () => {
    const hidden = setPlacement(EMPTY_SLOT_LAYOUT, 'gallery', 'hidden')
    expect(hiddenPanels(applyFloating(hidden, ['gallery']))).not.toContain('gallery')
  })
  test('nothing floating is the same object', () => {
    expect(applyFloating(EMPTY_SLOT_LAYOUT, [])).toBe(EMPTY_SLOT_LAYOUT)
  })
})
