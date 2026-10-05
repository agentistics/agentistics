import { describe, expect, test } from 'bun:test'
import { threadCopy } from './threadCopy'

describe('the tab and its two acts are named apart', () => {
  test('the tab covers topics AND comments, clearly, in both languages', () => {
    expect(threadCopy('pt').tabThreads).toBe('Conversa')
    expect(threadCopy('en').tabThreads).toBe('Discussion')
  })
  test('"Abrir tópico" opens a topic; "Comentar" is the plain comment — different verbs, different hints', () => {
    const pt = threadCopy('pt'), en = threadCopy('en')
    expect(pt.newThread).toBe('Abrir tópico')
    expect(en.newThread).toBe('Open a topic')
    expect(pt.commentAction).toBe('Comentar')
    expect(pt.newThread).not.toBe(pt.commentAction)
    expect(pt.newThreadHint).toContain('tópico')
    expect(pt.commentOnTaskHint).toContain('sem tópico')
    expect(en.commentOnTaskHint).toContain('no topic')
  })
})
