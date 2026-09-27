import React from 'react'
import { describe, test, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RowSwitch, StatusDot, Select, MultiPicker, popoverPosition } from './primitives'

describe('RowSwitch', () => {
  test('the row itself is a <button role="switch"> with aria-checked reflecting `on`', () => {
    const onHtml = renderToStaticMarkup(<RowSwitch on onToggle={() => {}} label="Acme/repo" />)
    expect(onHtml).toMatch(/^<button\b/)
    expect(onHtml).toContain('role="switch"')
    expect(onHtml).toContain('aria-checked="true"')

    const offHtml = renderToStaticMarkup(<RowSwitch on={false} onToggle={() => {}} label="Acme/repo" />)
    expect(offHtml).toContain('aria-checked="false"')
  })

  test('carries an aria-label so the row is announced without relying on visible text alone', () => {
    const html = renderToStaticMarkup(<RowSwitch on onToggle={() => {}} label="Acme/repo" />)
    expect(html).toContain('aria-label="Acme/repo"')
  })

  test('renders exactly one <button> — the switch pill is a plain span, never a nested button', () => {
    const html = renderToStaticMarkup(<RowSwitch on onToggle={() => {}} label="Acme/repo" sub="12 sessions" />)
    const buttonCount = (html.match(/<button\b/g) ?? []).length
    expect(buttonCount).toBe(1)
  })

  test('dimmed renders the label struck through, not only recolored', () => {
    const html = renderToStaticMarkup(<RowSwitch on={false} onToggle={() => {}} label="Acme/repo" dimmed />)
    expect(html).toContain('line-through')
  })

  test('disabled sets the disabled attribute', () => {
    const html = renderToStaticMarkup(<RowSwitch on onToggle={() => {}} label="Acme/repo" disabled />)
    expect(html).toContain('disabled')
  })
})

