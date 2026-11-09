import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

const { StrandedList, strandedActionKind } = await import('./StrandedList')
const cards = [{ text: 'run the full migration now', at: 1 }]
const draw = (composer: boolean, lang: 'en' | 'pt' = 'en', harness = 'codex') =>
  renderToStaticMarkup(<StrandedList cards={cards} sessionId="s" harness={harness} lang={lang} now={2000} onPutBack={() => {}} composer={composer} />)

test('no composer: the card stays with the full text and offers Copy, not put-back (any harness)', () => {
  expect(strandedActionKind(false)).toBe('copy')
  for (const h of ['claude', 'codex', 'gemini']) {
    const html = draw(false, 'en', h)
    expect(html).toContain('run the full migration now')
    expect(html).toContain('Copy message')
    expect(html).not.toContain('Put back in the message box')
  }
  expect(draw(false, 'pt')).toContain('Copiar mensagem')
})

test('composer present: put-back is unchanged', () => {
  expect(strandedActionKind(true)).toBe('put-back')
  const html = draw(true)
  expect(html).toContain('Put back in the message box')
  expect(html).not.toContain('Copy message')
})
