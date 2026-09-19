/**
 * What THIS component adds to an already-tested client — and, above everything else, the ONE
 * guarantee the whole repository explorer is allowed to write under:
 *
 *   **A save never silently overwrites a change that landed on disk while the file was open** — with
 *   ONE STATED LIMIT, which the component's own header names and this file cannot reach: an mtime
 *   comparison is only as fine as the filesystem's clock.
 *
 * `repoApi.test.ts` owns the three outcomes of a call and `repoErrorText.test.ts` owns the wording;
 * neither is re-asserted here. What is left is the save STATE MACHINE, and the last section of this
 * file drives it through a FAKE DISK that implements the server's contract exactly as
 * `editor-web.ts` does — a write is accepted only when its pinned mtime still matches, and a
 * mismatch writes NOTHING and answers 409 with the current content. That simulation is what makes
 * the guarantee a tested fact rather than a sentence in a header: it is asserted against what is on
 * the fake disk afterwards, not against what the UI believed.
 *
 * Rendering is `renderToStaticMarkup`, the stack `RepoTreeView.test.tsx` and
 * `RepoSearchView.test.tsx` already use: this repo has no `@testing-library/react`/jsdom (see
 * `ConnectionCard.test.tsx`'s own note), so typing cannot be simulated and `useEffect` never runs.
 * The strip, the banner and the question therefore take their state as props, exactly as
 * `RepoSearchResults` does, which is what makes every sentence assertable.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AUTOSAVE_FAILURE_LIMIT, autosaveStopped, binaryText, diskVersionOf, focusTrapTarget,
  initialSaveState, isDirty, isMidRetarget, loadStateFor, loadStateForRender,
  mediaFailedText, mediaTooBigText,
  monacoOptions, monacoThemeFor, nextSaveState, readPreviewMode, renderableDocKind,
  RepoConflictPrompt, RepoMediaView, RepoSaveStrip, RepoStaleBanner,
  saveButtonState, saveEventFor, saveGate, saveStatus, ViewModeToggle, writePreviewMode,
  type LoadState, type SaveEvent, type SaveState,
} from './RepoFileEditor'
import type { ReadFileResult, WriteFileResult } from '../../lib/repoApi'
import { AGENTISTICS_THEME_NAME } from '../../lib/monacoTheme'

function noop() { /* these renders press nothing */ }

/** Apply a whole sequence, the way the component's reducer does. */
function run(state: SaveState, ...events: SaveEvent[]): SaveState {
  return events.reduce(nextSaveState, state)
}

const OPENED = initialSaveState(1000)

// --- reading one file ----------------------------------------------------------------------------

describe('loadStateFor', () => {
  test('text becomes READY, carrying the mtime the next write will be pinned to', () => {
    const res: ReadFileResult = { ok: true, content: 'const a = 1\n', mtimeMs: 1700 }
    expect(loadStateFor(res, 'en')).toEqual({ kind: 'ready', content: 'const a = 1\n', mtimeMs: 1700 })
  })

  test('an EMPTY file is a file, not a failure', () => {
    expect(loadStateFor({ ok: true, content: '', mtimeMs: 9 }, 'en'))
      .toEqual({ kind: 'ready', content: '', mtimeMs: 9 })
  })

  test('a BINARY file is its own state — never an empty editor', () => {
    expect(loadStateFor({ ok: true, binary: true, name: 'logo.png', size: 20480 }, 'en'))
      .toEqual({ kind: 'binary', name: 'logo.png', size: 20480 })
  })

  test('a refusal the server worded is carried through verbatim', () => {
    expect(loadStateFor({
      ok: false, failure: 'refused', status: 404, reason: 'not-found',
      message: 'Esse caminho não existe mais.',
    }, 'pt')).toEqual({ kind: 'failed', text: 'Esse caminho não existe mais.' })
  })

  test('a gate refusal carries no sentence, so the UI supplies one in the reader’s language', () => {
    const gate: ReadFileResult = { ok: false, failure: 'refused', status: 403, reason: 'editor_disabled' }
    expect(loadStateFor(gate, 'en')).toEqual({
      kind: 'failed', text: expect.stringContaining('Settings → Sessions'),
    })
    expect(loadStateFor(gate, 'pt')).toEqual({
      kind: 'failed', text: expect.stringContaining('Configurações → Sessões'),
    })
  })

  test('an unreachable server is SAID — never an empty buffer', () => {
    const state = loadStateFor({ ok: false, failure: 'unreachable', cause: 'timeout' }, 'en')
    expect(state.kind).toBe('failed')
    expect(state.kind === 'failed' && state.text.length > 0).toBe(true)
  })
})

/**
 * C1 (2026-09-12, `session-w1c-tree-ops-review.md`): renaming or moving an open file with unsaved
 * changes discarded the buffer and the undo stack. The two functions below are the whole fix, pulled
 * out of the component so the failure — and the repair — can be asserted directly rather than
 * believed from a comment. The bug was a naive `read.key === fileKey ? read.state : {kind:'loading'}`
 * flipping to `loading` for exactly the render between a retarget being detected and the read effect
 * catching `read.key` up — long enough for the mount effect's `[load.kind]` dependency to see 'ready'
 * become 'loading' and dispose the live editor, so the NEXT flip back to 'ready' recreated one from
 * `contentRef.current` (the file's original disk text, not the dirty buffer).
 */
describe('isMidRetarget', () => {
  test('a path change with a live editor IS a retarget', () => {
    expect(isMidRetarget('src/a.ts', true)).toBe(true)
  })

  test('no path change is never a retarget, editor or not', () => {
    expect(isMidRetarget(undefined, true)).toBe(false)
    expect(isMidRetarget(undefined, false)).toBe(false)
  })

  test('a path change with NO live editor yet is an ordinary read — nothing to preserve', () => {
    // The race the component's own header names: a retarget landing before the first read resolved.
    expect(isMidRetarget('src/a.ts', false)).toBe(false)
  })
})

describe('loadStateForRender — the exact line C1 lived in', () => {
  const READY: LoadState = { kind: 'ready', content: '// DIRTY-LINE\nexport const a = 1\n', mtimeMs: 5 }
  const read = { key: 'sess\nsrc/a.ts', state: READY }
  const newFileKey = 'sess\nsrc/a2.ts'

  test('the key already matches: the state is returned untouched, retarget or not', () => {
    expect(loadStateForRender(read, read.key, undefined, true)).toBe(READY)
    expect(loadStateForRender(read, read.key, 'src/a.ts', true)).toBe(READY)
  })

  test('mid-retarget, a mismatched key still returns the live state — never `loading`', () => {
    // This is the render between the retarget being detected and the read effect patching
    // `read.key`: exactly where C1 lost the buffer. `isMidRetarget` is what the real render
    // computes as its third argument; passed here explicitly so the two can never drift apart.
    expect(loadStateForRender(read, newFileKey, 'src/a.ts', true)).toBe(READY)
  })

  test('THE PLANTED DEFECT: a bare key-equality check loses the buffer on the very render C1 reported', () => {
    // The exact shape of the line this replaced (`read.key === fileKey ? read.state : {kind:'loading'}`).
    // Restated here as an assertion so the regression is pinned in the test file, not only in a
    // comment above the real function: if `loadStateForRender` above ever regresses to this, this
    // expectation fails, but `read.key === fileKey ? read.state : {kind:'loading'} as LoadState`
    // itself proves the point — it drops the buffer whenever the key has not yet caught up, which is
    // exactly the render a retarget is detected on.
    const naive = (r: typeof read, key: string): LoadState => (r.key === key ? r.state : { kind: 'loading' })
    expect(naive(read, newFileKey)).toEqual({ kind: 'loading' })
    // ...while the real function, given the SAME inputs plus the retarget signal, keeps the buffer.
    expect(loadStateForRender(read, newFileKey, 'src/a.ts', true)).toBe(READY)
  })

  test('mid-retarget with NO live editor yet: nothing to preserve, so it reads loading', () => {
    expect(loadStateForRender(read, newFileKey, 'src/a.ts', false)).toEqual({ kind: 'loading' })
  })

  test('an ordinary file swap (no retarget signal) with a mismatched key reads loading', () => {
    expect(loadStateForRender(read, newFileKey, undefined, true)).toEqual({ kind: 'loading' })
  })
})

/**
 * MEDIA — the half of "binary" the Studio now SHOWS.
 *
 * The refusal it replaces was true and about the wrong thing: "it is not opened as text here, so it
 * cannot be saved back mangled" is a statement about SAVING, offered to somebody who wanted to LOOK.
 * What is asserted here is that the three showable kinds become their own state, that everything
 * else keeps the old sentence, that a file over its ceiling gets a sentence about its CEILING, and —
 * the one that matters most — that the shown pane offers no way into the save machinery.
 */
