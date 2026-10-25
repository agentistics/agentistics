import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HARNESS_ORDER } from '@agentistics/core'
import { visibleQueued } from '../../lib/queuedCards'
const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
const { ChatBubble } = await import('./ChatBubble')

// The driver's confirmed user turn is the acknowledgement, regardless of harness or command name.
// No command allowlist belongs in the browser: skills and ordinary prompts may also start with '/'.
describe('local command acknowledgement', () => {
  for (const harness of HARNESS_ORDER) for (const lang of ['pt', 'en'] as const) {
    test(`${harness}/${lang}: completion replaces the unread bubble with a system line`, () => {
      const command = '/rename Example'
      const pending = [{ text: command, at: 1 }]
      expect(visibleQueued(pending, [], true)).toEqual(pending)
      const before = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: command }} harness={harness} lang={lang} awaiting />)
      expect(before).toContain(lang === 'pt' ? 'ainda não lida' : 'not read yet')

      // A local result produces this turn only AFTER the harness has handled the command.
      expect(visibleQueued(pending, [command], true)).toEqual([])
      const after = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: command }} harness={harness} lang={lang} />)
      expect(after).toContain('Example')
      expect(after).toContain(lang === 'pt' ? 'Sessão renomeada para “Example”' : 'Session renamed to “Example”')
      expect(after).not.toContain('lucide-user')
      expect(after).not.toContain('aria-expanded')
      expect(after).not.toContain('/rename')
      expect(after).not.toContain(lang === 'pt' ? 'ainda não lida' : 'not read yet')
    })
  }

  test('only a complete rename invocation becomes a system line', () => {
    for (const text of ['/rename', '/rename-other Example', '/review Example', 'Explain /rename Example', '/rename Example\nPlease review this']) {
      const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text }} harness="claude" lang="en" />)
      expect(html).not.toContain('Session renamed to')
    }
    const assistant = renderToStaticMarkup(<ChatBubble turn={{ role: 'assistant', text: '/rename Example' }} harness="claude" lang="en" />)
    expect(assistant).not.toContain('Session renamed to')
    const pending = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: '/rename Example', pending: true }} harness="claude" lang="en" />)
    expect(pending).not.toContain('Session renamed to')
  })

  test('a long title uses the system line at desktop and 390px mobile widths', () => {
    const width = window.innerWidth
    try {
      for (const innerWidth of [1200, 390]) {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth })
        const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: `/rename ${'LongTitle'.repeat(100)}` }} harness="claude" lang="en" />)
        expect(html).toContain('Session renamed to')
        expect(html).toContain('overflow-wrap:anywhere')
        if (innerWidth === 390) expect(html).toContain('min-height:44px')
      }
    } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }) }
  })

  test('transcript chat uses the same system line in either language for every harness', async () => {
    const { MessageBubble } = await import('../HarnessChat')
    for (const harness of HARNESS_ORDER) for (const pt of [true, false]) {
      const html = renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content: '/rename Example', timestamp: 1 }} harness={harness} pt={pt} />)
      expect(html).toContain(pt ? 'Sessão renomeada para “Example”' : 'Session renamed to “Example”')
      expect(html).not.toContain('lucide-user')
      expect(html).not.toContain('/rename')
    }
  })

  test('acknowledging a command keeps a later mid-turn prompt unread', () => {
    const queue = [{ text: 'Please review the next change' }, { text: '/rename Example' }]
    expect(visibleQueued(queue, ['/rename Example'], true)).toEqual([queue[0]!])
    const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: queue[0]!.text }} harness="claude" lang="en" awaiting awaitingWorking />)
    expect(html).toContain('when its turn ends')
  })

  test('a slash skill without an acknowledgement remains unread', () => {
    const queue = [{ text: '/review Explain the changes' }]
    expect(visibleQueued(queue, [], true)).toEqual(queue)
  })
})
