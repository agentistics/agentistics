import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Structural pin (task-web's orphan sweep is fire-and-forget behind the whole Live read, so a behavioural drive would
// need the full task world): the sweep must take "is a leader live" from `leaderLiveOf` — the one rule that reads the
// leaders' STATE — never from the mere presence of a leader row.
const src = readFileSync(new URL('./task-web.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')

test('task-web feeds the orphan sweep through leaderLiveOf', () => {
  expect(src).toMatch(/leaderLive:\s*leaderLiveOf\(\s*all\.leaders\s*\)/)
})

test('task-web never derives leaderLive from a row count', () => {
  expect(src).not.toMatch(/leaderLive:\s*all\.leaders\.length/)
  expect(src).not.toMatch(/leaderLive:\s*[^,\n]*\.length/)
})
