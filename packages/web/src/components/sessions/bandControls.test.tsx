import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { panelBarEntries } from '../../lib/panelBar'
import {
  BAND_CONTROL_H, BandLabeledButton, BandOverflowMenu, BandSegment, BandSegmentTab, PanelBar,
  PanelFixedControls,
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
 * PanelBar — the BOTTOM BAND's own tab strip. AFTER THE RIGHT ICON RAIL (2026-09-21) it is scoped to
 * exactly the panels PLACED AT THE BOTTOM — the rail is now the switcher for every rail-placed panel
 * (`PanelRail.tsx`), so this bar no longer also offers a "jump to the right slot" reading, and with
 * it the Studio's old "side"/"bottom" location tag: this bar only ever draws panels that are, by
 * definition, at the bottom. `panelBarEntries` itself is pinned in `lib/panelBar.test.ts`; what is
 * tested here is that the COMPONENT actually threads the computed `on` into the markup rather than,
 * say, always rendering `false`.
 */

const ALL_GATES = { editorEnabled: true, shellEnabled: true, relayed: false, hardwareOffered: true }

function switcher(
  bottomIds: readonly ('studio' | 'cli' | 'shell' | 'hardware' | 'skills')[],
  activeBottom: 'studio' | 'cli' | 'shell' | 'hardware' | 'skills' | null,
  studioSeen: boolean,
  opts?: { lang?: 'en' | 'pt'; compact?: boolean },
): string {
  return renderToStaticMarkup(
    <PanelBar
      entries={panelBarEntries(bottomIds, activeBottom, ALL_GATES)}
      lang={opts?.lang ?? 'en'}
      studioSeen={studioSeen}
      harness="claude"
      onPick={() => {}}
      {...(opts?.compact !== undefined ? { compact: opts.compact } : {})}
    />,
  )
}

describe('PanelBar — exactly one lit tab, and the first-open dot', () => {
  /** Plant: force every entry's `on` to `false` regardless of `entries`. The first assertion then
   *  fails (Studio active should read `aria-selected="true"`); force it to `true` instead and the
   *  second one fails (nothing active should read `aria-selected="true"` nowhere at all). */
  test('aria-selected follows which entry is active, in both directions', () => {
    expect(switcher(['studio', 'cli', 'shell'], 'studio', true)).toContain('aria-selected="true"')
    const nothingActive = switcher(['studio', 'cli', 'shell'], null, true)
    expect(nothingActive).not.toContain('aria-selected="true"')
    expect(nothingActive.match(/aria-selected="false"/g)?.length).toBe(3)
  })

  test('exactly one tab is ever lit', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true)
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
    expect(html.match(/aria-selected="false"/g)?.length).toBe(2)
  })

  test('a panel not among bottomIds is simply absent from the bar, never rendered unlit', () => {
    const html = switcher(['cli', 'shell'], 'cli', true)
    expect(html).not.toContain('Studio')
  })

  test('the dot is present on a fresh origin (studioSeen false) and gone once it has fired', () => {
    expect(switcher(['studio'], null, false)).toContain('var(--anthropic-orange)')
    expect(switcher(['studio'], null, true)).not.toContain('var(--anthropic-orange)')
  })

  /** Item 1/3 (previous pass): ONE segmented control, the same visual language as the band's own
   *  `Claude Code | Shell | Studio` segment — `var(--bg-surface)`/`var(--text-primary)` for the lit
   *  tab, never a bespoke orange-bordered pill per entry. */
  test('the ON treatment matches the band segment\'s own tab styling, not a bespoke pill', () => {
    const html = switcher(['studio', 'cli'], 'studio', true)
    expect(html).toContain('background:var(--bg-surface)')
    expect(html).toContain('color:var(--text-primary)')
    expect(html).not.toContain('rgba(232,146,90,0.08)')
  })

  /** Item 1/3: the entries render inside ONE `role="tablist"` wrapper — never separate bordered
   *  pills each carrying their own border/background. */
  test('one wrapper, one role="tablist" — not separate pill buttons', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true)
    expect(html.match(/role="tablist"/g)?.length).toBe(1)
    expect(html.match(/role="tab"/g)?.length).toBe(3)
  })

  test('the entries render in exactly the order they are given', () => {
    const html = switcher(['shell', 'cli', 'studio'], 'studio', true)
    const order = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1])
    expect(order).toEqual(['Shell', 'Claude Code', 'Studio'])
  })

  test('a former Contents tab (e.g. skills, moved to the bottom by the gear) renders through the shared panelMeta title', () => {
    const html = switcher(['skills', 'cli'], 'skills', true)
    expect(html).toContain('>Skills<')
  })
})

