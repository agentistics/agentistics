import { describe, test, expect } from 'bun:test'
import {
  ACTION_SEP,
  actionAtColumn,
  cockpitRects,
  tabAtColumn,
  COCKPIT_MIN_WIDTH,
  cockpitHints,
  cockpitLayout,
  artWidth,
  detailContent,
  detailPlan,
  fitActionRow,
  fitActions,
  fitDetailLines,
  fitTabs,
  fitValue,
  footerHints,
  formatUptime,
  HEADER_GAP,
  headerLayout,
  headerMeta,
  headerMetaWidth,
  loadBar,
  loadLevel,
  LOAD_BAR,
  LOAD_WARN,
  LOAD_HIGH,
  HINT_SEP,
  LEFT_MAX_SHARE,
  LEFT_MIN,
  paneTop,
  paneBadgeRoom,
  paneTitleRoom,
  PANE_FRAME_X,
  PANE_FRAME_Y,
  PANE_MIN_ROWS,
  RIGHT_MIN,
  QUESTION_ROWS,
  serviceCells,
  SERVICE_MARKER,
  stripScheme,
  tabStripWidth,
  tabUnderline,
  type CockpitContent,
  type TabSpec,
  attentionCell as attentionCellGL02,
  attentionRings as attentionRingsGL02,
  narrowTerminal as narrowTerminalGL07,
  NARROW_WIDTH as NARROW_WIDTH_GL07,
  paneStrip as paneStripGL07,
  stripAt as stripAtGL07,
  STRIP_ROWS as STRIP_ROWS_GL07,
} from './chrome.ts'
import { TAB_ORDER, type ControlService, type ServiceRuntimeState } from './types'
import { truncate } from '../components/Primitives'
import { PANE_ORDER } from './nav'
import { brandMark, brandWidth, WORDMARK_ART } from '../components/Wordmark'
import { controlStrings } from './i18n'

const tabs = (lang: 'en' | 'pt' = 'en'): TabSpec[] => {
  const s = controlStrings(lang)
  return TAB_ORDER.map(id => ({ id, label: s.tabs[id] }))
}

describe('fitTabs', () => {
  test('renders the full strip on a wide terminal, marking exactly one tab active', () => {
    const layout = fitTabs(tabs(), 'logs', 200)
    expect(layout.kind).toBe('full')
    if (layout.kind !== 'full') throw new Error('unreachable')
    expect(layout.cells).toHaveLength(TAB_ORDER.length)
    expect(layout.cells.filter(c => c.active).map(c => c.id)).toEqual(['logs'])
  })

  test('cell widths include the padding on both sides', () => {
    const layout = fitTabs([{ id: 'help', label: 'Help' }], 'help', 80)
    if (layout.kind !== 'full') throw new Error('expected full')
    expect(layout.cells[0]!.width).toBe('Help'.length + 2)
  })

  test('the full strip is kept at exactly its measured width; one column below it becomes a WINDOW', () => {
    const t = tabs()
    const exact = tabStripWidth(t)
    const whole = fitTabs(t, 'services', exact)
    expect(whole.kind === 'full' && whole.window).toBeUndefined()
    const below = fitTabs(t, 'services', exact - 1)
    if (below.kind !== 'full' || !below.window) throw new Error('expected a window')
    // the active tab is always in the window, and the window is a contiguous run of the strip
    expect(below.cells.some(c => c.id === 'services' && c.active)).toBe(true)
    const ids = t.map(x => x.id)
    const at = ids.indexOf(below.cells[0]!.id)
    expect(below.cells.map(c => c.id)).toEqual(ids.slice(at, at + below.cells.length))
  })

  test('GL-01: at 106 columns the window shows most of the twelve tabs and says there is more', () => {
    const w = fitTabs(tabs(), 'home', 106)
    if (w.kind !== 'full' || !w.window) throw new Error('expected a window')
    expect(w.cells.map(c => c.id).slice(0, 6)).toEqual(['home', 'code', 'sessions', 'tasks', 'dashboard', 'services'])
    expect(w.window).toEqual({ prev: false, next: true })
    // the drawn row (arrows included) fits
    expect(2 + w.cells.reduce((n, c) => n + c.width + 1, 0) + 2).toBeLessThanOrEqual(106)
  })

  test('the threshold follows the translated labels rather than a fixed column count', () => {
    // The Portuguese names are not the same length as the English ones, so a hardcoded 60 would
    // be wrong for one of the two languages.
    expect(tabStripWidth(tabs('pt'))).not.toBe(tabStripWidth(tabs('en')))
  })

  test('the collapsed form (only one name fits) names the ACTIVE tab', () => {
    const layout = fitTabs(tabs(), 'contribute', 16)
    expect(layout.kind).toBe('collapsed')
    if (layout.kind !== 'collapsed') throw new Error('unreachable')
    expect(layout.id).toBe('contribute')
    expect(layout.label).toBe('Contribute')
  })

  test('collapsed affordances report the position in the strip', () => {
    // The FIRST tab is whatever leads `TAB_ORDER` — named through it, so reordering the strip does
    // not turn this into a test of which tab happens to be first today.
    const first = fitTabs(tabs(), TAB_ORDER[0]!, 12)
    const middle = fitTabs(tabs(), 'logs', 12)
    const last = fitTabs(tabs(), 'contribute', 16)
    if (first.kind !== 'collapsed' || middle.kind !== 'collapsed' || last.kind !== 'collapsed') {
      throw new Error('expected collapsed')
    }
    expect([first.hasPrev, first.hasNext]).toEqual([false, true])
    expect([middle.hasPrev, middle.hasNext]).toEqual([true, true])
    expect([last.hasPrev, last.hasNext]).toEqual([true, false])
  })

  test('the collapsed label still fits a very narrow terminal', () => {
    const layout = fitTabs(tabs(), 'cheatsheet', 10)
    if (layout.kind !== 'collapsed') throw new Error('expected collapsed')
    expect(layout.label.length).toBeLessThanOrEqual(10 - 4)
  })

  test('an unknown active id still names a tab instead of rendering nameless', () => {
    const layout = fitTabs(tabs(), 'nope' as never, 10)
    if (layout.kind !== 'collapsed') throw new Error('expected collapsed')
    expect(layout.id).toBe(TAB_ORDER[0]!)
  })

  test('an empty tab list is a full strip with nothing in it', () => {
    expect(fitTabs([], 'services', 80)).toEqual({ kind: 'full', cells: [] })
  })
})

describe('brandMark', () => {
  test('the mark and the name when the row can hold both', () => {
    const brand = brandMark(40)
    expect(brand.mark).toBe('◢◣')
    expect(brand.word).toBe('agentistics')
  })

  test('degrades as a MARK — the name goes, the glyph stays', () => {
    // The identity is the two triangles; `agentis…` is a word someone cut in half.
    expect(brandMark(12).word).toBe('')
    expect(brandMark(12).mark).toBe('◢◣')
  })

  test('never exceeds the width it was given, at any terminal size', () => {
    for (let width = 0; width <= 40; width++) {
      expect(brandWidth(brandMark(width))).toBeLessThanOrEqual(width)
    }
  })

  test('a mark is sliced, never ellipsised — `…` in place of a triangle says nothing', () => {
    expect(brandMark(1).mark).toBe('◢')
    expect(brandMark(0)).toEqual({ mark: '', word: '' })
  })
})

describe('tabUnderline', () => {
  const t = tabs()

  test('the rule sits exactly under the active cell, and nowhere else', () => {
    const layout = fitTabs(t, 'logs', 200)
    if (layout.kind !== 'full') throw new Error('expected full')
    const rule = tabUnderline(layout)
    const active = layout.cells.findIndex(c => c.active)
    // Everything before the active cell is blank, and the run is exactly as wide as the cell.
    const before = layout.cells.slice(0, active).reduce((n, c) => n + c.width + 1, 0)
    expect(rule.slice(0, before).trim()).toBe('')
    expect(rule.slice(before, before + layout.cells[active]!.width)).toBe('━'.repeat(layout.cells[active]!.width))
    expect(rule.slice(before + layout.cells[active]!.width).trim()).toBe('')
  })

  test('the rule row is exactly as wide as the strip it underlines', () => {
    const layout = fitTabs(t, 'services', 200)
    expect(tabUnderline(layout).length).toBe(tabStripWidth(t))
  })

  test('collapsed, it underlines the one name on the row and not its affordances', () => {
    const layout = fitTabs(t, 'contribute', 16)
    if (layout.kind !== 'collapsed') throw new Error('expected collapsed')
    expect(tabUnderline(layout)).toBe('  ' + '━'.repeat(layout.label.length))
  })

  test('windowed, the rule starts after the reserved `‹ ` and still sits under the active cell', () => {
    const layout = fitTabs(t, 'tasks', 60)
    if (layout.kind !== 'full' || !layout.window) throw new Error('expected a window')
    const rule = tabUnderline(layout)
    let x = 2
    for (const c of layout.cells) {
      if (c.active) { expect(rule.slice(x, x + c.width)).toBe('━'.repeat(c.width)); expect(tabAtColumn(layout, x)).toEqual({ kind: 'tab', id: 'tasks' }) }
      x += c.width + 1
    }
    expect(tabAtColumn(layout, 0)).toEqual(layout.window.prev ? { kind: 'prev' } : null)
  })

  test('a strip with no tabs underlines nothing rather than throwing', () => {
    expect(tabUnderline(fitTabs([], 'services', 80))).toBe('')
  })
})

