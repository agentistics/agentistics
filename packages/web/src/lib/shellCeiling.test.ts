import { describe, expect, test } from 'bun:test'
import { atCap, ceilingRows, ceilingTitle } from './shellCeiling'

const sh = (id: string, cwd: string, createdMs: number, sessionTitle?: string) =>
  ({ id, sessionId: `s-${id}`, cwd, createdMs, ...(sessionTitle ? { sessionTitle } : {}) })

describe('when the list is shown at all', () => {
  test('only the ceiling refusal opens it — the other three are impossible, not full', () => {
    expect(atCap('at-cap')).toBe(true)
    for (const r of ['no-tmux', 'no-cwd', 'cwd-missing', undefined, null, 'network']) {
      expect(atCap(r), String(r)).toBe(false)
    }
  })
})

describe('the rows a person has to choose between', () => {
  // THE DIRECTORY IS NOT ENOUGH. On the machine this was written for, all three open shells sat in
  // `/home/mithrandir/agentistics` — a picker whose rows all read the same is not a picker.
  test('the session’s own name leads, because several shells share one directory', () => {
    const rows = ceilingRows([
      sh('aaaaaaaa-1', '/home/u/proj', 3, 'Bug Fixer'),
      sh('bbbbbbbb-2', '/home/u/proj', 1, 'ALM: rollup'),
    ])
    expect(rows.map(r => r.title)).toEqual(['ALM: rollup', 'Bug Fixer'])
  })

  test('oldest first — the one most likely to be finished with', () => {
    const rows = ceilingRows([sh('c', '/a', 30), sh('a', '/a', 10), sh('b', '/a', 20)])
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  // A shell whose session nobody could name still has to be closable, and a blank row is not one.
  test('a shell with no session name falls back to WHERE it is, never to nothing', () => {
    const [row] = ceilingRows([sh('deadbeef-x', '/home/u/deep/er/proj', 1)])
    expect(row!.title).not.toBe('')
    expect(row!.title).toContain('proj')
  })

  test('the handle is always there, so two rows that read alike are still told apart', () => {
    const rows = ceilingRows([
      sh('aaaaaaaa-1111', '/home/u/proj', 1, 'same'),
      sh('bbbbbbbb-2222', '/home/u/proj', 2, 'same'),
    ])
    expect(rows[0]!.short).toBe('aaaaaaaa')
    expect(rows[1]!.short).toBe('bbbbbbbb')
    expect(rows[0]!.short).not.toBe(rows[1]!.short)
  })

  test('the home directory is shortened the way the band’s own title is', () => {
    const [row] = ceilingRows([sh('a', '/home/u/proj', 1, 'x')])
    expect(row!.where.startsWith('~')).toBe(true)
  })

  test('a list with nothing in it yields no rows rather than a row saying nothing', () => {
    expect(ceilingRows([])).toEqual([])
  })
})

describe('the sentence over the list', () => {
  test('names the ceiling and what to do, in both languages', () => {
    expect(ceilingTitle(8, 'pt')).toContain('8')
    expect(ceilingTitle(8, 'en')).toContain('8')
    expect(ceilingTitle(8, 'pt')).not.toBe(ceilingTitle(8, 'en'))
  })
})
