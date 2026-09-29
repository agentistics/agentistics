/**
 * sessionPanel.emptyBand.lint.test.ts — AN EMPTY BAND RENDERS NOTHING, in `SimpleDockedBand` too.
 *
 * Owner report: "na barra inferior ta aparecendo eternamente o - de minimizar" — a screenshot of an
 * otherwise empty bottom strip carrying a lone orange `−`. `PanelBarBand` already carries this rule
 * (`if (barEntries.length === 0) return null`, owner, 2026-09-21: "quando removo todos os itens ele
 * simplesmente deixa essa porra desse iconezinho feio ai"), but that guard was written for the
 * RELAYED case alone and `SimpleDockedBand` never got the same one.
 *
 * THE LEAK: `bottomBandFor` (`lib/panelBar.ts`) selects a band for `bottomOccupant` "whatever panel
 * it is, gated or not" (that function's own doc comment) — `resolveForGates` only clears a stored
 * `bottom` occupant for the three MACHINE-level `PanelGates` (`editorEnabled`/`shellEnabled`/
 * `relayed`). `hardware`'s own gate is per-SESSION (`hardwareOffered`), read only at the render
 * layer and never by `resolveForGates` (`panelSlots.ts`'s own `gateOpen`, which does not mention
 * `hardware` at all). So a browser that once docked Hardware at the bottom on an ordinary machine,
 * now pointed at a CENTRAL (`hardwareOffered` always false there), keeps `bottomOccupant ===
 * 'hardware'`; `bottomBandFor` still returns `'hardware'`; `panelBarEntries` filters the one entry
 * this band would have shown. `SimpleDockedBand` mounted anyway — its grip, its (now empty)
 * `PanelBar`, and `PanelFixedControls`' own literal `−` (that component's own header: "ALWAYS THE
 * SAME LITERAL `−`") all drawn with nothing docked behind any of them.
 *
 * `StudioBand` was checked and is NOT reachable the same way: `studio`'s own gate (`editorEnabled`)
 * IS one of the three `resolveForGates` clears, so a stored `bottom: 'studio'` never survives a
 * closed `editorEnabled` gate to reach `bottomBandFor` at all — confirmed by `panelSlots.ts`'s own
 * `gateOpen` naming `studio` explicitly. Its own minimize is a plain `ChevronDown`/`ChevronUp`
 * button besides (not `PanelFixedControls`' literal `−`), so it could not be the control the
 * screenshot shows even if it were reachable.
 *
 * Not reachable by rendering: `SimpleDockedBand` is not exported (no seam to mount it through — see
 * `sessionPanel.lint.test.ts`'s own header for the same fact about `StudioBand`), and this package
 * has no jsdom regardless. The SHAPE is what is asserted, over comment-free source, with a planted
 * reversion proving the scan still sees the bug this pins.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const SESSION_PANEL_RAW = readFileSync(join(import.meta.dir, 'SessionPanel.tsx'), 'utf-8')
const SESSION_PANEL_SRC = stripComments(SESSION_PANEL_RAW)

/** Slices one band's own function body out of `SessionPanel.tsx`, comments already stripped. */
function bandBody(name: 'StudioBand' | 'SimpleDockedBand' | 'PanelBarBand'): string {
  const start = SESSION_PANEL_SRC.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const nextFn = SESSION_PANEL_SRC.indexOf('\nfunction ', start + 1)
  // `PanelBarBand` is the last top-level function this file declares — no NEXT one to stop at, so
  // "to the end of the file" is the correct slice rather than a `-1` the caller would have to guard.
  return nextFn === -1 ? SESSION_PANEL_SRC.slice(start) : SESSION_PANEL_SRC.slice(start, nextFn)
}