describe('media', () => {
  const shown = (media: 'image' | 'video' | 'pdf') =>
    loadStateFor({ ok: true, binary: true, name: `f.${media}`, size: 4, media }, 'en')

  test('the three showable kinds become their own state, carrying which one it is', () => {
    expect(shown('image')).toEqual({ kind: 'media', media: 'image', name: 'f.image', size: 4 })
    expect(shown('video').kind).toBe('media')
    expect(shown('pdf').kind).toBe('media')
  })

  test('a media state carries NO mtime — which is what keeps it out of the save machinery', () => {
    // `initialSaveState`'s pin only ever moves on a `loaded` event, and only a `ready` read
    // dispatches one. There is nothing on this state to dispatch it WITH, so the guarantee is the
    // shape of the type rather than a branch somebody has to remember not to take.
    expect(Object.keys(shown('image')).sort()).toEqual(['kind', 'media', 'name', 'size'])
  })

  test('an ordinary binary keeps the old refusal — it is the right one for a .zip', () => {
    expect(loadStateFor({ ok: true, binary: true, name: 'build.zip', size: 900 }, 'en'))
      .toEqual({ kind: 'binary', name: 'build.zip', size: 900 })
  })

  test('over the ceiling is a REFUSAL carrying the ceiling, not a render', () => {
    const state = loadStateFor({
      ok: true, binary: true, name: 'huge.mp4', size: 900 * 1024 * 1024,
      mediaOverLimit: { media: 'video', limit: 512 * 1024 * 1024 },
    }, 'en')
    expect(state).toEqual({
      kind: 'binary', name: 'huge.mp4', size: 900 * 1024 * 1024, overLimit: 512 * 1024 * 1024,
    })
  })

  test('the too-big sentence names the FILE, its size and the limit it hit', () => {
    const text = mediaTooBigText({ name: 'huge.mp4', size: 900 * 1024 * 1024, limit: 512 * 1024 * 1024 }, 'en')
    expect(text).toContain('huge.mp4')
    expect(text).toContain('900 MB')
    expect(text).toContain('512 MB')
    // And it does NOT give the binary sentence's reason, which is about saving and is not why this
    // one was refused.
    expect(text).not.toContain('mangled')
    expect(mediaTooBigText({ name: 'h.mp4', size: 1, limit: 2 }, 'pt')).toContain('limite')
  })

  test('a load that failed is a SENTENCE naming the file, in both languages', () => {
    expect(mediaFailedText('shot.png', 'en')).toContain('shot.png')
    expect(mediaFailedText('shot.png', 'en')).toContain('could not be loaded')
    expect(mediaFailedText('shot.png', 'pt')).toContain('não foi possível carregar')
  })
})

function mediaView(
  media: 'image' | 'video' | 'pdf', lang: 'pt' | 'en' = 'en', isMobile = false,
): string {
  return renderToStaticMarkup(
    <RepoMediaView
      sessionId="s1" path="assets/bryan-home.png" media={media}
      name="bryan-home.png" size={216 * 1024} lang={lang} isMobile={isMobile}
    />,
  )
}

describe('the media pane', () => {
  test('an image is an <img> pointed at the STUDIO\'s media route, not the artifacts one', () => {
    const html = mediaView('image')
    expect(html).toContain('<img')
    // `/api/fleet/media` resolves against the files the session WROTE and would refuse a checked-in
    // asset — the exact file this feature was reported for.
    expect(html).toContain('/api/fleet/tree/media?id=s1&amp;path=assets%2Fbryan-home.png')
  })

  test('a video is a <video> with controls and no autoplay', () => {
    const html = mediaView('video')
    expect(html).toContain('<video')
    expect(html).toContain('controls=""')
    expect(html).toContain('playsInline=""')
    expect(html).not.toContain('autoplay')
  })

  test('a PDF goes to the browser\'s OWN viewer, fitted to the width', () => {
    const html = mediaView('pdf')
    expect(html).toContain('<iframe')
    expect(html).toContain('#view=FitH')
  })

  test('it SAYS it is read-only, and names the kind', () => {
    expect(mediaView('image')).toContain('Read-only')
    expect(mediaView('image')).toContain('image')
    expect(mediaView('video', 'pt')).toContain('Somente leitura')
    expect(mediaView('video', 'pt')).toContain('vídeo')
    expect(mediaView('image')).toContain('role="status"')
  })

  test('THERE IS NO SAVE, in any kind or language', () => {
    // The strongest half of "read-only" is structural (the state carries no mtime), but a pane that
    // still painted a Save button would be read as one whose save merely failed.
    for (const media of ['image', 'video', 'pdf'] as const) {
      for (const lang of ['en', 'pt'] as const) {
        const html = mediaView(media, lang)
        expect(html).not.toContain('<button')
        expect(html).not.toContain('Save')
        expect(html).not.toContain('Salvar')
        expect(html).not.toContain('data-dirty')
      }
    }
  })

  test('a wide image is capped to the column — the page may not scroll sideways at 390px', () => {
    const html = mediaView('image', 'en', true)
    expect(html).toContain('max-width:100%')
    expect(html).toContain('height:auto')
    // And the region that scrolls does it INSIDE itself, which is this workspace's rule for every
    // inner scroller — a flick off the end of one must not rubber-band the document.
    expect(html).toContain('overflow-x:hidden')
    expect(html).toContain('overscroll-behavior:contain')
  })

  test('the way out of the panel is a link, and it is a finger tall on a phone', () => {
    expect(mediaView('pdf', 'en', true)).toContain('Open in a tab')
    expect(mediaView('pdf', 'pt', true)).toContain('Abrir em uma aba')
    expect(mediaView('pdf', 'en', true)).toContain('min-height:44px')
    // 44px is the MOBILE number. On a desktop it would be a painted box three times the link.
    expect(mediaView('pdf', 'en', false)).not.toContain('min-height:44px')
  })
})

describe('binaryText', () => {
  test('names the file, says what it is, and carries the size', () => {
    const text = binaryText({ name: 'logo.png', size: 20480 }, 'en')
    expect(text).toContain('logo.png')
    expect(text).toContain('20 KB')
    expect(text).toContain('binary')
  })

  test('localized, and the two languages differ', () => {
    expect(binaryText({ name: 'a.bin', size: 10 }, 'pt'))
      .not.toBe(binaryText({ name: 'a.bin', size: 10 }, 'en'))
    expect(binaryText({ name: 'a.bin', size: 10 }, 'pt')).toContain('binário')
  })
})

// --- the machine, transition by transition --------------------------------------------------------

