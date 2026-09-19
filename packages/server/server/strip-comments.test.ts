import { describe, expect, it } from 'bun:test'
import { stripComments } from './strip-comments'

describe('stripComments (server)', () => {
  it('drops a block comment, however many lines it runs', () => {
    expect(stripComments('/** a\n * bbb\n */\nconst x = 1')).toContain('const x = 1')
    expect(stripComments('/** a\n * bbb\n */\nconst x = 1')).not.toContain('bbb')
  })

  it('drops a WHOLE-LINE comment', () => {
    expect(stripComments('  // res.headers.delete(\'X-Frame-Options\')\nconst x = 1')).not.toContain('headers.delete')
  })

  it('drops a TRAILING comment written after real code', () => {
    const planted = 'const x = 1 // res.headers.delete(\'X-Frame-Options\')\n'
    expect(planted).toContain('headers.delete')
    expect(stripComments(planted)).not.toContain('headers.delete')
    expect(stripComments(planted)).toContain('const x = 1')
  })

  it('leaves a URL alone — `://` is not a comment', () => {
    expect(stripComments("const u = 'https://example.com/a'\n")).toContain('https://example.com/a')
  })
})
