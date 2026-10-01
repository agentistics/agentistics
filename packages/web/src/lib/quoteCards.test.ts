import { describe, expect, it } from 'bun:test'
import type { ReplyTarget } from './replyQuote'
import {
  atomicDelete, composeQuoted, locateExcerpt, insertQuote, nextQuoteId, placeOrphans, quoteLabel, quoteMarker,
  quoteMarks, quotesInOrder, removeQuote, snapCaret, splitQuoted, stripQuotes, syncQuotes,
} from './quoteCards'

const label = (t: ReplyTarget) => quoteLabel(t, 'Claude Code')
const q1: ReplyTarget = { id: '1', role: 'assistant', text: 'Q1 · which database?', excerpt: true }
const q2: ReplyTarget = { id: '2', role: 'assistant', text: 'Q2 · which port?\nsecond line', excerpt: true }
const m1 = quoteMarker('1', label(q1))
const m2 = quoteMarker('2', label(q2))

describe('markers', () => {
  it('round-trips ids and finds every marker', () => {
    const d = `${m1}\nmongo\n${m2}\n48080`
    const marks = quoteMarks(d)
    expect(marks.map(m => m.id)).toEqual(['1', '2'])
    expect(d.slice(marks[0]!.labelStart, marks[0]!.closeStart)).toBe(label(q1))
  })
  it('ids above one bit survive', () => {
    expect(quoteMarks(quoteMarker('13', 'x')).map(m => m.id)).toEqual(['13'])
  })
  it('the label carries who and the first words, cut', () => {
    expect(label(q1)).toBe('↩ Claude Code: Q1 · which database?')
    const long = quoteLabel({ role: 'user', text: 'a'.repeat(200) }, 'Você', 20)
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThan(40)
  })
  it('nextQuoteId is one past the largest', () => {
    expect(nextQuoteId([])).toBe('1')
    expect(nextQuoteId([q1, { ...q2, id: '7' }])).toBe('8')
  })
})

describe('insertQuote', () => {
  it('puts the card on its own line at the caret and the caret after it', () => {
    const out = insertQuote('abc def', 3, m1)
    expect(out.draft).toBe(`abc\n${m1}\n\n def`)
    expect(out.caret).toBe(`abc\n${m1}\n`.length)
  })
  it('a card inserted ABOVE another leaves an empty line to answer on, never glued to it', () => {
    const out = insertQuote(`${m1}\nmongo`, 0, m2)
    expect(out.draft).toBe(`${m2}\n\n${m1}\nmongo`)
    expect(out.caret).toBe(`${m2}\n`.length)
  })
  it('a second card at the end ADDS, never replaces', () => {
    let d = insertQuote('', 0, m1)
    d = { ...d, draft: d.draft + 'answer one' }
    const out = insertQuote(d.draft, d.draft.length, m2)
    expect(quoteMarks(out.draft).map(m => m.id)).toEqual(['1', '2'])
    expect(out.draft).toBe(`${m1}\nanswer one\n${m2}\n`)
  })
  it('a caret inside a card is moved out of it first', () => {
    const d = `${m1}\nx`
    const out = insertQuote(d, 5, m2)
    expect(quoteMarks(out.draft).map(m => m.id)).toEqual(['2', '1'])
  })
})

describe('atomic editing', () => {
  const d = `${m1}\nmongo`
  const mk = quoteMarks(d)[0]!
  it('snaps a caret inside to the nearer edge, or across by direction', () => {
    expect(snapCaret(d, mk.start + 2)).toBe(mk.start)
    expect(snapCaret(d, mk.end - 2)).toBe(mk.end)
    expect(snapCaret(d, mk.start + 2, mk.end + 1)).toBe(mk.start)
    expect(snapCaret(d, mk.end - 2, 0)).toBe(mk.end)
    expect(snapCaret(d, mk.end + 2)).toBe(mk.end + 2)
  })
  it('Backspace after the card, or at the start of the next line, removes it whole', () => {
    expect(atomicDelete(d, mk.end, 'Backspace')?.draft).toBe('mongo')
    expect(atomicDelete(d, mk.end + 1, 'Backspace')?.draft).toBe('mongo')
    expect(atomicDelete(d, mk.end + 3, 'Backspace')).toBeNull()
  })
  it('Delete before the card removes it whole', () => {
    expect(atomicDelete(`x\n${m1}`, 2, 'Delete')?.draft).toBe('x')
  })
  it('removeQuote leaves no empty line behind', () => {
    expect(removeQuote(`a\n${m1}\nb`, '1')).toBe('a\nb')
    expect(removeQuote(`a\n${m1}`, '1')).toBe('a')
    expect(removeQuote('a', '9')).toBe('a')
  })
})

