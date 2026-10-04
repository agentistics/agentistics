import { describe, expect, it } from 'bun:test'

import {
  bodyHeight,
  CHROME_ROWS,
  CHROME_ROWS_AROUND,
  clampFocus,
  PANE_ORDER,
  resolveDigit,
  resolveFocusKey,
  resolveListKey,
  resolveScrollKey,
  resolveTabKey,
  resolveTailKey,
  scrollBy,
  scrollTailBy,
  windowOffset,
  type NavKey,
  type PaneId,
} from './nav'
import { TAB_ORDER } from './types'

const key = (k: Partial<NavKey>): NavKey => ({ input: '', ...k })

const FIRST = TAB_ORDER[0]!
const SECOND = TAB_ORDER[1]!
const LAST = TAB_ORDER[TAB_ORDER.length - 1]!

describe('resolveTabKey', () => {
  it('moves with the arrows', () => {
    expect(resolveTabKey(key({ rightArrow: true }), FIRST)).toBe(SECOND)
    expect(resolveTabKey(key({ leftArrow: true }), SECOND)).toBe(FIRST)
  })

  it('moves with the BRACKETS even where a screen has claimed the arrows', () => {
    // The escape hatch that lets a screen own its own arrows. Without it, claiming them is a screen
    // nobody can leave — and the sessions cockpit, whose list is read with the arrows, claims them
    // permanently.
    expect(resolveTabKey(key({ input: ']' }), FIRST, false)).toBe(SECOND)
    expect(resolveTabKey(key({ input: '[' }), SECOND, false)).toBe(FIRST)
    expect(resolveTabKey(key({ input: ']' }), FIRST)).toBe(SECOND)
  })

  it('answers no digit at all — the screens gave them back when the numbered strip went away', () => {
    // They belong to the screens' own lists now: the log viewer's three sources are numbered ON
    // screen, and `2` there used to switch the source AND leave the screen.
    for (let n = 0; n <= 9; n++) expect(resolveTabKey(key({ input: String(n) }), FIRST)).toBeNull()
  })

  it('no longer answers tab — that key belongs to the cockpit panes now', () => {
    expect(resolveTabKey(key({ tab: true }), FIRST)).toBeNull()
    expect(resolveTabKey(key({ tab: true, shift: true }), SECOND)).toBeNull()
  })

  it('surrenders the arrows to a pane that has claimed them, and then answers nothing', () => {
    // The cockpit's action row is a horizontal list. While it has focus the screens are unreachable
    // BY DESIGN — and the footer stops advertising `←→ screens` for exactly that long, which is why
    // the row's own hint leads with the way back out.
    expect(resolveTabKey(key({ rightArrow: true }), FIRST, false)).toBeNull()
    expect(resolveTabKey(key({ leftArrow: true }), SECOND, false)).toBeNull()
    expect(resolveTabKey(key({ input: '3' }), FIRST, false)).toBeNull()
  })

  it('wraps at both ends', () => {
    expect(resolveTabKey(key({ rightArrow: true }), LAST)).toBe(FIRST)
    expect(resolveTabKey(key({ leftArrow: true }), FIRST)).toBe(LAST)
  })

  it('walks the whole strip back to where it started', () => {
    let tab = FIRST
    for (let i = 0; i < TAB_ORDER.length; i++) tab = resolveTabKey(key({ rightArrow: true }), tab)!
    expect(tab).toBe(FIRST)
  })

  it('returns null for a key the screen switcher does not own', () => {
    expect(resolveTabKey(key({ input: 'x' }), FIRST)).toBeNull()
    expect(resolveTabKey(key({ upArrow: true }), FIRST)).toBeNull()
    expect(resolveTabKey(key({ downArrow: true }), FIRST)).toBeNull()
    expect(resolveTabKey(key({ return: true }), FIRST)).toBeNull()
    expect(resolveTabKey(key({ escape: true }), FIRST)).toBeNull()
    // shift alone must not shift screens, or capital letters would move the bar.
    expect(resolveTabKey(key({ shift: true, input: 'G' }), FIRST)).toBeNull()
  })
})

