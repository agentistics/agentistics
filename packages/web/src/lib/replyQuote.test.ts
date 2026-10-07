import { describe, test, expect } from 'bun:test'
import { addReply, insertReplyQuote, leadingQuote, leadingQuotes, normalizeComposer, splitQuotedDraft, markExcerpt, orderReplies, parseReplies, parseReply, quoteAll, quoteFor, quoteLines, replyAuthor, replyPreview, stripQuotedLines, composeReply } from './replyQuote'

test('a quote is "> "-prefixed, line by line', () => {
  expect(quoteLines('one\ntwo')).toBe('> one\n> two')
})

test('a reply is inserted as plain markdown and leaves the caret after a blank line', () => {
  const out = insertReplyQuote('answer', 6, { role: 'assistant', text: 'one\ntwo', excerpt: true })
  expect(out.draft).toBe('answer\n\n> one\n> two\n\n')
  expect(out.caret).toBe(out.draft.length)
  expect(out.draft).not.toMatch(/[\u2063\u2064\u200b\u200c]/)
})

test('leading quote parsing supports collapse without hiding the answer', () => {
  expect(leadingQuote('> one\n> two\n> three\n\nmy answer')).toEqual({
    quote: 'one\ntwo\nthree', rest: 'my answer',
  })
  expect(stripQuotedLines('> one\n> two\n\nmy answer')).toContain('my answer')
})

test('a long message is bounded and SAYS there was more', () => {
  const out = quoteLines('a\nb\nc\nd\ne\nf')
  expect(out.split('\n')).toHaveLength(5)
  expect(out.endsWith('> …')).toBe(true)
})

test('a message at exactly the bound carries no ellipsis', () => {
  expect(quoteLines('a\nb\nc\nd')).toBe('> a\n> b\n> c\n> d')
})

test('quoting nothing is EMPTY, never a lone marker', () => {
  expect(quoteLines('')).toBe('')
  expect(quoteLines('   \n\n ')).toBe('')
})

test('the preview drops blank lines rather than counting them', () => {
  expect(replyPreview('# Heading\n\nthe actual sentence')).toBe('# Heading the actual sentence')
})

test('the preview says it was cut only when something was cut', () => {
  expect(replyPreview('one\ntwo')).toBe('one two')
  expect(replyPreview('one\ntwo\nthree')).toBe('one two …')
})

test('a preview of nothing is empty', () => {
  expect(replyPreview('\n\n  ')).toBe('')
})

test('the user is "You", the assistant is the harness', () => {
  expect(replyAuthor('user', 'Claude Code', 'en')).toBe('You')
  expect(replyAuthor('user', 'Claude Code', 'pt')).toBe('Você')
  expect(replyAuthor('assistant', 'Claude Code', 'en')).toBe('Claude Code')
})

test('a missing harness label falls back to a WORD, never an empty name', () => {
  for (const label of [undefined, '', '   ']) {
    expect(replyAuthor('assistant', label, 'en')).toBe('the assistant')
    expect(replyAuthor('assistant', label, 'pt')).toBe('o assistente')
  }
})

test('a stored reply round-trips', () => {
  const target = { role: 'assistant' as const, text: 'what it said' }
  expect(parseReply(JSON.stringify(target))).toEqual(target)
})

test('anything that is not a usable target is dropped, never half-read', () => {
  for (const raw of [
    null, '', 'not json', '[]', '{}', '{"role":"nobody","text":"x"}',
    '{"role":"user"}', '{"role":"user","text":""}', '{"role":"user","text":"   "}',
    '{"role":"user","text":7}',
  ]) {
    expect(parseReply(raw)).toBeNull()
  }
})

test('an excerpt taken from the middle is marked at both ends', () => {
  expect(markExcerpt('one two three four', 'two three')).toBe('…two three…')
})

test('an excerpt that reaches an end is not marked at that end', () => {
  expect(markExcerpt('one two three', 'one two')).toBe('one two…')
  expect(markExcerpt('one two three', 'two three')).toBe('…two three')
  expect(markExcerpt('one two three', 'one two three')).toBe('one two three')
})

