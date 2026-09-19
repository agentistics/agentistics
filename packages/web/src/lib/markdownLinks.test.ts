import { describe, expect, test } from 'bun:test'
import { classifyHref, classifyImgSrc, resolveRepoRelativePath } from './markdownLinks'

describe('classifyHref', () => {
  test('http/https/mailto/tel are external', () => {
    expect(classifyHref('http://example.com')).toBe('external')
    expect(classifyHref('https://example.com/x')).toBe('external')
    expect(classifyHref('mailto:a@b.com')).toBe('external')
    expect(classifyHref('tel:+15551234')).toBe('external')
  })

  test('protocol-relative is external — it resolves against this page\'s own https', () => {
    expect(classifyHref('//example.com/x')).toBe('external')
  })

  test('a relative path is internal', () => {
    expect(classifyHref('./guide.md')).toBe('internal')
    expect(classifyHref('../docs/x.md')).toBe('internal')
    expect(classifyHref('README.md')).toBe('internal')
    expect(classifyHref('/README.md')).toBe('internal')
    expect(classifyHref('#section')).toBe('internal')
  })

  test('javascript:, data: and vbscript: are BLOCKED — the security test this exists for', () => {
    expect(classifyHref('javascript:alert(1)')).toBe('blocked')
    expect(classifyHref('JavaScript:alert(1)')).toBe('blocked')
    expect(classifyHref('data:text/html,<script>alert(1)</script>')).toBe('blocked')
    expect(classifyHref('vbscript:msgbox(1)')).toBe('blocked')
  })

  test('an empty href is blocked rather than treated as a relative empty path', () => {
    expect(classifyHref('')).toBe('blocked')
  })
})

describe('classifyImgSrc', () => {
  test('a relative path is internal', () => {
    expect(classifyImgSrc('./img.png')).toBe('internal')
    expect(classifyImgSrc('../assets/logo.svg')).toBe('internal')
  })

  test('a data: URI is internal — it makes no request', () => {
    expect(classifyImgSrc('data:image/png;base64,AAAA')).toBe('internal')
  })

  test('http(s) and protocol-relative are remote — never fetched', () => {
    expect(classifyImgSrc('http://tracker.example/pixel.gif')).toBe('remote')
    expect(classifyImgSrc('https://tracker.example/pixel.gif')).toBe('remote')
    expect(classifyImgSrc('//tracker.example/pixel.gif')).toBe('remote')
  })

  test('javascript: is remote too — never rendered as a live <img src>', () => {
    expect(classifyImgSrc('javascript:alert(1)')).toBe('remote')
  })
})

describe('resolveRepoRelativePath', () => {
  test('resolves against the DOCUMENT\'S directory, not the tree root', () => {
    expect(resolveRepoRelativePath('docs/guide.md', './img.png')).toBe('docs/img.png')
    expect(resolveRepoRelativePath('docs/guide.md', 'img.png')).toBe('docs/img.png')
  })

  test('walks up with ..', () => {
    expect(resolveRepoRelativePath('docs/sub/guide.md', '../img.png')).toBe('docs/img.png')
    expect(resolveRepoRelativePath('docs/sub/guide.md', '../../img.png')).toBe('img.png')
  })

  test('a root-level document resolves against the tree root', () => {
    expect(resolveRepoRelativePath('README.md', './img.png')).toBe('img.png')
  })

  test('a leading slash is root-relative, not a filesystem root', () => {
    expect(resolveRepoRelativePath('docs/sub/guide.md', '/assets/img.png')).toBe('assets/img.png')
  })

  test('a fragment or query is stripped before resolving', () => {
    expect(resolveRepoRelativePath('docs/guide.md', './other.md#section')).toBe('docs/other.md')
    expect(resolveRepoRelativePath('docs/guide.md', './x.png?v=2')).toBe('docs/x.png')
  })

  test('an escape past the joined root is not clamped here — the server refuses it', () => {
    expect(resolveRepoRelativePath('guide.md', '../../etc/passwd')).toBe('../../etc/passwd')
  })
})
