/**
 * What this file can assert without a pointer or a portal: `treeMenuEntries`, the one piece of
 * logic in `TreeContextMenu.tsx` that decides anything. This repo has no jsdom/`@testing-library`
 * (see `ConnectionCard.test.tsx`'s own note), so a click on the rendered menu cannot be simulated —
 * which is exactly why that decision is its own exported, pure function.
 */
import { describe, expect, test } from 'bun:test'
import { nextMenuIndex, treeMenuEntries } from './TreeContextMenu'

describe('treeMenuEntries', () => {
  test('a file offers create/rename/move/copy/delete, in this order, with no mention and no copy-path by default', () => {
    const actions = treeMenuEntries('file', 'en', false, false).map(e => e.action)
    expect(actions).toEqual([
      'new-file', 'new-folder', 'rename', 'move', 'copy-relative-path', 'delete',
    ])
  })

  test('a folder says "Delete folder", naming what is about to go', () => {
    const entry = treeMenuEntries('dir', 'en', false, false).find(e => e.action === 'delete')!
    expect(entry.label).toBe('Delete folder')
  })

  test('a file says plain "Delete"', () => {
    const entry = treeMenuEntries('file', 'en', false, false).find(e => e.action === 'delete')!
    expect(entry.label).toBe('Delete')
  })

  test('mention is ABSENT by default — never a disabled row with no explanation', () => {
    const actions = treeMenuEntries('file', 'en', false, false).map(e => e.action)
    expect(actions).not.toContain('mention')
  })

  test('mention appears, second to last, when the caller supplies a handler', () => {
    const actions = treeMenuEntries('file', 'en', true, false).map(e => e.action)
    expect(actions.at(-2)).toBe('mention')
    expect(actions.at(-1)).toBe('delete')
  })

  test('copy-path is ABSENT by default and appears when the caller supplies it', () => {
    expect(treeMenuEntries('file', 'en', false, false).map(e => e.action)).not.toContain('copy-path')
    const withIt = treeMenuEntries('file', 'en', false, true).map(e => e.action)
    expect(withIt).toContain('copy-path')
    // Right after its sibling copy action.
    expect(withIt.indexOf('copy-path')).toBe(withIt.indexOf('copy-relative-path') + 1)
  })

  test('both optional rows together land between the copy actions and delete', () => {
    const actions = treeMenuEntries('file', 'en', true, true).map(e => e.action)
    expect(actions).toEqual([
      'new-file', 'new-folder', 'rename', 'move', 'copy-relative-path', 'copy-path', 'mention', 'delete',
    ])
  })

  test('every entry is worded in Portuguese too, and the two languages disagree on every label', () => {
    const en = treeMenuEntries('dir', 'en', true, true)
    const pt = treeMenuEntries('dir', 'pt', true, true)
    expect(en.length).toBe(pt.length)
    for (let i = 0; i < en.length; i++) {
      expect(en[i]!.action).toBe(pt[i]!.action)
      expect(en[i]!.label).not.toBe(pt[i]!.label)
    }
  })
})

/**
 * I4 (`session-w1c-tree-ops-review.md`): the menu was unreachable by keyboard — Shift+F10 opened it
 * but left focus on the row, ArrowDown did nothing, and Tab from the `⋯` button skipped past it to
 * the next row (the portal sits at the end of `<body>`, so nothing put focus inside the menu first).
 * `nextMenuIndex` is the roving-focus arithmetic behind the fix, pulled out so it is assertable
 * without a portal, a pointer, or a render at all — the DOM wiring around it (auto-focus on mount,
 * the Tab trap) is verified in a real browser per the brief.
 */
describe('nextMenuIndex', () => {
  test('ArrowDown/ArrowUp with nothing yet focused resolve to something useful, not nothing', () => {
    expect(nextMenuIndex('ArrowDown', -1, 5)).toBe(0)
    expect(nextMenuIndex('ArrowUp', -1, 5)).toBe(4)
  })

  test('ArrowDown advances and wraps past the last item', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0)
  })

  test('ArrowUp retreats and wraps past the first item', () => {
    expect(nextMenuIndex('ArrowUp', 2, 3)).toBe(1)
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2)
  })

  test('Home always answers the first item, End always the last, regardless of current', () => {
    expect(nextMenuIndex('Home', 4, 6)).toBe(0)
    expect(nextMenuIndex('Home', -1, 6)).toBe(0)
    expect(nextMenuIndex('End', 0, 6)).toBe(5)
    expect(nextMenuIndex('End', -1, 6)).toBe(5)
  })

  test('an empty menu answers -1 for every key — nothing for a caller to focus', () => {
    expect(nextMenuIndex('ArrowDown', -1, 0)).toBe(-1)
    expect(nextMenuIndex('Home', -1, 0)).toBe(-1)
  })

  test('a menu of one item stays on it for both arrow keys', () => {
    expect(nextMenuIndex('ArrowDown', 0, 1)).toBe(0)
    expect(nextMenuIndex('ArrowUp', 0, 1)).toBe(0)
  })
})