describe('footerHints', () => {
  const s = controlStrings('en')
  const hints = [s.keyTabs, s.keyMove, s.keySelect, s.keyBack, s.keyRefresh, s.keyQuit]

  test('joins every hint when they fit', () => {
    expect(footerHints(hints, 200)).toBe(hints.join(HINT_SEP))
  })

  test('drops from the right, keeping the leftmost hints', () => {
    const out = footerHints(hints, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.startsWith(s.keyTabs)).toBe(true)
    expect(out.includes(s.keyQuit)).toBe(false)
  })

  test('never exceeds the width at any terminal size', () => {
    for (let width = 1; width <= 160; width++) {
      expect(footerHints(hints, width).length).toBeLessThanOrEqual(width)
    }
  })

  test('a single hint too wide for the terminal is truncated, not wrapped', () => {
    const out = footerHints(['tab ←→ screens'], 6)
    expect(out.length).toBeLessThanOrEqual(6)
    expect(out.endsWith('…')).toBe(true)
  })

  test('empty hints are ignored rather than producing dangling separators', () => {
    expect(footerHints(['a', '', 'b'], 80)).toBe(`a${HINT_SEP}b`)
  })

  test('no hints at all is an empty line', () => {
    expect(footerHints([], 80)).toBe('')
  })
})

describe('the load bar', () => {
  test('fills in proportion, and rounds DOWN like the number beside it', () => {
    // A bar showing full while the label says 99% is one of them being wrong, and it would be the
    // bar — the shape is what gets believed at a glance.
    expect(loadBar(0)).toBe('░'.repeat(LOAD_BAR))
    expect(loadBar(100)).toBe('█'.repeat(LOAD_BAR))
    expect(loadBar(50)).toBe('████░░░░')
    expect(loadBar(99)).not.toBe('█'.repeat(LOAD_BAR))
  })

  test('is bounded by a machine that reports nonsense', () => {
    expect(loadBar(-5)).toBe('░'.repeat(LOAD_BAR))
    expect(loadBar(9999)).toBe('█'.repeat(LOAD_BAR))
  })

  test('changes level as it climbs — the whole point of the colour', () => {
    // The thresholds are the MEMORY's, not the context window's: a context window at 80% is worth
    // noticing, a machine at 80% is already slow and one at 90% is minutes from swapping.
    expect(loadLevel(10)).toBe('ok')
    expect(loadLevel(LOAD_WARN - 1)).toBe('ok')
    expect(loadLevel(LOAD_WARN)).toBe('warn')
    expect(loadLevel(LOAD_HIGH - 1)).toBe('warn')
    expect(loadLevel(LOAD_HIGH)).toBe('full')
    expect(loadLevel(100)).toBe('full')
  })
})

describe('headerMeta', () => {
  test('states the mode, the version and the update dot when there is room', () => {
    const meta = headerMeta({ mode: 'member', version: '1.7.3', latestVersion: '1.7.4', width: 60 })
    expect(meta.text).toBe('member · v1.7.3')
    expect(meta.update).toBe('● 1.7.4')
  })

  test('draws the parallel-sessions budget, and NOTHING when it could not be measured', () => {
    const with_ = headerMeta({
      mode: 'solo', version: '1.7.4', memory: { used: 3, max: 17, red: false, percent: 62 }, width: 60,
    })
    // Sessions AND load: `3/17` says how many more fit, `62%` says how hard the box is already
    // working. A machine at 90% for reasons unrelated to agentop reads comfortable on the ratio
    // alone, which is why the percentage was asked for after the first pass shipped only the ratio.
    // A BAR, like htop, because a bare `62%` does not say what is 62% full. Both are drawn: the
    // shape is what gets read at a glance, the number is what gets acted on.
    expect(with_.memory).toBe('ram ████░░░░ 62% · 3/17')
    expect(with_.memoryRed).toBe(false)
    // A machine whose memory cannot be read draws no gauge at all — never a zero, which would read
    // as "no room left" on precisely the machines nobody could ask.
    expect(headerMeta({ mode: 'solo', version: '1.7.4', width: 60 }).memory).toBe('')
  })

  test('the budget is NAMED, so it cannot be read as a count of sessions', () => {
    // It was a bare `▤ n/m`, chosen so the pair could not be mistaken for a session count. That
    // failed twice on real machines — `▤ 4/18` over a list of 4, then `▤ 5/…` over a list of 3 —
    // because a glyph teaches nobody what a number measures.
    //
    // The two counts differ ON PURPOSE and no arithmetic change is wanted: this one counts assistant
    // PROCESSES (a background agent is a live process sharing its parent's directory, so it costs
    // memory here and owns no row in the list) while the list counts ROWS after its filter. The
    // label is the only thing that can say so, so the label is pinned.
    const meta = headerMeta({
      mode: 'solo', version: '1.7.4', memory: { used: 5, max: 18, red: false, percent: 62 }, width: 60,
    })
    expect(meta.memory).toContain('ram')
    expect(meta.memory).not.toContain('▤')
    // And it is not the word `sessions` in either language, which is the reading being prevented.
    expect(meta.memory.toLowerCase()).not.toContain('sess')
  })

  test('a RED budget outranks the version under width pressure', () => {
    // The pieces drop least-actionable-first, and a budget about to run out is the most actionable
    // thing on the row. Dropping the warning to keep a version number would be the wrong trade at
    // exactly the moment it matters — the version is one `agentop --version` away.
    const narrow = { mode: 'solo', version: '1.7.4', latestVersion: '1.9.0', attention: 2 }
    // Widened with the cell: it now carries the percentage too, so the row it has to survive on is
    // wider than it was. The ASSERTION is the ordering, not the number of columns.
    // Wider than before, because the cell now carries a bar too. The ASSERTION is the ordering.
    // Wider again for the counter's WORDS (`● 2 need you`).
    const red = headerMeta({ ...narrow, memory: { used: 14, max: 15, red: true, percent: 91 }, width: 53 })
    expect(red.memory).toContain('91%')
    expect(red.text).toBe('solo')            // the version went first
    // …while a calm budget gives way instead, because it is only informational.
    const calm = headerMeta({ ...narrow, memory: { used: 3, max: 17, red: false, percent: 62 }, width: 53 })
    expect(calm.memory).toBe('')
  })

  test('the waiting counter still outlives the budget', () => {
    // Ordering pinned end to end: update, then a calm budget, then the version, and the counter is
    // the last thing standing after the mode token.
    const meta = headerMeta({
      mode: 'solo', version: '1.7.4', latestVersion: '1.9.0', attention: 2,
      memory: { used: 3, max: 17, red: false, percent: 62 }, width: 12,
    })
    // At twelve columns the WORDS have gone and the count keeps its dot — the last form it takes.
    expect(meta.alert).toBe('● 2')
    expect(meta.memory).toBe('')
    expect(meta.update).toBe('')
  })

  test('says nothing about an update when the running version IS the latest', () => {
    expect(headerMeta({ mode: 'solo', version: '1.7.4', latestVersion: '1.7.4', width: 60 }).update).toBe('')
    expect(headerMeta({ mode: 'solo', version: '1.7.4', width: 60 }).update).toBe('')
  })

  test('drops the update notice before the version, and the version before the mode', () => {
    const full = headerMeta({ mode: 'member', version: '1.7.3', latestVersion: '1.7.4', width: 60 })
    const noUpdate = headerMeta({ mode: 'member', version: '1.7.3', latestVersion: '1.7.4', width: 16 })
    const bare = headerMeta({ mode: 'member', version: '1.7.3', latestVersion: '1.7.4', width: 8 })
    expect(headerMetaWidth(full)).toBeGreaterThan(headerMetaWidth(noUpdate))
    expect(noUpdate.update).toBe('')
    expect(bare.text).toBe('member')
  })

  test('never exceeds the width it was given, at any terminal size', () => {
    for (let width = 0; width <= 80; width++) {
      const meta = headerMeta({ mode: 'central', version: '1.7.3', latestVersion: '1.7.4', width })
      expect(headerMetaWidth(meta)).toBeLessThanOrEqual(width)
    }
  })

  test('says nothing about waiting sessions when none are waiting', () => {
    expect(headerMeta({ mode: 'solo', version: '1.7.4', width: 60 }).alert).toBe('')
    expect(headerMeta({ mode: 'solo', version: '1.7.4', attention: 0, width: 60 }).alert).toBe('')
  })

  test('states the waiting count with a glyph, not a bare number', () => {
    // A bare accent-coloured digit beside a dim one says nothing on a terminal that drops colour,
    // and this is the piece the user is meant to act on.
    const meta = headerMeta({ mode: 'solo', version: '1.7.4', attention: 2, width: 60 })
    expect(meta.alert).toContain('2')
    expect(meta.alert.length).toBeGreaterThan(1)
  })

  test('keeps the waiting count after the version has been given up', () => {
    // The drop order is least-actionable-first: update, then version, then the counter. A version
    // is one `agentop --version` away; a session waiting on you is why the app is open.
    const squeezed = headerMeta({
      mode: 'solo', version: '1.7.3', latestVersion: '1.7.4', attention: 3, width: 12,
    })
    expect(squeezed.text).toBe('solo')
    expect(squeezed.update).toBe('')
    expect(squeezed.alert).toContain('3')
  })

  test('gives up the counter only to keep the mode, and never overflows', () => {
    for (let width = 0; width <= 80; width++) {
      const meta = headerMeta({
        mode: 'central', version: '1.7.3', latestVersion: '1.7.4', attention: 7, width,
      })
      expect(headerMetaWidth(meta)).toBeLessThanOrEqual(width)
    }
    const tiny = headerMeta({ mode: 'central', version: '1.7.3', attention: 7, width: 8 })
    expect(tiny.text).toBe('central')
    expect(tiny.alert).toBe('')
  })
})

