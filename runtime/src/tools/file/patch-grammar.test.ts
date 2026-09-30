import { describe, expect, test } from 'bun:test'
import { parsePatchText } from './patch-grammar.ts'

function isError(x: ReturnType<typeof parsePatchText>): x is { line: number; message: string } {
  return !Array.isArray(x)
}

describe('parsePatchText', () => {
  test('parses an Add File section', () => {
    const text = ['*** Begin Patch', '*** Add File: a.txt', '+hello', '+world', '*** End Patch'].join('\n')
    const out = parsePatchText(text)
    expect(out).toEqual([{ path: 'a.txt', hunks: [{ kind: 'add', body: 'hello\nworld' }] }])
  })

  test('parses a Delete File section', () => {
    const text = ['*** Begin Patch', '*** Delete File: a.txt', '*** End Patch'].join('\n')
    const out = parsePatchText(text)
    expect(out).toEqual([{ path: 'a.txt', hunks: [{ kind: 'delete' }] }])
  })

  test('parses an Update File section with one hunk', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ def foo():',
      ' line1',
      '-line2',
      '+line2b',
      ' line3',
      '*** End Patch',
    ].join('\n')
    const out = parsePatchText(text)
    expect(out).toEqual([
      {
        path: 'a.txt',
        hunks: [
          {
            kind: 'update',
            moveTo: undefined,
            context: ['def foo():'],
            lines: [
              { op: ' ', text: 'line1' },
              { op: '-', text: 'line2' },
              { op: '+', text: 'line2b' },
              { op: ' ', text: 'line3' },
            ],
          },
        ],
      },
    ])
  })

  test('parses several hunks under one Update File section', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      ' a',
      '-b',
      '+b2',
      '@@',
      ' c',
      '-d',
      '+d2',
      '*** End Patch',
    ].join('\n')
    const out = parsePatchText(text)
    expect(Array.isArray(out)).toBe(true)
    if (!Array.isArray(out)) throw new Error('unreachable')
    expect(out[0]!.hunks).toHaveLength(2)
  })

  test('a rename carries Move to on the first hunk only', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: old.txt',
      '*** Move to: new.txt',
      '@@',
      ' a',
      '-b',
      '+b2',
      '@@',
      ' c',
      '-d',
      '+d2',
      '*** End Patch',
    ].join('\n')
    const out = parsePatchText(text)
    if (!Array.isArray(out)) throw new Error('unreachable')
    expect(out[0]!.hunks[0]).toMatchObject({ moveTo: 'new.txt' })
    expect(out[0]!.hunks[1]).toMatchObject({ moveTo: undefined })
  })

  test('a pure rename (Move to, no hunks) parses to one empty update hunk', () => {
    const text = ['*** Begin Patch', '*** Update File: old.txt', '*** Move to: new.txt', '*** End Patch'].join('\n')
    const out = parsePatchText(text)
    expect(out).toEqual([{ path: 'old.txt', hunks: [{ kind: 'update', moveTo: 'new.txt', context: [], lines: [] }] }])
  })

  test('parses several file sections in one patch', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+x',
      '*** Delete File: b.txt',
      '*** Update File: c.txt',
      '@@',
      ' x',
      '-y',
      '+z',
      '*** End Patch',
    ].join('\n')
    const out = parsePatchText(text)
    if (!Array.isArray(out)) throw new Error('unreachable')
    expect(out.map(f => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  test('rejects a patch missing "*** Begin Patch"', () => {
    const out = parsePatchText('*** Add File: a.txt\n+x\n*** End Patch')
    expect(isError(out)).toBe(true)
    if (isError(out)) expect(out.line).toBe(1)
  })

  test('rejects a patch missing "*** End Patch", naming the last line', () => {
    const out = parsePatchText('*** Begin Patch\n*** Add File: a.txt\n+x')
    expect(isError(out)).toBe(true)
    if (isError(out)) expect(out.message).toMatch(/End Patch/)
  })

  test('rejects an Add File body line with no +/- prefix, naming the line', () => {
    const out = parsePatchText('*** Begin Patch\n*** Add File: a.txt\nnope\n*** End Patch')
    expect(isError(out)).toBe(true)
    if (isError(out)) {
      expect(out.line).toBe(3)
      expect(out.message).toMatch(/nope/)
    }
  })

  test('rejects an update hunk line with an invalid prefix', () => {
    const out = parsePatchText('*** Begin Patch\n*** Update File: a.txt\n@@\n?bad\n*** End Patch')
    expect(isError(out)).toBe(true)
    if (isError(out)) expect(out.line).toBe(4)
  })

  test('rejects an empty patch', () => {
    expect(isError(parsePatchText(''))).toBe(true)
  })

  test('rejects a patch with no file sections', () => {
    const out = parsePatchText('*** Begin Patch\n*** End Patch')
    expect(isError(out)).toBe(true)
  })
})
