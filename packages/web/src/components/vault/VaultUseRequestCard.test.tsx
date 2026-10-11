import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UseRequestDialog, useRequestWords } from './VaultUseRequestCard'
import type { VaultUseRequest } from '../../lib/vaultApi'

const req: VaultUseRequest = { id: 'use-1', sessionTitle: 'Painel', harness: 'codex', name: 'OpenAI', field: 'value', command: 'curl https://example.invalid', flags: ['network'], count: 1, expiresAt: 0 }

describe('VaultUseRequestCard', () => {
  test('pt and en words: who asks, which secret, the command, the warning, Approve/Deny — and never a value', () => {
    const pt = useRequestWords(req, 'pt'), en = useRequestWords(req, 'en')
    expect(pt.title).toBe('Um agente quer usar um segredo'); expect(en.title).toBe('An agent wants to use a secret')
    expect([pt.confirm, pt.cancel]).toEqual(['Aprovar', 'Negar']); expect([en.confirm, en.cancel]).toEqual(['Approve', 'Deny'])
    expect(pt.message).toContain('Painel (codex) — OpenAI · value'); expect(pt.message).toContain('curl https://example.invalid'); expect(pt.message).toContain('Pode guardar o segredo.')
    expect(en.message).toContain('This command may keep the secret.')
    expect(useRequestWords(req, 'pt', true).confirm).toBe('Confirmando…'); expect(useRequestWords(req, 'en', true).confirm).toBe('Confirming…')
    expect(useRequestWords({ ...req, flags: [], command: null }, 'en').message).toBe('Painel (codex) — OpenAI · value')
  })
  test('renders through the shared ConfirmModal with both buttons', () => {
    const g = globalThis as Record<string, unknown>, had = 'window' in g
    if (!had) g.window = { innerWidth: 1280, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
    try {
    for (const lang of ['pt', 'en'] as const) {
      const html = renderToStaticMarkup(<UseRequestDialog request={req} lang={lang} busy={false} onDecide={() => {}} />)
      const w = useRequestWords(req, lang)
      expect(html).toContain(w.cancel); expect(html).toContain(w.confirm)
    }
    } finally { if (!had) delete g.window }
  })
})
