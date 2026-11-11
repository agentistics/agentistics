import { describe, expect, test } from 'bun:test'
import { hasStructuralProof, ownerConversationIsWork } from './review-clean'

describe('review cleanup safety rules', () => {
  test('owner conversation examples classify conversational updates as abandoned and work as report-only', () => {
    expect(ownerConversationIsWork('precisa de algo meu?')).toBe(false)
    expect(ownerConversationIsWork('mandei, to aguardando a resposta dela.')).toBe(false)
    expect(ownerConversationIsWork('eu vou dormir entao. n faz nada que possa…')).toBe(false)
    expect(ownerConversationIsWork('explora TODAS as pocs, certo? depois que fi')).toBe(true)
  })
  test('proof is structural and does not treat Portuguese prose containing pr as proof', () => {
    expect(hasStructuralProof(null, [{ body: 'precisa de algo meu?', kind: 'note' }])).toBe(false)
    expect(hasStructuralProof(null, [{ body: 'PR #42 foi aberto', kind: 'note' }])).toBe(true)
    expect(hasStructuralProof(null, [{ body: 'mandei o sha abcdef1', kind: 'note' }])).toBe(true)
    expect(hasStructuralProof(null, [{ body: 'resultado', kind: 'handback', role: 'session' }])).toBe(true)
    expect(hasStructuralProof(null, [{ body: 'prompt problema precisa', kind: 'note' }])).toBe(false)
  })
})