test('the comparison ignores whitespace differences, the excerpt keeps its own', () => {
  // What the bubble renders is not byte-identical to the source: markdown collapses newlines.
  expect(markExcerpt('alpha\n\n  beta gamma', 'beta\ngamma')).toBe('…beta\ngamma')
})

test('an excerpt that cannot be located in the turn is marked at BOTH ends', () => {
  // Never the reassuring reading: saying "this may be partial" about a complete quote costs one
  // character; saying "this is the whole message" about a fragment misleads the session.
  expect(markExcerpt('rendered differently', 'not in there')).toBe('…not in there…')
})

test('an empty selection is not an excerpt', () => {
  expect(markExcerpt('anything', '   \n ')).toBe('')
})

test('a whole-message quote is capped and an excerpt is not', () => {
  const long = 'a\nb\nc\nd\ne\nf'
  expect(quoteFor({ role: 'assistant', text: long })).toBe('> a\n> b\n> c\n> d\n> …')
  expect(quoteFor({ role: 'assistant', text: long, excerpt: true }))
    .toBe('> a\n> b\n> c\n> d\n> e\n> f')
})

test('the excerpt mark is honoured only when it is literally true', () => {
  expect(parseReply('{"role":"assistant","text":"x","excerpt":true}'))
    .toEqual({ role: 'assistant', text: 'x', excerpt: true })
  expect(parseReply('{"role":"assistant","text":"x","excerpt":"yes"}'))
    .toEqual({ role: 'assistant', text: 'x' })
})

// --- the quote ends where the reply begins ----------------------------------
//
// These were joined with a single newline, and CommonMark's LAZY CONTINUATION pulls a plain line
// following a `>` line into the blockquote. The person's own words rendered inside the grey bar,
// as if the session had said them.

test('a blank line separates the quote from what was typed', () => {
  expect(composeReply({ quote: '> disse isso', paths: [], text: 'reabre essa sessao' }))
    .toBe('> disse isso\n\nreabre essa sessao')
})

test('the paths get their own block too — a bare path is not something the session said', () => {
  expect(composeReply({ quote: '> disse isso', paths: ['/a/x.png', '/a/y.png'], text: 'olha' }))
    .toBe('> disse isso\n\n/a/x.png\n/a/y.png\n\nolha')
})

test('a message with no quote is exactly what was typed, with no leading blank line', () => {
  expect(composeReply({ quote: '', paths: [], text: 'oi' })).toBe('oi')
  expect(composeReply({ quote: '', paths: ['/a/x.png'], text: 'oi' })).toBe('/a/x.png\n\noi')
})

test('a quote with nothing typed after it is just the quote', () => {
  expect(composeReply({ quote: '> disse isso', paths: [], text: '' })).toBe('> disse isso')
})

test('a multi-line quote keeps its own lines together', () => {
  expect(composeReply({ quote: '> uma\n> duas', paths: [], text: 'resposta' }))
    .toBe('> uma\n> duas\n\nresposta')
})

describe('several quotes at once', () => {
  const a = { role: 'assistant' as const, text: 'Question one?', key: 'k1' }
  const b = { role: 'assistant' as const, text: 'Question two?', key: 'k2' }
  test('Reply ADDS to the list, never twice', () => {
    const one = addReply([], b)
    const two = addReply(one, a)
    expect(two).toEqual([b, a])
    expect(addReply(two, a)).toEqual([b, a])
    expect(addReply(two, { ...a, text: '  ' })).toEqual([b, a])
  })
  test('an excerpt of a message is a different quote from the whole message', () => {
    expect(addReply([a], { ...a, excerpt: true })).toHaveLength(2)
  })
  test('the list is put back in conversation order', () => {
    expect(orderReplies([b, a], ['k0', 'k1', 'k2'])).toEqual([a, b])
    const loose = { role: 'user' as const, text: 'no key' }
    expect(orderReplies([loose, b, a], ['k1', 'k2'])).toEqual([a, b, loose])
  })
  test('each quote travels briefly, a blank line apart, and the text stays out of the last one', () => {
    const q = quoteAll([a, { role: 'assistant', text: '1\n2\n3\n4\n5\n6', key: 'k3' }])
    expect(q).toBe('> Question one?\n\n> 1\n> 2\n> 3\n> 4\n> …')
    expect(composeReply({ quote: q, paths: [], text: 'answers' }).endsWith('> …\n\nanswers')).toBe(true)
    expect(quoteAll([])).toBe('')
  })
  test('a stored list parses, and so does the old single-object shape', () => {
    expect(parseReplies(JSON.stringify([a, { role: 'x', text: 'bad' }, b]))).toEqual([a, b])
    expect(parseReplies('{"role":"user","text":"old"}')).toEqual([{ role: 'user', text: 'old' }])
    expect(parseReplies('nope')).toEqual([])
    expect(parseReplies(null)).toEqual([])
  })
})

