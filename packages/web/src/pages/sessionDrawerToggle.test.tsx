import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { sessionDrawerToggle } from './SessionsPage'

const render = (open: boolean, dot = false) =>
  renderToStaticMarkup(sessionDrawerToggle({ open, dot, pt: false, onClick: () => {} }))

/** The opacity a given icon wrapper is drawn at. */
const opacityOf = (html: string, icon: string) => {
  const m = new RegExp(`data-icon="${icon}" style="[^"]*opacity:(\\d)`).exec(html)
  return m ? Number(m[1]) : null
}

describe('sessionDrawerToggle', () => {
  test('closed: PanelLeft shows, PanelLeftClose is faded out', () => {
    const html = render(false)
    expect(html).toContain('data-session-drawer-toggle="closed"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Open the session panel')
    expect(opacityOf(html, 'panel-left')).toBe(1)
    expect(opacityOf(html, 'panel-left-close')).toBe(0)
  })
  test('open: the icons cross-fade to PanelLeftClose', () => {
    const html = render(true)
    expect(html).toContain('data-session-drawer-toggle="open"')
    expect(html).toContain('Close the session panel')
    expect(opacityOf(html, 'panel-left')).toBe(0)
    expect(opacityOf(html, 'panel-left-close')).toBe(1)
  })
  test('both icons are always mounted, so the swap is a fade and never a jump', () => {
    for (const open of [true, false]) {
      const html = render(open)
      expect(html).toContain('lucide-panel-left"')
      expect(html).toContain('lucide-panel-left-close')
    }
  })
  test('the dot appears only when something wants you', () => {
    expect(render(false, false)).not.toContain('data-session-drawer-dot')
    expect(render(false, true)).toContain('data-session-drawer-dot')
  })
})
