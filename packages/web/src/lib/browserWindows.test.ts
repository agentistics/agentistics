import { describe, expect, test } from 'bun:test'
import {
  A1_WINDOW, B1_WINDOW, EMPTY_BROWSER_WINDOWS, choiceOf, dockBrowser, floatBrowser, focusBrowser, geometryOf, getBrowserWindows,
  isBrowserWindowId, managedIdOf, minimizeBrowser, mobileWindowGeometry, parseBrowserWindows, placeBrowser, placeOf, resetBrowserWindows,
  restoreBrowser, sessionWindowId, setBrowserFull, subscribeBrowserWindows, updateBrowserWindows, type BrowserWindowsState,
} from './browserWindows'

const VP = { w: 1280, h: 800 }
const A = sessionWindowId('m1')

describe('the one-place rule', () => {
  test('a browser with no window is docked; floating it puts it in a window', () => {
    expect(placeOf(EMPTY_BROWSER_WINDOWS, A)).toBe('docked')
    const s = floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP, 'Testar login da loja')
    expect(placeOf(s, A)).toBe('floating')
    expect(placeOf(s, 'personal')).toBe('docked')
  })

  test('a MINIMIZED window still owns its browser: the card/panel never takes it back by itself', () => {
    const s = minimizeBrowser(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), A)
    expect(placeOf(s, A)).toBe('minimized')
  })

  test('floating twice never opens a second window for the same browser — it raises and restores the one there is', () => {
    let s = floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP)
    s = floatBrowser(s, 'personal', VP)
    s = minimizeBrowser(s, A)
    s = floatBrowser(s, A, VP)
    expect(s.windows.filter(w => w.id === A)).toHaveLength(1)
    const a = s.windows.find(w => w.id === A)!
    expect(a.minimized).toBe(false)
    expect(a.z).toBeGreaterThan(s.windows.find(w => w.id === 'personal')!.z)
  })

  test('"Voltar" removes the window: the browser is back in its card/panel', () => {
    const s = dockBrowser(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), A)
    expect(placeOf(s, A)).toBe('docked')
    expect(dockBrowser(EMPTY_BROWSER_WINDOWS, A)).toBe(EMPTY_BROWSER_WINDOWS)
  })
})

describe('windows', () => {
  test('the prototype sizes: A1 580×420, B1 560×420, below the top bar', () => {
    const s = floatBrowser(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), 'personal', VP)
    const [a, b] = s.windows
    expect({ w: a!.w, h: a!.h }).toEqual(A1_WINDOW)
    expect({ w: b!.w, h: b!.h }).toEqual(B1_WINDOW)
    expect(a!.y).toBeGreaterThanOrEqual(64)
    expect(b!.x).not.toBe(a!.x) // cascaded, never exactly stacked
  })

  test('restore brings a minimized window back to the front', () => {
    let s = floatBrowser(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), 'personal', VP)
    s = minimizeBrowser(s, A)
    s = restoreBrowser(s, A)
    expect(placeOf(s, A)).toBe('floating')
    expect(s.windows.find(w => w.id === A)!.z).toBe(Math.max(...s.windows.map(w => w.z)))
  })

  test('minimizing leaves full screen; full screen is only for an open window', () => {
    let s = setBrowserFull(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), A, true)
    expect(s.windows[0]!.full).toBe(true)
    s = minimizeBrowser(s, A)
    expect(s.windows[0]!.full).toBe(false)
    expect(setBrowserFull(s, A, true)).toBe(s)
  })

  test('focus raises an open window and is a no-op for the front one', () => {
    let s = floatBrowser(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), 'personal', VP)
    expect(focusBrowser(s, 'personal')).toBe(s)
    s = focusBrowser(s, A)
    expect(s.windows.find(w => w.id === A)!.z).toBeGreaterThan(s.windows.find(w => w.id === 'personal')!.z)
  })

  test('the first window opens at the prototype\'s x=400 (A1 and B1) at 1280', () => {
    expect(floatBrowser(EMPTY_BROWSER_WINDOWS, A, { w: 1280, h: 800 }).windows[0]!.x).toBe(400)
    expect(floatBrowser(EMPTY_BROWSER_WINDOWS, 'personal', { w: 1280, h: 800 }).windows[0]!.x).toBe(400)
  })

  test('placing keeps the header on screen (nayDock.placeWindow rule)', () => {
    const s = placeBrowser(floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP), A, { x: 5000, y: -300, w: 10 }, VP)
    const w = s.windows[0]!
    expect(w.x).toBeLessThanOrEqual(VP.w - 80)
    expect(w.y).toBe(0)
    expect(w.w).toBe(320)
  })

  test('a phone draws the window almost full width (8px each side, 84px down)', () => {
    expect(mobileWindowGeometry({ w: 390, h: 844 })).toEqual({ x: 8, y: 84, w: 374, h: 380 })
  })

  test('ids', () => {
    expect(managedIdOf(A)).toBe('m1')
    expect(managedIdOf('personal')).toBeNull()
    expect(isBrowserWindowId('personal')).toBe(true)
    expect(isBrowserWindowId('s:')).toBe(false)
    expect(isBrowserWindowId('x:1')).toBe(false)
  })
})

