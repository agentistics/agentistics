import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { enterTab } from '../../lib/sessionTabs'
import { getPrevActive, resetOpenTabsCache, setPrevActive, trackStripMount } from '../../lib/sessionTabsStore'

const src = readFileSync(new URL('./SessionTabStrip.tsx', import.meta.url), 'utf8')

beforeEach(() => resetOpenTabsCache())

test('the tabs list marks pins with the lucide Pin, not an emoji', () => {
  expect(src).not.toContain('📌')
  expect(src).toContain('pinned: true')
})

test('a strip remount keeps the anchor while another strip lives (split pane remounts per navigation)', () => {
  const main = trackStripMount()
  const a = trackStripMount()
  setPrevActive('split', { key: 'A', id: 'A' })
  a() // split strip unmounts for the remount
  const a2 = trackStripMount()
  expect(getPrevActive('split')).toEqual({ key: 'A', id: 'A' })
  a2(); main()
})

test('mount A, unmount, reset, mount C with [A,B]: C is placed by its own rule, not by a stale anchor', () => {
  const unmountA = trackStripMount()
  setPrevActive('main', { key: 'A', id: 'A' })
  unmountA() // last strip out
  resetOpenTabsCache()
  const unmountC = trackStripMount()
  const prev = getPrevActive('main')
  expect(prev).toBeNull()
  // Stale anchor would put C right after A ([A,C,B]); with none it is appended.
  expect(enterTab(['A', 'B'], 'C', prev, 'C', [])).toEqual(['A', 'B', 'C'])
  unmountC()
})

test('the last strip unmounting clears the anchors even without a store reset', () => {
  const u = trackStripMount()
  setPrevActive('main', { key: 'A', id: 'A' })
  u()
  expect(getPrevActive('main')).toBeNull()
})

test('desktop tabs have rounded tops and square bottoms, no full pill', () => {
  expect(src).toContain('borderRadius: 8')
  expect(src).toContain("'10px 10px 0 0'")
  expect(src).not.toContain('borderRadius: 999')
})

test('the row the top bar reserves is the strip\'s own height, built from the terms the strip draws with', async () => {
  const { TAB_STRIP_H, TAB_H, TABLIST_TOP_PAD } = await import('./SessionTabStrip')
  expect(TAB_STRIP_H).toBe(TAB_H + TABLIST_TOP_PAD)
  expect(TAB_STRIP_H).toBe(44)
})

test('App reserves exactly that, never a typed number (a short row let the strip cross the title divider)', () => {
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  expect(app).toMatch(/const TABS_ROW_H = TAB_STRIP_H\b/)
})
