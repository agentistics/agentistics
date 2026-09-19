import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { panelBarEntries } from '../../lib/panelBar'
import {
  BAND_CONTROL_H, BandLabeledButton, BandOverflowMenu, BandSegment, BandSegmentTab, PanelBar,
} from './bandControls'

/**
 * Design item 3 (screenshot 1: "the buttons are non-standard sizes and it is very confusing") —
 * the ONE thing this module exists to guarantee is that every control it exports renders at the
 * SAME height. A live browser pass measures the real `getBoundingClientRect()`; this file pins the
 * STYLE STRINGS that measurement depends on, so a future edit that reintroduces a mismatch (a
 * `minHeight` swapped back in for `height`, a wrapper's padding added back on top of its own fixed
 * height) fails here before it ever needs a browser to catch.
 */

describe('every desktop control renders the same height', () => {
  test('BandLabeledButton', () => {
    const html = renderToStaticMarkup(
      <BandLabeledButton label="Move to the right" visibleText="Move to the right" isMobile={false} onClick={() => {}}>
        <span />
      </BandLabeledButton>,
    )
    expect(html).toContain(`height:${BAND_CONTROL_H}px`)
    expect(html).toContain('box-sizing:border-box')
  })

  test('BandSegment (the wrapper itself, not just its tabs)', () => {
    const html = renderToStaticMarkup(
      <BandSegment label="Which terminal" isMobile={false}><span /></BandSegment>,
    )
    expect(html).toContain(`height:${BAND_CONTROL_H}px`)
    expect(html).toContain('box-sizing:border-box')
  })

  // Plant: drop `boxSizing: 'border-box'` from `BandSegment`'s style (revert to the original defect
  // — a content-sized wrapper whose padding is ADDED on top of its children's height, measuring
  // taller than the pills beside it). This test would then still find `height:26px` in the markup
  // (the property survives) but the ACTUAL rendered box no longer equals it — which is exactly why
  // the browser pass, not only this string check, is what item 3's verification asks for. This test
  // instead guards the one thing a unit test CAN prove: the property is still there at all.
  test('mobile targets are 44px on every one of them, never 26px', () => {
    const labeled = renderToStaticMarkup(
      <BandLabeledButton label="x" visibleText="x" isMobile={true} onClick={() => {}}><span /></BandLabeledButton>,
    )
    const segment = renderToStaticMarkup(<BandSegment label="x" isMobile={true}><span /></BandSegment>)
    for (const html of [labeled, segment]) {
      expect(html).toContain('height:44px')
      expect(html).not.toContain(`height:${BAND_CONTROL_H}px`)
    }
  })

  test('BandSegmentTab fills the wrapper via height:100%, never a second fixed number', () => {
    const html = renderToStaticMarkup(
      <BandSegmentTab on={false} onClick={() => {}} label="Shell" />,
    )
    expect(html).toContain('height:100%')
  })
})

describe('BandSegmentTab — on/off styling matches the band segment\'s own visual language', () => {
  test('on: bg-surface / text-primary, role="tab" aria-selected="true"', () => {
    const html = renderToStaticMarkup(<BandSegmentTab on={true} onClick={() => {}} label="Shell" />)
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('background:var(--bg-surface)')
    expect(html).toContain('color:var(--text-primary)')
  })

  test('off: transparent / text-tertiary, aria-selected="false"', () => {
    const html = renderToStaticMarkup(<BandSegmentTab on={false} onClick={() => {}} label="Shell" />)
    expect(html).toContain('aria-selected="false"')
    expect(html).toContain('background:transparent')
    expect(html).toContain('color:var(--text-tertiary)')
  })
})

describe('BandLabeledButton — pressed is optional, and only rendered when given', () => {
  test('omitted entirely: no aria-pressed attribute at all', () => {
    const html = renderToStaticMarkup(
      <BandLabeledButton label="x" visibleText="x" isMobile={false} onClick={() => {}}><span /></BandLabeledButton>,
    )
    expect(html).not.toContain('aria-pressed')
  })

  test('given: renders the exact boolean', () => {
    const on = renderToStaticMarkup(
      <BandLabeledButton label="x" visibleText="x" isMobile={false} onClick={() => {}} pressed={true}><span /></BandLabeledButton>,
    )
    const off = renderToStaticMarkup(
      <BandLabeledButton label="x" visibleText="x" isMobile={false} onClick={() => {}} pressed={false}><span /></BandLabeledButton>,
    )
    expect(on).toContain('aria-pressed="true"')
    expect(off).toContain('aria-pressed="false"')
  })
})

