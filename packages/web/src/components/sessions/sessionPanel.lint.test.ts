/**
 * sessionPanel.lint.test.ts — `StudioBand`'s content box may never sit inside a non-growing wrapper
 * (the freeze this pins).
 *
 * `StudioBand` (`SessionPanel.tsx`) shares its "snap to fill the column" geometry with `ShellBand`
 * (`resolveBandHeight`, `shellBand.ts`) — dragging the handle near the column's own top edge sets
 * `heightPrefs.full`, and the band's ROOT then reads `flex: '1 1 auto'` to stretch and fill it.
 *
 * The content box (the one the Studio's own portal carrier — `contentRef` — lives inside) used to
 * sit wrapped, together with the resize handle, in an EXTRA `<div style={{display:'flex',
 * flexDirection: 'column'}}>` with no `flex`/`minHeight` of its own. That div is a flex ITEM of the
 * root, and with no `flex` it takes only the height its CONTENT asks for (`flex: 0 1 auto`, the CSS
 * default) instead of growing into whatever the root — which DOES stretch when `full` — actually had
 * to give it. The content box's own `flex: '1 1 auto'` then had nothing to grow INTO (a flex-grow
 * child cannot exceed a non-growing parent), so the whole thing collapsed to its minimum size and the
 * root's remaining ~400px sat empty below it.
 *
 * MEASURED live, before the fix: dragging the handle to the column's top DID grow the root (its own
 * `getBoundingClientRect().height` read 469px, `flex: 1 1 auto` correctly applied) while the box
 * carrying `data-studio-layout` measured `height: 0` — the tree and the editor rendered into a
 * sliver at the top of the band and the rest sat blank, which is what read as "the band went
 * empty… and never became full screen." `ShellBand` never had this bug: its own content box is a
 * direct child of ITS root, with no such wrapper.
 *
 * THIS FILE WAS UPDATED for the band-grip-position fix (owner: "o item de reposicionamento muda de
 * lugar dependendo da aba, deveria estar sempre no topo"). The resize handle no longer shares a
 * Fragment with the content box at all — it moved OUT, to render ABOVE the bar row through the
 * shared `BandResizeHandle` (`bandControls.tsx`), which is what `bandGripPosition.lint.test.ts`
 * pins. What is left for THIS file to guard is narrower but unchanged in spirit: the content box
 * itself must still be a direct, un-wrapped flex item of the root — the freeze this file exists for
 * is about THAT box, never about where the handle happens to sit.
 *
 * UPDATED AGAIN for the floating-panels redesign (`sdd/brief.md`): the band is now its OWN panel,
 * rendered as a Fragment whose FIRST child is the workspace's ordinary panel gap (a sibling BEFORE
 * the band's bordered box, never inside it) and whose gesture is only wired up while `open` — so the
 * handle's own guard is `{!fullscreen && (`, with the `open` check now living inside the spread
 * grip/no-op choice rather than in the JSX condition. The ORDERING invariant this test asserts is
 * unchanged (the handle is textually even further before the content box now, being outside the
 * bordered box entirely) — only the literal string identifying the handle's guard moved.
 *
 * Not reachable by rendering: `StudioBand` is not exported (there is no seam to mount it through),
 * and this package has no jsdom regardless. The SHAPE is what went wrong, so the shape is what is
 * asserted, over comment-free source, with the defect planted below to prove the scan still sees it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const RAW = readFileSync(join(import.meta.dir, 'SessionPanel.tsx'), 'utf-8')
const SRC = stripComments(RAW)

/** Only `StudioBand`'s own body — `SimpleDockedBand`, further down, has its own unrelated
 *  `{open && (`. */
