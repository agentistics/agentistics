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
    test(`${harness}/${lang}: completion replaces the unread caption with a normal bubble`, () => {
      const command = '/rename Example'
      const pending = [{ text: command, at: 1 }]
      expect(visibleQueued(pending, [], true)).toEqual(pending)
      const before = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: command }} harness={harness} lang={lang} awaiting />)
      expect(before).toContain(lang === 'pt' ? 'ainda não lida' : 'not read yet')

      // A local result produces this turn only AFTER the harness has handled the command.
      expect(visibleQueued(pending, [command], true)).toEqual([])
      const after = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: command }} harness={harness} lang={lang} />)
      expect(after).toContain('Example')
      expect(after).not.toContain(lang === 'pt' ? 'ainda não lida' : 'not read yet')
    })
  }

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