describe('the save state machine', () => {
  test('a freshly read file is clean, pinned to the mtime it was read at', () => {
    expect(isDirty(OPENED)).toBe(false)
    expect(OPENED.mtimeMs).toBe(1000)
    expect(saveGate(OPENED)).toEqual({ allowed: false, why: 'clean' })
  })

  test('an edit makes it dirty, and a save may be attempted against the read mtime', () => {
    const edited = run(OPENED, { kind: 'edited' })
    expect(isDirty(edited)).toBe(true)
    expect(saveGate(edited)).toEqual({ allowed: true, mtimeMs: 1000 })
  })

  test('a successful write advances the pin and clears the dirt', () => {
    const saved = run(OPENED, { kind: 'edited' }, { kind: 'save-started' }, { kind: 'saved', mtimeMs: 2000 })
    expect(saved.mtimeMs).toBe(2000)
    expect(isDirty(saved)).toBe(false)
    expect(saved.phase.kind).toBe('saved')
  })

  test('typing DURING a save leaves the buffer dirty afterwards — the write carried the older text', () => {
    const after = run(
      OPENED,
      { kind: 'edited' },
      { kind: 'save-started' },
      { kind: 'edited' },
      { kind: 'saved', mtimeMs: 2000 },
    )
    expect(isDirty(after)).toBe(true)
    expect(after.mtimeMs).toBe(2000)
  })

  test('a CONFLICT moves the pin NOWHERE and clears nothing — this is the guarantee', () => {
    const conflicted = run(
      OPENED,
      { kind: 'edited' },
      { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
    )
    expect(conflicted.mtimeMs).toBe(1000)
    expect(isDirty(conflicted)).toBe(true)
    expect(conflicted.phase).toEqual({ kind: 'conflict', diskContent: 'theirs', diskMtimeMs: 5000 })
  })

  test('a failed save keeps the pin and the dirt, and keeps its sentence', () => {
    const failed = run(
      OPENED,
      { kind: 'edited' },
      { kind: 'save-started' },
      { kind: 'save-failed', text: 'O servidor não respondeu.', failure: 'unreachable' },
    )
    expect(failed.mtimeMs).toBe(1000)
    expect(isDirty(failed)).toBe(true)
    expect(failed.phase).toEqual({ kind: 'failed', text: 'O servidor não respondeu.' })
  })

  test('typing does not dismiss an open question', () => {
    const conflicted = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
    )
    expect(run(conflicted, { kind: 'edited' }, { kind: 'edited' }).phase.kind).toBe('conflict')
  })

  test('typing DOES clear the two notices, which are about a write the buffer has moved past', () => {
    const saved = run(OPENED, { kind: 'edited' }, { kind: 'save-started' }, { kind: 'saved', mtimeMs: 2 })
    expect(run(saved, { kind: 'edited' }).phase.kind).toBe('idle')
    const failed = run(OPENED, { kind: 'edited' }, { kind: 'save-started' }, { kind: 'save-failed', text: 'x', failure: 'refused' })
    expect(run(failed, { kind: 'edited' }).phase.kind).toBe('idle')
  })

  test('"keep editing" becomes STALE and keeps the disk version for the two actions', () => {
    const stale = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
      { kind: 'dismiss-conflict' },
    )
    expect(stale.phase).toEqual({ kind: 'stale', diskContent: 'theirs', diskMtimeMs: 5000 })
    expect(diskVersionOf(stale.phase)).toEqual({ diskContent: 'theirs', diskMtimeMs: 5000 })
    expect(stale.mtimeMs).toBe(1000)
  })

  test('an explicit ask re-opens the question from STALE, and does nothing from anywhere else', () => {
    const stale = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
      { kind: 'dismiss-conflict' },
    )
    expect(run(stale, { kind: 'prompt-conflict' }).phase.kind).toBe('conflict')
    // From a clean, idle buffer there is no disk version to prompt ABOUT — inventing a dialog there
    // would ask a question nobody can answer.
    expect(run(OPENED, { kind: 'prompt-conflict' })).toBe(OPENED)
  })

  test('"save over it" moves the pin to the version it is overwriting, and stays dirty until written', () => {
    const chosen = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
      { kind: 'keep-mine' },
    )
    expect(chosen.mtimeMs).toBe(5000)
    expect(isDirty(chosen)).toBe(true)
    expect(chosen.phase.kind).toBe('idle')
  })

  test('"discard and reload" adopts the disk version: clean, at the disk mtime', () => {
    const reloaded = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
      { kind: 'take-disk' },
    )
    expect(reloaded.mtimeMs).toBe(5000)
    expect(isDirty(reloaded)).toBe(false)
    expect(reloaded.phase.kind).toBe('idle')
  })

  test('neither choice does anything when there is no conflict to resolve', () => {
    const dirty = run(OPENED, { kind: 'edited' })
    expect(run(dirty, { kind: 'keep-mine' })).toBe(dirty)
    expect(run(dirty, { kind: 'take-disk' })).toBe(dirty)
    expect(diskVersionOf(dirty.phase)).toBeNull()
  })

  test('only the "Saved" notice expires; a FAILURE stays until something really changes', () => {
    const saved = run(OPENED, { kind: 'edited' }, { kind: 'save-started' }, { kind: 'saved', mtimeMs: 2 })
    expect(run(saved, { kind: 'notice-cleared' }).phase.kind).toBe('idle')
    const failed = run(OPENED, { kind: 'edited' }, { kind: 'save-started' }, { kind: 'save-failed', text: 'x', failure: 'refused' })
    expect(run(failed, { kind: 'notice-cleared' }).phase.kind).toBe('failed')
    const conflicted = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'a', diskMtimeMs: 3 },
    )
    expect(run(conflicted, { kind: 'notice-cleared' }).phase.kind).toBe('conflict')
  })

  test('re-reading the file resets everything, including an open question', () => {
    const messy = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
    )
    expect(run(messy, { kind: 'loaded', mtimeMs: 7777 })).toEqual(initialSaveState(7777))
  })

  test('OPENING ANOTHER FILE resets everything too — nothing of the old one may be reported', () => {
    // A read that fails or turns out to be BINARY never dispatches `loaded`, so without this event
    // the previous file's edit count and mtime pin survived: `onDirtyChange(true)` stayed latched and
    // the host would warn about unsaved changes on a PNG.
    const messy = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
    )
    const fresh = run(messy, { kind: 'reset' })
    expect(fresh).toEqual(initialSaveState(0))
    expect(isDirty(fresh)).toBe(false)
    expect(fresh.phase.kind).toBe('idle')
  })

  test('consecutive save FAILURES are counted, and only a write that landed clears the count', () => {
    let state = run(OPENED, { kind: 'edited' })
    for (let i = 1; i <= 3; i++) {
      state = run(state, { kind: 'save-started' }, { kind: 'save-failed', text: 'read-only', failure: 'refused' })
      expect(state.failedStreak).toBe(i)
    }
    const landed = run(state, { kind: 'save-started' }, { kind: 'saved', mtimeMs: 9 })
    expect(landed.failedStreak).toBe(0)
    // A conflict is a QUESTION, not a failure: it must not count toward giving up.
    const conflicted = run(OPENED, { kind: 'edited' }, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 })
    expect(conflicted.failedStreak).toBe(0)
  })

  test('a fresh read, and opening another file, both clear the count', () => {
    const failing = run(
      OPENED, { kind: 'edited' }, { kind: 'save-started' }, { kind: 'save-failed', text: 'x', failure: 'refused' },
    )
    expect(failing.failedStreak).toBe(1)
    expect(run(failing, { kind: 'loaded', mtimeMs: 3 }).failedStreak).toBe(0)
    expect(run(failing, { kind: 'reset' }).failedStreak).toBe(0)
  })

  test('TYPING does not clear the count — a refusal that cannot change is not changed by a keystroke', () => {
    let state = run(OPENED, { kind: 'edited' })
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(state, { kind: 'save-started' },
        { kind: 'save-failed', text: 'read-only', failure: 'refused' })
    }
    expect(autosaveStopped(state)).toBe(true)
    expect(autosaveStopped(run(state, { kind: 'edited' }, { kind: 'edited' }))).toBe(true)
  })

  test('only a REFUSAL counts: a server that could not be reached has decided nothing', () => {
    // The bound exists for an answer that cannot change — a read-only file, a path outside the
    // session's folder. An unreachable server has not answered at all, and it is the one case that
    // un-refuses itself: this product's own CLI restarts the server, and the bound would otherwise
    // leave autosave permanently off on every file that happened to be open at the time.
    let state = run(OPENED, { kind: 'edited' })
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT * 3; i++) {
      state = run(state, { kind: 'save-started' },
        { kind: 'save-failed', text: 'The server did not answer.', failure: 'unreachable' })
    }
    expect(state.failedStreak).toBe(0)
    expect(autosaveStopped(state)).toBe(false)
    expect(state.phase).toEqual({ kind: 'failed', text: 'The server did not answer.' })
    expect(saveGate(state, 'auto')).toEqual({ allowed: true, mtimeMs: 1000 })
    // …and the sentence is still on screen while it keeps trying, which is the honest pair.
    expect(saveStatus(state, 'en', true).text).toBe('The server did not answer.')
  })

  test('a mixed run counts the refusals and ignores the rest', () => {
    let state = run(OPENED, { kind: 'edited' })
    const fail = (failure: 'refused' | 'unreachable'): SaveEvent =>
      ({ kind: 'save-failed', text: 'x', failure })
    state = run(state, { kind: 'save-started' }, fail('unreachable'))
    state = run(state, { kind: 'save-started' }, fail('refused'))
    state = run(state, { kind: 'save-started' }, fail('unreachable'))
    state = run(state, { kind: 'save-started' }, fail('refused'))
    expect(state.failedStreak).toBe(2)
    expect(autosaveStopped(state)).toBe(false)
    state = run(state, { kind: 'save-started' }, fail('refused'))
    expect(autosaveStopped(state)).toBe(true)
  })
})

// --- the gate ------------------------------------------------------------------------------------

describe('saveGate', () => {
  const dirty = run(OPENED, { kind: 'edited' })

  test('a clean buffer writes nothing — there is nothing to write', () => {
    expect(saveGate(OPENED)).toEqual({ allowed: false, why: 'clean' })
  })

  test('a write in flight blocks a second one', () => {
    expect(saveGate(run(dirty, { kind: 'save-started' }))).toEqual({ allowed: false, why: 'in-flight' })
  })

  test('an OPEN question blocks every write, whoever asks', () => {
    const conflicted = run(dirty, { kind: 'save-started' }, { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 })
    expect(saveGate(conflicted)).toEqual({ allowed: false, why: 'conflict-open' })
  })

  test('a pin known to be STALE blocks it too, with its own reason', () => {
    const stale = run(
      dirty, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 }, { kind: 'dismiss-conflict' },
    )
    expect(saveGate(stale)).toEqual({ allowed: false, why: 'stale' })
  })

  test('the pin a write carries is the state’s own — never a fresher one', () => {
    expect(saveGate(dirty)).toEqual({ allowed: true, mtimeMs: 1000 })
  })

  test('the two triggers differ in exactly one place: a refusal that keeps repeating', () => {
    let state = dirty
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(state, { kind: 'save-started' }, { kind: 'save-failed', text: 'read-only', failure: 'refused' })
    }
    // AUTOSAVE gives up — it would otherwise PUT every 1.5 s for as long as the tab is open, and the
    // error it keeps replacing with `Saving…` is the one thing the reader needs to be able to read.
    expect(saveGate(state, 'auto')).toEqual({ allowed: false, why: 'autosave-stopped' })
    // The PERSON is never locked out: a file that becomes writable again must be savable without
    // reopening the tab.
    expect(saveGate(state, 'explicit')).toEqual({ allowed: true, mtimeMs: 1000 })
    // An UNNAMED trigger is treated as the automatic one: both real callers name theirs, so the only
    // caller that can reach the default is a new one that forgot to — and of the two ways to be
    // wrong, handing it the bounded path costs a press, while handing it the unbounded one reopens
    // the very PUT loop above.
    expect(saveGate(state)).toEqual({ allowed: false, why: 'autosave-stopped' })
  })

  test('below the limit autosave still tries — one failure is not a permanent one', () => {
    const once = run(dirty, { kind: 'save-started' }, { kind: 'save-failed', text: 'read-only', failure: 'refused' })
    expect(saveGate(once, 'auto')).toEqual({ allowed: true, mtimeMs: 1000 })
  })
})

// --- one write result, one event ------------------------------------------------------------------