describe('PANE_ORDER', () => {
  it('has no log pane — logs belong to the Logs screen', () => {
    // The cockpit's log pane was a worse copy of a full screen one keypress away, and it was what
    // kept the detail pane in a column too narrow to state a URL. `tab` now cycles three regions.
    expect(PANE_ORDER).toEqual(['services', 'config', 'actions'])
    expect(PANE_ORDER).not.toContain('log' as PaneId)
  })
})

describe('resolveFocusKey', () => {
  const all = PANE_ORDER

  it('cycles the panes forward on tab and backward on shift+tab', () => {
    expect(resolveFocusKey(key({ tab: true }), 'services', all)).toBe('config')
    expect(resolveFocusKey(key({ tab: true, shift: true }), 'config', all)).toBe('services')
  })

  it('wraps at both ends', () => {
    expect(resolveFocusKey(key({ tab: true }), 'actions', all)).toBe('services')
    expect(resolveFocusKey(key({ tab: true, shift: true }), 'services', all)).toBe('actions')
  })

  it('only ever lands on a pane the layout actually drew', () => {
    const drawn: PaneId[] = ['services', 'actions']
    let focus: PaneId = 'services'
    for (let i = 0; i < 6; i++) {
      focus = resolveFocusKey(key({ tab: true }), focus, drawn)!
      expect(drawn).toContain(focus)
    }
  })

  it('lands on the first drawn pane when the current focus no longer exists', () => {
    expect(resolveFocusKey(key({ tab: true }), 'actions', ['services', 'config'])).toBe('services')
  })

  it('answers nothing for any key that is not tab, and for a layout with no panes', () => {
    expect(resolveFocusKey(key({ rightArrow: true }), 'services', all)).toBeNull()
    expect(resolveFocusKey(key({ input: 'j' }), 'services', all)).toBeNull()
    expect(resolveFocusKey(key({ tab: true }), 'services', [])).toBeNull()
  })
})

describe('clampFocus', () => {
  it('leaves a focus that is still on screen alone', () => {
    expect(clampFocus('actions', PANE_ORDER)).toBe('actions')
  })

  it('falls back TOWARD the services pane, which is the one that is always drawn', () => {
    expect(clampFocus('actions', ['services', 'config'])).toBe('config')
    expect(clampFocus('config', ['services'])).toBe('services')
  })

  it('never returns a pane that is not drawn, for any combination', () => {
    const subsets: PaneId[][] = [
      ['services'],
      ['services', 'config'],
      ['services', 'actions'],
      ['services', 'config', 'actions'],
    ]
    for (const drawn of subsets) {
      for (const focus of PANE_ORDER) expect(drawn).toContain(clampFocus(focus, drawn))
    }
  })

  it('answers the services pane rather than crashing on an empty layout', () => {
    expect(clampFocus('actions', [])).toBe('services')
  })
})

describe('resolveListKey', () => {
  it('moves with the arrows and the vi keys', () => {
    expect(resolveListKey(key({ downArrow: true }), 0, 5)).toBe(1)
    expect(resolveListKey(key({ input: 'j' }), 0, 5)).toBe(1)
    expect(resolveListKey(key({ upArrow: true }), 3, 5)).toBe(2)
    expect(resolveListKey(key({ input: 'k' }), 3, 5)).toBe(2)
  })

  it('jumps to the ends with g and G', () => {
    expect(resolveListKey(key({ input: 'g' }), 3, 5)).toBe(0)
    expect(resolveListKey(key({ input: 'G' }), 0, 5)).toBe(4)
  })

  it('wraps at both ends', () => {
    expect(resolveListKey(key({ downArrow: true }), 4, 5)).toBe(0)
    expect(resolveListKey(key({ upArrow: true }), 0, 5)).toBe(4)
  })

  it('holds the index for an unrelated key', () => {
    expect(resolveListKey(key({ input: 'x' }), 2, 5)).toBe(2)
    expect(resolveListKey(key({ return: true }), 2, 5)).toBe(2)
  })

  it('returns 0 for an empty list rather than NaN or -1', () => {
    for (const k of [{ downArrow: true }, { upArrow: true }, { input: 'G' }, { input: 'g' }]) {
      const next = resolveListKey(key(k), 0, 0)
      expect(next).toBe(0)
      expect(Number.isNaN(next)).toBe(false)
    }
    expect(resolveListKey(key({ downArrow: true }), 3, 0)).toBe(0)
  })

  it('stays on the only item of a single-item list', () => {
    expect(resolveListKey(key({ downArrow: true }), 0, 1)).toBe(0)
    expect(resolveListKey(key({ upArrow: true }), 0, 1)).toBe(0)
    expect(resolveListKey(key({ input: 'G' }), 0, 1)).toBe(0)
  })
})

