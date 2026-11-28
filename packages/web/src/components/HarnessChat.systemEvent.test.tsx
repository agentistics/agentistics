import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageBubble, TranscriptMessages } from './HarnessChat'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

describe('MessageBubble', () => {
  test('a session handback wrapped as pasted content is not drawn as the person', () => {
    const content = '\n\n<pasted_content id="a245">\n[from session 0bcf21c173 · handback]\nfix ready\n</pasted_content id="a245">\n'
    const html = renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content } as never} harness="claude" pt />)
    expect(html).not.toContain('Você')
    expect(html).toContain('Tarefa entregue')
    expect(html).not.toContain('0bcf21c173') // unknown senders are named by kind, never by a raw id
  })
  test('ordinary user text stays the person\'s bubble', () => {
    const html = renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content: 'oi' } as never} harness="claude" pt />)
    expect(html).toContain('Você')
  })
})

test('surface turns show the person text and mic marker in the harness transcript', () => {
  const html = renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content: '[from agentistics · surface]\n[Internal instructions.]\n\nShow my tasks.' } as never} harness="claude" pt={false} />)
  expect(html).toContain('Show my tasks.')
  expect(html).toContain('You')
  expect(html).toContain('data-surface-turn')
  expect(html).not.toContain('Internal instructions')
  expect(html).not.toContain('from agentistics')
})

describe('TranscriptMessages — a reaction to a notice', () => {
  const notice = '[from session 0bcf21c173 · notice]\nO líder mudou.\n(notice: no reply to the user. If nothing needs doing, end your turn with no chat text addressed to the user.)'
  const turns = [
    { role: 'user', content: notice },
    { role: 'assistant', content: 'Entendido: registrei a troca.' },
    { role: 'user', content: 'e agora?' },
    { role: 'assistant', content: 'Resposta normal.' },
  ] as never
  test('is folded under the notice row (pt), the next ordinary answer is not', () => {
    const html = renderToStaticMarkup(<TranscriptMessages transcript={turns} harness="codex" pt />)
    expect(html).toContain('data-notice-reply')
    expect(html).toContain('Reação ao aviso')
    expect(html.match(/data-notice-reply/g)!.length).toBe(1)
    expect(html).toContain('Resposta normal.')
    expect(html).not.toContain('no reply to the user')
  })
  test('en label', () => {
    expect(renderToStaticMarkup(<TranscriptMessages transcript={turns} harness="gemini" pt={false} />)).toContain('Reaction to the notice')
  })
  test('without a notice nothing is folded', () => {
    const html = renderToStaticMarkup(<TranscriptMessages transcript={(turns as unknown as unknown[]).slice(2) as never} harness="claude" pt />)
    expect(html).not.toContain('data-notice-reply')
  })
})
