import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as realFleet from '../../lib/fleet'
import { parseSystemEvent } from '../../lib/systemEvent'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

// Seed the fleet so the sender resolves to a title only through useFleet.
mock.module('../../lib/fleet', () => ({
  ...realFleet,
  useFleet: () => ({ fleet: { rows: [{ id: 'ab12cdef', conversationId: 'c1', title: 'Leader Xyzzy' }] } }),
}))
const { ChatBubble, SystemEventRow } = await import('./ChatBubble')

const turn = (text: string) => ({ role: 'user', text } as never)

test('marked and legacy check-in user turns render collapsed system rows without user chrome', () => {
  for (const opener of ['[from agentistics · check-in]\nFaça o check-in da liderança agora.', 'Faça o check-in da liderança agora.', 'Run the leadership check-in now.']) {
    const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: `${opener}\nxyzzy-checklist-marker`, pending: true }} lang="en" harness="claude" sessionId="leader-id" awaiting awaitingSinceMs={0} />)
    expect(html).toContain('Leadership check-in · system')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Open check-in')
    expect(html).not.toContain('xyzzy-checklist-marker')
    expect(html).not.toContain('Send now')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('lucide-user')
  }
})

test('expanded check-in row shows the checklist and its localized action', () => {
  const event = parseSystemEvent('[from agentistics · check-in]\nxyzzy-checklist-marker')!
  const html = renderToStaticMarkup(<SystemEventRow event={event} pt defaultOpen />)
  expect(html).toContain('Check-in da liderança · sistema')
  expect(html).toContain('Abrir check-in')
  expect(html).toContain('xyzzy-checklist-marker')
  expect(html).toContain('min-height:24px')
})

test('open check-in dispatches the existing session-scoped UI event', () => {
  const hadOwn = Object.prototype.hasOwnProperty.call(window, 'dispatchEvent')
  const originalDispatch = window.dispatchEvent
  const received: CustomEvent<{ sessionId: string }>[] = []
  window.dispatchEvent = ((event: Event) => { received.push(event as CustomEvent<{ sessionId: string }>); return true })
  try {
    function Row() {
      const tree = SystemEventRow({ event: { kind: 'checkin', body: 'checklist' }, pt: false, sessionId: 'leader-id' })
      React.Children.forEach(tree.props.children, child => {
        if (React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child) && child.type === 'button' && child.props.children === 'Open check-in') child.props.onClick!()
      })
      return tree
    }
    renderToStaticMarkup(<Row />)
    expect(received).toHaveLength(1)
    expect(received[0]?.type).toBe('agentistics:open-checkin')
    expect(received[0]?.detail).toEqual({ sessionId: 'leader-id' })
  } finally {
    if (hadOwn) window.dispatchEvent = originalDispatch
    else delete (window as { dispatchEvent?: unknown }).dispatchEvent
  }
})

test('check-in controls have 44px touch targets at 390px', () => {
  const viewport = window as { innerWidth: number }
  const originalWidth = viewport.innerWidth
  viewport.innerWidth = 390
  try {
    const html = renderToStaticMarkup(<SystemEventRow event={{ kind: 'checkin', body: 'checklist' }} pt={false} />)
    expect(html.match(/min-height:44px/g)).toHaveLength(2)
  } finally {
    viewport.innerWidth = originalWidth
  }
})

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
  expect(html).toContain('Leader Xyzzy')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('xyzzy-body-marker')
})

const findButton = (el: React.ReactNode): React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean }> | null => {
  let hit: React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean }> | null = null
  const visit = (n: React.ReactNode) => {
    React.Children.forEach(n, c => {
      if (hit || !React.isValidElement<{ children?: React.ReactNode }>(c)) return
      if (c.type === 'button') { hit = c as never; return }
      visit(c.props.children)
    })
  }
  visit(el)
  return hit
}

test('clicking the chip toggles the body', () => {
  const ev = parseSystemEvent('[from session abc · handback]\nxyzzy-body-marker')!
  let open = false
  let click: (() => void) | undefined
  function Row() {
    const tree = SystemEventRow({ event: ev, pt: false, open, onOpenChange: v => { open = v } })
    click = findButton(tree)?.props.onClick
    return tree
  }
  const closed = renderToStaticMarkup(<Row />)
  expect(closed).toContain('aria-expanded="false"')
  expect(closed).not.toContain('xyzzy-body-marker')
  click!()
  expect(open).toBe(true)
  const opened = renderToStaticMarkup(<Row />)
  expect(opened).toContain('aria-expanded="true"')
  expect(opened).toContain('xyzzy-body-marker')
  click!()
  expect(open).toBe(false)
  const again = renderToStaticMarkup(<Row />)
  expect(again).toContain('aria-expanded="false"')
  expect(again).not.toContain('xyzzy-body-marker')
})