describe('resolveDigit', () => {
  it('maps 1-9 onto zero-based indexes', () => {
    expect(resolveDigit(key({ input: '1' }), 5)).toBe(0)
    expect(resolveDigit(key({ input: '5' }), 5)).toBe(4)
    expect(resolveDigit(key({ input: '9' }), 9)).toBe(8)
  })

  it('rejects 0 — the list is numbered from 1 on screen', () => {
    expect(resolveDigit(key({ input: '0' }), 5)).toBeNull()
  })

  it('rejects a digit past the end of the list', () => {
    expect(resolveDigit(key({ input: '6' }), 5)).toBeNull()
    expect(resolveDigit(key({ input: '1' }), 0)).toBeNull()
  })

  it('offers no shortcut past 9 items, where the numbers stop matching the screen', () => {
    expect(resolveDigit(key({ input: '9' }), 20)).toBe(8)
    // '10' arrives as two separate keypresses, so it can only ever be read as '1'.
    expect(resolveDigit(key({ input: '10' }), 20)).toBeNull()
  })

  it('rejects multi-char and non-numeric input', () => {
    expect(resolveDigit(key({ input: '' }), 5)).toBeNull()
    expect(resolveDigit(key({ input: 'a' }), 5)).toBeNull()
    expect(resolveDigit(key({ input: ' ' }), 5)).toBeNull()
    expect(resolveDigit(key({ input: '\t' }), 5)).toBeNull()
  })
})

describe('windowOffset', () => {
  it('does not scroll while the content fits', () => {
    expect(windowOffset(0, 3, 10)).toBe(0)
    expect(windowOffset(2, 3, 10)).toBe(0)
    expect(windowOffset(9, 10, 10)).toBe(0)
  })

  it('keeps the offset at the top for early selections', () => {
    expect(windowOffset(0, 20, 5)).toBe(0)
    expect(windowOffset(1, 20, 5)).toBe(0)
    expect(windowOffset(2, 20, 5)).toBe(0)
  })

  it('centers the selection in the middle of a long list', () => {
    expect(windowOffset(10, 20, 5)).toBe(8)
  })

  it('never scrolls past the last row', () => {
    for (let i = 0; i < 20; i++) {
      const offset = windowOffset(i, 20, 5)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThanOrEqual(20 - 5)
      // The selection must stay inside the window, or the cursor renders off-screen.
      expect(i).toBeGreaterThanOrEqual(offset)
      expect(i).toBeLessThan(offset + 5)
    }
    expect(windowOffset(19, 20, 5)).toBe(15)
  })

  it('returns 0 for a zero-height window', () => {
    expect(windowOffset(5, 20, 0)).toBe(0)
  })
})

