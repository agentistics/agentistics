import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// MENSAGENS.KILL: a session killed before it ever wrote a transcript answers `unavailable` + `stranded`. The
// notice that replaces the chat must still draw the 'Never read' cards, or the person's words are lost exactly
// where a hung session ends up.
const src = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8')

test('the no-transcript notice draws the stranded cards', () => {
  const start = src.indexOf('if (payload?.unavailable) {')
  expect(start).toBeGreaterThan(0)
  const branch = src.slice(start, src.indexOf('\n  return (', start))
  expect(branch).toContain('<StrandedList')
  expect(branch).toContain('strandedList')
})

test('the stranded list does not wait for a transcript in the ordinary branch either', () => {
  expect(src.match(/<StrandedList/g)?.length).toBe(2)
})
