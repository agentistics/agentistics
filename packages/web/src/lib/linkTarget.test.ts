import { describe, expect, test } from 'bun:test'
import { linkHrefFrom } from './linkTarget'

const el = (href: string | null) => ({ closest: (s: string) => (s === 'a[href]' && href !== null ? { getAttribute: () => href } : null) }) as unknown as EventTarget

describe('linkHrefFrom', () => {
  test('inside a link', () => expect(linkHrefFrom(el('https://x.dev/a'))).toBe('https://x.dev/a'))
  test('plain text', () => expect(linkHrefFrom(el(null))).toBeNull())
  test('no target', () => expect(linkHrefFrom(null)).toBeNull())
  test('javascript: is refused', () => expect(linkHrefFrom(el('javascript:alert(1)'))).toBeNull())
})
