import { describe, expect, test } from 'bun:test'
import {
  handleComposerDrop, insertMention, mentionTargetForSelection, type ComposerDropDeps,
} from './mentionInsert'
import { consumeDraftRequest, getDraftRequest } from './composerStore'

/** Drains the store so one test's request never leaks into the next test's assertions. */
function drainDraft(): void {
  const req = getDraftRequest()
  if (req) consumeDraftRequest(req.at)
}

describe('insertMention', () => {
  test('queues the formatted text as a draft request for the right session', () => {
    drainDraft()
    const result = insertMention('sess-1', 'claude', { path: 'src/app.ts' }, true)
    expect(result.text).toBe('@src/app.ts')
    const req = getDraftRequest()
    expect(req?.sessionId).toBe('sess-1')
    expect(req?.text).toBe('@src/app.ts')
    drainDraft()
  })

  test('a range target uses the range form', () => {
    drainDraft()
    const result = insertMention('sess-1', 'claude', { path: 'a.ts', lines: { start: 3, end: 5 } }, true)
    expect(result.text).toBe('@a.ts#L3-5')
    drainDraft()
  })

  test('needsSwitch follows composerMounted, inverted', () => {
    drainDraft()
    expect(insertMention('sess-1', 'claude', { path: 'a.ts' }, true).needsSwitch).toBe(false)
    drainDraft()
    expect(insertMention('sess-1', 'claude', { path: 'a.ts' }, false).needsSwitch).toBe(true)
    drainDraft()
  })

  test('an unverified harness never produces an @ mention', () => {
    drainDraft()
    const result = insertMention('sess-1', 'gemini', { path: 'a.ts' }, true)
    expect(result.text).toBe('`a.ts`')
    drainDraft()
  })
})

describe('handleComposerDrop', () => {
  const fakeDataTransfer = {} as DataTransfer

  test('a repo-entry drop is handled and queues the mention', () => {
    drainDraft()
    const deps: ComposerDropDeps = {
      readRepoEntry: () => ({ path: 'src/app.ts' }),
      harness: 'claude',
    }
    const outcome = handleComposerDrop('sess-1', fakeDataTransfer, deps)
    expect(outcome).toEqual({ handled: true, text: '@src/app.ts' })
    expect(getDraftRequest()?.text).toBe('@src/app.ts')
    drainDraft()
  })

  test('a non-repo-entry drop is NOT handled, so the caller keeps its own file-drop logic', () => {
    drainDraft()
    const deps: ComposerDropDeps = { readRepoEntry: () => null, harness: 'claude' }
    const outcome = handleComposerDrop('sess-1', fakeDataTransfer, deps)
    expect(outcome).toEqual({ handled: false })
    // Nothing was queued — an unhandled drop must not silently insert anything.
    expect(getDraftRequest()).toBeNull()
  })

  test('the reader is called with the actual DataTransfer it was given', () => {
    drainDraft()
    let received: DataTransfer | undefined
    const deps: ComposerDropDeps = {
      readRepoEntry: dt => { received = dt; return null },
      harness: 'claude',
    }
    handleComposerDrop('sess-1', fakeDataTransfer, deps)
    expect(received).toBe(fakeDataTransfer)
  })

  test('an unverified harness on a drop still uses the plain form', () => {
    drainDraft()
    const deps: ComposerDropDeps = { readRepoEntry: () => ({ path: 'x/y.ts' }), harness: 'codex' }
    const outcome = handleComposerDrop('sess-1', fakeDataTransfer, deps)
    expect(outcome).toEqual({ handled: true, text: '`x/y.ts`' })
    drainDraft()
  })
})

describe('mentionTargetForSelection', () => {
  test('an empty selection yields no target', () => {
    expect(mentionTargetForSelection('a.ts', 4, 4, true)).toBeNull()
  })

  test('a non-empty selection yields a range target', () => {
    expect(mentionTargetForSelection('a.ts', 3, 5, false)).toEqual({ path: 'a.ts', lines: { start: 3, end: 5 } })
  })

  test('a reversed selection (dragged upward) is normalized start <= end', () => {
    expect(mentionTargetForSelection('a.ts', 9, 2, false)).toEqual({ path: 'a.ts', lines: { start: 2, end: 9 } })
  })

  test('a single-line non-empty selection yields start === end', () => {
    expect(mentionTargetForSelection('a.ts', 7, 7, false)).toEqual({ path: 'a.ts', lines: { start: 7, end: 7 } })
  })
})
