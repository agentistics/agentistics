import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { focusComposer } from './focusComposer'

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')

describe('writing a comment never needs a scroll to the end', () => {
  test('focusComposer finds the composer\'s field, scrolls it into view and focuses it', () => {
    const calls: string[] = []
    const ta = { scrollIntoView: () => calls.push('scroll'), focus: () => calls.push('focus') }
    const root = { querySelector: (sel: string) => (sel === '[data-comment-composer] textarea' ? ta : null) }
    expect(focusComposer(root as never)).toBe(true)
    expect(calls).toEqual(['scroll', 'focus'])
  })
  test('with no composer there is nothing to focus, and no throw', () => {
    expect(focusComposer({ querySelector: () => null } as never)).toBe(false)
    expect(focusComposer(null)).toBe(false)
  })
  test('the loose pane has a top "Comentar" button wired to it, in a sticky bar', () => {
    const s = src('ThreadsPanel.tsx')
    expect(s).toContain('data-comment-top')
    expect(s).toContain('focusComposer(looseRef.current)')
    expect(s).toMatch(/position: 'sticky', top: 0[\s\S]{0,700}commentOnTask/)
  })
  test('the composer sticks to the foot of the pane it scrolls in', () => {
    const c = src('CommentComposer.tsx')
    expect(c).toContain('data-comment-composer')
    expect(c).toMatch(/sticky \? \{ position: 'sticky', bottom: 0/)
    expect(src('DeliveryDetail.tsx')).toMatch(/<CommentComposer[\s\S]{0,400}\n\s+sticky\n/)
  })
})