describe('syncQuotes', () => {
  it('restores a label an edit reached into', () => {
    const d = `${m1}\nx`
    const mk = quoteMarks(d)[0]!
    const damaged = d.slice(0, mk.labelStart + 3) + 'ZZZ' + d.slice(mk.labelStart + 3)
    const out = syncQuotes(damaged, [q1], label)
    expect(out.draft).toBe(d)
    expect(out.replies).toEqual([q1])
  })
  it('drops a target whose card is gone, and a marker with no target', () => {
    const out = syncQuotes(`${m2}\nhello`, [q1], label)
    expect(out.draft).toBe('\nhello')
    expect(out.replies).toEqual([])
  })
  it('removes the stray pieces of a half-deleted marker and maps the caret', () => {
    const broken = m1.slice(3) + '\nab'
    const out = syncQuotes(broken, [q1], label, broken.length)
    expect(out.draft).not.toMatch(/[⁣⁤​‌]/)
    expect(out.caret).toBe(out.draft.length)
    expect(out.replies).toEqual([])
  })
  it('text typed against a card is moved to its own line, caret kept with the text', () => {
    const d = `ab${m1}cd`
    const out = syncQuotes(d, [q1], label, 2)
    expect(out.draft).toBe(`ab\n${m1}\ncd`)
    expect(out.caret).toBe(2)
  })
  it('a duplicated marker (copy-paste) keeps the first only', () => {
    const out = syncQuotes(`${m1}\na\n${m1}\nb`, [q1], label)
    expect(quoteMarks(out.draft)).toHaveLength(1)
  })
})

describe('placeOrphans', () => {
  it('gives a legacy target an id and a card at the top', () => {
    const legacy: ReplyTarget = { role: 'assistant', text: 'old quote' }
    const out = placeOrphans('my text', [legacy], label)
    expect(out.replies[0]!.id).toBe('1')
    expect(quotesInOrder(out.draft, out.replies)).toHaveLength(1)
    expect(stripQuotes(out.draft)).toBe('\nmy text')
  })
  it('changes nothing when every target has its card', () => {
    const d = `${m1}\nx`
    expect(placeOrphans(d, [q1], label)).toEqual({ draft: d, replies: [q1] })
  })
})

describe('composeQuoted — the format that travels', () => {
  it('each quote then its answer, a blank line apart', () => {
    const d = `${m1}\nmongo\n${m2}\n48080`
    expect(composeQuoted(d, [q1, q2])).toBe(
      '> Q1 · which database?\n\nmongo\n\n> Q2 · which port?\n> second line\n\n48080',
    )
  })
  it('mapText touches the person\'s text only', () => {
    const d = `${m1}\nhi`
    expect(composeQuoted(d, [q1], s => s.toUpperCase())).toBe('> Q1 · which database?\n\nHI')
  })
  it('text before the first card stays first', () => {
    expect(splitQuoted(`intro\n${m1}\nans`, [q1]).map(s => s.kind)).toEqual(['text', 'quote', 'text'])
  })
  it('no cards = exactly what was typed', () => {
    expect(composeQuoted('just text', [])).toBe('just text')
  })
})

describe('locateExcerpt', () => {
  it('finds an excerpt across collapsed whitespace and drops the ellipses', () => {
    const hay = 'One.\n\nWhich  port\nshould it use? Three.'
    const r = locateExcerpt(hay, '…Which port should it use?…')
    expect(r).not.toBeNull()
    expect(hay.slice(r![0], r![1])).toBe('Which  port\nshould it use?')
  })
  it('null when it is not there', () => {
    expect(locateExcerpt('abc', 'zzz')).toBeNull()
    expect(locateExcerpt('abc', '…')).toBeNull()
  })
})