describe('saveEventFor', () => {
  test('a success carries the NEW mtime the next write must be pinned to', () => {
    expect(saveEventFor({ ok: true, mtimeMs: 4242 }, 'en')).toEqual({ kind: 'saved', mtimeMs: 4242 })
  })

  test('a 409 carrying the disk version becomes the question', () => {
    const conflict: WriteFileResult = {
      ok: false, failure: 'refused', status: 409, reason: 'conflict',
      message: 'This file changed on disk.', content: 'theirs', mtimeMs: 5000,
    }
    expect(saveEventFor(conflict, 'en'))
      .toEqual({ kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 })
  })

  test('a 409 that names a conflict WITHOUT the content it needs is a failure, not a prompt', () => {
    // `isWriteConflict` is the test, never `reason === 'conflict'`: a dialog offering "reload what is
    // on disk" with no disk content would be a button that cannot do what it says.
    const half: WriteFileResult = {
      ok: false, failure: 'refused', status: 409, reason: 'conflict',
      message: 'O arquivo mudou no disco.',
    } as WriteFileResult
    expect(saveEventFor(half, 'pt'))
      .toEqual({ kind: 'save-failed', text: 'O arquivo mudou no disco.', failure: 'refused' })
  })

  test('any other refusal is the server’s own sentence', () => {
    expect(saveEventFor({
      ok: false, failure: 'refused', status: 403, reason: 'escaped',
      message: 'Esse caminho sai da pasta da sessão.',
    }, 'pt')).toEqual({
      kind: 'save-failed', text: 'Esse caminho sai da pasta da sessão.', failure: 'refused',
    })
  })

  test('an unreachable server is a failure with a sentence, never a silent no-op', () => {
    const event = saveEventFor({ ok: false, failure: 'unreachable', cause: 'network' }, 'en')
    expect(event.kind).toBe('save-failed')
    expect(event.kind === 'save-failed' && event.text.length > 0).toBe(true)
  })

  test('the event carries WHICH KIND of failure it was — only a refusal may bound autosave', () => {
    // The two are already apart in `WriteFileResult` (`refused` is a decision the server made,
    // `unreachable` is no answer at all) and the streak is the one place that distinction matters, so
    // it is carried through rather than re-derived from the sentence.
    const refused = saveEventFor({
      ok: false, failure: 'refused', status: 403, reason: 'not-a-file', message: 'Not a file.',
    }, 'en')
    expect(refused.kind === 'save-failed' && refused.failure).toBe('refused')
    for (const cause of ['network', 'timeout', 'malformed'] as const) {
      const event = saveEventFor({ ok: false, failure: 'unreachable', cause }, 'en')
      expect(event.kind === 'save-failed' && event.failure).toBe('unreachable')
    }
  })
})

// --- what the reader is told ---------------------------------------------------------------------

describe('saveStatus', () => {
  const dirty = run(OPENED, { kind: 'edited' })
  const saving = run(dirty, { kind: 'save-started' })
  const saved = run(saving, { kind: 'saved', mtimeMs: 2 })
  const failed = run(saving, { kind: 'save-failed', text: 'The server did not answer.', failure: 'unreachable' })
  const conflicted = run(saving, { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 })
  const stale = run(conflicted, { kind: 'dismiss-conflict' })

  test('a buffer that matches the disk says NOTHING — it invents no reassurance', () => {
    expect(saveStatus(OPENED, 'en')).toEqual({ text: null, tone: 'dim' })
  })

  test('the five things that can be happening are five different sentences', () => {
    const seen = [dirty, saving, saved, failed, conflicted]
      .map(state => saveStatus(state, 'en').text)
    expect(new Set(seen).size).toBe(5)
    expect(seen.every(text => text !== null)).toBe(true)
  })

  test('a failed save shows the server’s own sentence, verbatim', () => {
    expect(saveStatus(failed, 'en')).toEqual({ text: 'The server did not answer.', tone: 'bad' })
  })

  test('a conflict and a stale pin are never drawn as "Saved"', () => {
    for (const state of [conflicted, stale]) {
      const status = saveStatus(state, 'en')
      expect(status.tone).toBe('warn')
      expect(status.text).toContain('Not saved')
    }
  })

  test('a save that landed while the reader kept typing reads as UNSAVED, not as Saved', () => {
    const typedDuring = run(dirty, { kind: 'save-started' }, { kind: 'edited' }, { kind: 'saved', mtimeMs: 2 })
    expect(saveStatus(typedDuring, 'en').text).toBe('Unsaved changes')
  })

  test('every sentence is localized, and the two languages differ', () => {
    for (const state of [dirty, saving, saved, conflicted, stale]) {
      expect(saveStatus(state, 'en').text).not.toBe(saveStatus(state, 'pt').text)
    }
  })

  test('once autosave has GIVEN UP it says so, and names the way out', () => {
    let state = dirty
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(state, { kind: 'save-started' }, { kind: 'save-failed', text: 'This file is read-only.', failure: 'refused' })
    }
    const told = saveStatus(state, 'en', true)
    expect(told.tone).toBe('bad')
    expect(told.text).toContain('This file is read-only.')   // the server's own sentence survives
    expect(told.text).toContain('Autosave')
    expect(told.text).toContain('Save')                      // the manual retry is named
    expect(saveStatus(state, 'pt', true).text).toContain('automático')
  })

  /** Three consecutive REFUSALS — the bound's own case — leaving autosave given up. */
  function gaveUp(from: SaveState = dirty): SaveState {
    let state = from
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(
        state,
        { kind: 'save-started' },
        { kind: 'save-failed', text: 'This file cannot be written.', failure: 'refused' },
      )
    }
    return state
  }

  test('A KEYSTROKE MAY NOT ERASE IT — the sentence lasts exactly as long as the gate is shut', () => {
    // The fact belongs to the TRIGGER, not to any one write, and `phaseAfterEdit` clears the failure
    // NOTICE on every edit (rightly — that sentence described text the buffer has moved past) while
    // `failedStreak` survives it. Said only in the `failed` arm, it was therefore erased by the very
    // next keystroke, and the common path — somebody who keeps typing into a read-only file — ended
    // with the autosave switch visibly ON, a dim "Unsaved changes", and nothing saving, forever.
    const stopped = gaveUp()
    const typed = run(stopped, { kind: 'edited' }, { kind: 'edited' })

    expect(saveStatus(stopped, 'en', true).text).toContain('Autosave has stopped trying')
    expect(saveStatus(typed, 'en', true).text).toContain('Autosave has stopped trying')
    expect(saveStatus(typed, 'en', true).text).toContain('Save')      // the way out is still named
    expect(saveStatus(typed, 'en', true).tone).toBe('bad')            // never the dim reassuring one
    expect(saveStatus(typed, 'pt', true).text).toContain('automático')
    // …and what it says agrees with what the gate does: both outlive the keystroke.
    expect(saveGate(typed, 'auto')).toEqual({ allowed: false, why: 'autosave-stopped' })
  })

  test('a conflict RESOLVED after a failure streak reaches it by the other route, and is told too', () => {
    // `take-disk` (and `keep-mine`) move the pin and clear nothing else: the streak survives them, so
    // a person who adopts the disk version and carries on typing sits in exactly the same silent
    // state by a second route. The sentence is phase-independent, so it covers this one too.
    const resolved = run(
      gaveUp(),
      { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 },
      { kind: 'take-disk' },
      { kind: 'edited' },
    )
    expect(resolved.phase.kind).toBe('idle')
    expect(autosaveStopped(resolved)).toBe(true)
    expect(saveStatus(resolved, 'en', true).text).toContain('Autosave has stopped trying')
    expect(saveGate(resolved, 'auto')).toEqual({ allowed: false, why: 'autosave-stopped' })
  })

  test('nothing to save means nothing to warn about — a clean buffer is not told autosave stopped', () => {
    // The one thing that clears the streak is a write that LANDED, which also leaves the buffer
    // clean; and the sentence is about work sitting unsaved. With nothing unsaved there is nothing
    // for the reader to act on, and a warning that is always on screen is one nobody reads.
    const clean = run(gaveUp(), { kind: 'save-started' }, { kind: 'saved', mtimeMs: 9 })
    expect(autosaveStopped(clean)).toBe(false)
    expect(saveStatus(clean, 'en', true).text).not.toContain('Autosave')
  })

  test('it is not said over a write in flight, nor over a conflict — each names its own reason', () => {
    // `saving` may be about to land and clear the streak; a conflict has its own, more actionable
    // reason for autosave being paused, and the banner beside it already says so. Two explanations
    // of one pause is how a reader learns to read neither.
    const saving = run(gaveUp(), { kind: 'edited' }, { kind: 'save-started' })
    expect(saveStatus(saving, 'en', true).text).toBe('Saving…')
    const conflicted = run(saving, { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 })
    expect(saveStatus(conflicted, 'en', true).text).not.toContain('Autosave')
    expect(saveStatus(run(conflicted, { kind: 'dismiss-conflict' }), 'en', true).text)
      .not.toContain('Autosave')
  })

  test('a reader with autosave OFF is never told autosave stopped — it was never running', () => {
    let state = dirty
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(state, { kind: 'save-started' }, { kind: 'save-failed', text: 'This file is read-only.', failure: 'refused' })
    }
    expect(saveStatus(state, 'en', false).text).toBe('This file is read-only.')
    expect(saveStatus(state, 'en').text).toBe('This file is read-only.')
  })

  test('a single failure says nothing about autosave — it has not given up', () => {
    const once = run(dirty, { kind: 'save-started' }, { kind: 'save-failed', text: 'This file is read-only.', failure: 'refused' })
    expect(saveStatus(once, 'en', true).text).toBe('This file is read-only.')
  })
})

