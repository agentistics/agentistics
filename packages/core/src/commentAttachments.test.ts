import { describe, expect, it } from 'bun:test'
import { MAX_COMMENT_ATTACHMENTS, chatAttachmentRef, sanitizeCommentAttachments } from './commentAttachments'

const inside = (p: string) => (p.startsWith('/att/') ? p : null)

describe('sanitizeCommentAttachments', () => {
  it('keeps name+path, derives a missing name from the path', () => {
    expect(sanitizeCommentAttachments([{ name: 'a.png', path: '/att/1-a.png' }, { path: '/att/2-b.pdf' }], inside))
      .toEqual([{ name: 'a.png', path: '/att/1-a.png' }, { name: '2-b.pdf', path: '/att/2-b.pdf' }])
  })
  it('drops paths the containment rule refuses, junk shapes and duplicates', () => {
    expect(sanitizeCommentAttachments(
      [{ path: '/etc/passwd' }, null, 'x', { path: '' }, { path: '/att/a' }, { path: '/att/a' }], inside,
    )).toEqual([{ name: 'a', path: '/att/a' }])
  })
  it('anything that is not a list is no attachments', () => {
    expect(sanitizeCommentAttachments(undefined)).toEqual([])
    expect(sanitizeCommentAttachments({ path: '/att/a' })).toEqual([])
  })
  it('caps at the chat limit', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `/att/${i}` }))
    expect(sanitizeCommentAttachments(many, inside)).toHaveLength(MAX_COMMENT_ATTACHMENTS)
  })
  it('an MCP reference carries the url that serves it', () => {
    expect(chatAttachmentRef({ name: 'a b.png', path: '/att/a b.png' }).url)
      .toBe('/api/fleet/attachment?path=%2Fatt%2Fa%20b.png')
  })
})