describe('SimpleDockedBand guards against an empty barEntries, exactly like PanelBarBand', () => {
  test('PanelBarBand already carries the guard (the pre-existing floor this file extends)', () => {
    const body = bandBody('PanelBarBand')
    expect(body).toContain('if (barEntries.length === 0) return null')
  })

  test('SimpleDockedBand now carries the same guard, BEFORE its own return', () => {
    const body = bandBody('SimpleDockedBand')
    const guardAt = body.indexOf('if (barEntries.length === 0) return null')
    const returnAt = body.indexOf('return (')
    expect(guardAt).toBeGreaterThan(-1)
    expect(returnAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(returnAt)
  })

  test('the guard sits AFTER every hook call in SimpleDockedBand — react-hooks/rules-of-hooks', () => {
    const body = bandBody('SimpleDockedBand')
    const guardAt = body.indexOf('if (barEntries.length === 0) return null')
    // The last hook this component calls before its own return — see its own source.
    const lastHookAt = body.lastIndexOf('useBandDropTarget(')
    expect(lastHookAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(lastHookAt)
  })

  /**
   * StudioBand is checked and DELIBERATELY left without this guard — see this file's own module
   * header for why it is not reachable the same way (`editorEnabled` is one of the three gates
   * `resolveForGates` already clears a stored `bottom: 'studio'` through). Asserted here so a
   * future change that widens `PanelGates`/`gateOpen` without also widening this reasoning fails a
   * test instead of shipping silently.
   */
  test('StudioBand carries no such guard — its own gate is already cleared upstream', () => {
    const body = bandBody('StudioBand')
    expect(body).not.toContain('if (barEntries.length === 0) return null')
  })

  /** Plant: the guard REMOVED — the exact shape `SimpleDockedBand` carried before this fix. The
   *  first assertion in this describe block (`guardAt` found before `returnAt`) is what would fail:
   *  `indexOf` returns `-1`, so `-1 > -1` is false, so `expect(guardAt).toBeGreaterThan(-1)` fails —
   *  proving the scan actually distinguishes the fixed shape from the reverted one. */
  test('the scan still catches the original bug if it comes back', () => {
    const reverted = stripComments([
      'function SimpleDockedBand({',
      '  panel, panelName, lang, open, columnHeight, onToggleOpen, barEntries,',
      '}) {',
      '  const [barWidthRef, barWidth] = useElementWidth()',
      '  const bandDrop = useBandDropTarget(onBarDrop)',
      '  return (',
      '    <div>',
      '      <BandResizeHandle />',
      '      <div ref={barWidthRef}>',
      '        <PanelBar entries={barEntries} />',
      '        <PanelFixedControls onMinimize={onToggleOpen} />',
      '      </div>',
      '    </div>',
      '  )',
      '}',
      'function PanelBarBand({',
    ].join('\n'))
    const guardAt = reverted.indexOf('if (barEntries.length === 0) return null')
    expect(guardAt).toBe(-1)
  })
})

// THE CASE THE GUARDS ABOVE MISSED, reported a second time on v2.49.2 ("o - ainda aparece na barra
// mesmo com ela fechada"). The strip came from the band `bottomBandFor` SELECTED for a local
// desktop session with nothing docked — the old `'shell'` floor — not from a band rendering its
// own emptiness, so no guard inside a band could see it. `bottomBandFor` now answers `'none'` there
// (see `panelBar.test.ts`), and what that must not cost is the way back.
describe('an empty desktop band leaves a drag-only landing strip, and nothing else', () => {
  const src = stripComments(SESSION_PANEL_RAW)

  test('the drop zone renders only for the none band, on a desktop, for a local session', () => {
    expect(src).toContain("bottomBand === 'none' && !isMobile && !relayed && (")
    expect(src).toContain('<EmptyBandDropZone')
  })

  test('the drop zone exists only while a panel drag is in flight', () => {
    const zone = src.slice(src.indexOf('function EmptyBandDropZone'))
    expect(zone).toContain('hasDragPayload(e)')
    expect(zone).toContain('if (!dragging) return null')
  })

  test('it lands through the same drop handler every band uses', () => {
    const zone = src.slice(src.indexOf('function EmptyBandDropZone'))
    expect(zone).toContain('useBandDropTarget(onDrop)')
    expect(src).toContain('<EmptyBandDropZone lang={lang} onDrop={dropSlotPanel} />')
  })
})
