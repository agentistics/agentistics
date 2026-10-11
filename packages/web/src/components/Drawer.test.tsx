import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Drawer } from './Drawer'

// `useIsMobile` reads the viewport on first render; a phone-sized one, as on the session screen —
// installed for this file only, so no other test sees a `window` that is not there.
const g = globalThis as { window?: unknown }
const hadWindow = 'window' in g
beforeAll(() => { if (!hadWindow) g.window = { innerWidth: 390 } })
afterAll(() => { if (!hadWindow) delete g.window })

describe('Drawer', () => {
  test('closed renders nothing', () => {
    expect(renderToStaticMarkup(<Drawer open={false} title="T" onClose={() => {}}>body</Drawer>)).toBe('')
  })

  test('opening mounts the panel OFF-SCREEN first, so the slide has somewhere to start from', () => {
    const html = renderToStaticMarkup(<Drawer open side="left" title={<b>head</b>} onClose={() => {}}>body</Drawer>)
    expect(html).toContain('data-drawer-phase="entering"')
    expect(html).toContain('translateX(-100%)')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('<b>head</b>')
    expect(html).toContain('body')
  })

  test('left: the caller draws the header — no close X; right: the titled header with its X', () => {
    expect(renderToStaticMarkup(<Drawer open side="left" title="L" onClose={() => {}}>x</Drawer>)).not.toContain('aria-label="Close"')
    const right = renderToStaticMarkup(<Drawer open title="Settings" onClose={() => {}}>x</Drawer>)
    expect(right).toContain('aria-label="Close"')
    expect(right).toContain('translateX(100%)')
  })
})
