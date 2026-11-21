/** NAVEGADOR S5c r4 — a phone-shaped card gets a page with ITS aspect, so the frame fills it with no black bars. */
import { expect, test } from 'bun:test'
import { clampViewport, createViewportCast, MAX_PAGE_HEIGHT } from './browser-viewport'

const barsPx = (card: { w: number; h: number }) => {
  const v = clampViewport({ width: card.w, height: card.h, deviceScaleFactor: 2 })!
  // the frame is drawn with `object-fit: contain`: scale = min(card.w / page.w, card.h / page.h)
  const s = Math.min(card.w / v.width, card.h / v.height)
  return Math.max(Math.abs(card.w - v.width * s), Math.abs(card.h - v.height * s))
}

test('tall phones (aspect up to ~3) leave no bars: the page is raised, never cropped or squeezed', () => {
  for (const [w, h] of [[360, 800], [390, 844], [430, 932], [380, 900], [348, 707], [388, 646]] as Array<[number, number]>) {
    expect(barsPx({ w, h })).toBeLessThanOrEqual(1)
    expect(clampViewport({ width: w, height: h, deviceScaleFactor: 1 })!.width).toBeGreaterThanOrEqual(1024)
  }
})

test('the height ceiling is the one place left that can show a bar, and it is documented', () => {
  expect(MAX_PAGE_HEIGHT).toBeGreaterThanOrEqual(3200)
  // aspect 4 exceeds 3200/1024: the cap holds (bars are the stated limit there)
  expect(clampViewport({ width: 300, height: 1200, deviceScaleFactor: 1 })!.height).toBe(MAX_PAGE_HEIGHT)
})

test('the cast knows the page viewport the moment a start/resize is ASKED, not only when it lands', async () => {
  const cast = createViewportCast(async () => {})
  expect(cast.current()).toBeNull()
  const p = cast.start({ width: 818, height: 205, deviceScaleFactor: 1 })
  expect(cast.current()).toEqual({ w: 1596, h: 400 })
  await p
  void cast.resize({ width: 388, height: 646, deviceScaleFactor: 1 })
  expect(cast.current()!.w).toBe(1024)
  await cast.stop()
  expect(cast.current()).toBeNull()
})