describe('saveButtonState', () => {
  const dirty = run(OPENED, { kind: 'edited' })

  test('pressable when there is something to write, and it names the shortcut on a desktop', () => {
    expect(saveButtonState(dirty, 'en', false)).toEqual({ enabled: true, title: 'Save (Ctrl+S)' })
  })

  test('a phone has no Ctrl key, so it is not offered one', () => {
    expect(saveButtonState(dirty, 'en', true)).toEqual({ enabled: true, title: 'Save' })
  })

  test('every refusal to write has its OWN sentence — a dead control explains itself', () => {
    const saving = run(dirty, { kind: 'save-started' })
    const conflicted = run(saving, { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 })
    const titles = [OPENED, saving, conflicted].map(s => saveButtonState(s, 'en', false).title)
    expect(new Set(titles).size).toBe(3)
    expect(titles.every(t => t.length > 0)).toBe(true)
    expect([OPENED, saving, conflicted].map(s => saveButtonState(s, 'en', false).enabled))
      .toEqual([false, false, false])
  })

  test('a save that keeps failing keeps the button LIVE — the manual retry is the way back', () => {
    let state = dirty
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(state, { kind: 'save-started' }, { kind: 'save-failed', text: 'read-only', failure: 'refused' })
    }
    expect(saveButtonState(state, 'en', false).enabled).toBe(true)
  })

  test('a STALE pin keeps the button live — pressing it re-asks the question', () => {
    const stale = run(
      dirty, { kind: 'save-started' },
      { kind: 'conflicted', diskContent: 'x', diskMtimeMs: 2 }, { kind: 'dismiss-conflict' },
    )
    const button = saveButtonState(stale, 'en', false)
    expect(button.enabled).toBe(true)
    expect(button.title).toContain('changed on disk')
  })
})

// --- Monaco’s own decisions ----------------------------------------------------------------------

describe('monacoThemeFor', () => {
  test('reads the one place the app records its theme — and it is THIS product\u2019s theme', () => {
    // Not `vs` / `vs-dark`: the editor wears `lib/monacoTheme.ts`, derived from this dashboard\u2019s
    // own tokens. `monacoTheme.test.ts` owns the theme itself; what is asserted here is the wiring.
    expect(monacoThemeFor('light')).toBe(AGENTISTICS_THEME_NAME.light)
    expect(monacoThemeFor('dark')).toBe(AGENTISTICS_THEME_NAME.dark)
    expect(monacoThemeFor('dark')).not.toBe('vs-dark')
  })

  test('an absent attribute is the theme this app ships with, not a light editor on a dark page', () => {
    expect(monacoThemeFor(null)).toBe(AGENTISTICS_THEME_NAME.dark)
    expect(monacoThemeFor('')).toBe(AGENTISTICS_THEME_NAME.dark)
  })
})

describe('monacoOptions — the narrow-column decisions, pinned', () => {
  const phone = monacoOptions({ isMobile: true, theme: AGENTISTICS_THEME_NAME.dark })
  const desk = monacoOptions({ isMobile: false, theme: AGENTISTICS_THEME_NAME.light })

  test('word wrap is on at EVERY width — this editor never gets a window’s width', () => {
    expect(phone.wordWrap).toBe('on')
    expect(desk.wordWrap).toBe('on')
    expect(phone.scrollbar?.horizontal).toBe('hidden')
  })

  test('line numbers survive the phone — they are how a searched line is confirmed', () => {
    expect(phone.lineNumbers).not.toBe('off')
    expect((phone.lineNumbersMinChars ?? 0) > 0).toBe(true)
  })

  test('what the phone gives up is the gutter furniture, not the text', () => {
    expect(phone.folding).toBe(false)
    expect(desk.folding).toBe(true)
    expect(phone.overviewRulerLanes).toBe(0)
    expect(phone.contextmenu).toBe(false)
    expect(phone.quickSuggestions).toBe(false)
    expect((phone.fontSize ?? 0) >= 14).toBe(true)
  })

  test('no minimap anywhere, and the theme is the one it was given', () => {
    expect(phone.minimap?.enabled).toBe(false)
    expect(desk.minimap?.enabled).toBe(false)
    expect(desk.theme).toBe(AGENTISTICS_THEME_NAME.light)
    expect(phone.theme).toBe(AGENTISTICS_THEME_NAME.dark)
  })
})

// --- the strip, the banner and the question, as markup -------------------------------------------

const DIRTY = run(OPENED, { kind: 'edited' })
const SAVING = run(DIRTY, { kind: 'save-started' })
const CONFLICTED = run(SAVING, { kind: 'conflicted', diskContent: 'theirs', diskMtimeMs: 5000 })

function strip(
  state: SaveState, lang: 'pt' | 'en' = 'en', isMobile = false, autosave = false,
): string {
  return renderToStaticMarkup(
    <RepoSaveStrip
      state={state} lang={lang} isMobile={isMobile} autosave={autosave} onSave={noop}
    />,
  )
}

describe('the save strip', () => {
  test('a dirty buffer is VISIBLY dirty, and a clean one is not', () => {
    expect(strip(DIRTY)).toContain('data-dirty="true"')
    expect(strip(OPENED)).toContain('data-dirty="false"')
  })

  test('the status is announced rather than left for the eye to find', () => {
    expect(strip(DIRTY)).toContain('role="status"')
    expect(strip(DIRTY)).toContain('Unsaved changes')
  })

  test('nothing to save means a disabled button that says why', () => {
    const html = strip(OPENED)
    expect(html).toContain('disabled=""')
    expect(html).toContain('matches the version on disk')
  })

  test('something to save means a live button naming the shortcut', () => {
    const html = strip(DIRTY)
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('Ctrl+S')
  })

  test('a save in flight says so and cannot be pressed again', () => {
    const html = strip(SAVING)
    expect(html).toContain('Saving')
    expect(html).toContain('disabled=""')
  })

  test('a 44px target on a phone, dense on a desktop', () => {
    expect(strip(DIRTY, 'en', true)).toContain('min-height:44px')
    expect(strip(DIRTY, 'en', false)).not.toContain('min-height:44px')
  })

  test('localized, and the two languages differ', () => {
    for (const state of [OPENED, DIRTY, SAVING, CONFLICTED]) {
      expect(strip(state, 'en')).not.toBe(strip(state, 'pt'))
    }
  })

  test('a stopped autosave is SAID on the strip, so it never merely looks like it is still trying', () => {
    let state = DIRTY
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(state, { kind: 'save-started' }, { kind: 'save-failed', text: 'read-only', failure: 'refused' })
    }
    expect(strip(state, 'en', false, true)).toContain('Autosave')
    expect(strip(state, 'en', false, false)).not.toContain('Autosave')
  })

  test('and it SURVIVES typing — the strip never falls back to a dim "Unsaved changes"', () => {
    // The reader's own reproduction: the sentence was on the strip, they typed one character, and it
    // became "Unsaved changes" in the dim tone while autosave stayed off and nothing was saving.
    let state = DIRTY
    for (let i = 0; i < AUTOSAVE_FAILURE_LIMIT; i++) {
      state = run(
        state,
        { kind: 'save-started' },
        { kind: 'save-failed', text: 'This file cannot be written.', failure: 'refused' },
      )
    }
    const typed = run(state, { kind: 'edited' })
    expect(strip(typed, 'en', false, true)).toContain('Autosave has stopped trying')
    expect(strip(typed, 'en', false, true)).not.toContain('>Unsaved changes<')
    expect(strip(typed, 'pt', false, true)).toContain('automático')
    // With autosave off there is nothing to say: it was never running.
    expect(strip(typed, 'en', false, false)).not.toContain('Autosave')
  })

  test('the strip carries no toggle for a plain code file', () => {
    // `toggle` is `undefined` by default — every assertion above already renders without it, which
    // is the point: this is what proves the toggle is additive rather than a rewritten strip.
    expect(strip(DIRTY)).not.toContain('role="tablist"')
  })

  test('a toggle handed to the strip renders alongside the existing controls', () => {
    const html = renderToStaticMarkup(
      <RepoSaveStrip
        state={DIRTY} lang="en" isMobile={false} autosave={false} onSave={noop}
        toggle={<ViewModeToggle mode="code" isMobile={false} lang="en" onChange={noop} />}
      />,
    )
    expect(html).toContain('role="tablist"')
    expect(html).toContain('Ctrl+S')
  })
})

describe('renderableDocKind — which files the toggle appears on', () => {
  test('markdown, by extension', () => {
    for (const p of ['README.md', 'docs/guide.mdx', 'notes.markdown', 'AGENTS.md', 'SKILL.md']) {
      expect(renderableDocKind(p), p).toBe('markdown')
    }
  })
  test('markdown, by the two common extensionless names', () => {
    expect(renderableDocKind('README')).toBe('markdown')
    expect(renderableDocKind('CHANGELOG')).toBe('markdown')
    expect(renderableDocKind('readme')).toBe('markdown')
  })
  test('mermaid, by extension', () => {
    expect(renderableDocKind('diagram.mmd')).toBe('mermaid')
    expect(renderableDocKind('flow.mermaid')).toBe('mermaid')
  })
  test('everything else has no preview at all', () => {
    for (const p of ['index.ts', 'Dockerfile', 'notes.txt', 'LICENSE', 'package.json']) {
      expect(renderableDocKind(p), p).toBeNull()
    }
  })
})

