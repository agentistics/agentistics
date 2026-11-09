import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

const { ChatBubble } = await import('./ChatBubble')

const action = { label: 'Put back in the message box', hint: 'hint', run: () => {} }

test('MENSAGENS.KILL: a stranded message says it was never read and offers the one action (any harness)', () => {
  for (const harness of ['claude', 'codex', 'gemini']) {
    const html = renderToStaticMarkup(
      <ChatBubble turn={{ role: 'user', text: 'run the migration' }} lang="en" harness={harness} sessionId="s" awaiting stranded={action} />,
    )
    expect(html).toContain('Never read — the session is no longer running.')
    expect(html).toContain('data-testid="stranded-resend"')
    expect(html).toContain('Put back in the message box')
    expect(html).not.toContain('not read yet')
  }
})

test('MENSAGENS.KILL: the action is a real touch target (44 on phone, 32 on desktop), not a 12px link', () => {
  const html = (w: number) => {
    ;(globalThis as Record<string, any>).window.innerWidth = w
    return renderToStaticMarkup(
      <ChatBubble turn={{ role: 'user', text: 'x' }} lang="en" harness="claude" sessionId="s" awaiting stranded={action} />,
    )
  }
  const btn = (h: string) => h.slice(h.indexOf('data-testid="stranded-resend"'))
  expect(btn(html(390))).toContain('min-height:44px')
  expect(btn(html(1200))).toContain('min-height:32px')
  ;(globalThis as Record<string, any>).window.innerWidth = 1200
})

test('MENSAGENS.KILL: the caption is in Portuguese for pt', () => {
  const html = renderToStaticMarkup(
    <ChatBubble turn={{ role: 'user', text: 'oi' }} lang="pt" harness="claude" sessionId="s" awaiting stranded={action} />,
  )
  expect(html).toContain('Não chegou a ser lida')
})

test('a live queued message keeps its wait caption and has no stranded control', () => {
  const html = renderToStaticMarkup(
    <ChatBubble turn={{ role: 'user', text: 'x' }} lang="en" harness="claude" sessionId="s" awaiting awaitingSinceMs={1000} />,
  )
  expect(html).not.toContain('stranded-resend')
})
