import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// React #300: an ended session with no transcript renders the `unavailable` branch; any hook below that
// early return changes the hook count between renders and takes the whole page down.
describe('SessionChat hook order', () => {
  test('no hook is called after the `unavailable` early return', () => {
    const src = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8')
    const start = src.indexOf('export function SessionChat(')
    const early = src.indexOf('  if (payload?.unavailable) {', start)
    expect(early).toBeGreaterThan(start)
    const end = src.indexOf('\n}\n', early)
    const after = src.slice(early, end)
    expect(after.match(/^ {2}(?:const|let)?[^\n]*\buse[A-Z]\w*\(/gm) ?? []).toEqual([])
  })
})
