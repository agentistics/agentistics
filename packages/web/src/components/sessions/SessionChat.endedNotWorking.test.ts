import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8')

// A session ended mid-turn keeps its last `working` state (the structured payload and the row both
// froze on it), so the busy note must also require the session to be running.
test('the busy note never shows on an ended session', () => {
  expect(src).toMatch(/const showWorking = working && !loading && !sessionEnded\b/)
  expect(src).toContain('awaitingWorking={working && !sessionEnded}')
})