describe('the preview mode is remembered per doc kind, and survives a hostile localStorage', () => {
  function memory(): Storage {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => map.clear(),
      key: () => null,
      get length() { return map.size },
    } as unknown as Storage
  }

  test('absent reads as code', () => {
    expect(readPreviewMode('markdown', memory())).toBe('code')
  })

  test('round-trips, and the two kinds do not share a slot', () => {
    const s = memory()
    writePreviewMode('markdown', 'preview', s)
    expect(readPreviewMode('markdown', s)).toBe('preview')
    expect(readPreviewMode('mermaid', s)).toBe('code')
    writePreviewMode('mermaid', 'preview', s)
    expect(readPreviewMode('markdown', s)).toBe('preview')
    expect(readPreviewMode('mermaid', s)).toBe('preview')
  })

  test('a browser blocking site data costs the memory, never the toggle', () => {
    const hostile = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    } as unknown as Storage
    expect(() => readPreviewMode('markdown', hostile)).not.toThrow()
    expect(readPreviewMode('markdown', hostile)).toBe('code')
    expect(() => writePreviewMode('markdown', 'preview', hostile)).not.toThrow()
  })
})

describe('the stale banner', () => {
  function banner(autosave: boolean, lang: 'pt' | 'en' = 'en', isMobile = false): string {
    return renderToStaticMarkup(
      <RepoStaleBanner
        lang={lang} isMobile={isMobile} autosave={autosave} onResave={noop} onDiscard={noop}
      />,
    )
  }

  test('it states the fact and keeps BOTH resolving actions one press away', () => {
    const html = banner(false)
    expect(html).toContain('changed on disk')
    expect(html).toContain('Nothing has been saved')
    expect(html).toContain('Save over it')
    expect(html).toContain('Discard and reload')
  })

  test('a reader who trusts autosave is TOLD it has stopped — and not told so when it is off', () => {
    expect(banner(true)).toContain('Autosave is paused')
    expect(banner(false)).not.toContain('Autosave is paused')
    expect(banner(true, 'pt')).toContain('automático está pausado')
  })

  test('44px targets on a phone', () => {
    expect(banner(true, 'en', true)).toContain('min-height:44px')
    expect(banner(true, 'en', false)).not.toContain('min-height:44px')
  })

  test('ONE live region while stale — the strip is it, so the same fact is not announced twice', () => {
    // The strip is always there and already carries "Not saved — this file changed on disk."; the
    // banner says the same thing in more words and adds the two buttons. Two `role="status"` regions
    // mounted at once is one fact read out twice, in two wordings.
    const stale = run(CONFLICTED, { kind: 'dismiss-conflict' })
    const both = strip(stale) + banner(true)
    expect((both.match(/role="status"/g) ?? []).length).toBe(1)
    expect(banner(true)).not.toContain('role="status"')
    expect(strip(stale)).toContain('role="status"')
  })
})

describe('the conflict question', () => {
  function prompt(lang: 'pt' | 'en' = 'en', isMobile = false, autosave = false): string {
    return renderToStaticMarkup(
      <RepoConflictPrompt
        path="packages/web/src/lib/repoApi.ts"
        lang={lang}
        isMobile={isMobile}
        autosave={autosave}
        onResave={noop}
        onDiscard={noop}
        onDismiss={noop}
      />,
    )
  }

  test('it is a dialog, and it names the file it is about', () => {
    const html = prompt()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('packages/web/src/lib/repoApi.ts')
  })

  test('it says plainly that NOTHING was saved', () => {
    expect(prompt()).toContain('Nothing was saved')
    expect(prompt('pt')).toContain('Nada foi salvo')
  })

  test('THREE answers, each naming what it costs', () => {
    const html = prompt()
    expect(html).toContain('Save over it')
    expect(html).toContain('replaces the version that is on disk now')
    expect(html).toContain('Discard and reload')
    expect(html).toContain('Throws away what you typed')
    expect(html).toContain('Keep editing')
    expect(html).toContain('Decide later')
  })

  test('no answer is pre-selected or dressed as the safe one — both of them lose something', () => {
    const html = prompt()
    expect(html).not.toContain('autofocus')
    // The three choices are the same control, so none of them reads as the default.
    expect((html.match(/background:var\(--bg-elevated\)/g) ?? []).length).toBe(3)
  })

  test('"keep editing" mentions the paused autosave only when autosave is actually on', () => {
    expect(prompt('en', false, true)).toContain('autosave stays paused')
    expect(prompt('en', false, false)).not.toContain('autosave stays paused')
  })

  test('44px targets on a phone, and the dialog contains its own overscroll', () => {
    expect(prompt('en', true)).toContain('min-height:44px')
    expect(prompt('en')).toContain('overscroll-behavior:contain')
  })

  test('localized, and the two languages differ', () => {
    expect(prompt('en')).not.toBe(prompt('pt'))
  })

  test('a dialog claiming to be MODAL contains focus: it can hold it itself', () => {
    // `aria-modal="true"` promises that nothing behind the dialog is reachable. Monaco is behind it
    // and is keyboard-reachable by construction, so the dialog takes focus on open (the CONTAINER,
    // not an answer — no answer may be pre-selected) and Tab is wrapped inside it.
    const html = prompt()
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).not.toContain('autofocus')
  })
})

describe('focusTrapTarget — the Tab wrap a modal dialog owes its keyboard users', () => {
  test('Tab past the last control returns to the first, and back past the first to the last', () => {
    expect(focusTrapTarget(3, 2, false)).toBe(0)
    expect(focusTrapTarget(3, 0, true)).toBe(2)
  })

  test('it steps one at a time in between', () => {
    expect(focusTrapTarget(3, 0, false)).toBe(1)
    expect(focusTrapTarget(3, 1, false)).toBe(2)
    expect(focusTrapTarget(3, 2, true)).toBe(1)
  })

  test('from the container itself — focus nowhere in particular — Tab enters at the right end', () => {
    expect(focusTrapTarget(3, -1, false)).toBe(0)
    expect(focusTrapTarget(3, -1, true)).toBe(2)
  })

  test('a dialog with nothing focusable in it traps nothing, rather than focusing index 0', () => {
    expect(focusTrapTarget(0, -1, false)).toBeNull()
    expect(focusTrapTarget(0, 0, true)).toBeNull()
  })

  test('one control keeps the focus it has', () => {
    expect(focusTrapTarget(1, 0, false)).toBe(0)
    expect(focusTrapTarget(1, 0, true)).toBe(0)
  })
})

// --- THE GUARANTEE, against a fake disk that behaves exactly like the server ----------------------

/**
 * The server's own contract, in eight lines: a write lands only if the pin it carries still matches
 * the file's mtime; otherwise NOTHING is written and the refusal carries the current content and
 * mtime. Asserting against `disk` afterwards is what makes these tests about the file rather than
 * about the UI's opinion of it.
 */
function fakeDisk(content: string, mtimeMs: number) {
  const disk = { content, mtimeMs }
  /**
   * A refusal that has NOTHING to do with the pin — a read-only file, a path that left the session's
   * folder, a `not-a-file`. It is the case no retry can resolve, which is what the autosave loop has
   * to be bounded against.
   */
  let refusal: WriteFileResult | null = null
  return {
    disk,
    /** Somebody else — an agent, a terminal — writes to the file. */
    writtenByAnother(next: string) {
      disk.content = next
      disk.mtimeMs += 1000
    },
    refusesEveryWrite(because: WriteFileResult) { refusal = because },
    acceptsWritesAgain() { refusal = null },
    write(pin: number, next: string): WriteFileResult {
      if (refusal !== null) return refusal
      if (pin !== disk.mtimeMs) {
        return {
          ok: false, failure: 'refused', status: 409, reason: 'conflict',
          message: 'This file changed on disk.', content: disk.content, mtimeMs: disk.mtimeMs,
        }
      }
      disk.content = next
      disk.mtimeMs += 1000
      return { ok: true, mtimeMs: disk.mtimeMs }
    },
  }
}

/**
 * The component's own wiring, minus React: every save — Ctrl+S or the autosave timer — goes through
 * `saveGate`, and the result becomes an event through `saveEventFor`. Nothing here is a
 * test-only shortcut; these are the same four functions `RepoFileEditor` calls, in the same order.
 */
function driver(initialContent: string, initialMtime: number) {
  const fake = fakeDisk(initialContent, initialMtime)
  let state = initialSaveState(initialMtime)
  let buffer = initialContent
  /** `editorRef.current !== null && !writingRef.current` — the two guards `writeNow` opens with. */
  let writable = true
  const attempts: number[] = []

  /**
   * `writeNow`, with the ordering the guarantee rests on: the GUARD first, and only then the pin move
   * the caller asked for (`keep-mine`). Dispatching that before knowing the write goes out is how the
   * component would end up pinned to the disk mtime with a dirty buffer and NO open question — the
   * one state in which the next save, autosave included, silently overwrites somebody else's change.
   */
  const write = (pin: number, before: SaveEvent | null = null): boolean => {
    if (!writable) return false
    if (before !== null) state = nextSaveState(state, before)
    attempts.push(pin)
    state = nextSaveState(state, { kind: 'save-started' })
    state = nextSaveState(state, saveEventFor(fake.write(pin, buffer), 'en'))
    return true
  }

  return {
    fake,
    attempts,
    get state() { return state },
    get buffer() { return buffer },
    type(text: string) {
      buffer = text
      state = nextSaveState(state, { kind: 'edited' })
    },
    /** The editor is gone (unmounted) or a write is already out: `writeNow` returns without writing. */
    detachEditor() { writable = false },
    save(trigger: 'explicit' | 'auto') {
      const gate = saveGate(state, trigger)
      if (!gate.allowed) {
        if (gate.why === 'stale' && trigger === 'explicit') {
          state = nextSaveState(state, { kind: 'prompt-conflict' })
        }
        return
      }
      write(gate.mtimeMs)
    },
    resaveOverDisk() {
      const version = diskVersionOf(state.phase)
      if (version === null) return
      write(version.diskMtimeMs, { kind: 'keep-mine' })
    },
    discardAndReload() {
      const version = diskVersionOf(state.phase)
      if (version === null) return
      buffer = version.diskContent
      state = nextSaveState(state, { kind: 'take-disk' })
    },
    keepEditing() { state = nextSaveState(state, { kind: 'dismiss-conflict' }) },
  }
}

