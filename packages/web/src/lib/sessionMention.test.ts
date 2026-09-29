import { describe, expect, test } from 'bun:test'
import {
  applySessionMention, expandSessionMentions, filterMentionCandidates, hashPickerShown, hashQuery, mentionTitle,
  sessionMentionToken, sessionMentionTokens, shortSessionId, type MentionCandidate,
} from './sessionMention'

const row = (o: Partial<MentionCandidate> & { id: string }): MentionCandidate => ({
  title: 'Untitled', harness: 'claude', ...o,
})

describe('shortSessionId', () => {
  test('a managed id keeps its first eight hex characters', () => {
    expect(shortSessionId({ id: 'c567241c27' })).toBe('c567241c')
  })
  test('a closed row is named by its conversation', () => {
    expect(shortSessionId({ id: 'closed:f8f851b6-0f02-4a3c-a6ba-5858f5156ae0' })).toBe('f8f851b6')
  })
  test('no usable prefix falls back to the conversation, then to nothing', () => {
    expect(shortSessionId({ id: 'xyz', conversationId: 'ab12cd34-ffff' })).toBe('ab12cd34')
    expect(shortSessionId({ id: 'xyz' })).toBe('')
  })
})

describe('mentionTitle', () => {
  test('one line, no guillemets, no id separator, capped', () => {
    expect(mentionTitle('A «quoted»\ntitle · part')).toBe('A quoted title - part')
    expect(mentionTitle('x'.repeat(80))).toHaveLength(60)
    expect(mentionTitle('x'.repeat(80)).endsWith('…')).toBe(true)
  })
})

describe('hashQuery', () => {
  test('opens at the start of the text and after whitespace', () => {
    expect(hashQuery('#')).toBe('')
    expect(hashQuery('see #agen')).toBe('agen')
    expect(hashQuery('line\n#x')).toBe('x')
  })
  test('does not open inside a word, and closes on a space (a markdown heading)', () => {
    expect(hashQuery('issue#12')).toBeNull()
    expect(hashQuery('# Title')).toBeNull()
  })
  test('a query may hold spaces after its first character, on one line, bounded', () => {
    expect(hashQuery('#PROBE li')).toBe('PROBE li')
    expect(hashQuery('see #abc ')).toBe('abc ')
    expect(hashQuery('#a\nb')).toBeNull()
    expect(hashQuery(`#${'x'.repeat(60)}`)).toBeNull()
  })
  test('a query with a space is offered only while it matches', () => {
    expect(hashPickerShown('probe', 0)).toBe(true)
    expect(hashPickerShown('1 is the plan', 0)).toBe(false)
    expect(hashPickerShown('probe li', 2)).toBe(true)
  })
})

describe('filterMentionCandidates', () => {
  const rows = [
    row({ id: 'aaaa000001', title: 'Refactor billing', project: 'agentistics', stateLabel: 'working' }),
    row({ id: 'bbbb000002', title: 'Docs pass', project: 'billing-site', harness: 'codex' }),
    row({ id: 'cccc000003', title: 'Self', project: 'x' }),
    row({ id: 'aaaa000001', title: 'Refactor billing (dup)' }),
    row({ id: 'nohex', title: 'Unpointable' }),
  ]
  test('leaves out the current session, duplicates and rows with no id to point with', () => {
    const out = filterMentionCandidates(rows, '', { id: 'cccc000003' })
    expect(out.map(r => r.id)).toEqual(['aaaa000001', 'bbbb000002'])
  })
  test('a closed twin of the current session is left out too', () => {
    const rows2 = [
      row({ id: 'closed:dddd1234-1', title: 'Me, closed' }),
      row({ id: 'eeee000001', conversationId: 'dddd1234-1', title: 'Me, live' }),
      row({ id: 'ffff000001', title: 'Other' }),
    ]
    expect(filterMentionCandidates(rows2, '', { id: 'eeee000001', conversationId: 'dddd1234-1' }).map(r => r.id))
      .toEqual(['ffff000001'])
    expect(filterMentionCandidates(rows2, '', { id: 'closed:dddd1234-1' }).map(r => r.id))
      .toEqual(['ffff000001'])
  })
  test('title matches rank ahead of folder/harness/state matches', () => {
    expect(filterMentionCandidates(rows, 'billing').map(r => r.id)).toEqual(['aaaa000001', 'bbbb000002'])
    expect(filterMentionCandidates(rows, 'codex').map(r => r.id)).toEqual(['bbbb000002'])
    expect(filterMentionCandidates(rows, 'WORKING').map(r => r.id)).toEqual(['aaaa000001'])
  })
  test('the limit bounds the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: `ab${String(i).padStart(8, '0')}` }))
    expect(filterMentionCandidates(many, '')).toHaveLength(8)
  })
})

describe('applySessionMention', () => {
  const target = row({ id: 'c567241c27', title: 'Líder — Enterprise' })
  test('a multi-word query is replaced whole', () => {
    const out = applySessionMention('ask #líder ent', 14, target, true)!
    expect(out.text).toBe('ask #«Líder — Enterprise · c567241c» ')
  })
  test('replaces the #query with the chip and a space, caret after it', () => {
    const out = applySessionMention('ask #lid about it', 8, target, true)!
    expect(out.text).toBe('ask #«Líder — Enterprise · c567241c» about it')
    expect(out.text.slice(0, out.caret)).toBe('ask #«Líder — Enterprise · c567241c»')
  })
  test('adds the trailing space when nothing follows', () => {
    const out = applySessionMention('#li', 3, target, false)!
    expect(out.text).toBe('#«Líder — Enterprise · c567241c» ')
    expect(out.caret).toBe(out.text.length)
  })
  test('with no trigger under the caret the chip is appended', () => {
    const out = applySessionMention('hello', 2, target, false)!
    expect(out.text).toBe('hello #«Líder — Enterprise · c567241c» ')
  })
  test('a row with no id makes no chip', () => {
    expect(applySessionMention('#', 1, row({ id: 'zz' }), false)).toBeNull()
    expect(sessionMentionToken(row({ id: 'zz' }), false)).toBeNull()
  })
  test('an untitled row still gets a readable chip', () => {
    expect(sessionMentionToken(row({ id: 'abcd1234', title: '' }), true)).toBe('#«sessão sem título · abcd1234»')
  })
})

describe('chips in the draft', () => {
  const draft = '#«Alpha · abcd1234» compare with #«Beta two · 0011aabb».'
  test('are found as ranges for the mirror', () => {
    const t = sessionMentionTokens(draft)
    expect(t.map(r => draft.slice(r.start, r.end))).toEqual(['#«Alpha · abcd1234»', '#«Beta two · 0011aabb»'])
  })
  test('an edited chip stops being one', () => {
    expect(sessionMentionTokens('#«Alpha · abcd1234')).toEqual([])
  })
  test('expand into the lean reference and never leave a leading #', () => {
    expect(expandSessionMentions(draft, true))
      .toBe('«Alpha» (sessão abcd1234) compare with «Beta two» (sessão 0011aabb).')
    expect(expandSessionMentions(draft, false).startsWith('#')).toBe(false)
    expect(expandSessionMentions(draft, false)).toContain('(session abcd1234)')
  })
  test('a # the person typed is left alone', () => {
    expect(expandSessionMentions('# heading and #tag', true)).toBe('# heading and #tag')
  })
  test('the round trip: an inserted chip expands', () => {
    const out = applySessionMention('#x', 2, row({ id: 'deadbeef99', title: 'T' }), false)!
    expect(expandSessionMentions(out.text, false)).toBe('«T» (session deadbeef) ')
  })
})