describe('resolveScrollKey', () => {
  it('answers every key a document should answer', () => {
    expect(resolveScrollKey(key({ downArrow: true }), 0, 100, 10)).toBe(1)
    expect(resolveScrollKey(key({ input: 'j' }), 0, 100, 10)).toBe(1)
    expect(resolveScrollKey(key({ upArrow: true }), 5, 100, 10)).toBe(4)
    expect(resolveScrollKey(key({ input: 'k' }), 5, 100, 10)).toBe(4)
    expect(resolveScrollKey(key({ pageDown: true }), 0, 100, 10)).toBe(10)
    expect(resolveScrollKey(key({ pageUp: true }), 30, 100, 10)).toBe(20)
    expect(resolveScrollKey(key({ home: true }), 30, 100, 10)).toBe(0)
    expect(resolveScrollKey(key({ input: 'g' }), 30, 100, 10)).toBe(0)
    expect(resolveScrollKey(key({ end: true }), 0, 100, 10)).toBe(99)
    expect(resolveScrollKey(key({ input: 'G' }), 0, 100, 10)).toBe(99)
  })

  it('CLAMPS at both ends — a document is not a ring', () => {
    // The difference from `resolveListKey`, and the reason this is a second function: `↓` at the
    // bottom of a two-thousand-line log must not throw the reader back to line one.
    expect(resolveScrollKey(key({ downArrow: true }), 99, 100, 10)).toBe(99)
    expect(resolveScrollKey(key({ upArrow: true }), 0, 100, 10)).toBe(0)
    expect(resolveScrollKey(key({ pageDown: true }), 95, 100, 10)).toBe(99)
    expect(resolveScrollKey(key({ pageUp: true }), 3, 100, 10)).toBe(0)
  })

  it('never leaves the document, at any index and any page size', () => {
    for (const k of [{ upArrow: true }, { downArrow: true }, { pageUp: true }, { pageDown: true }, { home: true }, { end: true }]) {
      for (let i = 0; i < 40; i++) {
        for (const page of [0, 1, 7, 500]) {
          const next = resolveScrollKey(key(k), i, 40, page)
          expect(next).not.toBeNull()
          expect(next!).toBeGreaterThanOrEqual(0)
          expect(next!).toBeLessThan(40)
        }
      }
    }
  })

  it('answers nothing for a key it does not own, so the caller can fall through', () => {
    expect(resolveScrollKey(key({ input: 'f' }), 0, 100, 10)).toBeNull()
    expect(resolveScrollKey(key({ leftArrow: true }), 0, 100, 10)).toBeNull()
    expect(resolveScrollKey(key({ input: ']' }), 0, 100, 10)).toBeNull()
  })

  it('answers nothing at all for an empty document', () => {
    expect(resolveScrollKey(key({ downArrow: true }), 0, 0, 10)).toBeNull()
  })
})

describe('resolveTailKey', () => {
  const at = (index: number, follow: boolean) => ({ index, follow })

  it('re-pins to the tail on f, and says nothing when it is already pinned', () => {
    expect(resolveTailKey(key({ input: 'f' }), at(3, false), 100, 10)).toEqual(at(3, true))
    expect(resolveTailKey(key({ input: 'f' }), at(3, true), 100, 10)).toBeNull()
  })

  it('UNPINS on any movement — a reader who scrolled back is never yanked to the newest line', () => {
    for (const k of [{ upArrow: true }, { pageUp: true }, { home: true }, { input: 'G' }]) {
      expect(resolveTailKey(key(k), at(50, true), 100, 10)?.follow).toBe(false)
    }
  })

  it('unpins even when the position does not change, so the poll stops', () => {
    // `↓` on the last line moves nothing, and it is still the keystroke that says "I am reading".
    expect(resolveTailKey(key({ downArrow: true }), at(99, true), 100, 10)).toEqual(at(99, false))
  })

  it('answers nothing for a key it does not own', () => {
    expect(resolveTailKey(key({ input: ']' }), at(0, true), 100, 10)).toBeNull()
    expect(resolveTailKey(key({ input: '1' }), at(0, true), 100, 10)).toBeNull()
  })
})