describe('a save never silently overwrites somebody else’s change', () => {
  test('the ordinary case still works: edit, save, the file holds what was typed', () => {
    const d = driver('one\n', 1000)
    d.type('one\ntwo\n')
    d.save('explicit')
    expect(d.fake.disk.content).toBe('one\ntwo\n')
    expect(d.state.mtimeMs).toBe(d.fake.disk.mtimeMs)
    expect(isDirty(d.state)).toBe(false)
  })

  test('an agent writing between the read and the save is NOT overwritten — the file keeps its change', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')

    expect(d.fake.disk.content).toBe('theirs\n')          // nothing was written
    expect(d.state.phase.kind).toBe('conflict')            // and the person is being asked
    expect(diskVersionOf(d.state.phase)?.diskContent).toBe('theirs\n')
    expect(isDirty(d.state)).toBe(true)                    // their edit is still theirs to keep
  })

  test('AUTOSAVE cannot answer the question: it keeps refusing, and writes nothing', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('auto')                                          // the autosave timer fires, and conflicts
    expect(d.attempts.length).toBe(1)

    for (let i = 0; i < 20; i++) d.save('auto')             // every later tick, for as long as it sits
    expect(d.attempts.length).toBe(1)
    expect(d.fake.disk.content).toBe('theirs\n')
    expect(d.state.phase.kind).toBe('conflict')
  })

  test('an autosave tick cannot resolve it after "keep editing" either', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('auto')
    d.keepEditing()

    d.type('mine again\n')                                  // still editing, autosave still on
    for (let i = 0; i < 20; i++) d.save('auto')
    expect(d.attempts.length).toBe(1)
    expect(d.fake.disk.content).toBe('theirs\n')
    expect(d.state.phase.kind).toBe('stale')
  })

  test('an explicit Ctrl+S after "keep editing" re-asks rather than writing', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')
    d.keepEditing()

    d.save('explicit')
    expect(d.attempts.length).toBe(1)                       // no second write
    expect(d.state.phase.kind).toBe('conflict')             // the question, asked again
    expect(d.fake.disk.content).toBe('theirs\n')
  })

  test('"save over it" is the ONLY thing that overwrites, and it takes a person to press it', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')
    expect(d.fake.disk.content).toBe('theirs\n')

    d.resaveOverDisk()
    expect(d.fake.disk.content).toBe('mine\n')
    expect(d.state.phase.kind).toBe('saved')
    expect(d.state.mtimeMs).toBe(d.fake.disk.mtimeMs)
    expect(isDirty(d.state)).toBe(false)
  })

  test('a SECOND change arriving while the question is open conflicts again, rather than being lost', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')

    // The agent writes AGAIN while the dialog sits there, so the mtime the refusal reported is
    // itself already out of date.
    d.fake.writtenByAnother('theirs again\n')
    d.resaveOverDisk()

    expect(d.fake.disk.content).toBe('theirs again\n')      // still not overwritten
    expect(d.state.phase.kind).toBe('conflict')             // asked again, with the newer version
    expect(diskVersionOf(d.state.phase)?.diskContent).toBe('theirs again\n')

    // …and pressing it once more, now against the version it was actually shown, lands.
    d.resaveOverDisk()
    expect(d.fake.disk.content).toBe('mine\n')
    expect(d.state.phase.kind).toBe('saved')
  })

  test('"discard and reload" takes the other version, and the next save is clean against it', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')

    d.discardAndReload()
    expect(d.buffer).toBe('theirs\n')
    expect(isDirty(d.state)).toBe(false)
    expect(d.state.mtimeMs).toBe(d.fake.disk.mtimeMs)

    d.type('theirs\nplus mine\n')
    d.save('explicit')
    expect(d.fake.disk.content).toBe('theirs\nplus mine\n')
    expect(d.state.phase.kind).toBe('saved')
  })

  test('a save nobody asked for never happens: a clean buffer writes nothing, ever', () => {
    const d = driver('one\n', 1000)
    for (let i = 0; i < 10; i++) { d.save('auto'); d.save('explicit') }
    expect(d.attempts).toEqual([])
    expect(d.fake.disk.mtimeMs).toBe(1000)
  })

  test('the whole round trip: save over it, the agent writes AGAIN, and the next save still asks', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')
    d.resaveOverDisk()
    expect(d.fake.disk.content).toBe('mine\n')            // the person's deliberate overwrite landed
    expect(isDirty(d.state)).toBe(false)

    // A resolved conflict does not buy a free pass for the NEXT one: the agent writes again, on top
    // of the version that was just saved, and the following save is refused exactly as the first was.
    d.fake.writtenByAnother('theirs again\n')
    d.type('mine again\n')
    d.save('explicit')
    expect(d.fake.disk.content).toBe('theirs again\n')     // nothing written
    expect(d.state.phase.kind).toBe('conflict')
    expect(diskVersionOf(d.state.phase)?.diskContent).toBe('theirs again\n')

    // …and the person's second deliberate overwrite lands on the version they were shown.
    d.resaveOverDisk()
    expect(d.fake.disk.content).toBe('mine again\n')
    expect(d.state.phase.kind).toBe('saved')
    expect(d.state.mtimeMs).toBe(d.fake.disk.mtimeMs)
  })

  test('"save over it" that cannot write moves NOTHING — the question stays open', () => {
    // The silent-clobber state is: pinned to the disk mtime, buffer dirty, no open question. It is
    // reachable the moment `keep-mine` is dispatched by a path that then fails to write — so the pin
    // may only ever move together with the write that earns it.
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('explicit')
    expect(d.state.phase.kind).toBe('conflict')
    const pinned = d.state.mtimeMs

    d.detachEditor()
    d.resaveOverDisk()

    expect(d.attempts.length).toBe(1)                      // nothing was attempted
    expect(d.state.mtimeMs).toBe(pinned)                   // the pin did not move
    expect(d.state.phase.kind).toBe('conflict')            // the question is still being asked
    expect(diskVersionOf(d.state.phase)?.diskContent).toBe('theirs\n')
    expect(isDirty(d.state)).toBe(true)
    expect(d.fake.disk.content).toBe('theirs\n')

    // And the blind overwrite is still impossible from every automatic path.
    for (let i = 0; i < 20; i++) d.save('auto')
    expect(d.attempts.length).toBe(1)
    expect(d.fake.disk.content).toBe('theirs\n')
  })
})

describe('autosave gives up instead of retrying a refusal that cannot change', () => {
  const READ_ONLY: WriteFileResult = {
    ok: false, failure: 'refused', status: 403, reason: 'not-a-file',
    message: 'This file cannot be written.',
  }

  test('20 autosave ticks over a save-failed attempt a BOUNDED number of writes', () => {
    const d = driver('one\n', 1000)
    d.fake.refusesEveryWrite(READ_ONLY)
    d.type('mine\n')

    for (let i = 0; i < 20; i++) d.save('auto')

    expect(d.attempts.length).toBe(AUTOSAVE_FAILURE_LIMIT)
    expect(d.state.phase.kind).toBe('failed')
    expect(autosaveStopped(d.state)).toBe(true)
    expect(saveGate(d.state, 'auto')).toEqual({ allowed: false, why: 'autosave-stopped' })
  })

  test('typing between the ticks does not re-arm it — the PUT storm is bounded either way', () => {
    const d = driver('one\n', 1000)
    d.fake.refusesEveryWrite(READ_ONLY)
    for (let i = 0; i < 20; i++) { d.type(`mine ${i}\n`); d.save('auto') }
    expect(d.attempts.length).toBe(AUTOSAVE_FAILURE_LIMIT)
  })

  test('a MANUAL save still works afterwards, and a file that becomes writable again is saved', () => {
    const d = driver('one\n', 1000)
    d.fake.refusesEveryWrite(READ_ONLY)
    d.type('mine\n')
    for (let i = 0; i < 20; i++) d.save('auto')
    const gaveUp = d.attempts.length

    d.save('explicit')                                     // the person presses Save anyway
    expect(d.attempts.length).toBe(gaveUp + 1)
    expect(d.state.phase.kind).toBe('failed')

    d.fake.acceptsWritesAgain()                            // the file becomes writable again
    d.save('explicit')
    expect(d.fake.disk.content).toBe('mine\n')
    expect(isDirty(d.state)).toBe(false)
    expect(autosaveStopped(d.state)).toBe(false)           // …and autosave is armed again

    d.type('mine once more\n')
    d.save('auto')
    expect(d.fake.disk.content).toBe('mine once more\n')
  })

  test('a server that cannot be REACHED never trips the bound, and saves itself once it is back', () => {
    // The bound is against an answer that cannot change. Nothing answered here, and this is the one
    // failure that un-refuses itself — `agentop restart` is an ordinary act in this product — so
    // counting it would leave autosave off on every file that was open at the time, to be noticed and
    // undone by hand. The cost is a retry per debounce window while the server is down, with the
    // refusal's own sentence on the strip throughout; the benefit is the next line.
    const d = driver('one\n', 1000)
    d.fake.refusesEveryWrite({ ok: false, failure: 'unreachable', cause: 'network' })
    d.type('mine\n')

    for (let i = 0; i < 20; i++) d.save('auto')
    expect(d.attempts.length).toBe(20)
    expect(autosaveStopped(d.state)).toBe(false)
    expect(d.state.phase.kind).toBe('failed')

    d.fake.acceptsWritesAgain()                            // the server comes back
    d.save('auto')                                         // …and the buffer saves ITSELF
    expect(d.fake.disk.content).toBe('mine\n')
    expect(isDirty(d.state)).toBe(false)
  })

  test('a CONFLICT never counts toward giving up — that question is still a person’s to answer', () => {
    const d = driver('one\n', 1000)
    d.type('mine\n')
    d.fake.writtenByAnother('theirs\n')
    d.save('auto')
    expect(autosaveStopped(d.state)).toBe(false)
    expect(saveGate(d.state, 'auto')).toEqual({ allowed: false, why: 'conflict-open' })
  })
})