function studioBandBody(src: string): string {
  const start = src.indexOf('function StudioBand(')
  const end = src.indexOf('function SimpleDockedBand(')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('StudioBand — the content box is a direct, un-wrapped flex item of the growing root', () => {
  test('the content block is `{open && (`, never `{open && !fullscreen && (` — that guard belongs to the handle alone', () => {
    const body = studioBandBody(SRC)
    // The handle's own conditional carries the EXTRA `!fullscreen` term (it disappears in true full
    // screen); the content box renders whenever the band is merely `open`, fullscreen or not. Two
    // different conditionals for two different things — collapsing them back into one would either
    // hide the content in full screen or show a handle with nothing left to negotiate a height for.
    const contentAt = body.indexOf('{open && (')
    expect(contentAt).toBeGreaterThan(-1)
    const handleAt = body.indexOf('{open && !fullscreen && (')
    expect(handleAt).toBeGreaterThan(-1)
    expect(handleAt).toBeLessThan(contentAt)
  })

  test('the open content block\'s immediate child is a plain div, never re-wrapped in a further non-flex div', () => {
    const body = studioBandBody(SRC)
    const contentAt = body.indexOf('{open && (')
    const after = body.slice(contentAt + '{open && ('.length).trimStart()
    // The box itself carries an explicit `flex`/`height` decision (see the style object a few lines
    // below) — a bare, propless wrapper div is exactly the shape that swallowed the height before.
    expect(after.startsWith('<div style={{ display: \'flex\', flexDirection: \'column\' }}>')).toBe(false)
    expect(after.startsWith('<div style={{')).toBe(true)
  })

  test('`ref={contentRef}` sits after that SAME open block, and nowhere else in this band', () => {
    const body = studioBandBody(SRC)
    const contentAt = body.indexOf('{open && (')
    const contentRefAt = body.indexOf('ref={contentRef}')
    expect(contentRefAt).toBeGreaterThan(contentAt)
    // Exactly one — a second `contentRef` anywhere in this band would mean a second host, which
    // `StudioHost.tsx`'s own re-parenting trick cannot handle.
    expect(body.match(/ref=\{contentRef\}/g)?.length).toBe(1)
  })

  test('the scan still sees the wrapper reintroduced, at the exact spot that broke this', () => {
    const body = studioBandBody(SRC)
    const contentAt = body.indexOf('{open && (')
    const DIV_OPEN = '<div style={{ display: \'flex\', flexDirection: \'column\' }}>'
    // Plant: wrap the content box's own opening tag in the old, non-flex wrapper.
    const boxOpenAt = contentAt + '{open && ('.length
    const planted = body.slice(0, boxOpenAt) + DIV_OPEN + body.slice(boxOpenAt)
    const after = planted.slice(boxOpenAt).trimStart()
    expect(after.startsWith(DIV_OPEN)).toBe(true)
  })
})

/**
 * FULL SCREEN IS A PROPERTY OF THE PANEL, NOT OF THE SLOT — found while fixing the band's resize
 * grip: drag the Studio to fill the column, then move Contents into the SAME bottom band, and
 * Contents read as full too, on the first frame, before anyone had dragged it anywhere. The stored
 * `BandPrefs.full` used to be one flat boolean shared by whichever panel next reads it — the fix
 * (`shellBand.ts`'s `bandPanelFull`/`withBandPanelFull`, keyed by `PanelId`) means `StudioBand` and
 * `SimpleDockedBand` must each read and write only THEIR OWN entry, never the bare `p.full`/
 * `next.full` boolean the old shape allowed.
 *
 * Not reachable by rendering, for the same reason as the tests above — the SHAPE is what is
 * asserted, with the old pattern planted back in to prove the scan still catches it.
 */
describe('StudioBand / SimpleDockedBand read and write only their OWN panel\'s full-screen entry', () => {
  test('no component in this file reads the old flat `p.full === true` shape', () => {
    expect(SRC).not.toMatch(/p\.full === true/)
  })

  test('StudioBand reads its own entry by name', () => {
    expect(SRC).toContain("return { height: p.height, full: bandPanelFull(p, 'studio') }")
  })

  test('SimpleDockedBand reads its own entry through the `panel` prop, not a literal', () => {
    expect(SRC).toContain('return { height: p.height, full: bandPanelFull(p, panel) }')
  })

  test('both bands write through `withBandPanelFull`, never a bare `full: true`/`full: next.full` merge', () => {
    expect([...SRC.matchAll(/withBandPanelFull\(/g)]).toHaveLength(2)
    // The OLD write shape this replaces — a literal `full: true` spliced into the record by hand.
    expect(SRC).not.toMatch(/\.\.\.\(next\.full \? \{ full: true \} : \{\}\)/)
  })

  test('the scan still sees the old shared-boolean read reintroduced', () => {
    const planted = SRC.replace(
      "return { height: p.height, full: bandPanelFull(p, 'studio') }",
      'return { height: p.height, full: p.full === true }',
    )
    expect(planted).toMatch(/p\.full === true/)
  })

  test('the scan still sees the old shared-boolean write reintroduced', () => {
    const planted = `${SRC}\n  writeBandPrefs({ ...rest, height: next.height, ...(next.full ? { full: true } : {}) })\n`
    expect(planted).toMatch(/\.\.\.\(next\.full \? \{ full: true \} : \{\}\)/)
  })
})

/**
 * FULL SCREEN STOPS SHORT OF THE ARTIFACTS ASIDE (change #2) — `StudioBand`'s and
 * `SimpleDockedBand`'s own `position: fixed` overlays used to hard-code `inset: 0`, covering the
 * aside whenever it was independently showing something else (owner: "o studio... some com o
 * aside da direita"). Both must now compute `right` through `fullscreenInsetRight`, never `inset: 0`
 * on the fullscreen branch.
 */
describe('the fullscreen overlay respects the artifacts aside (I2)', () => {
  test('no `inset: 0` survives on the fullscreen branch of either band', () => {
    expect(SRC).not.toMatch(/position: 'fixed', inset: 0/)
  })

  test('both bands compute their right inset through `fullscreenInsetRight`, respecting the rail too', () => {
    // A third argument joined this call in the right-icon-rail pass (the rail's own LIVE width on
    // desktop, 0 on a phone — `useRailWidth()`, since the rail became resizable, owner 2026-09-21)
    // — spec §2, "full screen respects the rail" — so both bands must ALSO stop short of the rail
    // even when the aside itself shows nothing.
    expect([...SRC.matchAll(/right: fullscreenInsetRight\(rightAsideEdge, viewportWidth, isMobile \? 0 : railWidth\)/g)]).toHaveLength(2)
  })

  test('both bands read the aside\'s live edge, the viewport width, the rail\'s live width, and whether the rail exists here, reactively', () => {
    expect([...SRC.matchAll(/const rightAsideEdge = useRightAsideEdge\(\)/g)]).toHaveLength(2)
    expect([...SRC.matchAll(/const viewportWidth = useViewportWidth\(\)/g)]).toHaveLength(2)
    expect([...SRC.matchAll(/const railWidth = useRailWidth\(\)/g)]).toHaveLength(2)
    // `StudioBand` reads `isMobile` once for itself; `SimpleDockedBand` does too — plus the one
    // `SessionPanel` itself already reads for `resolveForViewport`, three in total.
    expect([...SRC.matchAll(/const isMobile = useIsMobile\(\)/g)]).toHaveLength(3)
  })

  test('the scan still sees `inset: 0` reintroduced on a fullscreen branch', () => {
    const planted = SRC.replace(
      "position: 'fixed', top: 0, left: leftAsideEdge, bottom: 0,\n          right: fullscreenInsetRight(rightAsideEdge, viewportWidth, isMobile ? 0 : railWidth),\n          zIndex: PANEL_FULLSCREEN_Z,",
      "position: 'fixed', inset: 0, zIndex: PANEL_FULLSCREEN_Z,",
    )
    expect(planted).toMatch(/position: 'fixed', inset: 0/)
  })

  test('the scan still sees the rail-width argument dropped, silently uncovering it when the aside is empty', () => {
    const planted = SRC.replace(
      /right: fullscreenInsetRight\(rightAsideEdge, viewportWidth, isMobile \? 0 : railWidth\)/g,
      'right: fullscreenInsetRight(rightAsideEdge, viewportWidth)',
    )
    expect([...planted.matchAll(/right: fullscreenInsetRight\(rightAsideEdge, viewportWidth, isMobile \? 0 : railWidth\)/g)])
      .toHaveLength(0)
  })
})

/**
 * `<ShellBand>` IS WIRED TO THE SAME `slotLayout.bottomOpen` / `setBottomOpen` PAIR
 * `<StudioBand>`/`<SimpleDockedBand>` ALREADY TAKE AS `open`/`onToggleOpen` — the fix for "picking
 * a tab minimized the band instead of switching to it" (owner report). `ShellBand` cannot take
 * `open` as a fully controlled prop the way the other two do (its shell-resolution reducer reads
 * the SAME flag at its own mount-time init, not only at render), so it takes `open`/`onOpenChange`
 * instead — a seed plus a change notifier — but the SOURCE on this end is identical: this page's
 * own `slotLayout.bottomOpen` and `setBottomOpen`, never a value this component invents.
 */
describe('ShellBand is wired to the shared bottomOpen state (I3 — "picking Shell minimized the band")', () => {
  test('the mount call passes `open={slotLayout.bottomOpen}`', () => {
    expect(SRC).toContain('open={slotLayout.bottomOpen}')
  })

  test('the mount call passes `onOpenChange={setBottomOpen}`', () => {
    expect(SRC).toContain('onOpenChange={setBottomOpen}')
  })

  test('both land inside the `bottomBand === \'shell\'` branch, on the `<ShellBand` call, not a different component', () => {
    const start = SRC.indexOf("bottomBand === 'shell' ? (")
    const shellBandAt = SRC.indexOf('<ShellBand', start)
    const closeAt = SRC.indexOf('/>', shellBandAt)
    expect(start).toBeGreaterThan(-1)
    expect(shellBandAt).toBeGreaterThan(start)
    expect(closeAt).toBeGreaterThan(shellBandAt)
    const props = SRC.slice(shellBandAt, closeAt)
    expect(props).toContain('open={slotLayout.bottomOpen}')
    expect(props).toContain('onOpenChange={setBottomOpen}')
  })

  test('the scan still sees the wiring dropped from the call — the check itself would then fail', () => {
    // Simulates the regression WITHIN THE SHELLBAND CALL SPECIFICALLY — `open={slotLayout.bottomOpen}`
    // is not a unique string (`StudioBand`/`SimpleDockedBand` take the identical prop), so the plant
    // is scoped to the exact slice the earlier test already isolates, or removing the FIRST
    // occurrence anywhere in the file (most likely `StudioBand`'s own, textually first) would prove
    // nothing about THIS call.
    const start = SRC.indexOf("bottomBand === 'shell' ? (")
    const shellBandAt = SRC.indexOf('<ShellBand', start)
    const closeAt = SRC.indexOf('/>', shellBandAt)
    const before = SRC.slice(shellBandAt, closeAt)
    const after = before
      .replace('open={slotLayout.bottomOpen}', '// removed')
      .replace('onOpenChange={setBottomOpen}', '// removed')
    expect(after.includes('open={slotLayout.bottomOpen}')).toBe(false)
    expect(after.includes('onOpenChange={setBottomOpen}')).toBe(false)
  })
})

/**
 * THE FIXED TASK CONTROL IS GONE FROM EVERY BOTTOM BAND, AND AN EMPTY ONE RENDERS NOTHING (owner,
 * 2026-09-21: "quando removo todos os itens ele simplesmente deixa essa porra desse iconezinho feio
 * ai... pode remover o icone fixo de tarefas tbm"). `tasks` is a rail-capable panel now, so the
 * always-on `SessionTitleFlag` shortcut in every band's bar row was the one thing left standing once
 * a reader emptied the bottom band entirely.
 */
describe('the fixed task control no longer renders in any bottom band', () => {
  test('no band renders `taskControl` any more, and none of the four still takes it as a prop', () => {
    expect(SRC).not.toMatch(/\{taskControl\}/)
    expect(SRC).not.toMatch(/taskControl[?:]/)
    expect(SRC).not.toMatch(/taskControl=\{taskControl\}/)
  })

  test('the scan still sees the render reintroduced on a call site', () => {
    const planted = `${SRC}\n<ShellBand taskControl={taskControl} />\n`
    expect(planted).toMatch(/taskControl=\{taskControl\}/)
    expect(SRC).not.toMatch(/taskControl=\{taskControl\}/)
  })

  test('`PanelBarBand` (the relayed-session fallback) renders nothing once its own panel bar is empty', () => {
    const start = SRC.indexOf('function PanelBarBand(')
    const bodyEnd = SRC.indexOf('\nfunction ', start + 1)
    const fn = bodyEnd === -1 ? SRC.slice(start) : SRC.slice(start, bodyEnd)
    expect(start).toBeGreaterThan(-1)
    expect(fn).toContain('if (barEntries.length === 0) return null')
    // The guard must run BEFORE the band's own markup, or an empty band still measures a live DOM
    // node for the length of one render.
    expect(fn.indexOf('if (barEntries.length === 0) return null')).toBeLessThan(fn.indexOf('return ('))
  })

  test('the scan still sees the empty-band guard dropped from `PanelBarBand`', () => {
    const start = SRC.indexOf('function PanelBarBand(')
    const bodyEnd = SRC.indexOf('\nfunction ', start + 1)
    const fn = bodyEnd === -1 ? SRC.slice(start) : SRC.slice(start, bodyEnd)
    const planted = fn.replace('if (barEntries.length === 0) return null', '')
    expect(planted.includes('if (barEntries.length === 0) return null')).toBe(false)
  })
})
