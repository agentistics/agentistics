import { describe, expect, test } from 'bun:test'
import {
  clampLines,
  MENU_MARKER,
  MENU_NUMBER,
  menuCells,
  promptLayout,
  sectionHead,
  logRows,
  logSources,
  sourceAtColumn,
  sourceRowFit,
  sourceRowText,
  staticRows,
  windowLabel,
  wrapText,
} from './surface.ts'
import type { ControlService } from './types'

/**
 * These are the numbers behind the linear screens and the questions. They are tested the same way
 * `chrome.test.ts` tests the cockpit's: against the guarantee rather than against the arithmetic,
 * because the arithmetic is allowed to change and the guarantee is not.
 */

describe('sectionHead', () => {
  test('a drawn rule reaches the edge exactly, and nothing ever passes it', () => {
    for (let width = 1; width <= 120; width++) {
      const head = sectionHead('COMMANDS', width)
      const used = head.title.length + head.rule.length
      expect(used).toBeLessThanOrEqual(width)
      // The rule is either absent or exact: a header one cell short of the edge reads as a
      // rendering fault, which is the whole reason this returns parts instead of a string.
      if (head.rule) expect(used).toBe(width)
    }
  })

  test('a title that would leave no rule keeps the title', () => {
    const head = sectionHead('COMMANDS', 9)
    expect(head.title).toBe('COMMANDS')
    expect(head.rule).toBe('')
  })

  test('a title longer than the row is truncated, never wrapped', () => {
    const head = sectionHead('RUN FROM A CHECKOUT', 8)
    expect(head.title.length).toBeLessThanOrEqual(8)
    expect(head.rule).toBe('')
  })

  test('a zero or negative width draws nothing', () => {
    expect(sectionHead('X', 0)).toEqual({ title: '', rule: '' })
    expect(sectionHead('X', -4)).toEqual({ title: '', rule: '' })
  })

  test('the rule reaches the edge in Portuguese too', () => {
    const head = sectionHead('DIAGNOSTICAR', 60)
    expect(head.title.length + head.rule.length).toBe(60)
  })
})

describe('menuCells', () => {
  const labels = ['solo', 'central', 'member']

  test('without hints the label takes everything left of the marker', () => {
    const cells = menuCells(labels, { numbered: true, hints: false, width: 40 })
    expect(cells.label).toBe(40 - MENU_MARKER - MENU_NUMBER)
    expect(cells.hint).toBe(0)
  })

  test('with hints the label is capped at the longest label', () => {
    const cells = menuCells(labels, { numbered: true, hints: true, width: 80 })
    expect(cells.label).toBe('central'.length)
    expect(cells.hint).toBeGreaterThan(0)
  })

  test('the cells never exceed the row', () => {
    for (let width = 6; width <= 120; width++) {
      const cells = menuCells(labels, { numbered: true, hints: true, width })
      const used = MENU_MARKER + MENU_NUMBER + cells.label + (cells.hint > 0 ? cells.hint + 2 : 0)
      expect(used).toBeLessThanOrEqual(width)
    }
  })

  test('a hint too narrow to hold a word is dropped whole, not ellipsised', () => {
    const cells = menuCells(labels, { numbered: true, hints: true, width: 22 })
    expect(cells.hint).toBe(0)
    // …and the label gets the columns back rather than staying short beside nothing.
    expect(cells.label).toBe(22 - MENU_MARKER - MENU_NUMBER)
  })

  test('an empty menu asks for nothing', () => {
    expect(menuCells([], { numbered: false, hints: false, width: 40 })).toEqual({ label: 0, hint: 0 })
  })
})

describe('promptLayout', () => {
  const question = 'Central endpoint URL (e.g. http://host:48080)'

  test('a wide row keeps the field on the question row', () => {
    const layout = promptLayout(question, '', 100)
    expect(layout.inline).toBe(true)
    expect(layout.head).toEqual([question])
    expect(layout.room).toBeGreaterThanOrEqual(16)
  })

  test("a narrow row moves the field under the question rather than starving it", () => {
    const layout = promptLayout(question, '', 44)
    expect(layout.inline).toBe(false)
    expect(layout.head.length).toBeGreaterThan(1)
    // The whole question survives — this is the case where truncating it would ask nothing.
    expect(layout.head.join(' ')).toBe(question)
    expect(layout.room).toBeGreaterThan(16)
  })

  test('the default is part of the question when it is stacked', () => {
    const layout = promptLayout('Org', ' (default)', 12)
    expect(layout.inline).toBe(false)
    expect(layout.head.join(' ')).toBe('Org (default)')
  })

  test('the default is paid for before deciding the field fits', () => {
    // 'Org' alone would fit inline at this width; with its default it does not.
    expect(promptLayout('Org', '', 24).inline).toBe(true)
    expect(promptLayout('Org', ' (a-very-long-org-name)', 24).inline).toBe(false)
  })

  test('no row is ever wider than the field it was measured for', () => {
    for (let width = 4; width <= 120; width++) {
      const layout = promptLayout(question, ' (default)', width)
      for (const line of layout.head) expect(line.length).toBeLessThanOrEqual(width)
      expect(layout.room).toBeLessThanOrEqual(width)
    }
  })
})