/**
 * PanelBar — the ONE panel switcher (design item 1), now rendered inside the bottom band's own bar
 * instead of the fixed header. These assertions used to live in `App.test.tsx` against the header's
 * own `SessionHeaderSwitcher`; they moved here with the component — see that file's own header on
 * why. `panelBarEntries` itself is pinned in `lib/panelBar.test.ts`; what is tested here is that the
 * COMPONENT actually threads the computed `on`/`studioAt` into the markup (`aria-selected`, the tag
 * text) rather than, say, always rendering `false`.
 */

const ALL_GATES = { editorEnabled: true, shellEnabled: true, relayed: false, hardwareOffered: true }

function switcher(
  rightOccupant: 'contents' | 'studio' | 'cli' | 'shell' | 'hardware' | null,
  bottomOccupant: 'cli' | 'shell' | 'studio' | null,
  studioSeen: boolean,
  opts?: { lang?: 'en' | 'pt'; compact?: boolean },
): string {
  return renderToStaticMarkup(
    <PanelBar
      entries={panelBarEntries(rightOccupant, bottomOccupant, ALL_GATES)}
      lang={opts?.lang ?? 'en'}
      studioSeen={studioSeen}
      harness="claude"
      onPick={() => {}}
      {...(opts?.compact !== undefined ? { compact: opts.compact } : {})}
    />,
  )
}

describe('PanelBar — exactly one lit tab (two with Studio at the bottom), and the first-open dot', () => {
  /** Plant: force every entry's `on` to `false` regardless of `entries`. The first assertion then
   *  fails (Studio active should read `aria-selected="true"`); force it to `true` instead and the
   *  second one fails (nothing active should read `aria-selected="true"` nowhere at all). */
  test('aria-selected follows which entry is active, in both directions', () => {
    expect(switcher('studio', null, true)).toContain('aria-selected="true"')
    const nothingActive = switcher(null, null, true)
    expect(nothingActive).not.toContain('aria-selected="true"')
    expect(nothingActive.match(/aria-selected="false"/g)?.length).toBe(5)
  })

  test('exactly one tab is ever lit, matching the design\'s "never more than one lit control"', () => {
    const html = switcher('studio', null, true)
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
    expect(html.match(/aria-selected="false"/g)?.length).toBe(4)
  })

  // Design item 1: the band's own occupant switcher merges into this bar, so cli/shell must ALSO
  // light for the bottom slot (unlike contents/hardware, which stay right-slot-only).
  test('Claude Code lit as the bottom band\'s own occupant, with nothing on the right', () => {
    const html = switcher(null, 'cli', true)
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
    expect(html).toContain('aria-selected="true"')
  })

  // Owner follow-up: "the Studio must be ACTIVE from the moment it is open... with a small tag
  // saying where it is open". Studio docked at the bottom while Contents holds the right slot is
  // the one case two tabs read `on` at once.
  test('Studio at the bottom, Contents on the right: BOTH lit, Studio carries the "embaixo"/"bottom" tag', () => {
    const html = switcher('contents', 'studio', true)
    expect(html.match(/aria-selected="true"/g)?.length).toBe(2)
    expect(html).toContain('Studio · bottom')
  })

  test('Studio in the right slot carries the "side" tag', () => {
    expect(switcher('studio', null, true)).toContain('Studio · side')
  })

  test('Studio shown nowhere carries no tag at all', () => {
    const html = switcher('contents', null, true)
    expect(html).not.toContain('Studio ·')
    expect(html).toContain('>Studio<')
  })

  test('the tag is in Portuguese too', () => {
    const html = switcher('contents', 'studio', true, { lang: 'pt' })
    expect(html).toContain('Studio · embaixo')
  })

  test('the dot is present on a fresh origin (studioSeen false) and gone once it has fired', () => {
    // Checked with nothing active, where nothing else in the markup draws `--anthropic-orange` — the
    // ON tokens themselves use it too, which would confound this assertion.
    expect(switcher(null, null, false)).toContain('var(--anthropic-orange)')
    expect(switcher(null, null, true)).not.toContain('var(--anthropic-orange)')
  })

  /** Item 1/3 (previous pass): ONE segmented control, the same visual language as the band's own
   *  `Claude Code | Shell | Studio` segment — `var(--bg-surface)`/`var(--text-primary)` for the lit
   *  tab, never a bespoke orange-bordered pill per entry. */
  test('the ON treatment matches the band segment\'s own tab styling, not a bespoke pill', () => {
    const html = switcher('studio', null, true)
    expect(html).toContain('background:var(--bg-surface)')
    expect(html).toContain('color:var(--text-primary)')
    expect(html).not.toContain('rgba(232,146,90,0.08)')
  })

  /** Item 1/3: the five entries render inside ONE `role="tablist"` wrapper — never five separate
   *  bordered pills each carrying their own border/background. */
  test('one wrapper, one role="tablist" — not five separate pill buttons', () => {
    const html = switcher('studio', null, true)
    expect(html.match(/role="tablist"/g)?.length).toBe(1)
    expect(html.match(/role="tab"/g)?.length).toBe(5)
  })

  test('the entries render in the design\'s fixed order — Conteúdo · Studio · Claude Code · Shell · Hardware', () => {
    const html = switcher('studio', null, true)
    const order = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1])
    expect(order).toEqual(['Contents', 'Studio · side', 'Claude Code', 'Shell', 'Hardware'])
  })
})

