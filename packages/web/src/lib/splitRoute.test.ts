import { describe, expect, test } from 'bun:test'
import { closePane, openBeside, openInPane, readSplitRoute, replaceInPane, splitHref, splitIdOf } from './splitRoute'

const q = (s: string) => new URLSearchParams(s)

describe('reading the split from the URL', () => {
  test('the split is ?split=, never the main session itself', () => {
    expect(splitIdOf(q('split=b'), 'a')).toBe('b')
    expect(splitIdOf(q('split=a'), 'a')).toBeNull()
    expect(splitIdOf(q(''), 'a')).toBeNull()
  })
  test('no main session means no split', () => {
    expect(readSplitRoute(undefined, q('split=b')).split).toBeNull()
  })
})

describe('where a gesture lands', () => {
  const both = { main: 'a', split: 'b', splitView: null }
  test('opening from the list goes into the ACTIVE pane', () => {
    expect(openInPane(both, 'c', 'split')).toEqual({ main: 'a', split: 'c', splitView: null })
    expect(openInPane(both, 'c', 'main')).toEqual({ main: 'c', split: 'b', splitView: null })
    expect(openInPane({ main: 'a', split: null, splitView: null }, 'c', 'split').main).toBe('c')
  })
  test('a session already on screen is never opened twice', () => {
    expect(openInPane(both, 'b', 'main')).toBe(both)
    expect(openBeside(both, 'a')).toBe(both)
  })
  test('open beside fills the split pane; with nothing open it becomes the main one', () => {
    expect(openBeside({ main: 'a', split: null, splitView: null }, 'b').split).toBe('b')
    expect(openBeside({ main: null, split: null, splitView: null }, 'b')).toEqual({ main: 'b', split: null, splitView: null })
  })
  test('closing the main pane promotes the split one', () => {
    expect(closePane({ ...both, splitView: 'terminal' }, 'main')).toEqual({ main: 'b', split: null, splitView: null })
    expect(closePane(both, 'split')).toEqual({ main: 'a', split: null, splitView: null })
    expect(closePane({ main: 'a', split: null, splitView: null }, 'main').main).toBeNull()
  })
  test('a reopen follows its own pane only', () => {
    expect(replaceInPane(both, 'split', 'b2')).toEqual({ main: 'a', split: 'b2', splitView: null })
    expect(replaceInPane(both, 'main', 'a2')).toEqual({ main: 'a2', split: 'b', splitView: null })
    expect(replaceInPane(both, 'main', 'b')).toEqual({ main: 'b', split: null, splitView: null })
  })
})

describe('splitHref', () => {
  test('keeps unrelated params, sets or clears the split', () => {
    expect(splitHref({ main: 'a', split: 'b', splitView: 'terminal' }, q('view=terminal'))).toBe('/sessions/a?view=terminal&split=b&splitView=terminal')
    expect(splitHref({ main: 'a', split: null, splitView: null }, q('split=b&splitView=terminal&view=terminal'))).toBe('/sessions/a?view=terminal')
    expect(splitHref({ main: null, split: null, splitView: null }, q('split=b'))).toBe('/sessions')
  })
})