describe('headerLayout', () => {
  const tag = { mode: 'member', version: '1.7.3', latestVersion: '1.7.4' }
  /** The exact column at which the art stops being affordable — measured, never written down. */
  const threshold = (input: Omit<Parameters<typeof headerLayout>[0], 'width'>) =>
    artWidth(WORDMARK_ART) + HEADER_GAP + headerMetaWidth(headerMeta({ ...input, width: 1e9 }))

  test('a wide terminal gets the two-line block wordmark', () => {
    const layout = headerLayout({ ...tag, width: 120 })
    expect(layout.kind).toBe('art')
    if (layout.kind !== 'art') throw new Error('unreachable')
    expect(layout.art).toEqual(WORDMARK_ART)
    expect(layout.rows).toBe(WORDMARK_ART.length)
  })

  test('a narrow terminal degrades to the one-line mark rather than wrapping the art', () => {
    const layout = headerLayout({ ...tag, width: 40 })
    expect(layout.kind).toBe('compact')
    expect(layout.rows).toBe(1)
  })

  test('THE THRESHOLD is the measured art plus the measured tag, not a column count', () => {
    const at = threshold(tag)
    expect(headerLayout({ ...tag, width: at }).kind).toBe('art')
    expect(headerLayout({ ...tag, width: at - 1 }).kind).toBe('compact')
    // …and it MOVES with the tag: a longer mode word and an update notice both push it right.
    expect(threshold({ mode: 'member', version: '1.7.3', latestVersion: '1.7.4' }))
      .toBeGreaterThan(threshold({ mode: 'solo', version: '1.7.3' }))
  })

  test('the art branch never truncates the tag it took the row for', () => {
    // All-or-nothing is the point: a header that took the art and then dropped the version to pay
    // for it would have spent a whole row on a worse answer.
    const at = threshold(tag)
    const layout = headerLayout({ ...tag, width: at })
    expect(layout.meta.text).toBe('member · v1.7.3')
    expect(layout.meta.update).toBe('● 1.7.4')
  })

  test('the art and the tag always fit the row they share', () => {
    for (let width = 0; width <= 160; width++) {
      const layout = headerLayout({ ...tag, width })
      const left = layout.kind === 'art' ? artWidth(layout.art) : 0
      expect(left + headerMetaWidth(layout.meta)).toBeLessThanOrEqual(Math.max(0, width))
    }
  })
})

describe('paneTop', () => {
  const width = (top: ReturnType<typeof paneTop>) =>
    top.head.length + top.title.length + top.gap.length + top.badge.length + top.tail.length

  test('the parts concatenate to EXACTLY the pane width', () => {
    for (let w = 0; w <= 120; w++) {
      expect(width(paneTop('services', 'native', w))).toBe(w === 1 ? 1 : w)
    }
  })

  test('drops the badge before the title — the title is the only thing naming the pane', () => {
    const wide = paneTop('services', 'following', 40)
    const narrow = paneTop('services', 'following', 14)
    expect(wide.badge).toBe('following')
    expect(narrow.badge).toBe('')
    expect(narrow.title.length).toBeGreaterThan(0)
  })

  test('a pane too narrow for a title is still a box, just an anonymous one', () => {
    const top = paneTop('services', '', 5)
    expect(top.title).toBe('')
    expect(top.head.startsWith('╭')).toBe(true)
    expect(top.tail).toBe('╮')
  })
})

describe('paneTitleRoom', () => {
  // The inverse of `paneBadgeRoom`, for the caller whose BADGE is the thing that may not disappear:
  // a card puts the session handle there, and `paneTop` would drop it whole rather than cut the
  // project name in the title. Cutting the title first is what keeps the handle on the frame.
  test('a title cut to this width never costs a badge the frame could have drawn', () => {
    const long = 'a-very-long-project-name-indeed'
    for (const badge of ['a1b2c', 'following']) {
      for (let w = 0; w <= 120; w++) {
        // What the frame can do at ALL at this width: the shortest possible title, which is the
        // most room a badge can ever be given.
        const best = paneTop('x', badge, w).badge
        const cut = paneTop(truncate(long, paneTitleRoom(badge, w)), badge, w).badge
        expect(cut).toBe(best)
      }
      // And the cut is only ever as deep as the badge needs: with the badge gone, the title takes
      // everything the frame has.
      expect(paneTitleRoom('', 40)).toBeGreaterThan(paneTitleRoom(badge, 40))
    }
  })

  test('a pane with no badge gives the whole budget to the title', () => {
    expect(paneTitleRoom('', 40)).toBeGreaterThan(paneTitleRoom('a1b2c', 40))
    expect(paneTitleRoom('a1b2c', 0)).toBe(0)
  })
})

