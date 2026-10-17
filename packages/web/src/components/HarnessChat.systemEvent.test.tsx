import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageBubble } from './HarnessChat'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

describe('MessageBubble', () => {
  test('a session handback wrapped as pasted content is not drawn as the person', () => {
    const content = '\n\n<pasted_content id="a245">\n[from session 0bcf21c173 · handback]\nfix ready\n</pasted_content id="a245">\n'
    const html = renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content } as never} harness="claude" pt />)
    expect(html).not.toContain('Você')
    expect(html).toContain('0bcf21c173')
  })
  test('ordinary user text stays the person\'s bubble', () => {
    const html = renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content: 'oi' } as never} harness="claude" pt />)
    expect(html).toContain('Você')
  })
})
