import { describe, expect, it } from 'bun:test'
import { excerptAround, findMatches, foldForSearch, foldQuery, searchChatTurns, type ChatSearchTurn } from './chatSearch'

const mark = (excerpt: string, hs: { start: number; end: number }[]): string[] =>
  hs.map(h => excerpt.slice(h.start, h.end))

describe('folding', () => {
  it('ignores case and accents, and maps every folded unit back to the original', () => {
    const { folded, map } = foldForSearch('Função AÇÃO')
    expect(folded).toBe('funcao acao')
    expect(map.length).toBe(folded.length + 1)
    expect(map[map.length - 1]).toBe('Função AÇÃO'.length)
  })

  it('a decomposed accent (e + U+0301) folds like the precomposed one', () => {
    expect(foldForSearch('café').folded).toBe('cafe')
  })

  it('a query shorter than two characters is refused', () => {
    expect(foldQuery(' a ')).toBe('')
    expect(foldQuery('Ação')).toBe('acao')
  })
})

describe('findMatches', () => {
  it('finds the accented original from an unaccented query, in ORIGINAL offsets', () => {
    const text = 'Qual é a função disso? A FUNÇÃO principal.'
    const spans = findMatches(text, foldQuery('funcao'))
    expect(spans.map(s => text.slice(s.start, s.end))).toEqual(['função', 'FUNÇÃO'])
  })

  it('a decomposed accent is inside the highlighted span, not left dangling after it', () => {
    const text = 'um café forte'
    const [s] = findMatches(text, foldQuery('café'))
    expect(text.slice(s!.start, s!.end)).toBe('café')
  })
})

describe('excerptAround', () => {
  it('collapses newlines and marks the match inside the collapsed line', () => {
    const text = 'linha um\n\n  linha dois tem a palavra Busca aqui\nfim'
    const { excerpt, highlights } = excerptAround(text, findMatches(text, foldQuery('busca')))
    expect(excerpt).not.toContain('\n')
    expect(mark(excerpt, highlights)).toEqual(['Busca'])
  })

  it('a long message is cut around the match and says so on both ends', () => {
    const text = `${'antes '.repeat(60)}ALVO${' depois'.repeat(80)}`
    const { excerpt, highlights } = excerptAround(text, findMatches(text, foldQuery('alvo')))
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.length).toBeLessThan(220)
    expect(mark(excerpt, highlights)).toEqual(['ALVO'])
  })

  it('a match at the very start keeps the start uncut', () => {
    const text = 'Deploy feito com sucesso.'
    const { excerpt, highlights } = excerptAround(text, findMatches(text, foldQuery('deploy')))
    expect(excerpt).toBe(text)
    expect(highlights).toEqual([{ start: 0, end: 6 }])
  })
})

describe('searchChatTurns', () => {
  const turns: ChatSearchTurn[] = [
    { role: 'user', text: 'Como faço a migração?', at: '2026-10-01T10:00:00Z' },
    { role: 'assistant', text: 'A migracao roda no boot.', at: '2026-10-01T10:00:05Z' },
    { role: 'assistant', text: 'nota', system: 'skill' },
    { role: 'user', text: '   ' },
    { role: 'user', text: 'Outra coisa', at: '2026-10-02T09:00:00Z' },
    { role: 'user', text: 'E a MIGRAÇÃO de novo?', at: '2026-10-03T09:00:00Z' },
  ]

  it('returns matching messages newest first, with their position in the conversation', () => {
    const page = searchChatTurns(turns, 'migracao')
    expect(page.total).toBe(3)
    expect(page.hits.map(h => h.index)).toEqual([5, 1, 0])
    expect(page.hits[0]!.role).toBe('user')
    expect(page.hits[0]!.text).toBe('E a MIGRAÇÃO de novo?')
    expect(mark(page.hits[0]!.excerpt, page.hits[0]!.highlights)).toEqual(['MIGRAÇÃO'])
  })

  it('never returns a harness note or an empty message, and counts only real messages as scanned', () => {
    const page = searchChatTurns(turns, 'nota')
    expect(page.total).toBe(0)
    expect(page.scanned).toBe(4)
  })

  it('pages through the results', () => {
    const many = Array.from({ length: 100 }, (_, i): ChatSearchTurn => ({ role: 'user', text: `item ${i} alvo` }))
    const first = searchChatTurns(many, 'alvo', { limit: 30 })
    const second = searchChatTurns(many, 'alvo', { offset: 30, limit: 30 })
    expect(first.total).toBe(100)
    expect(first.hits[0]!.index).toBe(99)
    expect(second.hits[0]!.index).toBe(69)
  })

  it('a one-character query is refused and searches nothing', () => {
    const page = searchChatTurns(turns, 'm')
    expect(page.tooShort).toBe(true)
    expect(page.hits).toEqual([])
  })
})