describe('cockpitLayout', () => {
  // Measured from the real screen: the two logical services, four config rows, and an enriched
  // detail pane — the alert or summary, the runtimes, the addresses and the machine's own settings,
  // each under its section rule.
  const content: CockpitContent = {
    services: 26,
    config: 30,
    serviceRows: 2,
    configRows: 4,
    detailRows: 14,
  }

  test('a comfortable terminal gets two band columns and all three panes', () => {
    const layout = cockpitLayout(118, 35, content)
    expect(layout.kind).toBe('columns')
    for (const h of Object.values(layout.heights)) expect(h).toBeGreaterThan(0)
  })

  test('THE BAND: its two panes are the same height, so neither ends in a hole', () => {
    for (let height = PANE_MIN_ROWS; height <= 60; height++) {
      const { heights } = cockpitLayout(118, height, content)
      expect(heights.services).toBe(heights.config)
    }
  })

  test('the band stops at its content, and everything under it is the detail pane', () => {
    // The fix for the dead region the log pane used to fill. The band is as tall as the taller of
    // its two panes wants — four config rows plus a frame — and never taller.
    const { heights } = cockpitLayout(118, 40, content)
    expect(heights.services).toBe(content.configRows + PANE_FRAME_Y)

    const short = cockpitLayout(118, 20, content)
    const tall = cockpitLayout(118, 40, content)
    expect(tall.heights.services).toBe(short.heights.services)
    expect(tall.heights.detail - short.heights.detail).toBe(40 - 20)
  })

  test('nothing overflows the body, and nothing is left dead in it', () => {
    for (let height = PANE_MIN_ROWS; height <= 60; height++) {
      const { heights, kind } = cockpitLayout(118, height, content)
      expect(kind).toBe('columns')
      // Band + detail is the whole body, exactly — no row unaccounted for in either direction.
      expect(heights.services + heights.detail).toBe(height)
    }
  })

  test('the DETAIL pane is served before the band — it is the one holding the verbs', () => {
    // At seven rows the band would like six and the detail pane would be left one, which cannot be
    // framed. The band gives way instead, and the config pane scrolls inside what it kept.
    const { heights } = cockpitLayout(118, 7, content)
    expect(heights.detail).toBeGreaterThanOrEqual(PANE_MIN_ROWS)
    expect(heights.services).toBeGreaterThanOrEqual(PANE_MIN_ROWS)
  })

  test('a question is reserved its rows out of the detail region, not out of the log', () => {
    const asked = cockpitLayout(118, 40, content, { question: true })
    expect(asked.heights.detail).toBeGreaterThanOrEqual(QUESTION_ROWS)
    // …and the band is still standing, so choosing an answer never costs sight of what is running.
    expect(asked.heights.services).toBeGreaterThanOrEqual(PANE_MIN_ROWS)
  })

  test('a question never overflows the body, at any height', () => {
    for (let height = PANE_MIN_ROWS; height <= 60; height++) {
      const { heights } = cockpitLayout(118, height, content, { question: true })
      expect(heights.services).toBe(heights.config)
      expect(heights.services + heights.detail).toBe(height)
    }
  })

  test('a body too short to frame anything keeps the services pane and nothing else', () => {
    for (const height of [1, 2]) {
      const { heights } = cockpitLayout(118, height, content)
      expect(heights.services).toBe(height)
      expect(heights.detail).toBe(0)
    }
  })

  test('the detail pane gives way last, and services is never dropped', () => {
    const tall = cockpitLayout(118, 30, content)
    const shorter = cockpitLayout(118, 8, content)
    const shortest = cockpitLayout(118, 4, content)
    expect(tall.heights.detail).toBeGreaterThan(shorter.heights.detail)
    expect(shortest.heights.detail).toBe(0)
    expect(shortest.heights.services).toBeGreaterThan(0)
  })

  test('the stack threshold is the two band columns measured floors, not a round number', () => {
    expect(cockpitLayout(COCKPIT_MIN_WIDTH, 30, content).kind).toBe('columns')
    expect(cockpitLayout(COCKPIT_MIN_WIDTH - 1, 30, content).kind).toBe('stacked')
    expect(COCKPIT_MIN_WIDTH).toBe(LEFT_MIN + RIGHT_MIN)
  })

  test('the columns keep their floors and never overrun the terminal', () => {
    for (let width = COCKPIT_MIN_WIDTH; width <= 200; width++) {
      const layout = cockpitLayout(width, 30, content)
      expect(layout.leftWidth).toBeGreaterThanOrEqual(LEFT_MIN)
      expect(layout.rightWidth).toBeGreaterThanOrEqual(RIGHT_MIN)
      expect(layout.leftWidth + layout.rightWidth).toBe(width)
    }
  })

  test('the services column never grows past its share, however long the translated words are', () => {
    const verbose = { ...content, services: 80 }
    const layout = cockpitLayout(120, 30, verbose)
    expect(layout.leftWidth).toBeLessThanOrEqual(Math.floor(120 * LEFT_MAX_SHARE))
  })

  test('the surplus goes to the CONFIG pane, which is the one that can spend it', () => {
    // `fitValue` shows the mode sentence and the whole endpoint URL as soon as the column holds
    // them whole, so a wide terminal buys something rather than padding a list of two rows.
    const layout = cockpitLayout(140, 30, content)
    expect(layout.leftWidth).toBe(content.services + PANE_FRAME_X)
    expect(layout.rightWidth).toBe(140 - layout.leftWidth)
  })

  test('stacked, the single column also adds up to exactly the body', () => {
    for (let height = 1; height <= 40; height++) {
      const { heights, kind } = cockpitLayout(28, height, content)
      expect(kind).toBe('stacked')
      expect(heights.services + heights.config + heights.detail).toBe(height)
    }
  })

  test('stacked, the priority is services then detail then config', () => {
    const { heights } = cockpitLayout(28, 9, content)
    expect(heights.services).toBeGreaterThan(0)
    expect(heights.detail).toBeGreaterThan(0)
    expect(heights.config).toBe(0)
  })

  test('a pane is either frameable or absent — never a frame with nothing inside it', () => {
    for (let width = 20; width <= 140; width += 7) {
      for (let height = 1; height <= 40; height++) {
        const { heights } = cockpitLayout(width, height, content)
        for (const [id, h] of Object.entries(heights)) {
          // The services pane is the one exception: below PANE_MIN_ROWS it comes back FRAMELESS
          // rather than disappearing, because a cockpit with no selection is a blank screen.
          if (id === 'services') continue
          expect(h === 0 || h >= PANE_MIN_ROWS).toBe(true)
        }
      }
    }
  })
})

describe('serviceCells', () => {
  const rows = [
    { label: 'agentistics', runtime: 'native', state: '● no ar' },
    { label: 'agentistics central', runtime: 'docker', state: '● desconhecido' },
    { label: 'agentistics', runtime: 'docker', state: '● parado' },
  ]

  test('a wide pane gets the measured widths, so the columns are aligned and not merely fitting', () => {
    const cells = serviceCells(rows, 80)
    expect(cells.label).toBe('agentistics central'.length)
    expect(cells.runtime).toBe('docker'.length)
    expect(cells.state).toBe('● desconhecido'.length)
  })

  test('the NAME is squeezed first, then the runtime cell goes, and the state WORD goes last', () => {
    // The order is the point, and it used to be the other way round: the runtime cell outlived the
    // word, so at every terminal under about a hundred columns the row read `agentistics
    // native+docker ▲` and the state was carried by a coloured glyph alone. The word is the cell
    // nothing else on the row repeats — the runtime is said again by the detail pane's badge and by
    // its conflict sentence — so it is the last thing this row gives up.
    const wide = serviceCells(rows, 80)
    const squeezed = serviceCells(rows, 36)
    const tight = serviceCells(rows, 30)
    const desperate = serviceCells(rows, 24)
    // The name gives way while both other cells are whole …
    expect(squeezed.runtime).toBe(wide.runtime)
    expect(squeezed.state).toBe(wide.state)
    expect(squeezed.label).toBeLessThan(wide.label)
    // … then the runtime cell, with the word still standing …
    expect(tight.runtime).toBe(0)
    expect(tight.state).toBe(wide.state)
    // … and only then is the state reduced to its glyph.
    expect(desperate.state).toBe(1)
  })

  /** The row the whole ladder exists for: the same program running under both runtimes. */
  const conflict = [
    { label: 'agentistics', runtime: 'native+docker', state: '▲ conflict' },
    { label: 'agentistics central', runtime: '', state: '○ stopped' },
  ]

  test('a conflicted row keeps SAYING conflict long after it can name the two runtimes', () => {
    // The bug: at a 90-column terminal (36 is what the services pane's body measures there) the row
    // read `agentistics  native+docker ▲` — two copies fighting over one port, announced by a red
    // triangle. Now the names are what give way, and the word survives to the width below.
    const c = serviceCells(conflict, 36)
    expect(c.state).toBe('▲ conflict'.length)
    expect(c.label).toBeGreaterThan('agentistics '.length)
    // And the names are still there whenever the row can afford them beside the word.
    expect(serviceCells(conflict, 50).runtime).toBe('native+docker'.length)
  })

  test('the state word is never dropped while a row that keeps it would have fit', () => {
    // The anti-idle-column property, stated as the ladder's contract rather than as a width: if the
    // narrowest rung that still says `conflict` fits, that is the rung. The old chain could pick a
    // glyph-only row and then leave the columns the word needed sitting empty beside it.
    for (const set of [rows, conflict]) {
      const state = Math.max(...set.map(r => r.state.length))
      for (let width = 1; width <= 90; width++) {
        const affordable = SERVICE_MARKER + Math.min(12, Math.max(...set.map(r => r.label.length))) + 1 + state
        if (width >= affordable) expect(serviceCells(set, width).state).toBe(state)
      }
    }
  })

  test('degrades monotonically — no cell comes back as the pane gets narrower', () => {
    // A wider pane never says less. The state and runtime cells are non-decreasing outright; the
    // NAME is allowed to dip, but only where a wider cell beside it is what took the columns — the
    // trade the ladder exists to make, with the row as a whole still gaining. Without this property
    // a ladder flickers on a resize.
    for (const set of [rows, conflict]) {
      for (let width = SERVICE_MARKER + 3; width < 90; width++) {
        const here = serviceCells(set, width)
        const wider = serviceCells(set, width + 1)
        expect(wider.runtime).toBeGreaterThanOrEqual(here.runtime)
        expect(wider.state).toBeGreaterThanOrEqual(here.state)
        if (wider.label < here.label) {
          expect(wider.runtime + wider.state).toBeGreaterThan(here.runtime + here.state)
        }
      }
    }
  })

  test('the state word is all of it or none — never a cut word beside a glyph', () => {
    for (let width = 1; width <= 90; width++) {
      const c = serviceCells(rows, width)
      expect(c.state === 0 || c.state === 1 || c.state === '● desconhecido'.length).toBe(true)
    }
  })

  test('the row always fits the pane it was measured against', () => {
    for (let width = 1; width <= 90; width++) {
      const c = serviceCells(rows, width)
      const used = SERVICE_MARKER + c.label + (c.runtime ? c.runtime + 1 : 0) + (c.state ? c.state + 1 : 0)
      expect(used).toBeLessThanOrEqual(Math.max(SERVICE_MARKER, width))
    }
  })

  test('no rows is no columns rather than a negative width', () => {
    expect(serviceCells([], 80)).toEqual({ label: 0, runtime: 0, state: 0 })
  })
})