/**
 * `compact` (below ~1100px wide, tab labels collapse to icons with tooltips; the lit tab keeps its
 * label). The full text is asserted via the VISUALLY HIDDEN span (still there for the accessible
 * name) rather than its absence, since the tooltip (`title`) already carries it too and a test that
 * only checked "the visible word is gone" cannot tell an intentional compact icon from a broken
 * label prop.
 */
describe('PanelBar — compact mode collapses UNLIT labels to icons, never the lit one', () => {
  test('wide (compact false): every entry\'s full text is plainly visible', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true, { compact: false })
    expect(html).not.toContain('clip:rect(0,0,0,0)')
  })

  test('compact: the unlit entries each get a visually-hidden label', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true, { compact: true })
    expect(html.match(/clip:rect\(0,0,0,0\)/g)?.length).toBe(2)
  })

  // Plant: drop the `compact && !on` guard so EVERY entry (lit included) hides its label. The lit
  // Studio tab's own text would then be wrapped in the visually-hidden style too, and this fails.
  test('compact: the lit Studio tab\'s label stays a plain, non-hidden span', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true, { compact: true })
    expect(html).toContain('<span>Studio</span>')
  })
})

/**
 * THE ICON-ONLY BAR NO LONGER DRAWS TWO IDENTICAL TERMINAL GLYPHS (owner, 2026-09-19: "tem 2 icones
 * de terminal repetidos... coloca a logo do harness invés do icone de terminal"). The `cli` tab now
 * carries the session's own `HarnessMark` — the same mark every chat bubble already uses, monogram
 * fallback included — while `shell` keeps the generic `TerminalSquare`, which is then the only tab
 * drawing one. Both icons now come from the shared `panelIcons.tsx`, used identically by this bar
 * and by `PanelRail.tsx`.
 */
