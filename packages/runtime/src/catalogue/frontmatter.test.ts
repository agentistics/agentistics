import { describe, expect, test } from 'bun:test'
import { splitFrontmatter } from './frontmatter.ts'

describe('splitFrontmatter', () => {
  test('scalars, lists, block scalars, map, lines', () => {
    const r = splitFrontmatter(['---', 'a: plain', "b: 'q ''x'''", 'c: "d"', 'e: true', 'f: 12', 'g: [x, "y z"]', 'h:', '  - one', '  - two', 'i: |', '  l1', '  l2', 'j: >', '  f1', '  f2', 'k:', '  sub: x', '---', 'body'].join('\n'))
    expect(r.errors).toEqual([])
    const f = r.frontmatter!
    expect(f.get('a')).toEqual({ value: { kind: 'string', value: 'plain' }, line: 2 })
    expect(f.get('b')?.value).toEqual({ kind: 'string', value: "q 'x'" })
    expect(f.get('e')?.value).toEqual({ kind: 'boolean', value: true })
    expect(f.get('f')?.value).toEqual({ kind: 'number', value: 12 })
    expect(f.get('g')?.value).toEqual({ kind: 'list', value: ['x', 'y z'] })
    expect(f.get('h')?.value).toEqual({ kind: 'list', value: ['one', 'two'] })
    expect(f.get('i')?.value).toEqual({ kind: 'string', value: 'l1\nl2' })
    expect(f.get('j')?.value).toEqual({ kind: 'string', value: 'f1 f2' })
    expect(f.get('k')?.value).toEqual({ kind: 'map' })
    expect(f.get('k')?.line).toBe(17)
    expect(r.body).toBe('body')
    expect(r.bodyStartLine).toBe(20)
  })
  test('no opening = no frontmatter', () => {
    const r = splitFrontmatter('hello\n---\nx')
    expect(r.frontmatter).toBeNull()
    expect(r.body).toBe('hello\n---\nx')
  })
  test('unclosed and duplicate keys', () => {
    expect(splitFrontmatter('---\na: 1\n').errors[0]?.line).toBe(1)
    expect(splitFrontmatter('---\na: 1\na: 2\n---\n').errors[0]).toMatchObject({ line: 3 })
  })
})