describe('fitActions', () => {
  const labels = ['Restart', 'Stop', 'Open in browser', 'Stop all', 'Restart all']

  test('keeps every action when the row has room', () => {
    expect(fitActions(labels, 0, 120).labels).toEqual(labels)
  })

  test('the selected action is ALWAYS visible, wherever it is in the list', () => {
    for (let width = 6; width <= 80; width++) {
      for (let sel = 0; sel < labels.length; sel++) {
        const { labels: shown, from } = fitActions(labels, sel, width)
        expect(sel).toBeGreaterThanOrEqual(from)
        expect(sel).toBeLessThan(from + shown.length)
      }
    }
  })

  test('drops from the right while the selection allows it', () => {
    const { labels: shown, from } = fitActions(labels, 0, 20)
    expect(from).toBe(0)
    expect(shown[0]).toBe('Restart')
    expect(shown.length).toBeLessThan(labels.length)
  })

  test('never overflows once more than one action is showing', () => {
    for (let width = 6; width <= 80; width++) {
      const { labels: shown } = fitActions(labels, 2, width)
      if (shown.length > 1) {
        expect(SERVICE_MARKER + shown.join(ACTION_SEP).length).toBeLessThanOrEqual(width)
      }
    }
  })

  test('an empty action list is an empty row rather than a crash', () => {
    expect(fitActions([], 0, 40)).toEqual({ labels: [], from: 0 })
  })
})

describe('fitActionRow', () => {
  const starts = ['Start (this terminal)', 'Start (background)', 'Start (docker)', 'Start at boot']

  test('says nothing about a window when the whole row is the window', () => {
    const fit = fitActionRow(starts, 0, 120)
    expect(fit.labels).toEqual(starts)
    expect([fit.less, fit.more]).toEqual([false, false])
  })

  test('marks the verbs it left outside — an unseen start is a start that does not exist', () => {
    const fit = fitActionRow(starts, 0, 46)
    expect(fit.more).toBe(true)
    expect(fit.less).toBe(false)
    expect(fit.labels.length).toBeLessThan(starts.length)
  })

  test('marks both sides once the selection has scrolled into the middle', () => {
    const fit = fitActionRow(starts, 2, 30)
    expect(fit.less).toBe(true)
    expect(starts[2]).toBe(fit.labels[fit.labels.length - 1] ?? fit.labels[0])
  })

  test('the marks are paid for, so the row still fits at every width', () => {
    for (let width = 6; width <= 90; width++) {
      for (let sel = 0; sel < starts.length; sel++) {
        const fit = fitActionRow(starts, sel, width)
        const marks = (fit.less ? 2 : 0) + (fit.more ? 2 : 0)
        if (fit.labels.length > 1) {
          expect(SERVICE_MARKER + marks + fit.labels.join(ACTION_SEP).length).toBeLessThanOrEqual(width)
        }
        // The selected verb is never the one hidden — it is the row that would run a command.
        expect(sel).toBeGreaterThanOrEqual(fit.from)
        expect(sel).toBeLessThan(fit.from + fit.labels.length)
      }
    }
  })
})

describe('fitValue', () => {
  const sentence = 'member — sends metrics to a central'

  test('prefers the fuller wording whenever it fits whole', () => {
    expect(fitValue(sentence, 'member', 40)).toBe(sentence)
  })

  test('falls back to the short form rather than to a prefix of the long one', () => {
    expect(fitValue(sentence, 'member', 20)).toBe('member')
  })

  test('cuts only when even the fallback will not fit', () => {
    const out = fitValue(sentence, 'member', 4)
    expect(out.length).toBeLessThanOrEqual(4)
    expect(out.endsWith('…')).toBe(true)
  })

  test('no room at all is nothing, not a stray ellipsis', () => {
    expect(fitValue(sentence, 'member', 0)).toBe('')
  })
})

describe('stripScheme', () => {
  test('drops the least informative part of a cramped URL', () => {
    expect(stripScheme('http://198.51.100.199:48080')).toBe('198.51.100.199:48080')
    expect(stripScheme('https://central.example.com/x')).toBe('central.example.com/x')
  })

  test('leaves something that is not a URL alone', () => {
    expect(stripScheme('localhost:47292')).toBe('localhost:47292')
    expect(stripScheme('')).toBe('')
  })
})

describe('formatUptime', () => {
  const MIN = 60_000

  test('never shows more than two units', () => {
    expect(formatUptime(45_000)).toBe('45s')
    expect(formatUptime(9 * MIN)).toBe('9m')
    expect(formatUptime(134 * MIN)).toBe('2h14m')
    expect(formatUptime(3 * 24 * 60 * MIN + 4 * 60 * MIN)).toBe('3d4h')
  })

  test('a clock that ran backwards says nothing rather than a negative age', () => {
    expect(formatUptime(-1)).toBe('')
    expect(formatUptime(Number.NaN)).toBe('')
  })
})