describe('PanelBar — the CLI tab carries the harness mark, never the generic terminal glyph', () => {
  test('with a known harness, the CLI tab renders that harness\'s own mark asset, not TerminalSquare', () => {
    // `claude` is a FILE mark (`HarnessMark`'s `MARK_FILE`) — its own `<img src="/harness/claude.svg">`
    // is unambiguous markup no lucide icon could ever produce.
    const html = switcher(['studio', 'cli'], 'studio', true) // switcher() always passes harness="claude"
    expect(html).toContain('src="/harness/claude.svg"')
  })

  test('the SHELL tab is untouched — it still draws the generic terminal glyph', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true)
    expect(html).toContain('d="m7 11 2-2-2-2"')
  })

  test(
    'the mark is DECORATIVE — aria-hidden, so a screen reader is not told "Claude Code Claude ' +
    'Code" (the mark\'s own vendor name, then the tab\'s own label, concatenated)',
    () => {
      const html = switcher(['studio', 'cli'], 'studio', true)
      expect(html).toContain('aria-hidden="true"><img src="/harness/claude.svg"')
    },
  )

  test('no `harness` at all — the CLI tab falls back to the generic terminal glyph, never a broken image', () => {
    const html = renderToStaticMarkup(
      <PanelBar
        entries={panelBarEntries(['studio', 'cli', 'shell'], 'studio', ALL_GATES)}
        lang="en" studioSeen={true} onPick={() => {}}
      />,
    )
    expect(html).not.toContain('<img')
    // Both the CLI and Shell tabs now draw the SAME generic glyph — that is the one case this
    // product accepts two identical icons in one bar: there is genuinely no harness to name yet.
    expect(html.match(/d="m7 11 2-2-2-2"/g)?.length).toBe(2)
  })

  test('an UNKNOWN harness (no file, no mono, no colour) still resolves through HarnessMark\'s own monogram — never TerminalSquare and never a blank tab', () => {
    const html = renderToStaticMarkup(
      <PanelBar
        entries={panelBarEntries(['studio', 'cli', 'shell'], 'studio', ALL_GATES)}
        lang="en" studioSeen={true} harness="a-future-harness-nobody-has-shipped-a-mark-for"
        onPick={() => {}}
      />,
    )
    // The CLI tab resolves to `HarnessMark`'s own monogram fallback (a letter, not an image or the
    // generic glyph) — only the SHELL tab still draws `TerminalSquare`'s own path, exactly once.
    expect(html).not.toContain('<img')
    expect(html.match(/d="m7 11 2-2-2-2"/g)?.length).toBe(1)
  })

  test('the icon-only (compact) bar keeps the SAME distinction — this is exactly the width the ' +
    'owner reported as ambiguous', () => {
    const html = switcher(['studio', 'cli', 'shell'], 'studio', true, { compact: true })
    expect(html).toContain('src="/harness/claude.svg"')
    expect(html.match(/d="m7 11 2-2-2-2"/g)?.length).toBe(1) // Shell alone, now
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

/**
 * PanelFixedControls — the ONE cluster every panel's own bar now renders (owner, 2026-09-19:
 * "botões que ficaram fixos... tela cheia, minimizar... a engrenagem"). Order, presence and colour
 * are asserted structurally (titles, button count, inline style strings) since this package has no
 * jsdom to click through — the same approach every other test in this file already takes.
 */
describe('PanelFixedControls — gear, full screen, minimize, in that order (minimize ALWAYS last)', () => {
  const gearEntries = [{ id: 'move-right', label: 'Move Hardware to the right', icon: <span />, onSelect: () => {} }]

  // Owner, 2026-09-25: minimize stays at the far right, where a collapsed band's reopen chevron
  // sits, so the pointer that opened the band closes it without moving. "config, maximizar,
  // minimizar".
  test('the full trio renders, in order — the gear, then full screen, then minimize LAST', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        fullscreen={{ active: false, onToggle: () => {} }}
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    const fullscreenAt = html.indexOf('Hardware full screen')
    const minimizeAt = html.indexOf('Minimize Hardware')
    const gearAt = html.indexOf('Hardware options')
    expect(fullscreenAt).toBeGreaterThan(-1)
    expect(minimizeAt).toBeGreaterThan(-1)
    expect(gearAt).toBeGreaterThan(-1)
    expect(gearAt).toBeLessThan(fullscreenAt)
    expect(fullscreenAt).toBeLessThan(minimizeAt)
  })

  test('full screen is ABSENT — never present and refusing — when the caller offers nowhere to send it', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(html).not.toContain('full screen')
    expect(html).toContain('Minimize Hardware')
  })

  test(
    'minimize is ABSENT for exactly one caller — Studio\'s own bottom-docked toolbar, which relies ' +
    'on StudioBand\'s own outer chevron instead',
    () => {
      const html = renderToStaticMarkup(
        <PanelFixedControls
          lang="en" panelName="Studio"
          fullscreen={{ active: false, onToggle: () => {} }}
          gearLabel="Studio options" gearEntries={gearEntries}
        />,
      )
      expect(html).not.toContain('Minimize')
      expect(html).toContain('Studio full screen')
      expect(html).toContain('Studio options')
    },
  )

  test('the minimize button is ALWAYS the accent orange — never the neutral secondary colour every other icon here uses', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(html).toContain('color:var(--anthropic-orange)')
  })

  test('full screen toggles its own label between "X full screen" and "Exit full screen — X"', () => {
    const off = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        fullscreen={{ active: false, onToggle: () => {} }}
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(off).toContain('Hardware full screen')
    expect(off).not.toContain('Exit full screen')
    const on = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        fullscreen={{ active: true, onToggle: () => {} }}
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(on).toContain('Exit full screen — Hardware')
  })

  test('the gear is ABSENT — never a trigger opening onto nothing — when there is nothing to offer', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={[]}
      />,
    )
    expect(html).not.toContain('Hardware options')
    expect(html).toContain('Minimize Hardware')
  })

  test('the panel name appears in every button\'s own label — two adjacent panels never read as the same control', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Contents"
        fullscreen={{ active: false, onToggle: () => {} }}
        onMinimize={() => {}} minimizeLabel="Minimize Contents"
        gearLabel="Contents options" gearEntries={gearEntries}
      />,
    )
    expect(html).toContain('Contents full screen')
    expect(html).toContain('Minimize Contents')
    expect(html).toContain('Contents options')
  })
})

/**
 * PIN (narrow-overlay pass, 2026-09-22, spec §11 item 3) — absent wherever the caller does not offer
 * it (the bottom band's own bars never pass it), present as a fourth control between minimize and
 * the gear, its PRESSED state visible on the row itself (not only in the tooltip).
 */