describe('bodyHeight', () => {
  it('reserves five rows around a header, and six in total with a one-row one', () => {
    expect(CHROME_ROWS_AROUND).toBe(5)
    expect(CHROME_ROWS).toBe(6)
  })

  it('leaves the chrome its rows on a normal terminal', () => {
    expect(bodyHeight(40)).toBe(40 - CHROME_ROWS)
    expect(bodyHeight(24)).toBe(24 - CHROME_ROWS)
  })

  it('charges for the block wordmark when the header draws it', () => {
    // The header is two rows of art or one row of mark; a body budgeted against the wrong one
    // pushes its last row under the footer, which Ink composites rather than clips.
    expect(bodyHeight(40, 2)).toBe(40 - CHROME_ROWS_AROUND - 2)
    expect(bodyHeight(40, 2)).toBe(bodyHeight(40, 1) - 1)
  })

  it('never returns less than one row, however short the terminal is', () => {
    expect(bodyHeight(CHROME_ROWS)).toBe(1)
    expect(bodyHeight(CHROME_ROWS - 1)).toBe(1)
    expect(bodyHeight(1)).toBe(1)
    expect(bodyHeight(0)).toBe(1)
    expect(bodyHeight(6, 2)).toBe(1)
    // A header claiming zero rows would hand the body a row the frame is already using.
    expect(bodyHeight(40, 0)).toBe(bodyHeight(40, 1))
  })
})

describe('scrollBy', () => {
  it('moves by the delta and stops dead at both ends', () => {
    expect(scrollBy(5, 3, 20)).toBe(8)
    expect(scrollBy(5, -3, 20)).toBe(2)
    // Clamped, never wrapped: a wheel that jumped from the last line of a log to the first would be
    // a scroll gesture that teleports, which reads as a broken screen rather than as the end.
    expect(scrollBy(1, -3, 20)).toBe(0)
    expect(scrollBy(18, 3, 20)).toBe(19)
  })

  it('answers zero for a list with nothing in it', () => {
    expect(scrollBy(0, 3, 0)).toBe(0)
  })
})

describe('scrollTailBy', () => {
  it('unpins the tail on any movement, exactly as every scroll key does', () => {
    expect(scrollTailBy({ index: 90, follow: true }, -3, 100)).toEqual({ index: 87, follow: false })
  })

  it('unpins even when the position does not change', () => {
    // Rolling the wheel up at the very newest line is still a reader asking to stop being moved.
    expect(scrollTailBy({ index: 99, follow: true }, 3, 100)).toEqual({ index: 99, follow: false })
  })

  it('answers null when nothing would change, so a wheel at the end does not repaint', () => {
    expect(scrollTailBy({ index: 0, follow: false }, -3, 100)).toBeNull()
    expect(scrollTailBy({ index: 5, follow: false }, 0, 100)).toBeNull()
  })

  it('answers null for an empty log', () => {
    expect(scrollTailBy({ index: 0, follow: true }, 3, 0)).toBeNull()
  })
})

describe('ST-05 — the footer and the help table follow a rebinding', () => {
  it('a default shell key becomes the person\'s; other hints pass through', async () => {
    const { rebindHint, DEFAULT_SHELL_KEYS } = await import('./nav')
    const binds = { ...DEFAULT_SHELL_KEYS, quit: 'Q', 'prev-tab': '<', 'next-tab': '>' }
    expect(rebindHint('q quit', binds)).toBe('Q quit')
    expect(rebindHint('[ ] screens', binds)).toBe('< > screens')
    expect(rebindHint('x stop', binds)).toBe('x stop')
  })
})

describe('ST-05 — only the changed keys are stored', () => {
  it('a table at the defaults stores nothing; one change stores one key', async () => {
    const { changedShellKeys, DEFAULT_SHELL_KEYS } = await import('./nav')
    expect(changedShellKeys({ ...DEFAULT_SHELL_KEYS })).toEqual({})
    expect(changedShellKeys({ ...DEFAULT_SHELL_KEYS, help: 'H' })).toEqual({ help: 'H' })
  })
})
