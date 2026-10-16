import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatBubble, SystemEventRow } from './ChatBubble'
import { parseSystemEvent } from '../../lib/systemEvent'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }

const turn = (text: string) => ({ role: 'user', text } as never)

test('injected away turn renders the event row, not a bubble', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('[from agentistics · away]\nxyzzy-body-marker')} lang="en" harness="claude" />)
  expect(html).toContain('Away mode updated')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('xyzzy-body-marker')
})
test('open row shows body', () => {
  const ev = parseSystemEvent('[from session abc · handback]\nline1\nline2')!
  const html = renderToStaticMarkup(<SystemEventRow event={ev} pt={false} defaultOpen />)
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('line1\nline2')
})
test('normal user turn is not an event row', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('hello there')} lang="en" harness="claude" />)
  expect(html).not.toContain('aria-expanded')
  expect(html).toContain('hello there')
})
test('handback turn with a sender goes through the fleet row and shows the sender', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('[from session ab12 · handback]\nxyzzy-body-marker')} lang="en" harness="claude" />)
  expect(html).toContain('handed back')
  expect(html).toContain('ab12')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('xyzzy-body-marker')
})

/** Renders a function component against a minimal hook dispatcher so a click can be replayed (no DOM lib here). */
function renderWithState(Comp: (p: never) => React.ReactElement, props: unknown) {
  const slots: unknown[] = []
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!
  let i = 0
  const dispatcher = {
    useState(init: unknown) {
      const idx = i++
      if (!(idx in slots)) slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => { slots[idx] = typeof v === 'function' ? (v as (x: unknown) => unknown)(slots[idx]) : v }
      return [slots[idx], set]
    },
    useEffect() {},
  }
  return () => {
    i = 0
    const prev = internals.H
    internals.H = dispatcher
    try { return (Comp as unknown as (p: unknown) => React.ReactElement)(props) } finally { internals.H = prev }
  }
}
const findButton = (el: React.ReactElement): React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean }> => {
  const hit = (n: unknown): React.ReactElement | null => {
    if (!React.isValidElement(n)) return null
    if (n.type === 'button') return n
    for (const c of React.Children.toArray((n.props as { children?: React.ReactNode }).children)) { const r = hit(c); if (r) return r }
    return null
  }
  return hit(el) as never
}

test('clicking the chip toggles the body', () => {
  const ev = parseSystemEvent('[from session abc · handback]\nxyzzy-body-marker')!
  const render = renderWithState(SystemEventRow as never, { event: ev, pt: false })
  const first = render()
  expect(findButton(first).props['aria-expanded']).toBe(false)
  expect(renderToStaticMarkup(first)).not.toContain('xyzzy-body-marker')
  findButton(first).props.onClick()
  const second = render()
  expect(findButton(second).props['aria-expanded']).toBe(true)
  expect(JSON.stringify(second)).toContain('xyzzy-body-marker')
  findButton(second).props.onClick()
  const third = render()
  expect(findButton(third).props['aria-expanded']).toBe(false)
  expect(JSON.stringify(third)).not.toContain('xyzzy-body-marker')
})
