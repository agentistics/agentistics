import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./SessionTabStrip.tsx', import.meta.url), 'utf8')

test('the previous active session is kept outside the component, per pane (the split pane remounts the strip)', () => {
  expect(src).toContain('prevActiveByPane')
  expect(src).not.toContain('prevActive = useRef')
})

test('the tabs list marks pins with the lucide Pin, not an emoji', () => {
  expect(src).not.toContain('📌')
  expect(src).toContain('pinned: true')
})
