import React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountLoginModal } from './AccountLoginModal'
import { ADD_COPY, addErrorText, type RootRowView } from './addAccountLogic'

const g = globalThis as unknown as { window: { innerWidth: number } }
const noop = () => {}
for (const width of [390, 1440]) for (const lang of ['pt', 'en'] as const) {
  describe(`account login · ${lang} · ${width}px`, () => {
    const render = (props: Partial<React.ComponentProps<typeof AccountLoginModal>> = {}) => {
      const old = g.window
      g.window = { innerWidth: width }
      try { return renderToStaticMarkup(<AccountLoginModal harness="codex" lang={lang} busy={false} submitted={false} error={null} onSubmit={noop} onCancel={noop} {...props} />) }
      finally { g.window = old }
    }
    const t = ADD_COPY(lang === 'pt')
    test('preparing link keeps cancellation available', () => {
      const html = render({ busy: true })
      expect(html).toContain(t.workingNote)
      expect(html).toContain(t.cancelPending)
      expect(html).toContain('role="dialog"')
    })
    for (const harness of ['claude', 'gemini', 'codex', 'copilot', 'kimi'] as const) {
      test(`${harness}: complete URL, appropriate code step and controls`, () => {
        const paste = harness === 'claude' || harness === 'gemini'
        const url = 'https://auth.example.test/authorize?public_state=' + 'a'.repeat(180)
        const html = render({ harness, login: { kind: paste ? 'paste' : 'device', url, code: 'ABCD-EFGH', expiresAt: Date.now() + 900000 } })
        // CONTAS.LOGIN r2: the long link is a button and a copy action, never printed raw.
        expect(html).toContain(`href="${url}"`)
        expect(html.replace(/href="[^"]*"/g, '')).not.toContain(url)
        expect(html).toContain('max-width:520px')
        expect(html).toContain(t.openLink)
        expect(html).toContain(t.copyLink)
        if (width === 390) expect(html).toContain('min-height:44px')
        else expect(html).not.toContain('min-height:44px')
        expect(html).toContain('data-login-url=')
        // Three numbered steps; the first is the current one and carries the one primary action.
        expect(html).toContain('data-step="1" data-step-state="active"')
        expect(html).toContain('data-step="2" data-step-state="todo"')
        expect(html).toContain('data-step="3" data-step-state="todo"')
        expect(html).toContain(t.stepDone)
        expect(html).toContain(`data-login-step="${paste ? 'paste' : 'device'}"`)
        if (paste) {
          // CONTAS.LOGIN: a one-time code, never a password field (Chrome offered "Update password?").
          expect(html).not.toContain('type="password"')
          expect(html).toContain('autoComplete="one-time-code"')
          expect(html).toContain(t.submit)
          expect(html).toContain(t.awaitingCode)
          expect(html).not.toContain(t.submitted)
        } else {
          expect(html).toContain(t.copyCode)
          expect(html).toContain('ABCD-EFGH')
          expect(html).not.toContain('<input')
        }
        expect(html).not.toContain('view=terminal')
        expect(html).not.toContain('Terminal')
      })
    }
    test('submitted paste waits without keeping the authorization code', () => {
      const html = render({ harness: 'gemini', submitted: true, login: { kind: 'paste', url: 'https://accounts.google.com/auth', expiresAt: Date.now() + 300000 } })
      expect(html).toContain(t.submitted)
      expect(html).toContain('value=""')
      expect(html).toContain('disabled=""')
    })
    test('invalid paste code restores the form with current URL and localized error', () => {
      const error = addErrorText({ error: 'invalid_code' }, lang === 'pt')
      const html = render({ harness: 'gemini', error, login: { kind: 'paste', url: 'https://accounts.google.com/auth?state=NEW_FAKE_STATE', expiresAt: Date.now() + 300000 } })
      expect(html).toContain('state=NEW_FAKE_STATE')
      expect(html).toContain(error)
      expect(html).toContain('type="text"')
      expect(html).not.toMatch(/<input[^>]*disabled/)
      expect(html).toContain(t.submit)
    })
    test('CONTAS.LOGIN r2: an attempt that is over shows "expired" with Try again, never a loose error', () => {
      const error = addErrorText({ error: 'not_found' }, lang === 'pt')
      const html = render({ harness: 'claude', expired: true, error, login: { kind: 'paste', url: 'https://claude.ai/oauth', expiresAt: Date.now() + 300000 } })
      expect(html).toContain('data-login-step="expired"')
      expect(html).toContain(t.expired)
      expect(html).toContain(t.retry)
      expect(html).toContain('data-login-retry')
      expect(html).not.toContain('Esta conta já não existe')
      expect(html).not.toContain('This account no longer exists')
      expect(html).not.toContain(t.copyLink)
    })
    test('success contains bound assistant, identity and plan', () => {
      const bound: RootRowView = { harness: 'codex', status: 'bound', root: '/root', label: 'person@example.test', plan: 'Pro' }
      const html = render({ bound })
      expect(html).toContain(t.done)
      expect(html).toContain('Codex CLI · person@example.test')
      expect(html).toContain('Pro')
      expect(html).toContain(t.finish)
      expect(html).not.toContain(t.copyLink)
    })
    test('CONTAS.LOGIN r4: the pasted code is masked without being a password field', () => {
      const html = render({ harness: 'claude', login: { kind: 'paste', url: 'https://claude.com/cai/oauth/authorize?x=1', expiresAt: Date.now() + 900000 } })
      const input = html.match(/<input[^>]*>/)![0]
      expect(input).toContain('type="text"')
      expect(input).not.toContain('type="password"')
      expect(input).toContain('-webkit-text-security:disc')
      expect(input).toContain('data-1p-ignore')
      expect(input).toContain('data-lpignore="true"')
      expect(input).toContain('autoComplete="one-time-code"')
      expect(html).toContain('aria-pressed')
    })
    for (const reason of ['plaintext_refused', 'login_timeout', 'login_failed', 'invalid_code']) {
      test(`${reason}: localized refusal`, () => {
        const message = addErrorText({ error: reason }, lang === 'pt')
        const html = render({ error: message })
        expect(html).toContain('role="alert"')
        expect(html).toContain(message)
        expect(html).not.toContain(reason)
      })
    }
  })
}