describe('detailContent', () => {
  const s = controlStrings('en')
  const NOW = 1_700_000_000_000

  /** One runtime of a service, as the host reports it. */
  const runtime = (over: Partial<ServiceRuntimeState> = {}): ServiceRuntimeState => ({
    id: 'local',
    kind: 'native',
    state: 'up',
    available: true,
    ...over,
  })

  /**
   * A logical service. Facts live on the RUNTIME, which is the whole point of the model: a service
   * has no pid of its own, the way it happens to be running does.
   */
  const service = (over: Partial<ControlService> = {}): ControlService => {
    const runtimes = over.runtimes ?? [runtime()]
    const up = runtimes.filter(r => r.state === 'up')
    return {
      id: 'agentistics',
      label: 'agentistics',
      state: up.length > 0 ? 'up' : 'down',
      runtimes,
      running: up.map(r => r.id),
      active: up[0],
      startOptions: [],
      restartOptions: [],
      stopOptions: [],
      bootOptions: [],
      ...over,
    }
  }

  /** Every `text` line, in order — the sentences the pane leads with. */
  const texts = (c: ReturnType<typeof detailContent>) =>
    c.lines.filter(l => l.kind === 'text').map(l => l.value)
  /** Every `row` line under a given section title. */
  const rowsUnder = (c: ReturnType<typeof detailContent>, section: string) => {
    const from = c.lines.findIndex(l => l.kind === 'section' && l.label === section)
    if (from < 0) return []
    const out: { label: string; value: string }[] = []
    for (const line of c.lines.slice(from + 1)) {
      if (line.kind === 'section') break
      if (line.kind === 'row') out.push({ label: line.label, value: line.value })
    }
    return out
  }

  test('states the runtime, the pid and the uptime of a running native server', () => {
    const c = detailContent(
      service({ runtimes: [runtime({ pid: 48213, startedAt: NOW - 134 * 60_000 })] }),
      s,
      NOW,
    )
    expect(texts(c)).toEqual(['native · pid 48213 · up 2h14m'])
    expect(c.alert).toBe('')
  })

  test('names a second copy that is running and serving nothing', () => {
    // The seventy-minute incident: a second `agentop server` could not bind the ports and kept the
    // file watcher going anyway, burning a core for nobody. Every runtime probe asks
    // `lsof -sTCP:LISTEN` and therefore CANNOT see it, so the service row read perfectly healthy.
    const c = detailContent(
      service({ idle: 'a second server (pid 3189270) is running and serving nothing — kill 3189270' }),
      s,
      NOW,
    )
    expect(texts(c).join(' ')).toContain('3189270')
  })

  test('says the conflict AND the idle copy when both are true', () => {
    // Different faults with different answers — one asks which runtime to stop, the other names a
    // pid doing work for nobody. Folding them into one sentence would lose an instruction.
    const c = detailContent(
      service({ conflict: 'conflict: native + docker both running — stop one', idle: 'a second server (pid 7) …' }),
      s,
      NOW,
    )
    const said = texts(c).join(' ')
    expect(said).toContain('conflict')
    expect(said).toContain('pid 7')
  })

  test('says nothing about a pid the box would not give up — never `pid 0`', () => {
    const c = detailContent(service(), s, NOW)
    expect(texts(c)).toEqual(['native'])
    expect(texts(c).join(' ')).not.toContain('pid')
  })

  test('lists EVERY runtime this box could run it under, with its own state', () => {
    // The pane's whole job after the enrichment: a service is one row in the list and two ways of
    // running it, and which of them is up is not something the list has room to say.
    const c = detailContent(
      service({ runtimes: [runtime({ pid: 48213 }), runtime({ id: 'machine', kind: 'docker', state: 'down' })] }),
      s,
      NOW,
    )
    const rows = rowsUnder(c, s.sectionRuntimes)
    expect(rows.map(r => r.label)).toEqual(['native', 'docker'])
    expect(rows[0]!.value).toContain(s.stateUp)
    expect(rows[0]!.value).toContain('48213')
    expect(rows[1]!.value).toContain(s.stateDown)
  })

  test('a runtime this box cannot run at all says WHY, on its own row', () => {
    // "docker not installed" is the answer to "why does this service offer me nothing", which is
    // the most confusing thing a service panel can fail to say.
    const c = detailContent(
      service({
        runtimes: [
          runtime({ state: 'down' }),
          runtime({ id: 'machine', kind: 'docker', state: 'unknown', available: false, reason: 'docker not installed' }),
        ],
      }),
      s,
      NOW,
    )
    expect(rowsUnder(c, s.sectionRuntimes)[1]!.value).toContain('docker not installed')
  })

  test('a service with ONE runtime states the reason once, at the top where a short pane keeps it', () => {
    // The central on a box without docker: the note answers "why does this offer me nothing", and
    // repeating it on the single runtime row would spend two of a three-row pane on one fact.
    const c = detailContent(
      service({
        state: 'down',
        runtimes: [runtime({ id: 'central', kind: 'docker', state: 'unknown', available: false, reason: 'docker not installed' })],
      }),
      s,
      NOW,
    )
    expect(texts(c)).toContain('docker not installed')
    expect(rowsUnder(c, s.sectionRuntimes)[0]!.value).not.toContain('docker not installed')
  })

  test('every state word is paired with a glyph, so colour never carries it alone', () => {
    const c = detailContent(
      service({
        runtimes: [
          runtime(),
          runtime({ id: 'machine', kind: 'docker', state: 'down' }),
        ],
      }),
      s,
      NOW,
    )
    for (const row of rowsUnder(c, s.sectionRuntimes)) {
      expect(['●', '○', '?']).toContain(row.value.slice(0, 1))
    }
  })

  test('names the api only when it is a different address from the dashboard', () => {
    const split = detailContent(
      service({ runtimes: [runtime({ webUrl: 'http://localhost:47292', apiUrl: 'http://localhost:47291' })] }),
      s,
      NOW,
    )
    const single = detailContent(
      service({ runtimes: [runtime({ webUrl: 'http://localhost:48080', apiUrl: 'http://localhost:48080' })] }),
      s,
      NOW,
    )
    expect(rowsUnder(split, s.sectionAddresses).map(r => r.label)).toEqual([s.webLabel, s.apiLabel])
    expect(rowsUnder(single, s.sectionAddresses).map(r => r.label)).toEqual([s.webLabel])
  })

  test('a service with no addresses gets no ADDRESSES rule — a heading for nothing says nothing', () => {
    const c = detailContent(service({ runtimes: [runtime({ state: 'down' })] }), s, NOW)
    expect(c.lines.some(l => l.kind === 'section' && l.label === s.sectionAddresses)).toBe(false)
  })

  test('boot is stated when the host can tell, and OMITTED when it cannot', () => {
    // The N/A-versus-real-0 rule: a service that says "does not start at boot" when nobody asked
    // systemd is a fact the user acts on by installing a unit they already have.
    const known = detailContent(service({ boot: 'on' }), s, NOW)
    expect(rowsUnder(known, s.sectionMachine)).toContainEqual({ label: s.bootLabel, value: s.bootOn })

    const off = detailContent(service({ boot: 'off' }), s, NOW)
    expect(rowsUnder(off, s.sectionMachine)).toContainEqual({ label: s.bootLabel, value: s.bootOff })

    const unknown = detailContent(service(), s, NOW)
    expect(rowsUnder(unknown, s.sectionMachine).map(r => r.label)).not.toContain(s.bootLabel)
  })

  test('the boot row NAMES the unit, which is the only thing a user can go and look at', () => {
    // "starts at boot" on its own tells someone that SOMETHING will bring their central back and
    // gives them nowhere to go. With the unit named, `systemctl --user status <unit>` answers, and
    // the verb that removes it is on the same pane.
    const named = detailContent(service({ boot: 'on', bootUnit: 'agentop-central.service' }), s, NOW)
    const row = rowsUnder(named, s.sectionMachine).find(r => r.label === s.bootLabel)
    expect(row?.value).toContain(s.bootOn)
    expect(row?.value).toContain('agentop-central.service')
  })

  test('a unit with no boot state is not stated at all', () => {
    // The unit is a detail OF the state. Printing it where the state is unknown would answer a
    // question the pane has just declined to answer.
    const c = detailContent(service({ bootUnit: 'agentop-server.service' }), s, NOW)
    expect(rowsUnder(c, s.sectionMachine).map(r => r.value).join(' ')).not.toContain('agentop-server')
  })

  test("the machine's own facts land under their own rule, in the order they were given", () => {
    const c = detailContent(service({ boot: 'on' }), s, NOW, {
      rows: [
        { label: s.historyLabel, value: 'consolidate' },
        { label: s.endpointLabel, value: 'http://198.51.100.199:48080' },
      ],
    })
    expect(rowsUnder(c, s.sectionMachine).map(r => r.label))
      .toEqual([s.bootLabel, s.historyLabel, s.endpointLabel])
  })

  test('a stopped service says so, and an undetectable one explains itself', () => {
    const down = detailContent(
      service({ runtimes: [runtime({ id: 'central', kind: 'docker', state: 'down' })] }),
      s,
      NOW,
    )
    // Nothing is running, so there is no runtime to name — only the state.
    expect(texts(down)[0]).toBe(s.stateDown)

    const unknown = detailContent(
      service({
        state: 'unknown',
        runtimes: [runtime({ kind: 'docker', state: 'unknown' })],
        reason: 'docker not installed',
      }),
      s,
      NOW,
    )
    expect(texts(unknown)[0]).toContain(s.stateUnknown)
    expect(texts(unknown)).toContain('docker not installed')
  })

  test('a conflict LEADS, in its own field as well as its own line', () => {
    const c = detailContent(
      service({
        runtimes: [runtime(), runtime({ id: 'machine', kind: 'docker' })],
        conflict: 'conflict — native and docker are both running; stop one',
      }),
      s,
      NOW,
    )
    // Nothing this pane can say is worth a row before two copies fighting over one port — and the
    // sentence names both runtimes, so the danger colour never carries it alone.
    expect(c.lines[0]!.value).toBe(c.alert)
    expect(c.lines[0]!.tone).toBe('bad')
    expect(c.alert).toContain('docker')
  })

  test('the label column is measured across the ROWS, so every value lines up', () => {
    const c = detailContent(service({ boot: 'on' }), s, NOW, {
      rows: [{ label: 'a-very-long-label', value: 'x' }],
    })
    expect(c.labelWidth).toBe('a-very-long-label'.length)
    for (const line of c.lines) {
      if (line.kind === 'row') expect(line.label.length).toBeLessThanOrEqual(c.labelWidth)
    }
  })
})

describe('fitDetailLines', () => {
  const s = controlStrings('en')
  const line = (kind: 'section' | 'row' | 'text' | 'blank', label = '', value = '') =>
    ({ kind, label, value, tone: 'plain' as const })
  const lines = [
    line('text', '', 'native · pid 1'),
    line('blank'),
    line('section', s.sectionRuntimes),
    line('row', 'native', '● up'),
    line('blank'),
    line('section', s.sectionAddresses),
    line('row', 'web', 'http://localhost:47292'),
  ]

  test('keeps everything when the pane can hold it', () => {
    expect(fitDetailLines(lines, 20)).toEqual(lines)
  })

  test('never leaves a rule heading nothing, nor a blank hanging off the last fact', () => {
    // A cut that lands right after `ADDRESSES ─────` spends a row on a heading for nothing, which
    // is exactly the row the pane was short of.
    for (let max = 0; max <= lines.length; max++) {
      const kept = fitDetailLines(lines, max)
      expect(kept.length).toBeLessThanOrEqual(max)
      const last = kept[kept.length - 1]
      if (last) expect(['section', 'blank']).not.toContain(last.kind)
    }
  })

  test('cuts from the BOTTOM, so the conflict and the summary always survive', () => {
    expect(fitDetailLines(lines, 1)).toEqual([lines[0]!])
  })

  test('a pane with no rows draws nothing rather than one orphan rule', () => {
    expect(fitDetailLines(lines, 0)).toEqual([])
    expect(fitDetailLines([line('section', 'X')], 1)).toEqual([])
  })
})

