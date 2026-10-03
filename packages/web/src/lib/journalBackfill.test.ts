import { describe, expect, test } from 'bun:test'
import { journalBackfillText } from './journalBackfill'

describe('the journal first-import line', () => {
  test('nothing to say: no line', () => {
    expect(journalBackfillText(null, 'pt')).toBeNull()
    expect(journalBackfillText(undefined, 'en')).toBeNull()
  })
  test('running says where it is and that the figures come from the previous path', () => {
    const t = journalBackfillText({ state: 'running', written: 1234, harness: 'codex', done: 3, total: 19 }, 'en')!
    expect(t).toBe("Importing this machine's history into the journal · codex 3/19 · 1,234 events — until it completes, the figures come from the previous path.")
    expect(journalBackfillText({ state: 'running', written: 1234, harness: 'codex', done: 3, total: 19 }, 'pt')).toContain('1.234 eventos')
  })
  test('paused names the reason a person can act on', () => {
    expect(journalBackfillText({ state: 'paused', written: 0, harness: null, done: null, total: null }, 'pt')).toContain('pausada')
  })
})
