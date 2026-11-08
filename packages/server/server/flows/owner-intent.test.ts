import { describe, expect, test } from 'bun:test'
import { nudgeExcerpt, ownerIntent, ownerRequestTitle, ownerTextWords } from './owner-intent'

describe('ownerIntent — a deterministic host rule', () => {
  test('questions: a trailing ?, or a short text with no request verb', () => {
    for (const q of ['e o deploy?', 'por que falhou???', 'qual a versão atual?', 'está pronto', 'and the release?', 'o que é o pedido p-1?']) expect(ownerIntent(q)).toBe('question')
  })
  test('work: an imperative verb, a polite request, a long statement — even when it ends in ?', () => {
    for (const w of [
      'corrige o login', 'manda o relatório', 'Fix the history column', 'faz o deploy e me avisa',
      'pode corrigir a coluna de histórico?', 'can you ship 2.203.0?', 'por favor revisa o PR', 'quero que a fila mostre a prioridade',
      'a passagem de liderança deveria ser um item de sistema e não um pedido do dono porque ela confunde a fila inteira',
    ]) expect(ownerIntent(w)).toBe('work')
  })
  test('when in doubt it is work: an empty or attachment-only message is never dropped as a question', () => {
    expect(ownerIntent('')).toBe('work')
    expect(ownerIntent('/home/me/.agentistics/attachments/158e1f81-image.png')).toBe('work')
  })
  test('quoted text and attachment paths are not the owner\'s words', () => {
    expect(ownerIntent('> corrige o login\n> faz o deploy\ne agora?')).toBe('question')
    expect(ownerTextWords('olha isso /home/me/.agentistics/attachments/a1b2-image.png ![x](file:abc)')).toBe('olha isso')
  })
})

describe('request title and nudge excerpt', () => {
  test('the title drops attachment paths and quote prefixes; an attachment-only message says so', () => {
    expect(ownerRequestTitle('> a coluna de histórico\n> está cortada /home/me/.agentistics/attachments/158e1f81-image.png')).toBe('a coluna de histórico está cortada')
    expect(ownerRequestTitle('/home/me/.agentistics/attachments/158e1f81-image.png')).toBe('(anexo, sem texto)')
    expect(ownerRequestTitle('x'.repeat(100))).toHaveLength(60)
  })
  test('the nudge carries about 80 characters, never the whole message', () => {
    const long = `Corrige a tela de sessões ${'blá '.repeat(100)}`
    const e = nudgeExcerpt(long, 80)
    expect(e.length).toBeLessThanOrEqual(81)
    expect(e.endsWith('…')).toBe(true)
    expect(nudgeExcerpt('curto')).toBe('curto')
  })
})
