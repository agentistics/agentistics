import { describe, expect, it } from 'bun:test'
import { PAGE_MAX, WIDE_PAGE_MAX, isWidePage, pageMaxWidth } from './pageWidth'

describe('pageMaxWidth', () => {
  it('lets the deliveries and repositories pages grow', () => {
    for (const p of ['/tasks', '/tasks/abc', '/repositories', '/repositories/actions', '/repo/github.com%2Fo%2Fr']) {
      expect(pageMaxWidth(p)).toBe(WIDE_PAGE_MAX)
    }
  })

  it('keeps every other page at the standard cap', () => {
    for (const p of ['/', '/costs', '/tags', '/tags/x', '/compare', '/settings/repositories']) {
      expect(pageMaxWidth(p)).toBe(PAGE_MAX)
    }
  })

  it('matches a whole path segment, never a prefix of a word', () => {
    expect(isWidePage('/taskstats')).toBe(false)
    expect(isWidePage('/repository-x')).toBe(false)
  })
})
