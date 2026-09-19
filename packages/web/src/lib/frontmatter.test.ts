import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  test('no frontmatter at all — the body is the whole file, untouched', () => {
    const text = '# Title\n\nSome text.\n'
    expect(parseFrontmatter(text)).toEqual({ present: false, data: null, raw: '', body: text })
  })

  test('a flat block parses into an ordered map', () => {
    const text = '---\nname: my-skill\ndescription: one line\n---\n# Body\n'
    const r = parseFrontmatter(text)
    expect(r.present).toBe(true)
    expect(r.data).toEqual(new Map([['name', 'my-skill'], ['description', 'one line']]))
    expect(r.body).toBe('# Body\n')
  })

  test('quoted values lose exactly one layer of quotes', () => {
    const r = parseFrontmatter('---\ntitle: "Hello, world"\nother: \'single\'\n---\nbody\n')
    expect(r.data).toEqual(new Map([['title', 'Hello, world'], ['other', 'single']]))
  })

  test('an empty value is the empty string, not dropped', () => {
    const r = parseFrontmatter('---\nempty:\nname: x\n---\nbody\n')
    expect(r.data).toEqual(new Map([['empty', ''], ['name', 'x']]))
  })

  test('a nested block folds under its key as text, never rejected', () => {
    const text = '---\nname: skill\nmetadata:\n  type: feedback\n  scope: user\n---\nbody\n'
    const r = parseFrontmatter(text)
    expect(r.data).toEqual(new Map([
      ['name', 'skill'],
      ['metadata', 'type: feedback\nscope: user'],
    ]))
  })

  test('a genuinely unreadable block is refused — data is null, raw is kept', () => {
    const text = '---\ntags: [a, b, c]\n---\nbody\n'
    const r = parseFrontmatter(text)
    expect(r.present).toBe(true)
    expect(r.data).toBeNull()
    expect(r.raw).toBe('tags: [a, b, c]')
    expect(r.body).toBe('body\n')
  })

  test('indentation with no preceding key is refused rather than silently dropped', () => {
    const r = parseFrontmatter('---\n  stray: x\n---\nbody\n')
    expect(r.data).toBeNull()
  })

  test('an unterminated fence is not frontmatter at all', () => {
    const text = '---\nname: x\n# no closing fence\n'
    expect(parseFrontmatter(text)).toEqual({ present: false, data: null, raw: '', body: text })
  })

  test('a heading underline shaped like `---title` is not a false-positive close', () => {
    // `---` immediately followed by content on the same line is never a fence.
    const text = '---\nname: x\n---title\nmore\n---\nbody\n'
    const r = parseFrontmatter(text)
    expect(r.present).toBe(true)
    expect(r.raw).toBe('name: x\n---title\nmore')
    expect(r.body).toBe('body\n')
  })

  test('a leading BOM does not block detection', () => {
    const text = '﻿---\nname: x\n---\nbody\n'
    const r = parseFrontmatter(text)
    expect(r.present).toBe(true)
    expect(r.data).toEqual(new Map([['name', 'x']]))
  })

  test('a file that is only `---` with nothing after is not frontmatter (no closing fence)', () => {
    expect(parseFrontmatter('---').present).toBe(false)
  })

  test('an empty file never throws', () => {
    expect(() => parseFrontmatter('')).not.toThrow()
    expect(parseFrontmatter('').present).toBe(false)
  })

  // M3: a Windows-authored SKILL.md (`---\r\nname: x\r\n---\r\n# Body`) used to fail the very first
  // gate (`text.startsWith('---\n')`, which a `---\r\n` opening fence never satisfies) and render its
  // frontmatter as an `<hr>` plus a setext heading instead of a table.
  test('a CRLF-terminated fence is still detected — the opening AND the closing line', () => {
    const text = '---\r\nname: x\r\ndescription: one line\r\n---\r\n# Body\r\n'
    const r = parseFrontmatter(text)
    expect(r.present).toBe(true)
    expect(r.data).toEqual(new Map([['name', 'x'], ['description', 'one line']]))
    expect(r.body).toBe('# Body\n')
  })

  test('CRLF and a nested block fold the same way LF does', () => {
    const text = '---\r\nname: skill\r\nmetadata:\r\n  type: feedback\r\n---\r\nbody\r\n'
    const r = parseFrontmatter(text)
    expect(r.data).toEqual(new Map([['name', 'skill'], ['metadata', 'type: feedback']]))
  })

  test('a bare CR-only line ending is normalized the same way', () => {
    const r = parseFrontmatter('---\rname: x\r---\rbody\r')
    expect(r.present).toBe(true)
    expect(r.data).toEqual(new Map([['name', 'x']]))
  })
})