describe('persistence', () => {
  test('the choice and the geometry round-trip; full screen is never stored', () => {
    let s = floatBrowser(EMPTY_BROWSER_WINDOWS, A, VP, 'Loja')
    s = placeBrowser(s, A, { x: 300, y: 120 }, VP)
    s = setBrowserFull(minimizeBrowser(floatBrowser(s, 'personal', VP), 'personal'), A, true)
    const back = parseBrowserWindows(JSON.parse(JSON.stringify(choiceOf(s))), JSON.parse(JSON.stringify(geometryOf(s))), VP)
    expect(back.windows.map(w => ({ ...w, full: false }))).toEqual(s.windows.map(w => ({ ...w, full: false })))
    expect(back.windows.every(w => !w.full)).toBe(true)
    expect(JSON.stringify(choiceOf(s))).not.toContain('"x"')
  })

  test('the return page round-trips, and only a Sessions page is accepted as one', () => {
    const s = floatBrowser(EMPTY_BROWSER_WINDOWS, 'personal', VP, undefined, '/sessions/abc')
    expect(parseBrowserWindows(choiceOf(s), geometryOf(s), VP).windows[0]!.from).toBe('/sessions/abc')
    expect(floatBrowser(EMPTY_BROWSER_WINDOWS, 'personal', VP, undefined, 'https://evil.example').windows[0]!.from).toBeUndefined()
    expect(floatBrowser(EMPTY_BROWSER_WINDOWS, 'personal', VP, undefined, '/vault').windows[0]!.from).toBeUndefined()
    expect(parseBrowserWindows({ windows: [{ id: 'personal', from: '//evil.example' }] }, null, VP).windows[0]!.from).toBeUndefined()
  })

  test('malformed stored values are dropped, never repaired into a window', () => {
    const s = parseBrowserWindows({ windows: [null, { id: 'evil' }, { id: 's:a', minimized: 'yes' }, { id: 's:a' }] }, 'nope', VP)
    expect(s.windows.map(w => w.id)).toEqual(['s:a'])
    expect(s.windows[0]!.minimized).toBe(false)
    expect(parseBrowserWindows(null, null, VP)).toEqual(EMPTY_BROWSER_WINDOWS)
  })
})

describe('the store (survives navigation: it lives outside every page)', () => {
  test('a page that unmounts does not take the window with it; subscribers hear every change', () => {
    resetBrowserWindows()
    let heard = 0
    const off = subscribeBrowserWindows(() => { heard++ })
    updateBrowserWindows((s, vp) => floatBrowser(s, A, vp, 'Loja'))
    off() // the Sessions page unmounts (navigation to Tarefas)
    expect(placeOf(getBrowserWindows(), A)).toBe('floating')
    const again = subscribeBrowserWindows(() => { heard++ }) // Uso mounts
    updateBrowserWindows(s => minimizeBrowser(s, A))
    expect(placeOf(getBrowserWindows(), A)).toBe('minimized')
    expect(heard).toBe(2)
    again()
    resetBrowserWindows()
  })

  test('a step that changes nothing notifies nobody', () => {
    resetBrowserWindows()
    let heard = 0
    const off = subscribeBrowserWindows(() => { heard++ })
    updateBrowserWindows(s => dockBrowser(s, A))
    expect(heard).toBe(0)
    off()
  })

  test('state shape', () => {
    const s: BrowserWindowsState = floatBrowser(EMPTY_BROWSER_WINDOWS, 'personal', VP)
    expect(s.windows[0]!.title).toBeUndefined()
  })
})
