import { describe, expect, test } from 'bun:test'
import { classifyOwnerMessage, isHandoffText, markHandoffRequest, markSuccessorPrompt } from './owner-intent'
import { isOwnerTurn } from '../sessions/handoff-relay'

describe('classifyOwnerMessage — a question is not a request (FLUXO.CICLO-COMPLETO 7b)', () => {
  test('the measured case and other plain questions', () => {
    for (const q of ['quando sai as coisas?', 'E o bug do login?', 'quanto já gastamos hoje', 'qual é o status da release?', 'tá rodando?', 'Saiu a 2.202?', 'what is blocking the merge?', 'how long until the release?']) {
      expect([q, classifyOwnerMessage(q)]).toEqual([q, 'question'])
    }
  })
  test('a work request keeps the request path, even phrased as a question', () => {
    for (const r of [
      'Implementa o botão de exportar CSV na tela de custos',
      'pode corrigir o login?',
      'consegue adicionar o filtro por conta?',
      'Corrige o alinhamento do card',
      'can you fix the export?',
      'faça a release hoje',
      'muda a cor do botão',
      'o card de custos está desalinhado',
    ]) expect([r, classifyOwnerMessage(r)]).toEqual([r, 'request'])
  })
  test('a long or multi-paragraph message is a request', () => {
    expect(classifyOwnerMessage(`quando ${'x'.repeat(300)}?`)).toBe('request')
    expect(classifyOwnerMessage('quando sai?\n\nE outra coisa: o card')).toBe('request')
    expect(classifyOwnerMessage('')).toBe('request')
  })
})

describe('hand-off texts never read as the owner (FLUXO.CICLO-COMPLETO 7a)', () => {
  test('the hand-off request and the successor prompt carry a header that isOwnerTurn refuses', () => {
    const req = markHandoffRequest('Quero passar a liderança agora. Prepare o arquivo durável de passagem…')
    expect(req.startsWith('[from agentistics · passagem]\n')).toBe(true)
    expect(isOwnerTurn({ role: 'user', text: req })).toBe(false)
    const first = markSuccessorPrompt('Leia o arquivo de passagem e assuma', 'abc123')
    expect(first.startsWith('[from session abc123 · passagem]\n')).toBe(true)
    expect(isOwnerTurn({ role: 'user', text: first })).toBe(false)
  })
  test('marking is idempotent and leaves an already-headed text (the automatic hint) alone', () => {
    const hint = '[from agentistics · question]\nHora de passar a liderança'
    expect(markHandoffRequest(hint)).toBe(hint)
    expect(markSuccessorPrompt(markSuccessorPrompt('x', 'a'), 'b')).toBe(markSuccessorPrompt('x', 'a'))
    expect(markSuccessorPrompt('x', 'bad id with spaces')).toBe('[from session predecessor · passagem]\nx')
  })
  test('the button sentence from before the header is recognised in old transcripts', () => {
    for (const t of ['Quero passar a liderança agora. Prepare o arquivo durável…', 'Hand off leadership now. Prepare the durable handoff file…']) {
      expect(isHandoffText(t)).toBe(true)
      expect(isOwnerTurn({ role: 'user', text: t })).toBe(false)
    }
    expect(isOwnerTurn({ role: 'user', text: 'quero passar o card para a direita' })).toBe(true)
  })
})
