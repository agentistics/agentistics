/**
 * sessionPanel.lint.test.ts — `StudioBand`'s resize handle and content box may never sit inside a
 * non-growing wrapper (the freeze this pins).
 *
 * `StudioBand` (`SessionPanel.tsx`) shares its "snap to fill the column" geometry with `ShellBand`
 * (`resolveBandHeight`, `shellBand.ts`) — dragging the handle near the column's own top edge sets
 * `heightPrefs.full`, and the band's ROOT then reads `flex: '1 1 auto'` to stretch and fill it.
 *
 * The resize handle and the content box (the one the Studio's own portal carrier — `contentRef` —
 * lives inside) used to sit wrapped in an EXTRA `<div style={{display:'flex',flexDirection:
 * 'column'}}>` with no `flex`/`minHeight` of its own. That div is a flex ITEM of the root, and
 * with no `flex` it takes only the height its CONTENT asks for (`flex: 0 1 auto`, the CSS default)
 * instead of growing into whatever the root — which DOES stretch when `full` — actually had to
 * give it. The content box's own `flex: '1 1 auto'` then had nothing to grow INTO (a flex-grow
 * child cannot exceed a non-growing parent), so the whole thing collapsed to its minimum size and
 * the root's remaining ~400px sat empty below it.
 *
 * MEASURED live, before the fix: dragging the handle to the column's top DID grow the root (its own
 * `getBoundingClientRect().height` read 469px, `flex: 1 1 auto` correctly applied) while the box
 * carrying `data-studio-layout` measured `height: 0` — the tree and the editor rendered into a
 * sliver at the top of the band and the rest sat blank, which is what read as "the band went
 * empty… and never became full screen." `ShellBand` never had this bug: its own handle and content
 * box are direct children of ITS root, with no such wrapper — this file's fix makes `StudioBand`
 * match that shape (a Fragment, not a div) rather than inventing a second one.
 *
 * Not reachable by rendering: `StudioBand` is not exported (there is no seam to mount it through),
 * and this package has no jsdom regardless. The SHAPE is what went wrong, so the shape is what is
 * asserted, over comment-free source, with the defect planted below to prove the scan still sees
 * it — see `SessionPanel.tsx`'s own header comment at the fix site for the live-repro proof (two
 * screenshots, before and after, in this task's report) that a rendering test cannot itself carry.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const RAW = readFileSync(join(import.meta.dir, 'SessionPanel.tsx'), 'utf-8')
const SRC = stripComments(RAW)

/** Only `StudioBand`'s own body — `PanelBarBand`, further down, has its own unrelated `{open && (`. */
function studioBandBody(src: string): string {
  const start = src.indexOf('function StudioBand(')
  const end = src.indexOf('function PanelBarBand(')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('StudioBand — the resize handle and content box are direct children of the growing root', () => {
  test('the open block is a Fragment, never a plain div, around the handle and the content box', () => {
    const body = studioBandBody(SRC)
    const openAt = body.indexOf('{open && (')
    expect(openAt).toBeGreaterThan(-1)
    // The next non-whitespace token after `{open && (` must be a Fragment opener, not a div that
    // would re-introduce the non-growing wrapper.
    const after = body.slice(openAt + '{open && ('.length).trimStart()
    expect(after.startsWith('<>')).toBe(true)
    expect(after.startsWith("<div style={{ display: 'flex', flexDirection: 'column' }}>")).toBe(false)
  })

  test('the resize handle and the content box both close back into that SAME fragment', () => {
    const body = studioBandBody(SRC)
    const openAt = body.indexOf('{open && (')
    const closeAt = body.indexOf('</>', openAt)
    const separatorAt = body.indexOf('role="separator"', openAt)
    const contentRefAt = body.indexOf('ref={contentRef}', openAt)
    expect(closeAt).toBeGreaterThan(-1)
    expect(separatorAt).toBeGreaterThan(openAt)
    expect(separatorAt).toBeLessThan(closeAt)
    expect(contentRefAt).toBeGreaterThan(separatorAt)
    expect(contentRefAt).toBeLessThan(closeAt)
  })

  test('the scan still sees the wrapper reintroduced, at the exact spot that broke this', () => {
    const body = studioBandBody(SRC)
    const openAt = body.indexOf('{open && (')
    const fragOpenAt = body.indexOf('<>', openAt)
    const fragCloseAt = body.indexOf('</>', fragOpenAt)
    expect(fragOpenAt).toBeGreaterThan(-1)
    expect(fragCloseAt).toBeGreaterThan(fragOpenAt)
    const DIV_OPEN = "<div style={{ display: 'flex', flexDirection: 'column' }}>"
    const planted = body.slice(0, fragOpenAt) + DIV_OPEN
      + body.slice(fragOpenAt + '<>'.length, fragCloseAt) + '</div>'
      + body.slice(fragCloseAt + '</>'.length)
    const after = planted.slice(openAt + '{open && ('.length).trimStart()
    expect(after.startsWith(DIV_OPEN)).toBe(true)
  })
})
