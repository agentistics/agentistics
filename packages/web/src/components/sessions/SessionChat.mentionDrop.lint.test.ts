/**
 * SessionChat.mentionDrop.lint.test.ts — the composer's drop handler CHECKS THE REPO ENTRY FIRST.
 *
 * §6.1 of the slots-and-references design: "the repo MIME is checked first, anything else falls
 * through untouched — pinned by a test for both." `mentionInsert.test.ts` proves `handleComposerDrop`
 * itself falls through correctly when its injected reader returns `null` — but nothing pinned the
 * WIRING inside `SessionChat.tsx`'s own `onDrop`, which is the function that actually decides the
 * order against a live `DataTransfer` (a repo-entry drop, checked before the existing OS-file/image
 * attachment path).
 *
 * Found by review (`session-w2b-references-review.md`, Important #1): swapping the two checks in the
 * real `onDrop` produced ZERO test failures anywhere in the suite, because the only thing pinned was
 * the pure helper's behavior, not this file's own ordering. There is no jsdom and no
 * `@testing-library/react` in this repo, so `onDrop` (a closure inside the component, never exported)
 * cannot be exercised by rendering and dispatching a real drop event — the source is what there is to
 * assert against, in the shape `sessionsPage.lint.test.ts` and `ArtifactsAside.gate.lint.test.ts`
 * already use here.
 *
 * COMMENTS ARE STRIPPED FIRST (`lib/stripComments.ts`) — this file's own doc comment above `onDrop`
 * names both checks in prose, so a raw grep would be satisfied by the very comment explaining the
 * order it exists to pin.
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const FILE = join(import.meta.dir, 'SessionChat.tsx')
const raw = readFileSync(FILE, 'utf8')

/** The `onDrop` function's own body, cut out of the RAW source (comments intact) by brace depth —
 *  never the whole file: `stripComments`'s own header warns a `/* … *\/` or `//` inside a string can
 *  eat far more than intended on a big file, and cutting the region out first is the documented fix. */
function onDropBody(src: string): string {
  const start = src.indexOf('function onDrop(')
  if (start === -1) throw new Error('onDrop not found — has it been renamed?')
  const braceStart = src.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(braceStart, i + 1)
    }
  }
  throw new Error('unbalanced braces in onDrop')
}

/** The two checks, as they appear in `onDrop`'s stripped body: `undefined` if either is missing. */
function checkOrder(body: string): { repoAt: number; osAt: number } {
  const repoAt = body.indexOf('handleComposerDrop(')
  const osAt = body.indexOf('dataTransfer.files.length === 0')
  return { repoAt, osAt }
}

test('the repo-entry check runs BEFORE the OS-file check in onDrop, on the real source', () => {
  const body = stripComments(onDropBody(raw))
  const { repoAt, osAt } = checkOrder(body)
  expect(repoAt).toBeGreaterThan(-1)
  expect(osAt).toBeGreaterThan(-1)
  expect(repoAt).toBeLessThan(osAt)
})

test('the scan itself distinguishes ordered from reordered bodies', () => {
  // The reviewer's exact repro, as a body this scan is handed directly — the OS-file check written
  // FIRST, the repo-entry check after. This proves `checkOrder` — the same function the real-source
  // test above calls — actually catches a reordering; the real-source test was itself run against
  // the reviewer's literal reordering (`handleComposerDrop` moved after the `files.length` check) in
  // `SessionChat.tsx`, watched to fail, and restored — see this file's own commit message.
  const ordered = 'if (handleComposerDrop(...)) return\nif (dataTransfer.files.length === 0) return'
  const reordered = 'if (dataTransfer.files.length === 0) return\nif (handleComposerDrop(...)) return'
  expect(checkOrder(ordered).repoAt).toBeLessThan(checkOrder(ordered).osAt)
  expect(checkOrder(reordered).repoAt).toBeGreaterThan(checkOrder(reordered).osAt)
})
