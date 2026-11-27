/**
 * The session composer's send must SEND what was being dictated, not discard it (owner, 2026-11-27).
 * The behaviour itself is tested on the shared helper (`lib/dictationFinish.test.ts`) and through a
 * mounted composer (`tasks/CommentComposer.dictation.dom.test.tsx`); SessionChat is too large to
 * mount here, so its wiring to that helper is pinned over the source, like its other lint tests.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8')
const body = (start: string) => {
  const i = src.indexOf(start)
  expect(i).toBeGreaterThan(-1)
  return src.slice(i, src.indexOf('\n  }', i))
}

test('ending dictation for a send STOPS through finishDictation and never aborts the recogniser itself', () => {
  const end = body('const endDictationForSend = useCallback(')
  expect(end).toContain('finishDictation(rec, pending)')
  expect(end).not.toContain('abort')
})

// The tail-append step itself is behaviour-tested in `lib/dictationSend.test.ts`. What only this
// file can check is that SessionChat USES the helper's result: the draft it composes and restores
// must be `flushed.draft`, and the re-entry guard must be checked before anything else in send().
test('send folds the dictated tail in through flushDictationIntoDraft and composes from ITS result', () => {
  const send = body('async function send() {')
  expect(send.indexOf('if (flushingRef.current) return')).toBeGreaterThan(-1)
  expect(send.indexOf('if (flushingRef.current) return')).toBeLessThan(send.indexOf('flushDictationIntoDraft('))
  expect(send).toMatch(/const flushed = await flushDictationIntoDraft\(flushingRef, \{[^}]*finish: endDictationForSend,/)
  expect(send).toMatch(/readDraft: \(\) => draftRef\.current,/)
  // The result is not discarded: the draft sent and restored is the flushed one.
  expect(send).toMatch(/draftNow = flushed\.draft\b/)
  expect(send).toMatch(/const sendFields = draftNow === draft \? fields : toFields\(replyTo, draftNow\)/)
  expect(send).toContain('sendFields.fields')
  expect(send).toContain('restore = { draft: draftNow')
  // No hand-rolled copy of the step beside the helper.
  expect(send).not.toContain('appendDictation(')
})

test('words still being heard make the Send button live', () => {
  expect(src).toContain("|| heard.trim() !== ''")
})