describe('StatusDot', () => {
  test('renders a decorative dot with no text content of its own', () => {
    const html = renderToStaticMarkup(<StatusDot state="ok" />)
    expect(html).toContain('aria-hidden')
    // No visible text — the caller is responsible for stating the status in words.
    expect(html.replace(/<[^>]+>/g, '').trim()).toBe('')
  })

  test('each state maps to a distinct color', () => {
    const colorsOf = (html: string) => html.match(/background:\s*([^;"]+)/)?.[1]
    const ok = colorsOf(renderToStaticMarkup(<StatusDot state="ok" />))
    const warn = colorsOf(renderToStaticMarkup(<StatusDot state="warn" />))
    const error = colorsOf(renderToStaticMarkup(<StatusDot state="error" />))
    const unknown = colorsOf(renderToStaticMarkup(<StatusDot state="unknown" />))
    const set = new Set([ok, warn, error, unknown])
    expect(set.size).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Popovers inside a scrolling drawer
//
// The Drawer's body is `overflowY: auto`. A `position: absolute` child of a scroll container is
// CLIPPED by it — CSS, not opinion — so both popovers opened into a box that cut them off as soon
// as the drawer had enough content to scroll. That is what made the tag editor's pickers
// unclickable: the panel was open, and outside the visible area.
//
// Worse, both decided which way to open by measuring the WINDOW (`window.innerHeight - rect.bottom`)
// while the thing doing the clipping was the drawer, so "there is room below" was answered about
// the wrong box.
//
// They are anchored with `position: fixed` now, which no ancestor's overflow can clip.
// ---------------------------------------------------------------------------

describe('popovers are not clipped by a scrolling ancestor', () => {
  // These two render their panel, which reaches for `useIsMobile()` — and static markup has no
  // window. The stub is only what that hook reads; nothing here depends on the value.
  const withWindow = (fn: () => string): string => {
    const g = globalThis as { window?: unknown }
    const had = 'window' in g
    if (!had) g.window = { innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
    try { return fn() } finally { if (!had) delete g.window }
  }

  test('Select renders its listbox as position: fixed', () => {
    const html = withWindow(() => renderToStaticMarkup(
      <Select value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} defaultOpenForTest />,
    ))
    expect(html).toContain('role="listbox"')
    expect(html).toMatch(/role="listbox"[^>]*style="[^"]*position:fixed/)
    expect(html).not.toMatch(/role="listbox"[^>]*style="[^"]*position:absolute/)
  })

  test('MultiPicker renders its listbox as position: fixed', () => {
    const html = withWindow(() => renderToStaticMarkup(
      <MultiPicker
        options={[{ value: 'a', label: 'A' }]}
        onCommit={() => {}}
        placeholder="pick"
        searchPlaceholder="search"
        confirmLabel={n => `Add ${n}`}
        selectAllLabel="all"
        emptyLabel="none"
        defaultOpenForTest
      />,
    ))
    expect(html).toContain('role="listbox"')
    expect(html).toMatch(/role="listbox"[^>]*style="[^"]*position:fixed/)
    expect(html).not.toMatch(/role="listbox"[^>]*style="[^"]*position:absolute/)
  })
})

// ---------------------------------------------------------------------------
// Touch targets — the project rule is >= 44px on mobile ONLY, never desktop.
// ---------------------------------------------------------------------------

describe('Select trigger touch target', () => {
  // Unlike the `withWindow` helper above (which only needs SOME window to exist), this test's
  // outcome depends on the exact width — so it cannot skip stubbing just because some other test
  // file in this same bun process left a `window` behind (e.g. UnsavedChangesGuard.test.tsx sets
  // one at module scope). Always force the width for the call and restore whatever was there
  // before, own-property-ness included, rather than conditionally no-op-ing on `'window' in g`.
  const withWindowWidth = (width: number, fn: () => string): string => {
    const g = globalThis as { window?: unknown }
    const hadOwn = Object.prototype.hasOwnProperty.call(g, 'window')
    const prev = g.window
    g.window = {
      innerWidth: width, innerHeight: 900,
      matchMedia: () => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {}, removeEventListener() {},
    }
    try { return fn() } finally { if (hadOwn) g.window = prev; else delete g.window }
  }
  const withMobileWindow = (fn: () => string) => withWindowWidth(390, fn)
  const withDesktopWindow = (fn: () => string) => withWindowWidth(1440, fn)

  test('the closed trigger button is at least 44px tall on mobile', () => {
    const html = withMobileWindow(() => renderToStaticMarkup(
      <Select value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />,
    ))
    expect(html).toMatch(/<button\b[^>]*style="[^"]*min-height:44px/)
  })

  test('the closed trigger has no min-height on desktop', () => {
    const html = withDesktopWindow(() => renderToStaticMarkup(
      <Select value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />,
    ))
    expect(html).not.toMatch(/<button\b[^>]*style="[^"]*min-height/)
  })
})

describe('popoverPosition', () => {
  const rect = (top: number, height = 40, left = 100, width = 240) =>
    ({ top, bottom: top + height, left, width, right: left + width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

  test('opens downward when the viewport has room below', () => {
    expect(popoverPosition(rect(100), 280, 900)).toEqual({ left: 100, top: 144, width: 240 })
  })

  test('flips up when there is not enough room below AND more room above', () => {
    const pos = popoverPosition(rect(700), 280, 900)
    expect(pos.bottom).toBe(204)   // 900 - 700, + the 4px gap
    expect(pos.top).toBeUndefined()
  })

  test('stays down when neither side fits — flipping into even less room is worse', () => {
    const pos = popoverPosition(rect(40), 280, 300)
    expect(pos.top).toBe(84)
    expect(pos.bottom).toBeUndefined()
  })

  test('carries the trigger width, so the panel lines up with the field', () => {
    expect(popoverPosition(rect(100, 40, 12, 333), 280, 900).width).toBe(333)
  })
})