describe('quote blocks: several leading blocks, draft round-trip', () => {

  test('leadingQuotes reads EVERY leading block, blank lines between them consumed', () => {
    const text = '> …Como foi o teste?\n\n> …coisa está pronta\n> segunda linha\n\nminha resposta\n\n> not leading'
    expect(leadingQuotes(text)).toEqual({
      quotes: ['…Como foi o teste?', '…coisa está pronta\nsegunda linha'],
      rest: 'minha resposta\n\n> not leading',
    })
  })

  test('leadingQuotes with no leading quote returns the text untouched', () => {
    expect(leadingQuotes('hello\n> later')).toEqual({ quotes: [], rest: 'hello\n> later' })
    expect(leadingQuotes('> only a quote')).toEqual({ quotes: ['only a quote'], rest: '' })
  })

  test('leadingQuote keeps its old single-block shape, the later blocks in rest', () => {
    expect(leadingQuote('> a\n\n> b\n\nme')).toEqual({ quote: 'a', rest: '> b\n\nme' })
  })

  test('serialize: quotes a blank line apart, then the typed text', () => {
    const list = [
      { role: 'assistant' as const, text: '…first…', excerpt: true },
      { role: 'assistant' as const, text: 'second\nline', excerpt: true },
    ]
    expect(composeReply({ quote: quoteAll(list), paths: [], text: 'my answer' }))
      .toBe('> …first…\n\n> second\n> line\n\nmy answer')
  })

  test('round trip: what is sent parses back into the same stack and words', () => {
    const list = [
      { role: 'assistant' as const, text: '…first…', excerpt: true },
      { role: 'user' as const, text: 'one\ntwo\nthree\nfour\nfive' },
    ]
    const sent = composeReply({ quote: quoteAll(list), paths: [], text: 'answer\nline 2' })
    const back = splitQuotedDraft(sent)
    expect(back.text).toBe('answer\nline 2')
    expect(back.replies.map(r => r.text)).toEqual(['…first…', 'one\ntwo\nthree\nfour\n…'])
    // Lifted quotes are excerpts, so sending them again yields the very same message.
    expect(composeReply({ quote: quoteAll(back.replies), paths: [], text: back.text })).toBe(sent)
  })

  test('splitQuotedDraft leaves a draft without leading quotes alone', () => {
    expect(splitQuotedDraft('plain\n> mid')).toEqual({ replies: [], text: 'plain\n> mid' })
  })

  test('normalizeComposer: an old inline draft is not drawn (or sent) twice', () => {
    const t = { role: 'assistant' as const, text: 'quoted bit', excerpt: true, key: 'k1' }
    const out = normalizeComposer('> quoted bit\n\nmy words', [t])
    expect(out.draft).toBe('my words')
    expect(out.replies.map(r => r.text)).toEqual(['quoted bit'])
  })

  test('normalizeComposer: a list kept outside the draft passes through untouched', () => {
    const t = { role: 'assistant' as const, text: 'quoted bit', excerpt: true, key: 'k1' }
    expect(normalizeComposer('my words', [t])).toEqual({ draft: 'my words', replies: [t] })
  })
})
