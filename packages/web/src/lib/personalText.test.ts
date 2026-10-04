import { expect, test } from 'bun:test'
import { PERSONAL_TEXT, pt_ } from './personalText'

test('every key has EN and PT, and no text tells the person to run a command', () => {
  for (const [k, v] of Object.entries(PERSONAL_TEXT)) {
    expect(v.en.length, k).toBeGreaterThan(0)
    expect(v.pt.length, k).toBeGreaterThan(0)
    for (const s of [v.en, v.pt]) expect(s, k).not.toMatch(/`agentop /)
  }
})
test('the Login hint is the owner\'s wording', () => {
  expect(pt_('loginHint', 'pt')).toBe('e-mail, usuário, telefone, CPF…')
  expect(pt_('showing', 'pt', { a: 1, b: 25, n: 40 })).toBe('1–25 de 40')
})