describe('PanelFixedControls — pin, beside the gear', () => {
  const gearEntries = [{ id: 'move-right', label: 'Move Hardware to the right', icon: <span />, onSelect: () => {} }]

  test('absent entirely when the caller offers no pin — the bottom band’s own bars', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        fullscreen={{ active: false, onToggle: () => {} }}
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(html).not.toContain('Float Hardware as a window')
    expect(html).not.toContain('Dock Hardware back')
  })

  test('present, and sits beside the gear — gear, pin, full screen, minimize, in that order', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        fullscreen={{ active: false, onToggle: () => {} }}
        onMinimize={() => {}} minimizeLabel="Minimize Hardware"
        pinned={{ active: false, onToggle: () => {} }}
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    const fullscreenAt = html.indexOf('Hardware full screen')
    const minimizeAt = html.indexOf('Minimize Hardware')
    const pinAt = html.indexOf('Float Hardware as a window')
    const gearAt = html.indexOf('Hardware options')
    expect(fullscreenAt).toBeGreaterThan(-1)
    expect(minimizeAt).toBeGreaterThan(-1)
    expect(pinAt).toBeGreaterThan(-1)
    expect(gearAt).toBeGreaterThan(-1)
    expect(gearAt).toBeLessThan(pinAt)
    expect(pinAt).toBeLessThan(fullscreenAt)
    expect(fullscreenAt).toBeLessThan(minimizeAt)
  })

  test('unpinned: neutral colour, aria-pressed=false, and the "Float X as a window" label', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        pinned={{ active: false, onToggle: () => {} }}
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(html).toContain('Float Hardware as a window')
    expect(html).not.toContain('Dock Hardware back')
    expect(html).toContain('aria-pressed="false"')
  })

  test('pinned: accent orange, aria-pressed=true, and the "Dock X back" label — visible at a glance, not only in the tooltip', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        pinned={{ active: true, onToggle: () => {} }}
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    expect(html).toContain('Dock Hardware back')
    expect(html).toContain('aria-pressed="true"')
    // The pin glyph itself is FILLED while active (`fill="currentColor"`), not colour alone.
    expect(html).toContain('fill="currentColor"')
  })

  test('the pinned button is the accent orange, matching the codebase’s one "this is active" colour', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Hardware"
        pinned={{ active: true, onToggle: () => {} }}
        gearLabel="Hardware options" gearEntries={gearEntries}
      />,
    )
    // The trailing pin <button>'s own inline style — same technique the minimize-colour test above
    // uses (a whole-document string match; there is exactly one accent-orange consumer here when
    // minimize is absent, so this is unambiguous).
    expect(html).toContain('color:var(--anthropic-orange)')
  })

  test('pt labels: "Soltar X como janela" / "Encaixar X de volta"', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="pt" panelName="Hardware"
        pinned={{ active: false, onToggle: () => {} }}
        gearLabel="Opções Hardware" gearEntries={gearEntries}
      />,
    )
    expect(html).toContain('Soltar Hardware como janela')
    const pinnedHtml = renderToStaticMarkup(
      <PanelFixedControls
        lang="pt" panelName="Hardware"
        pinned={{ active: true, onToggle: () => {} }}
        gearLabel="Opções Hardware" gearEntries={gearEntries}
      />,
    )
    expect(pinnedHtml).toContain('Encaixar Hardware de volta')
  })

  test('the panel name appears in the pin’s own label too — same rule as the rest of the trio', () => {
    const html = renderToStaticMarkup(
      <PanelFixedControls
        lang="en" panelName="Contents"
        pinned={{ active: false, onToggle: () => {} }}
        gearLabel="Contents options" gearEntries={gearEntries}
      />,
    )
    expect(html).toContain('Float Contents as a window')
  })
})

// A COLLAPSED BAND DRAWS THE WAY BACK, NOT A SECOND MINIMIZE. For one release the `−` was drawn in
// both states, and the owner reported it twice on a bar that was already closed ("o - ainda aparece
// na barra mesmo com ela fechada"). The label already said "Expandir"; the glyph now agrees.
describe('the minimize control follows the collapsed state', () => {
  const render = (collapsed: boolean) => renderToStaticMarkup(
    <PanelFixedControls
      lang="pt"
      panelName="Claude Code"
      collapsed={collapsed}
      onMinimize={() => {}}
      minimizeLabel={collapsed ? 'Expandir Claude Code' : 'Recolher Claude Code'}
      gearLabel="Opções"
      gearEntries={[]}
    />,
  )

  test('an OPEN band shows the literal minus', () => {
    const html = render(false)
    expect(html).toContain('lucide-minus')
    expect(html).not.toContain('lucide-chevron-up')
  })

  test('a COLLAPSED band shows the up chevron that reopens it, and no minus', () => {
    const html = render(true)
    expect(html).toContain('lucide-chevron-up')
    expect(html).not.toContain('lucide-minus')
    expect(html).toContain('aria-label="Expandir Claude Code"')
  })
})
