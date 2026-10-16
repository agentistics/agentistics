import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatBubble, SystemEventRow } from './ChatBubble'
import { parseSystemEvent } from '../../lib/systemEvent'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }

const turn = (text: string) => ({ role: 'user', text } as never)

test('injected away turn renders the event row, not a bubble', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('[from agentistics · away]\nbody')} lang="en" harness="claude" />)
  expect(html).toContain('Away mode updated')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('body')
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
