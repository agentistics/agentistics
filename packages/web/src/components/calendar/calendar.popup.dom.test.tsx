/**
 * CALENDARIO.POPUP-VISIVEL (owner 2026-11-17): the detail popover opened partly off-screen depending
 * on the resolution. It must be 100% inside the viewport from 390 to 1920 wide, with the click near
 * every edge.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { brtDayStartMs, buildCalendar, filterCalendar } from '@agentistics/core'
import { DETAIL_MARGIN, placeDetail } from './placeDetail'

const NOW = Date.parse('2026-11-07T18:40:00.000Z')
void brtDayStartMs

const SIZES: Array<[number, number]> = [[390, 844], [768, 1024], [1024, 600], [1280, 720], [1280, 900], [1366, 640], [1920, 1080], [1920, 480]]
const POPUP_W = 330

describe('placeDetail — fully inside the viewport for every click', () => {
  for (const [vw, vh] of SIZES) {
    test(`${vw}×${vh}: a grid of click points, tall and short popovers`, () => {
      for (const h of [120, 300, 560, 2000]) {
        for (let x = 0; x <= vw; x += Math.max(1, Math.floor(vw / 24))) {
          for (let y = 0; y <= vh; y += Math.max(1, Math.floor(vh / 24))) {
            const p = placeDetail({ x, y }, { w: POPUP_W, h }, vw, vh)
            const shown = Math.min(h, p.maxHeight)
            expect(p.left).toBeGreaterThanOrEqual(DETAIL_MARGIN)
            expect(p.top).toBeGreaterThanOrEqual(DETAIL_MARGIN)
            expect(p.left + p.width).toBeLessThanOrEqual(vw - DETAIL_MARGIN)
            expect(p.top + shown).toBeLessThanOrEqual(vh - DETAIL_MARGIN)
          }
        }
      }
    })
  }
  test('the old rule overflowed: a click at the bottom with a 560px popover (regression pin)', () => {
    const p = placeDetail({ x: 600, y: 760 }, { w: 330, h: 560 }, 1280, 800)
    expect(p.top + 560).toBeLessThanOrEqual(800 - DETAIL_MARGIN)
    // The old formula: y = min(760 - 30, 800 - 380) = 420 → bottom 980 > 800.
  })
  test('flips to the left of the click at the right edge', () => {
    const p = placeDetail({ x: 1270, y: 300 }, { w: 330, h: 300 }, 1280, 800)
    expect(p.flipped).toBe(true)
    expect(p.left + p.width).toBeLessThanOrEqual(1270)
  })
  test('opens to the right of the click when it fits', () => {
    const p = placeDetail({ x: 200, y: 300 }, { w: 330, h: 300 }, 1280, 800)
    expect(p).toMatchObject({ left: 214, top: 270, flipped: false })
  })
  test('no anchor (keyboard) is centred and visible', () => {
    const p = placeDetail(null, { w: 330, h: 560 }, 1280, 800)
    expect(p.top + 560).toBeLessThanOrEqual(792)
  })
})

describe('CalendarDetail in the DOM', () => {
  let root: Root | undefined
  let createRoot: typeof import('react-dom/client').createRoot
  let Detail: typeof import('./CalendarDetail').CalendarDetail
  const view = filterCalendar(buildCalendar({
    nowMs: NOW,
    lives: [{
      key: 't/a', taskId: 't', taskTitle: 'Esteira', subtaskId: 'a', title: 'Peça a', stage: 'qa', startedAtMs: NOW - 1, stageSinceMs: NOW - 1,
      harnesses: ['claude'], models: ['opus'], trail: [], eta: { kind: 'none', reason: 'no-history' }, stageEta: { kind: 'none' },
      publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
    } as never],
    records: [], tasks: [{ id: 't', title: 'Esteira', status: 'in_progress', priority: 'high' } as never], subtasks: [], resets: [],
  }), {})

  beforeAll(async () => {
    GlobalRegistrator.register({ width: 1280, height: 720 })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    createRoot = (await import('react-dom/client')).createRoot
    Detail = (await import('./CalendarDetail')).CalendarDetail
  })
  afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
  afterAll(async () => GlobalRegistrator.unregister())

  const open = async (vw: number, vh: number, anchor: { x: number; y: number } | null, height: number) => {
    ;(window as unknown as { innerWidth: number; innerHeight: number }).innerWidth = vw
    ;(window as unknown as { innerWidth: number; innerHeight: number }).innerHeight = vh
    const proto = HTMLElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return height } })
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(Detail, {
        selection: { kind: 'piece', key: view.pieces[0]!.key }, anchor, pieces: view.pieces, versions: [], marks: [], nowMs: NOW, pt: true, isMobile: false,
        onClose: () => {}, onSelect: () => {},
      })))
    })
    if (original) Object.defineProperty(proto, 'offsetHeight', original); else delete (proto as unknown as Record<string, unknown>).offsetHeight
    const el = document.querySelector('[data-cal-detail]') as HTMLElement
    return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), el }
  }

  for (const [vw, vh] of [[1280, 720], [1366, 640], [1920, 1080], [1024, 600]] as const) {
    for (const [name, ax, ay] of [['top-left', 2, 2], ['top-right', vw - 2, 2], ['bottom-left', 2, vh - 2], ['bottom-right', vw - 2, vh - 2], ['centre', vw / 2, vh / 2]] as const) {
      test(`${vw}×${vh} click at ${name}: the measured popover is inside the viewport`, async () => {
        const h = 500
        const r = await open(vw, vh, { x: ax, y: ay }, h)
        expect(r.left).toBeGreaterThanOrEqual(8)
        expect(r.top).toBeGreaterThanOrEqual(8)
        expect(r.left + r.width).toBeLessThanOrEqual(vw - 8)
        expect(r.top + Math.min(h, vh - 16)).toBeLessThanOrEqual(vh - 8)
      })
    }
  }

  test('a popover taller than the window is capped to it (scrolls inside), never hangs out', async () => {
    const r = await open(1280, 400, { x: 600, y: 390 }, 560)
    expect(r.top).toBeGreaterThanOrEqual(8)
    expect(parseFloat(r.el.style.maxHeight)).toBeLessThanOrEqual(400 - 16)
  })

  test('the phone keeps the bottom sheet (full width, bottom 0)', async () => {
    ;(window as unknown as { innerWidth: number }).innerWidth = 390
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(Detail, {
        selection: { kind: 'piece', key: view.pieces[0]!.key }, anchor: { x: 380, y: 800 }, pieces: view.pieces, versions: [], marks: [], nowMs: NOW, pt: true, isMobile: true,
        onClose: () => {}, onSelect: () => {},
      })))
    })
    const el = document.querySelector('[data-cal-detail]') as HTMLElement
    expect(el.style.left).toBe('0px')
    expect(el.style.right).toBe('0px')
    expect(el.style.bottom).toBe('0px')
  })
})
