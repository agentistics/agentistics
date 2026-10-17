import { describe, expect, test } from 'bun:test'
import {
  closeEnded, closeOthers, closeTab, closeToRight, enterTab, livePins, MAX_OPEN_TABS, openTab, ownsTabShortcut, reconcileTabs, parseTabs, pruneTabs,
  replaceTab, stepTab, stripOrder, tabAt,
} from './sessionTabs'

describe('stripOrder', () => {
  test('pins lead, then the open tabs in opening order, with no duplicates', () => {
    expect(stripOrder(['a', 'b', 'c'], ['c', 'x'])).toEqual(['c', 'x', 'a', 'b'])
  })
})

describe('openTab', () => {
  test('an already open tab is unchanged', () => {
    expect(openTab(['a', 'b'], 'a', 'b', [])).toEqual(['a', 'b'])
  })
  test('a pinned session is always a tab, so it is never added to the open list', () => {
    expect(openTab(['a'], 'p', 'a', ['p'])).toEqual(['a'])
  })
  test('a new tab lands right after the active one', () => {
    expect(openTab(['a', 'b', 'c'], 'n', 'a', [])).toEqual(['a', 'n', 'b', 'c'])
  })
  test('from a pinned tab the new tab leads the unpinned segment', () => {
    expect(openTab(['b', 'c'], 'd', 'a', ['a'])).toEqual(['d', 'b', 'c'])
    expect(stripOrder(openTab(['b', 'c'], 'd', 'a', ['a']), ['a'])).toEqual(['a', 'd', 'b', 'c'])
    expect(openTab([], 'd', 'a', ['a'])).toEqual(['d'])
  })
  test('with no active tab it is appended', () => {
    expect(openTab(['a', 'b'], 'n', null, [])).toEqual(['a', 'b', 'n'])
  })
  test('past the cap the oldest unpinned, non-active tab goes — never a pinned one', () => {
    const open = Array.from({ length: MAX_OPEN_TABS }, (_, i) => `t${i}`)
    const next = openTab(open, 'new', 't0', [])
    expect(next).toHaveLength(MAX_OPEN_TABS)
    expect(next).toContain('new')
    expect(next).toContain('t0')
    expect(next).not.toContain('t1')
  })
  test('pins do not count toward the cap and are never dropped', () => {
    const pins = ['p1', 'p2']
    const open = ['p1', ...Array.from({ length: MAX_OPEN_TABS }, (_, i) => `t${i}`)]
    const next = openTab(open, 'new', 'new', pins, MAX_OPEN_TABS)
    expect(next).toContain('p1')
  })
})

describe('closeTab', () => {
  const pins = ['p']
  test('closing a non-active tab keeps the active one', () => {
    expect(closeTab(['p', 'a', 'b'], 'b', 'a', pins)).toEqual({ open: ['a'], active: 'a' })
  })
  test('closing the active tab activates the right neighbour', () => {
    expect(closeTab(['p', 'a', 'b', 'c'], 'b', 'b', pins)).toEqual({ open: ['a', 'c'], active: 'c' })
  })
  test('closing the last one falls back to the left neighbour', () => {
    expect(closeTab(['p', 'a', 'b'], 'b', 'b', pins)).toEqual({ open: ['a'], active: 'a' })
  })
  test('closing the only tab leaves none', () => {
    expect(closeTab(['a'], 'a', 'a', [])).toEqual({ open: [], active: null })
  })
  test('a pinned tab cannot be closed', () => {
    expect(closeTab(['p', 'a'], 'p', 'p', pins)).toEqual({ open: ['a'], active: 'p' })
  })
})

describe('replaceTab (a reopen minted a new key)', () => {
  test('the new key takes the old one’s place', () => {
    expect(replaceTab(['a', 'old', 'b'], 'old', 'new')).toEqual(['a', 'new', 'b'])
  })
  test('if the new key is already open the old one just goes', () => {
    expect(replaceTab(['a', 'old', 'new'], 'old', 'new')).toEqual(['a', 'new'])
  })
  test('an old key that was not a tab changes nothing', () => {
    expect(replaceTab(['a'], 'old', 'new')).toEqual(['a'])
  })
})

describe('pruneTabs', () => {
  test('drops what no fleet row resolves; ended rows are still known, so they stay', () => {
    expect(pruneTabs(['live', 'ended', 'gone'], new Set(['live', 'ended']))).toEqual(['live', 'ended'])
  })
})

