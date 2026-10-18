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

test('VS Code classic tabs: flush, separated, active merged with a top accent line', () => {
  expect(src).not.toContain('borderRadius: 999')
  expect(src).not.toContain('borderRadius: 10')
  expect(src).toContain("borderRight: '1px solid var(--border-subtle)'")
  expect(src).toContain("boxShadow: active ? 'inset 0 1px 0 var(--anthropic-orange)'")
})

test('needs-attention tabs carry no orange bottom inset (the status dot says it)', () => {
  expect(src).not.toContain('inset 0 -2px 0')
})

test('titles stay on one line and fade out instead of an ellipsis', () => {
  expect(src).toContain("whiteSpace: 'nowrap'")
  expect(src).not.toContain("whiteSpace: 'normal'")
  expect(src).not.toContain('textOverflow')
  expect(src).toContain('maskImage: TITLE_FADE')
})