describe('wrapText', () => {
  test('wraps on words and never exceeds the width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12)
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog')
  })

  test('hard-splits a word longer than the line', () => {
    const lines = wrapText('https://github.com/blpsoares/agentistics', 10)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10)
    expect(lines.join('')).toBe('https://github.com/blpsoares/agentistics')
  })

  test('always yields at least one row, so a blank line stays a line', () => {
    expect(wrapText('', 20)).toEqual([''])
  })

  test('a width of zero yields nothing rather than looping', () => {
    expect(wrapText('anything', 0)).toEqual([])
  })
})

describe('clampLines', () => {
  test('leaves prose that fits alone', () => {
    expect(clampLines(['a', 'b'], 3, 10)).toEqual(['a', 'b'])
  })

  test('marks the cut on the last kept row', () => {
    const kept = clampLines(['one', 'two', 'three'], 2, 10)
    expect(kept.length).toBe(2)
    expect(kept[1]).toBe('two…')
  })

  test('the marker never pushes the row past the width', () => {
    const kept = clampLines(['exactlyten', 'more'], 1, 10)
    expect(kept[0]!.length).toBeLessThanOrEqual(10)
  })

  test('a zero budget draws nothing', () => {
    expect(clampLines(['a'], 0, 10)).toEqual([])
  })
})

describe('windowLabel', () => {
  test('states the window, not the cursor', () => {
    expect(windowLabel(0, 24, 27)).toBe('1–24 / 27')
    expect(windowLabel(3, 24, 27)).toBe('4–27 / 27')
  })

  test('never claims to show more than there is', () => {
    expect(windowLabel(0, 24, 5)).toBe('1–5 / 5')
  })

  test('an empty body has no position', () => {
    expect(windowLabel(0, 24, 0)).toBe('')
    expect(windowLabel(0, 0, 10)).toBe('')
  })
})

/**
 * The row budgets. Ink COMPOSITES an overflowing child rather than clipping it, so the guarantee
 * these three are tested against is arithmetic and absolute: what is drawn never adds up to more
 * than the height it was given. Everything else — which piece gives way, and in what order — is a
 * judgement that is allowed to change.
 */
describe('staticRows', () => {
  test('never draws more rows than it was given, at any height or intro length', () => {
    for (let height = 0; height <= 40; height++) {
      for (let intro = 0; intro <= 5; intro++) {
        const rows = staticRows(height, intro)
        const used = (rows.intro ? intro : 0) + rows.body + (rows.footer ? 1 : 0)
        expect(used).toBeLessThanOrEqual(height)
      }
    }
  })

  test('keeps a row of content before it keeps its prose', () => {
    // Three rows, a two-row intro: the intro is what goes, because the reader came for the content.
    const rows = staticRows(3, 2)
    expect(rows.intro).toBe(false)
    expect(rows.body).toBeGreaterThanOrEqual(1)
  })

  test('spends everything it can afford when the height is comfortable', () => {
    const rows = staticRows(20, 2)
    expect(rows.intro).toBe(true)
    expect(rows.footer).toBe(true)
    expect(2 + rows.body + 1).toBe(20)
  })

  test('a height of nothing draws nothing', () => {
    expect(staticRows(0, 2)).toEqual({ intro: false, body: 0, footer: false })
  })
})

describe('logRows', () => {
  test('a comfortable pane draws the selector, the rule and the rest as log', () => {
    expect(logRows(20)).toEqual({ source: true, divider: true, body: 18 })
  })

  test('the rule goes before the selector — it separates two things already different', () => {
    expect(logRows(3)).toEqual({ source: true, divider: false, body: 2 })
    expect(logRows(2)).toEqual({ source: true, divider: false, body: 1 })
  })

  test('one row is one line of log: the screen, with nothing around it', () => {
    expect(logRows(1)).toEqual({ source: false, divider: false, body: 1 })
  })

  test('never spends more rows than it has, and never fewer than it was given', () => {
    // The screen used to draw both header rows unconditionally against `height - 2`, so a two-row
    // body rendered three rows — and Ink COMPOSITES an overflow, which silently dropped the
    // selector and left an orphan rule saying nothing over a log nobody could identify.
    for (let height = 0; height <= 30; height++) {
      const r = logRows(height)
      const used = r.body + (r.source ? 1 : 0) + (r.divider ? 1 : 0)
      expect(used).toBe(Math.max(0, height))
      expect(r.body).toBeGreaterThanOrEqual(height > 0 ? 1 : 0)
    }
  })
})