describe('bulk closes', () => {
  test('closeOthers keeps only the chosen unpinned tab', () => {
    expect(closeOthers(['a', 'b', 'c'], 'b')).toEqual(['b'])
  })
  test('closeToRight keeps everything up to and including the tab, unpinned only', () => {
    expect(closeToRight(['p', 'a', 'b', 'c'], 'a', ['p'])).toEqual(['a'])
  })
  test('closeEnded drops the ended ones', () => {
    expect(closeEnded(['a', 'b', 'c'], id => id === 'b')).toEqual(['a', 'c'])
  })
})

describe('keyboard', () => {
  const order = ['a', 'b', 'c']
  test('stepTab wraps both ways', () => {
    expect(stepTab(order, 'c', 1)).toBe('a')
    expect(stepTab(order, 'a', -1)).toBe('c')
    expect(stepTab(order, 'b', 1)).toBe('c')
  })
  test('stepTab with no active tab starts at the edge; with no tabs is null', () => {
    expect(stepTab(order, null, 1)).toBe('a')
    expect(stepTab([], null, 1)).toBeNull()
  })
  test('tabAt is 1-based and null past the end', () => {
    expect(tabAt(order, 1)).toBe('a')
    expect(tabAt(order, 4)).toBeNull()
  })
})

describe('parseTabs', () => {
  test('junk is no tabs; duplicates and non-strings are dropped', () => {
    expect(parseTabs('x')).toEqual([])
    expect(parseTabs(null)).toEqual([])
    expect(parseTabs(['a', 3, '', 'a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('enterTab', () => {
  test('a new session opens right after the tab it came from, not at the end', () => {
    expect(enterTab(['a', 'b'], 'c', { key: 'a', id: 'a' }, 'c', [])).toEqual(['a', 'c', 'b'])
  })
  test('the same session discovering its conversation REPLACES its old tab (no duplicate)', () => {
    expect(enterTab(['x', 'm1', 'y'], 'conv-1', { key: 'm1', id: 'm1' }, 'm1', [])).toEqual(['x', 'conv-1', 'y'])
  })
  test('unpinning the open session adds its tab back', () => {
    expect(enterTab(['a'], 'p', { key: 'p', id: 'p' }, 'p', [])).toEqual(['a', 'p'])
  })
  test('the cap never drops the tab just left', () => {
    const open = Array.from({ length: MAX_OPEN_TABS }, (_, i) => `t${i}`)
    const next = enterTab(open, 'new', { key: 't5', id: 't5' }, 'new', [])
    expect(next).toContain('t5')
    expect(next).toContain('new')
  })
})

describe('reconcileTabs', () => {
  test('an old id tab whose row now has a conversation key is migrated in place and deduped', () => {
    const rows = [{ id: 'm1', key: 'conv-1' }, { id: 'm2', key: 'm2' }]
    expect(reconcileTabs(['m1', 'm2', 'conv-1'], rows, 'conv-1')).toEqual(['conv-1', 'm2'])
  })
  test('what no row resolves goes, but the active key stays', () => {
    expect(reconcileTabs(['gone', 'a'], [{ id: 'a', key: 'a' }], 'new')).toEqual(['a'])
    expect(reconcileTabs(['new'], [{ id: 'a', key: 'a' }], 'new')).toEqual(['new'])
  })
  test('applied after an open in ONE update, the open tab survives (no lost write)', () => {
    let store: string[] = ['dead']
    const update = (fn: (c: string[]) => string[]) => { store = fn(store) }
    update(cur => enterTab(cur, 'fresh', null, 'fresh', []))
    update(cur => reconcileTabs(cur, [{ id: 'fresh', key: 'fresh' }], 'fresh'))
    expect(store).toEqual(['fresh'])
  })
})

describe('livePins', () => {
  test('a pin whose session left the fleet is not a tab; before the fleet is known all stand', () => {
    expect(livePins(['a', 'gone'], new Set(['a']))).toEqual(['a'])
    expect(livePins(['a', 'gone'], null)).toEqual(['a', 'gone'])
  })
})

describe('ownsTabShortcut', () => {
  test('only the active pane acts, and never on an already-handled key', () => {
    expect(ownsTabShortcut('main', 'main', false)).toBe(true)
    expect(ownsTabShortcut('split', 'main', false)).toBe(false)
    expect(ownsTabShortcut('main', 'main', true)).toBe(false)
  })
})
