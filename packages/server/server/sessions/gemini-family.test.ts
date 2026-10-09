import { describe, expect, it } from 'bun:test'
import { compareChatNames, groupGeminiFamilies, parseChatName } from './gemini-family'

const U = '550dc3a6-6fb8-42b5-9ad3-22dc68f74e88'
const OTHER = '550dc3a6-0000-4000-8000-000000000000' // same eight characters, a different conversation

describe('parseChatName', () => {
  it('reads the minute, the collision counter and the suffix', () => {
    expect(parseChatName('session-2026-10-09T11-02-550dc3a6.jsonl')).toEqual({ stamp: '2026-10-09T11-02', counter: 0, suffix: '550dc3a6' })
    expect(parseChatName('session-2026-10-09T11-02-1-550DC3A6')).toEqual({ stamp: '2026-10-09T11-02', counter: 1, suffix: '550dc3a6' })
  })
  it('refuses anything that is not the journal naming', () => {
    for (const n of ['chat.jsonl', 'session-x-550dc3a6.jsonl', 'session-2026-10-09T11-02-550dc3a.jsonl', 'checkpoint-a.json']) {
      expect(parseChatName(n), n).toBeNull()
    }
  })
})

describe('compareChatNames — oldest first', () => {
  it('orders by minute, then by counter, so the -1- file comes AFTER the original it collided with', () => {
    // As plain strings "11-02-1-550dc3a6" < "11-02-550dc3a6" ('1' < '5'): the wrong way round.
    const names = [
      'session-2026-10-09T11-03-550dc3a6.jsonl',
      'session-2026-10-09T11-02-1-550dc3a6.jsonl',
      'session-2026-10-09T11-02-550dc3a6.jsonl',
    ]
    expect([...names].sort(compareChatNames)).toEqual([
      'session-2026-10-09T11-02-550dc3a6.jsonl',
      'session-2026-10-09T11-02-1-550dc3a6.jsonl',
      'session-2026-10-09T11-03-550dc3a6.jsonl',
    ])
  })
})

describe('groupGeminiFamilies', () => {
  it('attaches the headerless continuation files to the conversation whose header names the suffix', () => {
    const r = groupGeminiFamilies([
      { name: 'session-2026-10-09T11-03-550dc3a6.jsonl', headerId: null },
      { name: 'session-2026-10-09T11-02-550dc3a6.jsonl', headerId: U },
      { name: 'session-2026-10-09T11-02-1-550dc3a6.jsonl', headerId: null },
    ])
    expect(r).toEqual([{
      id: U,
      members: ['session-2026-10-09T11-02-550dc3a6.jsonl', 'session-2026-10-09T11-02-1-550dc3a6.jsonl', 'session-2026-10-09T11-03-550dc3a6.jsonl'],
    }])
  })

  it('keeps two conversations that share a suffix apart, and ORPHANS a headerless file it cannot place', () => {
    const r = groupGeminiFamilies([
      { name: 'session-2026-10-09T11-02-550dc3a6.jsonl', headerId: U },
      { name: 'session-2026-10-08T09-00-550dc3a6.jsonl', headerId: OTHER },
      { name: 'session-2026-10-09T12-00-550dc3a6.jsonl', headerId: null },
    ])
    expect(r.filter(f => f.id !== null).map(f => f.members)).toEqual([
      ['session-2026-10-09T11-02-550dc3a6.jsonl'],
      ['session-2026-10-08T09-00-550dc3a6.jsonl'],
    ])
    // ambiguous: it could be either conversation's, so it is nobody's
    expect(r.find(f => f.id === null)?.members).toEqual(['session-2026-10-09T12-00-550dc3a6.jsonl'])
  })

  it('a headerless file with no headed owner stays alone (an interrupted write, or a deleted original)', () => {
    expect(groupGeminiFamilies([{ name: 'session-2026-10-09T11-03-550dc3a6.jsonl', headerId: null }]))
      .toEqual([{ id: null, members: ['session-2026-10-09T11-03-550dc3a6.jsonl'] }])
  })

  it('puts every input in exactly one family, and leaves non-journal names alone', () => {
    const files = [
      { name: 'session-2026-10-09T11-02-550dc3a6.jsonl', headerId: U },
      { name: 'legacy-chat.json', headerId: null },
      { name: 'session-2026-10-09T11-05-aaaaaaaa.jsonl', headerId: 'aaaaaaaa-0000-4000-8000-000000000000' },
    ]
    const r = groupGeminiFamilies(files)
    expect(r.flatMap(f => f.members).sort()).toEqual(files.map(f => f.name).sort())
  })

  it('matches the header case-insensitively', () => {
    const r = groupGeminiFamilies([
      { name: 'session-2026-10-09T11-02-550dc3a6.jsonl', headerId: U.toUpperCase() },
      { name: 'session-2026-10-09T11-03-550dc3a6.jsonl', headerId: U },
    ])
    expect(r).toHaveLength(1)
    expect(r[0]!.members).toHaveLength(2)
  })
})