// --- the wiring no render can reach, pinned over the module's own source --------------------------

/**
 * Three facts live in the React wiring rather than in a pure function, and this repo has no jsdom to
 * exercise them (`ConnectionCard.test.tsx`'s note). Greps over the module's own source are what the
 * repo already does where a rule cannot otherwise be held (`backup-plan.test.ts`,
 * `shell-isolation.test.ts`): they fail the build when the ordering is undone in a refactor, which
 * is the whole job here.
 */
/**
 * The module's own source with every comment removed. A rule a COMMENT can satisfy is not a rule —
 * the same reason `shell-isolation.test.ts` strips them before grepping — and it is what makes the
 * ordering below assertable rather than merely mentioned.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The read effect's own body, comments stripped. Anchored on its DEPENDENCY LIST rather than on the
 * section comment above it, so the slice survives a comment being reworded — and on the `useEffect`
 * that opens it, so nothing from the effects around it can be read as part of this one.
 *
 * The dependency list is deliberately `[sessionId, path]` alone — `retargetFrom` is EXCLUDED on
 * purpose (see `RepoFileEditor.tsx`'s own note by `priorPathRef`): including it is exactly what made
 * C1 possible, since a later render where `retargetFrom` alone flips back to `undefined` would
 * re-trigger this effect down the ordinary reset-and-reread branch.
 */
function readFileEffect(source: string): string {
  const end = source.indexOf('}, [sessionId, path])')
  expect(end).toBeGreaterThan(0)
  const start = source.lastIndexOf('useEffect(', end)
  expect(start).toBeGreaterThanOrEqual(0)
  return withoutComments(source.slice(start, end))
}

describe('the save wiring, asserted over the source', () => {
  const src = readFileSync(join(import.meta.dir, 'RepoFileEditor.tsx'), 'utf8')

  test('the PIN is moved in exactly one place: inside the write that earns it', () => {
    // `resaveOverDisk` used to dispatch `keep-mine` and THEN call `writeNow`, whose own guards can
    // return without writing — leaving the pin ahead of the write.
    // `includes` rather than `not.toContain`, so a failure prints `true` instead of a 40 KB module.
    expect(src.includes("dispatch({ kind: 'keep-mine' })")).toBe(false)
    expect(src).toContain("writeNow(disk.diskMtimeMs, { kind: 'keep-mine' })")
  })

  test('opening another file resets the reducer before the read, whatever the read turns out to be', () => {
    // A bare `toContain` over the whole module is satisfied by a COMMENT: deleting the dispatch and
    // leaving `// TODO: restore dispatch({ kind: 'reset' }) here` in its place kept this file green
    // while the PNG dirty-latch bug was fully back. Its sibling above already learned that lesson
    // (`includes(...).toBe(false)`, matched on the whole expression); this one had not.
    // So the READ EFFECT's own body is sliced out, its comments are stripped, and the two calls are
    // compared BY INDEX — the reset has to come before the read, in code that runs.
    const effect = readFileEffect(src)
    const reset = effect.indexOf("dispatch({ kind: 'reset' })")
    const read = effect.indexOf('readRepoFile(')
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(read).toBeGreaterThan(reset)
  })

  test('a RETARGET (a rename of an already-open file) skips the re-read and re-reset, before either runs', () => {
    // A STRUCTURAL companion to the `loadStateForRender`/`isMidRetarget` behavioural tests above —
    // it is not, on its own, proof that the buffer survives (that was exactly the two tests the
    // review found satisfied by a comment: C1 shipped with this ordering intact and the bug anyway,
    // because the loss happened in `load`'s derivation, not in this effect's branch order). Kept as a
    // regression guard on the branch itself: matched BY INDEX against the same two calls the previous
    // test anchors on, so a refactor that moved the guard clause BELOW the reset (silently re-reading
    // every retarget from disk) fails this test even though the guard clause still exists somewhere
    // in the function — and on the actual predicate, so inlining the check back by hand instead of
    // calling `isMidRetarget` is caught too.
    const effect = readFileEffect(src)
    const guard = effect.indexOf('isMidRetarget(retargetFrom, editorRef.current !== null)')
    const reset = effect.indexOf("dispatch({ kind: 'reset' })")
    const read = effect.indexOf('readRepoFile(')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(reset)
    expect(reset).toBeLessThan(read)
  })

  test('the MOUNT effect depends on load.kind alone — `path` is absent, which is the whole reason a retarget does not tear down the model', () => {
    // The mount effect is the one whose cleanup DISPOSES the live Monaco model and editor. Were
    // `path` back in its dependency array, a rename would re-trigger it (React runs the OUTGOING
    // cleanup unconditionally on any dependency change, before the new effect body gets a say) and
    // dispose the very instance the retarget skip above exists to keep alive. THIS ALONE is not the
    // proof C1's fix works — `load.kind` staying 'ready' throughout a retarget is what
    // `loadStateForRender`'s behavioural tests above pin — but it is a real, independent invariant:
    // even with `load.kind` correctly staying 'ready', re-adding `path` here would tear the editor
    // down on every retarget regardless.
    expect(src).toContain('}, [load.kind])')
    // And the model itself is created from the LATEST path via the ref, never the closed-over
    // `path` — the one a removed dependency would otherwise leave stale forever.
    expect(src).toContain('languageForPath(argsRef.current.path)')
  })

  test('the conflict prompt keeps Escape to itself, and nothing behind it is reachable', () => {
    // Sliced to the Escape handler's own body, and matched on the whole expression rather than the
    // word: `stopPropagation` and `inert` both appear in this module's comments, so a bare grep for
    // either is a test a comment can pass.
    const onKey = src.slice(
      src.indexOf('const onKey ='), src.indexOf("document.addEventListener('keydown'"),
    )
    expect(onKey).toContain('Escape')
    expect(onKey).toContain('ev.stopPropagation()')
    // `includes` again, for its neighbour's reason: a failure here prints `false`, not 40 KB of module.
    // The condition grew a second clause (the preview toggle also hides Monaco with `inert`), so this
    // now matches the WHOLE expression rather than the old exact string — still real code, not a
    // comment: `inert=` is a JSX attribute, and this module's comments never write JSX.
    expect(src.includes("inert={save.phase.kind === 'conflict' || viewMode === 'preview'}")).toBe(true)
  })

  // M6: the preview region used to carry NO `inert` of its own — reachable behind the conflict
  // prompt exactly when the Monaco host (correctly `inert` in that same state) was not showing.
  test('the preview region is inert while the conflict prompt is open too (M6)', () => {
    expect(src.includes("inert={save.phase.kind === 'conflict'}")).toBe(true)
  })

  // M6: Ctrl+S in preview mode used to have nowhere to land — Monaco's own command only fires while
  // MONACO is focused, and Monaco is `inert` throughout preview mode.
  test('the preview region has its own Ctrl+S, since Monaco cannot be focused to receive one (M6)', () => {
    expect(src).toContain("ev.key.toLowerCase() !== 's'")
    expect(src.includes("requestSaveRef.current('explicit')")).toBe(true)
  })

  // M2: `discardAndReload` used to leave the preview showing the DISCARDED buffer — the debounce
  // that would otherwise refresh it is deliberately skipped for this programmatic `setValue`
  // (`applyingDiskRef`), so nothing else updated `previewText` for this one path.
  test('discarding and reloading refreshes the preview immediately, not just the model (M2)', () => {
    const fn = src.slice(src.indexOf('const discardAndReload ='), src.indexOf('const handleViewModeChange ='))
    expect(fn).toContain('setPreviewText(disk.diskContent)')
    // Ordered after the model is actually replaced — a preview refreshed from the STALE
    // `contentRef`/model would show the buffer this discard is meant to replace.
    expect(fn.indexOf('editor.setValue(disk.diskContent)')).toBeLessThan(fn.indexOf('setPreviewText(disk.diskContent)'))
  })

  // I3: the JSON diagnostics relaxation has to run before the FIRST model is ever created, or the
  // very first tsconfig.json/*.jsonc opened this session still shows the old squiggles until a
  // second file triggers it.
  test('JSON diagnostics are configured before the first model is created (I3)', () => {
    const mount = src.slice(src.indexOf("void import('../../lib/monacoSetup')"), src.indexOf('setMounted(n => n + 1)'))
    expect(mount).toContain('configureJsonDiagnostics(monaco)')
    expect(mount.indexOf('configureJsonDiagnostics(monaco)'))
      .toBeLessThan(mount.indexOf('monaco.editor.createModel('))
  })
})