describe('logSources', () => {
  /** A logical service, in the shape `buildService` produces. */
  const service = (over: Partial<ControlService> = {}): ControlService => ({
    id: 'agentistics',
    label: 'agentistics',
    state: 'up',
    runtimes: [
      { id: 'local', kind: 'native', state: 'up', available: true },
      { id: 'machine', kind: 'docker', state: 'down', available: true },
    ],
    running: ['local'],
    startOptions: [],
    restartOptions: [],
    stopOptions: [],
    bootOptions: [],
    ...over,
  })

  test('one entry per LOGICAL service, under the name the cockpit prints', () => {
    // The bug this replaces: a constant `['local', 'central', 'machine']` inside the component,
    // rendered verbatim, so the selector offered the native process and the container of the SAME
    // service as two things — the exact distinction the logical-service model deleted.
    expect(logSources([service()])).toEqual([
      { source: 'agentistics', label: 'agentistics' },
    ])
  })

  test('never offers a runtime id as a label', () => {
    for (const option of logSources([service()])) {
      expect(['local', 'machine']).not.toContain(option.label)
    }
  })

  test('a CONFLICT expands into its running runtimes — those really are two different logs', () => {
    const conflicted = service({ running: ['local', 'machine'] })
    expect(logSources([conflicted])).toEqual([
      { source: 'local', label: 'agentistics (native)' },
      { source: 'machine', label: 'agentistics (docker)' },
    ])
  })

  test('the expansion is derived, so it disappears with the conflict', () => {
    expect(logSources([service({ running: ['machine'] })])).toEqual([
      { source: 'agentistics', label: 'agentistics' },
    ])
  })

  test('no services is no sources rather than a stale list', () => {
    expect(logSources([])).toEqual([])
  })

  test('the labels are whatever the host said — this module translates nothing', () => {
    const pt = service({ label: 'agentistics', running: ['local', 'machine'] })
    expect(logSources([pt])[0]!.label).toContain('native')
  })
})

describe('sourceRowFit', () => {
  const cells = ['1 local', '2 central', '3 machine']

  test('never lays out a row wider than the width — the bug that chopped `central` to `centra`', () => {
    for (const label of ['SOURCE', 'FONTE', '']) {
      for (let width = 1; width <= 80; width++) {
        for (let selected = 0; selected < cells.length; selected++) {
          const fit = sourceRowFit(label, cells, selected, width)
          // Below the floor even one cell cannot fit; what matters is that nothing is ever chopped
          // mid-word by the layout engine, so the row is only allowed to exceed the width when a
          // single indivisible cell does.
          const text = sourceRowText(fit)
          if (fit.labels.length > 1) expect(text.length).toBeLessThanOrEqual(width)
          for (const cell of fit.labels) expect(cells).toContain(cell)
        }
      }
    }
  })

  test('drops the naming word before it drops a source', () => {
    const wide = sourceRowFit('SOURCE', cells, 0, 60)
    expect(wide.label).toBe('SOURCE')
    expect(wide.labels).toEqual(cells)

    // 40 columns inside a pane leaves 36: room for all three cells, none for the caption.
    const narrow = sourceRowFit('SOURCE', cells, 0, 36)
    expect(narrow.label).toBe('')
    expect(narrow.labels).toEqual(cells)
  })

  test('keeps the selected source visible even when cells have to go', () => {
    for (let selected = 0; selected < cells.length; selected++) {
      const fit = sourceRowFit('SOURCE', cells, selected, 16)
      expect(fit.labels).toContain(cells[selected]!)
    }
  })
})

describe('sourceAtColumn', () => {
  const cells = ['1 agentistics', '2 agentistics central']

  test('names the source the row actually drew there', () => {
    const fit = sourceRowFit('SOURCE', cells, 0, 80)
    expect(fit.label).toBe('SOURCE')
    expect(fit.labels).toEqual(cells)

    // Measured through `sourceRowText`, which is also what the screen budgets the follow state
    // against — so the hit test and the width budget cannot disagree about where a cell starts.
    let x = sourceRowText({ ...fit, labels: [] }).length
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!
      expect(sourceAtColumn(fit, x)).toBe(i)
      expect(sourceAtColumn(fit, x + cell.length - 1)).toBe(i)
      x += cell.length + 3 // ACTION_SEP
    }
    expect(sourceAtColumn(fit, x)).toBeNull()
  })

  test('claims neither the naming word nor the reserved marker', () => {
    const fit = sourceRowFit('SOURCE', cells, 0, 80)
    expect(sourceAtColumn(fit, 0)).toBeNull()
    expect(sourceAtColumn(fit, 'SOURCE'.length)).toBeNull()
  })

  test('follows the row that had to drop its naming word', () => {
    const fit = sourceRowFit('SOURCE', cells, 1, 24)
    expect(fit.label).toBe('')
    // The cells moved left by the whole word; a hit test that still reserved it would name the
    // wrong source on every narrow terminal.
    expect(sourceAtColumn(fit, 2)).toBe(fit.from)
  })

  test('maps back to the FULL list when the row is a window', () => {
    const many = ['1 one', '2 two', '3 three', '4 four', '5 five']
    const fit = sourceRowFit('SOURCE', many, many.length - 1, 18)
    expect(fit.from).toBeGreaterThan(0)
    expect(sourceAtColumn(fit, sourceRowText({ ...fit, labels: [] }).length)).toBe(fit.from)
  })
})