describe('detailPlan', () => {
  test('the action row is the last thing to go, and it lands on the pane floor', () => {
    const plan = detailPlan(9, 4, true)
    expect(plan.facts).toBe(4)
    expect(plan.actions).toBe(true)
    // 4 facts + 4 blank + the verbs = the 9 rows the pane has, with the verbs on the last one.
    expect(plan.pad).toBe(4)
    expect(plan.facts + plan.pad + 1).toBe(9)
  })

  test('a one-row pane is the verbs alone — a readout is not what this pane is for', () => {
    expect(detailPlan(1, 4, true)).toEqual({ facts: 0, pad: 0, actions: true })
  })

  test('with nothing to run, the facts take the pane and no padding is drawn', () => {
    expect(detailPlan(6, 2, false)).toEqual({ facts: 2, pad: 0, actions: false })
  })

  test('never spends more rows than the pane has, at any content size', () => {
    for (let rows = 0; rows <= 20; rows++) {
      for (let facts = 0; facts <= 8; facts++) {
        for (const acts of [true, false]) {
          const p = detailPlan(rows, facts, acts)
          expect(p.facts + p.pad + (p.actions ? 1 : 0)).toBeLessThanOrEqual(Math.max(0, rows))
          expect(p.pad).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })
})

describe('cockpitHints', () => {
  const s = controlStrings('en')
  /** The comfortable case: every pane drawn, so only the selection gates anything. */
  const full = { canAct: true, canStop: true, canOpen: true, panes: 4 }

  test('the action row says nothing about screens, because it has taken the arrows', () => {
    const hints = cockpitHints('actions', s, full)
    expect(hints).not.toContain(s.keyTabs)
    expect(hints).toContain(s.keyActionMove)
    // …and it leads with the way back out, which is what makes the screens reachable again.
    expect(hints[0]).toBe(s.keyBack)
  })

  test('never offers stop or open for a service that cannot be stopped or opened', () => {
    const down = cockpitHints('services', s, { canAct: true, canStop: false, canOpen: false, panes: 4 })
    expect(down).not.toContain(s.keyStop)
    expect(down).not.toContain(s.keyRestart)
    expect(down).not.toContain(s.keyOpen)
    const up = cockpitHints('services', s, full)
    expect(up).toContain(s.keyStop)
    expect(up).toContain(s.keyOpen)
  })

  test('every focus can say how to leave and how to change pane', () => {
    for (const focus of PANE_ORDER) {
      const hints = cockpitHints(focus, s, { canAct: true, canStop: true, canOpen: false, panes: 3 })
      expect(hints).toContain(s.keyPane)
      // The action row's way out is `esc` back to the list, not `q` out of the app.
      expect(hints.includes(s.keyQuit) || hints.includes(s.keyBack)).toBe(true)
    }
  })

  test('a lone pane never advertises the key that would cycle it', () => {
    // A short terminal keeps the services pane and drops the other two; `tab` there is a no-op,
    // and the footer is the only documentation this screen has.
    for (const focus of PANE_ORDER) {
      const hints = cockpitHints(focus, s, { canAct: true, canStop: true, canOpen: true, panes: 1 })
      expect(hints).not.toContain(s.keyPane)
      // …and the row still says how to leave, which is what it can least afford to lose.
      expect(hints.includes(s.keyQuit) || hints.includes(s.keyBack)).toBe(true)
    }
    expect(cockpitHints('services', s, { ...full, panes: 2 })).toContain(s.keyPane)
  })

  test('a selection with no verbs at all never advertises the key that would open them', () => {
    // A central on a box with no docker: down, and unstartable here. `enter` opens nothing.
    const hints = cockpitHints('services', s, { ...full, canAct: false, canStop: false, canOpen: false })
    expect(hints).not.toContain(s.keyActions)
    expect(hints).toContain(s.keyQuit)
  })

  test('no focus offers a log key — the cockpit has no log pane to follow', () => {
    for (const focus of PANE_ORDER) {
      const hints = cockpitHints(focus, s, { canAct: true, canStop: true, canOpen: true, panes: 3 })
      expect(hints).not.toContain(s.logFollow)
      expect(hints).not.toContain(s.keyLogSource)
    }
  })

  /**
   * A task streaming into the detail region owns the whole screen: the services underneath it are not
   * selectable, and the shell's global keys have stood down (`capture`), so a row naming any of them
   * would be advertising a key that does nothing — the exact bug this function exists to prevent.
   */
  test('a running task names its three keys, whatever the focus was, and nothing else', () => {
    for (const focus of PANE_ORDER) {
      const hints = cockpitHints(focus, s, { ...full, task: true })
      expect(hints).toEqual([s.keyTaskClose, s.keyScroll, s.logFollow])
      // Not the screen keys, not quit, and nothing about the selection underneath.
      expect(hints).not.toContain(s.keyTabs)
      expect(hints).not.toContain(s.keyQuit)
      expect(hints).not.toContain(s.keyStop)
    }
  })

  test('the way out of the output pane leads, because it is the way back to everything else', () => {
    expect(cockpitHints('services', s, { ...full, task: true })[0]).toBe(s.keyTaskClose)
  })
})

describe('pane frame constants', () => {
  test('a pane costs a border and a padding column on each side', () => {
    expect(PANE_FRAME_X).toBe(4)
    expect(PANE_FRAME_Y).toBe(2)
    expect(PANE_MIN_ROWS).toBe(PANE_FRAME_Y + 1)
  })
})

describe('tabAtColumn', () => {
  const tabs: TabSpec[] = TAB_ORDER.map(id => ({ id, label: id }))

  test('resolves every column of the strip against the cells fitTabs drew', () => {
    const layout = fitTabs(tabs, 'services', 200)
    if (layout.kind !== 'full') throw new Error('expected the full strip at 200 columns')

    // Walked cell by cell rather than at a handful of magic columns: the guarantee is that the whole
    // strip is live, and that no column answers with the tab beside the one under it.
    let x = 0
    for (const cell of layout.cells) {
      for (let i = 0; i < cell.width; i++) {
        expect(tabAtColumn(layout, x + i)).toEqual({ kind: 'tab', id: cell.id })
      }
      // The gap after a cell belongs to that cell: one column of air between two names is not a
      // dead stripe down a bar whose whole job is to be pointed at.
      expect(tabAtColumn(layout, x + cell.width)).toEqual({ kind: 'tab', id: cell.id })
      x += cell.width + 1
    }
    expect(tabAtColumn(layout, x)).toBeNull()
  })

  test('claims nothing before the strip', () => {
    expect(tabAtColumn(fitTabs(tabs, 'services', 200), -1)).toBeNull()
  })

  test('makes the collapsed form’s arrows live, and only when they are drawn', () => {
    const narrow = fitTabs(tabs, 'logs', 14)
    if (narrow.kind !== 'collapsed') throw new Error('expected the collapsed strip at 14 columns')

    expect(narrow.hasPrev).toBe(true)
    expect(tabAtColumn(narrow, 0)).toEqual({ kind: 'prev' })
    expect(tabAtColumn(narrow, 2)).toEqual({ kind: 'tab', id: 'logs' })
    expect(tabAtColumn(narrow, 2 + narrow.label.length)).toEqual({ kind: 'next' })

    // On the first tab there is no `‹`, so those two columns answer nothing rather than wrapping.
    const first = fitTabs(tabs, TAB_ORDER[0]!, 14)
    if (first.kind !== 'collapsed') throw new Error('expected the collapsed strip')
    expect(first.hasPrev).toBe(false)
    expect(tabAtColumn(first, 0)).toBeNull()
  })

  test('says nothing about an empty strip', () => {
    expect(tabAtColumn(fitTabs([], 'services', 80), 0)).toBeNull()
  })
})

describe('cockpitRects', () => {
  const content: CockpitContent = {
    services: 30, config: 26, serviceRows: 2, configRows: 5, detailRows: 12,
  }

  test('covers the band and everything under it, with no cell claimed twice', () => {
    const width = 120
    const height = 30
    const layout = cockpitLayout(width, height, content)
    const rects = cockpitRects(layout)
    if (layout.kind !== 'columns') throw new Error('expected the cockpit at 120x30')

    // The band is two columns of EQUAL height, side by side, spanning the width.
    expect(rects.config).not.toBeNull()
    expect(rects.services.height).toBe(rects.config!.height)
    expect(rects.services.x + rects.services.width).toBe(rects.config!.x)
    expect(rects.config!.x + rects.config!.width).toBe(width)

    // The detail pane starts where the band ends and runs to the bottom, at the full width.
    expect(rects.detail).not.toBeNull()
    expect(rects.detail!.y).toBe(rects.services.height)
    expect(rects.detail!.width).toBe(width)
    expect(rects.detail!.y + rects.detail!.height).toBe(height)
  })

  test('stacks in the order the screen DRAWS them — services, detail, config', () => {
    // The render order is not the declaration order: the detail pane belongs directly under the
    // selection that drives it. Assuming otherwise would hand every click on the config pane to the
    // detail pane, on exactly the terminals where the panes are hardest to tell apart.
    const width = COCKPIT_MIN_WIDTH - 1
    const layout = cockpitLayout(width, 30, content)
    if (layout.kind !== 'stacked') throw new Error('expected the stacked fallback below COCKPIT_MIN_WIDTH')
    const rects = cockpitRects(layout)

    expect(rects.services.y).toBe(0)
    expect(rects.detail!.y).toBe(layout.heights.services)
    expect(rects.config!.y).toBe(layout.heights.services + layout.heights.detail)
    expect(rects.config!.y + rects.config!.height).toBe(30)
    for (const rect of [rects.services, rects.detail!, rects.config!]) expect(rect.width).toBe(width)
  })

  test('gives no rectangle to a pane the layout dropped', () => {
    // A short body keeps the services pane alone; a rectangle for a pane that is not on screen would
    // be a click landing on a frame nobody can see.
    const layout = cockpitLayout(120, PANE_MIN_ROWS, content)
    const rects = cockpitRects(layout)
    expect(rects.detail).toBeNull()
    expect(rects.services.height).toBeGreaterThan(0)
  })
})

describe('actionAtColumn', () => {
  const labels = ['Restart', 'Stop', 'Open in browser']

  test('names the verb the row actually drew there', () => {
    const fit = fitActionRow(labels, 0, 60)
    expect(fit.labels).toEqual(labels)

    let x = SERVICE_MARKER
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!
      expect(actionAtColumn(fit, x)).toBe(i)
      expect(actionAtColumn(fit, x + label.length - 1)).toBe(i)
      x += label.length + ACTION_SEP.length
    }
  })

  test('gives the separator to neither verb', () => {
    const fit = fitActionRow(labels, 0, 60)
    const gap = SERVICE_MARKER + labels[0]!.length
    // Three columns of air between `Restart` and `Stop` is a pointer's margin for error, and a
    // click there had better do nothing rather than stop a server the user was aiming past.
    for (let i = 0; i < ACTION_SEP.length; i++) expect(actionAtColumn(fit, gap + i)).toBeNull()
  })

  test('claims neither the reserved cursor cell nor the window marks', () => {
    const fit = fitActionRow(labels, 0, 60)
    expect(actionAtColumn(fit, 0)).toBeNull()
    expect(actionAtColumn(fit, SERVICE_MARKER - 1)).toBeNull()
  })

  test('maps back to the FULL list when the row is a window', () => {
    // The verbs are a slice; the caller runs an index into the real list, so a scrolled row must not
    // report `0` for whatever happens to be leftmost.
    const many = ['Start (foreground)', 'Start (background)', 'Start (docker)', 'Start at boot']
    const fit = fitActionRow(many, many.length - 1, 34)
    expect(fit.from).toBeGreaterThan(0)
    expect(fit.less).toBe(true)

    const first = SERVICE_MARKER + 2 // the `‹ ` mark comes out of the row before it is fitted
    expect(actionAtColumn(fit, first)).toBe(fit.from)
    expect(actionAtColumn(fit, first - 1)).toBeNull()
  })

  test('says nothing about an empty row', () => {
    expect(actionAtColumn(fitActionRow([], 0, 40), 2)).toBeNull()
  })
})

describe('paneBadgeRoom', () => {
  // The contract is exact: a badge cut to this length must actually be DRAWN, and one character
  // longer must be the case `paneTop` drops. A room that is merely "about right" is a badge that
  // vanishes on some widths and not others.
  test('is exactly the length paneTop will draw', () => {
    for (let w = 0; w <= 80; w++) {
      const room = paneBadgeRoom('3f5f', w)
      if (room === 0) continue
      expect(paneTop('3f5f', 'x'.repeat(room), w).badge).toBe('x'.repeat(room))
      expect(paneTop('3f5f', 'x'.repeat(room + 1), w).badge).toBe('')
    }
  })

  test('answers zero on a pane with no room for one', () => {
    expect(paneBadgeRoom('3f5f', 6)).toBe(0)
    expect(paneBadgeRoom('3f5f', 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GL-02 — the attention counter's words
// ---------------------------------------------------------------------------

describe('attentionCell (GL-02)', () => {
  test('says how many need you, plural-correct in both languages', () => {
    expect(attentionCellGL02(1, 'en')).toBe('● 1 needs you')
    expect(attentionCellGL02(2, 'en')).toBe('● 2 need you')
    expect(attentionCellGL02(1, 'pt')).toBe('● 1 precisa de você')
    expect(attentionCellGL02(3, 'pt')).toBe('● 3 precisam de você')
  })

  test('the bell rings on the TRANSITION into waiting, never on the level', () => {
    expect(attentionRingsGL02(0, 1)).toBe(true)
    expect(attentionRingsGL02(0, 3)).toBe(true)
    expect(attentionRingsGL02(1, 1)).toBe(false)
    expect(attentionRingsGL02(2, 1)).toBe(false)
    expect(attentionRingsGL02(1, 0)).toBe(false)
    expect(attentionRingsGL02(0, 0)).toBe(false)
  })

  test('draws NOTHING at zero — absence is the calm state, never "0 need you"', () => {
    expect(attentionCellGL02(0, 'en')).toBe('')
    expect(attentionCellGL02(0, 'pt')).toBe('')
    expect(headerMeta({ mode: 'solo', version: '1.7.4', attention: 0, width: 80 }).alert).toBe('')
  })

  test('the header carries the words in the chosen language', () => {
    expect(headerMeta({ mode: 'solo', version: '1.7.4', attention: 2, width: 80 }).alert).toBe('● 2 need you')
    expect(headerMeta({ mode: 'solo', version: '1.7.4', attention: 2, lang: 'pt', width: 80 }).alert)
      .toBe('● 2 precisam de você')
  })

  test('under width pressure the WORDS go before the number, and the number before the mode', () => {
    const tight = headerMeta({ mode: 'solo', version: '1.7.4', attention: 4, lang: 'pt', width: 12 })
    expect(tight.alert).toBe('● 4')
    expect(tight.text).toBe('solo')
    for (let width = 0; width <= 90; width++) {
      for (const lang of ['en', 'pt'] as const) {
        const meta = headerMeta({ mode: 'member', version: '1.7.3', latestVersion: '1.7.4', attention: 9, lang, width })
        expect(headerMetaWidth(meta)).toBeLessThanOrEqual(width)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// GL-07 — one pane at a time on a narrow terminal
// ---------------------------------------------------------------------------

describe('narrow cockpit (GL-07)', () => {
  const content = { services: 30, config: 30, serviceRows: 2, configRows: 4, detailRows: 12 }

  test('the threshold is 100 columns of body, the one the code tab uses too', () => {
    expect(NARROW_WIDTH_GL07).toBe(100)
    expect(narrowTerminalGL07(78)).toBe(true)
    expect(narrowTerminalGL07(99)).toBe(true)
    expect(narrowTerminalGL07(100)).toBe(false)
  })

  test('draws exactly ONE pane, under the strip, and never overflows the body', () => {
    for (const single of ['services', 'config', 'detail'] as const) {
      for (let height = 1; height <= 40; height++) {
        const layout = cockpitLayout(78, height, content, { single })
        expect(layout.kind).toBe('single')
        const drawn = Object.values(layout.heights).filter(h => h > 0)
        expect(drawn.length).toBe(1)
        expect((layout.strip ?? 0) + drawn[0]!).toBeLessThanOrEqual(Math.max(height, 1 + (layout.strip ?? 0)))
        if (height >= 2) expect((layout.strip ?? 0) + drawn[0]!).toBe(height)
        expect(layout.leftWidth).toBe(78)
      }
    }
    expect(cockpitLayout(78, 22, content, { single: 'config' }).shown).toBe('config')
    expect(cockpitLayout(78, 22, content, { single: 'config' }).strip).toBe(STRIP_ROWS_GL07)
  })

  test('a question or a running task takes the detail pane, whichever pane was asked for', () => {
    const layout = cockpitLayout(78, 22, content, { single: 'services', question: true })
    expect(layout.shown).toBe('detail')
    expect(layout.heights.detail).toBe(21)
    expect(layout.heights.services).toBe(0)
  })

  test('only the drawn pane has a rectangle, and it sits under the strip', () => {
    const layout = cockpitLayout(78, 22, content, { single: 'config' })
    const rects = cockpitRects(layout)
    expect(rects.config).toEqual({ x: 0, y: 1, width: 78, height: 21 })
    expect(rects.detail).toBeNull()
    expect(rects.services.width * rects.services.height).toBe(0)
  })

  test('the strip names every pane and marks the shown one; a column resolves back to its pane', () => {
    const labels = ['services', 'config', 'detail']
    const cells = paneStripGL07(labels, 1, 78)
    expect(cells.map(c => c.label)).toEqual(labels)
    expect(cells.filter(c => c.active).map(c => c.label)).toEqual(['config'])
    expect(stripAtGL07(cells, labels, cells[2]!.x)).toBe(2)
    expect(stripAtGL07(cells, labels, 0)).toBe(-1)
    // Too narrow for all three: the shown one survives, and nothing is wider than the row.
    const tight = paneStripGL07(labels, 2, 10)
    expect(tight).toHaveLength(1)
    expect(tight[0]!.label).toBe('detail')
  })

  test('the footer names esc on the narrow config pane, and no verb keys on a verbless detail', () => {
    const s = controlStrings('en')
    const base = { canAct: true, canStop: true, canOpen: false, panes: 3 }
    expect(cockpitHints('config', s, { ...base, narrow: true })).toContain(s.keyBack)
    expect(cockpitHints('config', s, base)).not.toContain(s.keyBack)
    const verbless = cockpitHints('actions', s, { ...base, canAct: false, narrow: true })
    expect(verbless).not.toContain(s.keyRun)
    expect(verbless).not.toContain(s.keyActionMove)
    expect(verbless).toContain(s.keyBack)
  })
})