/**
 * `compact` (design item 7: "below ~1100px wide collapse tab labels to icons with tooltips, the lit
 * tab keeps its label and the Studio location tag"). The full text is asserted via the VISUALLY
 * HIDDEN span (still there for the accessible name) rather than its absence, since the tooltip
 * (`title`) already carries it too and a test that only checked "the visible word is gone" cannot
 * tell an intentional compact icon from a broken label prop.
 */
describe('PanelBar — compact mode collapses UNLIT labels to icons, never the lit one', () => {
  test('wide (compact false): every entry\'s full text is plainly visible', () => {
    const html = switcher('studio', null, true, { compact: false })
    expect(html).not.toContain('clip:rect(0,0,0,0)')
  })

  test('compact: the four unlit entries each get a visually-hidden label', () => {
    const html = switcher('studio', null, true, { compact: true })
    expect(html.match(/clip:rect\(0,0,0,0\)/g)?.length).toBe(4)
  })

  // Plant: drop the `compact && !on` guard so EVERY entry (lit included) hides its label. The lit
  // Studio tab's own text would then be wrapped in the visually-hidden style too, and this fails.
  test('compact: the lit Studio tab\'s label stays a plain, non-hidden span', () => {
    const html = switcher('studio', null, true, { compact: true })
    expect(html).toContain('<span>Studio · side</span>')
  })
})

/**
 * BandOverflowMenu — the "⋯" that holds a bottom bar's secondary actions (design item 7). Closed by
 * default; absent entirely with no entries, rather than a trigger that opens onto nothing.
 */
describe('BandOverflowMenu', () => {
  test('absent entirely when there are no entries', () => {
    const html = renderToStaticMarkup(<BandOverflowMenu label="More actions" entries={[]} />)
    expect(html).toBe('')
  })

  test('renders the trigger, closed, with the given entries not yet in the markup', () => {
    const html = renderToStaticMarkup(
      <BandOverflowMenu
        label="More actions"
        entries={[{ id: 'move', label: 'Move to the right', icon: <span />, onSelect: () => {} }]}
      />,
    )
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    // Closed: the menu itself (and its entries) are not rendered until opened.
    expect(html).not.toContain('role="menu"')
    expect(html).not.toContain('Move to the right')
  })

  test('the trigger icon can be overridden — Studio.tsx\'s own gear reads as a DIFFERENT menu from the band\'s "⋯"', () => {
    const withDefault = renderToStaticMarkup(
      <BandOverflowMenu label="More actions" entries={[{ id: 'x', label: 'X', icon: <span />, onSelect: () => {} }]} />,
    )
    const withGear = renderToStaticMarkup(
      <BandOverflowMenu
        label="Studio settings" icon={<svg data-gear-marker="1" />}
        entries={[{ id: 'x', label: 'X', icon: <span />, onSelect: () => {} }]}
      />,
    )
    expect(withGear).toContain('data-gear-marker="1"')
    expect(withDefault).not.toContain('data-gear-marker="1"')
  })
})
