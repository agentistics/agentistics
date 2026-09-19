import { describe, expect, test, test as it } from 'bun:test'
import { isImagePath, openComposerLightbox, previousPersonTurnMs, splitImageAttachments, splitImageMarkers, resolveMarkerPaths, SEND_WINDOW_MS } from './attachmentPreview'
import type { AttachmentMessage } from '@agentistics/core'

describe('isImagePath', () => {
  test('recognises known image extensions, case-insensitively', () => {
    expect(isImagePath('/tmp/x/screenshot.PNG')).toBe(true)
    expect(isImagePath('/tmp/x/photo.jpeg')).toBe(true)
  })
  test('rejects a non-image extension and a bare name', () => {
    expect(isImagePath('/tmp/x/notes.txt')).toBe(false)
    expect(isImagePath('noext')).toBe(false)
  })
})

describe('splitImageAttachments', () => {
  test('pulls a bare attachment path out of the text', () => {
    const out = splitImageAttachments('/home/me/.agentistics/attachments/a1-shot.png\nlook at this')
    expect(out.images).toEqual(['/home/me/.agentistics/attachments/a1-shot.png'])
    expect(out.text).toBe('look at this')
  })

  test('leaves prose mentioning a filename alone — it has spaces around it', () => {
    const out = splitImageAttachments('see diagram.png in the repo root')
    expect(out.images).toEqual([])
    expect(out.text).toBe('see diagram.png in the repo root')
  })

  test('pulls several attachments, keeping their order', () => {
    const out = splitImageAttachments('/a/one.png\n/a/two.jpg\nboth attached')
    expect(out.images).toEqual(['/a/one.png', '/a/two.jpg'])
    expect(out.text).toBe('both attached')
  })

  test('a message that is ONLY attachments leaves empty text, not a blank line', () => {
    const out = splitImageAttachments('/a/one.png')
    expect(out.images).toEqual(['/a/one.png'])
    expect(out.text).toBe('')
  })

  test('a non-image bare path is left as ordinary text', () => {
    const out = splitImageAttachments('/a/notes.txt\nhere it is')
    expect(out.images).toEqual([])
    expect(out.text).toBe('/a/notes.txt\nhere it is')
  })
})

describe('splitImageMarkers', () => {
  test('a marker jammed against the first word is taken off it', () => {
  expect(splitImageMarkers('[Image #22]os itens nao estao indo'))
    .toEqual({ markers: [22], text: 'os itens nao estao indo' })
})

test('a merged turn carries the whole run of markers at the front', () => {
  expect(splitImageMarkers('[Image #4] [Image #5] [Image #6]1. a visao geral'))
    .toEqual({ markers: [4, 5, 6], text: '1. a visao geral' })
})

test('a marker further down is left where it is — somebody wrote it', () => {
  const msg = 'the harness writes [Image #4] where the image was'
  expect(splitImageMarkers(msg)).toEqual({ markers: [], text: msg })
})

test('text with no marker is returned untouched, whitespace included', () => {
  expect(splitImageMarkers('  olha esse print\n')).toEqual({ markers: [], text: '  olha esse print\n' })
})

test('a turn that is nothing but markers keeps no text', () => {
  expect(splitImageMarkers('[Image #1] [Image #2]')).toEqual({ markers: [1, 2], text: '' })
})
})

// --- a marker that CAN find its file ----------------------------------------

const T = Date.UTC(2026, 8, 7, 20, 0, 0)
const snd = (atMs: number, path: string) => ({ sessionId: 's', atMs, path })

test('three markers and three sends resolve, in the order they were sent', () => {
  expect(resolveMarkerPaths({
    markers: [4, 5, 6], turnAtMs: T,
    sends: [snd(T - 3000, '/a/c.png'), snd(T - 9000, '/a/a.png'), snd(T - 6000, '/a/b.png')],
  })).toEqual(['/a/a.png', '/a/b.png', '/a/c.png'])
})

// Every case below answers null: a wrong thumbnail is false and convincing, a chip is merely useless.
test('one too few, or one too many, resolves nothing', () => {
  expect(resolveMarkerPaths({ markers: [1, 2], turnAtMs: T, sends: [snd(T - 1, '/a/a.png')] })).toBe(null)
  expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [snd(T - 1, '/a/a.png'), snd(T - 2, '/a/b.png')] })).toBe(null)
})

test('a send after the turn, or older than the window, is not this turn’s', () => {
  expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [snd(T + 1, '/a/a.png')] })).toBe(null)
  expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [snd(T - SEND_WINDOW_MS - 1, '/a/a.png')] })).toBe(null)
  expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [snd(T - SEND_WINDOW_MS, '/a/a.png')] })).toEqual(['/a/a.png'])
})

test('no markers is not a question, and markers with no record resolve nothing', () => {
  expect(resolveMarkerPaths({ markers: [], turnAtMs: T, sends: [snd(T - 1, '/a/a.png')] })).toBe(null)
  expect(resolveMarkerPaths({ markers: [4, 5], turnAtMs: T, sends: [] })).toBe(null)
})

test('the ordinals are a count, never an index', () => {
  const s = [snd(T - 2, '/a/a.png'), snd(T - 1, '/a/b.png')]
  expect(resolveMarkerPaths({ markers: [4, 5], turnAtMs: T, sends: s }))
    .toEqual(resolveMarkerPaths({ markers: [1, 2], turnAtMs: T, sends: s }))
})

// --- a marker paired against the MESSAGE it came in ---------------------------

const msg = (atMs: number, paths: string[], images = paths.length): AttachmentMessage =>
  ({ conversationId: 'c', atMs, paths, images })

describe('a conversation with no message record resolves exactly as before', () => {
  // The pin for every conversation this change must not touch: one that was never sent to by the
  // build that records messages. Each case is the upload rule's own answer, asked three ways.
  const cases: Array<{ markers: number[]; sends: ReturnType<typeof snd>[] }> = [
    { markers: [4, 5, 6], sends: [snd(T - 3000, '/a/c.png'), snd(T - 9000, '/a/a.png'), snd(T - 6000, '/a/b.png')] },
    { markers: [1, 2], sends: [snd(T - 1, '/a/a.png')] },
    { markers: [1], sends: [snd(T - SEND_WINDOW_MS, '/a/a.png')] },
    { markers: [1], sends: [snd(T + 1, '/a/a.png')] },
    { markers: [4, 5], sends: [] },
  ]
  test('omitting messages, an empty list, and only records from AFTER the turn all agree', () => {
    for (const c of cases) {
      const before = resolveMarkerPaths({ markers: c.markers, turnAtMs: T, sends: c.sends })
      expect(resolveMarkerPaths({ ...c, turnAtMs: T, messages: [] })).toEqual(before)
      expect(resolveMarkerPaths({ ...c, turnAtMs: T, messages: [msg(T + 60_000, ['/a/later.png'])], sinceMs: T - 1 }))
        .toEqual(before)
    }
  })
})

describe('resolving against delivered messages', () => {
  test('THE MEASURED CASE: four markers, seven uploads in the hour, the message carried four', () => {
    // Replayed from a real conversation: three files attached forty minutes earlier for another
    // message, four attached together for this one. The upload rule counted seven and drew chips.
    const earlier = ['/s/87d32d2e-image.png', '/s/b515b064-image.png', '/s/ccc2bb77-image.png']
    const mine = ['/s/b3e3d1c3-1.png', '/s/82de2098-3.png', '/s/addee503-2.png', '/s/a657b798-legendas.png']
    const sends = [
      ...earlier.map((p, i) => snd(T - 2_449_000 + i * 8000, p)),
      ...mine.map((p, i) => snd(T - 330_000 + i * 100, p)),
    ]
    expect(resolveMarkerPaths({ markers: [1, 2, 3, 4], turnAtMs: T, sends })).toBe(null)
    const messages = [msg(T - 2_400_000, earlier), msg(T - 2000, mine)]
    // The earlier message was the previous person's turn (its paths survived as text), so it closes
    // the interval and only this message is offered.
    expect(resolveMarkerPaths({ markers: [1, 2, 3, 4], turnAtMs: T, sends, messages, sinceMs: T - 2_390_000 }))
      .toEqual(mine)
  })

  test('a queue committed as ONE turn is every message in the interval, in the order sent', () => {
    const messages = [msg(T - 5000, ['/a/c.png']), msg(T - 9000, ['/a/a.png', '/a/b.png'])]
    expect(resolveMarkerPaths({ markers: [8, 9, 10], turnAtMs: T, sends: [], messages, sinceMs: T - 60_000 }))
      .toEqual(['/a/a.png', '/a/b.png', '/a/c.png'])
  })

  test('resolveMarkerPaths’ own contract: an explicit `null` bound accepts everything in the window', () => {
    // `previousPersonTurnMs` itself never produces `null` any more (see its own header) — this pins
    // `resolveMarkerPaths`’ documented meaning of the value in isolation, for any caller that does.
    expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [], messages: [msg(T - 10, ['/a/a.png'])], sinceMs: null }))
      .toEqual(['/a/a.png'])
  })

  // Every case below answers null — THE REFUSAL SURVIVES. A wrong thumbnail is false and convincing.
  test('a message already shown in an earlier turn is never offered to a later marker', () => {
    // 185 turns kept their paths against 34 that became markers: the common case, not an edge.
    const messages = [msg(T - 40_000, ['/a/shown-as-path.png'])]
    expect(resolveMarkerPaths({ markers: [3], turnAtMs: T, sends: [], messages, sinceMs: T - 30_000 })).toBe(null)
  })

  test('once a conversation records messages, uploads are no longer evidence', () => {
    // Uploads that WOULD have matched, beside a message record that does not: the message wins,
    // and the answer is a chip rather than a pairing the upload rule cannot vouch for.
    const sends = [snd(T - 20, '/a/x.png'), snd(T - 10, '/a/y.png')]
    const messages = [msg(T - 5, ['/a/x.png'])]
    expect(resolveMarkerPaths({ markers: [1, 2], turnAtMs: T, sends, messages, sinceMs: T - 60_000 })).toBe(null)
    expect(resolveMarkerPaths({ markers: [1, 2], turnAtMs: T, sends, messages: [msg(T - 5, [])], sinceMs: T - 60_000 }))
      .toBe(null)
  })

  test('one too few, or one too many, resolves nothing', () => {
    const messages = [msg(T - 5, ['/a/a.png', '/a/b.png'])]
    expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [], messages, sinceMs: null })).toBe(null)
    expect(resolveMarkerPaths({ markers: [1, 2, 3], turnAtMs: T, sends: [], messages, sinceMs: null })).toBe(null)
  })

  test('a message that named an image this machine cannot serve is short, and resolves nothing', () => {
    const messages = [msg(T - 5, ['/a/a.png'], 2)]
    expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [], messages, sinceMs: null })).toBe(null)
    expect(resolveMarkerPaths({ markers: [1, 2], turnAtMs: T, sends: [], messages, sinceMs: null })).toBe(null)
  })

  test('a message after the turn, or older than the window, is not this turn’s', () => {
    const early = msg(T - 100, ['/a/first.png'])
    expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [], messages: [early, msg(T + 1, ['/a/a.png'])], sinceMs: T - 50 }))
      .toBe(null)
    expect(resolveMarkerPaths({
      markers: [1], turnAtMs: T, sends: [], messages: [msg(T - SEND_WINDOW_MS - 1, ['/a/a.png'])], sinceMs: null,
    })).toBe(null)
  })

  test('a previous person turn with no timestamp proves nothing belongs to this one', () => {
    const messages = [msg(T - 5, ['/a/a.png'])]
    expect(resolveMarkerPaths({ markers: [1], turnAtMs: T, sends: [], messages, sinceMs: Number.POSITIVE_INFINITY })).toBe(null)
  })
})

describe('previousPersonTurnMs', () => {
  const at = (ms: number) => new Date(ms).toISOString()
  test('finds the last person turn before the index, skipping what the harness wrote', () => {
    const turns = [
      { role: 'user' as const, at: at(T - 900) },
      { role: 'assistant' as const, at: at(T - 800) },
      { role: 'user' as const, at: at(T - 700), system: 'command output' },
      { role: 'user' as const, at: at(T - 600), task: { label: 'x', running: false } },
      { role: 'user' as const, at: at(T) },
    ]
    expect(previousPersonTurnMs(turns, 4)).toBe(T - 900)
    // Nothing before index 0 — out of view, same as never having a bound. See the function's own
    // header: this used to be `null`, which `resolveMarkerPaths` reads as "no bound" and would have
    // let a message from before this window pair with a marker that is not its own.
    expect(previousPersonTurnMs(turns, 0)).toBe(Number.POSITIVE_INFINITY)
  })
  test('a person turn with no usable time closes the interval without saying where', () => {
    expect(previousPersonTurnMs([{ role: 'user' }, { role: 'user', at: at(T) }], 1)).toBe(Number.POSITIVE_INFINITY)
  })
})

/**
 * THE COMPOSER'S OWN LIGHTBOX INDEX.
 *
 * A thumbnail in the composer opens the same `AttachmentLightbox` a sent message does, over the
 * images CURRENTLY attached — and that list is editable underneath it. Removing the picture being
 * viewed, or every picture, must close the overlay rather than leave it open on a path that is no
 * longer there; the lightbox renders nothing for a missing path, so without this the reader is left
 * looking at a black screen with no image and a close button they have to find.
 */
describe('openComposerLightbox', () => {
  it('keeps a valid index', () => {
    expect(openComposerLightbox(1, 3)).toBe(1)
    expect(openComposerLightbox(0, 1)).toBe(0)
  })

  it('closes when nothing is attached any more', () => {
    expect(openComposerLightbox(0, 0)).toBeNull()
  })

  it('closes when the image being viewed was the one removed', () => {
    // Two images, viewing the second, the second is removed: index 1 no longer names anything.
    // Deliberately NOT clamped to the last image — the reader asked for THAT picture, and silently
    // showing a different one is a worse answer than closing.
    expect(openComposerLightbox(1, 1)).toBeNull()
  })

  it('stays closed when it was never open', () => {
    expect(openComposerLightbox(null, 3)).toBeNull()
  })

  it('refuses an index that is not a real position', () => {
    expect(openComposerLightbox(-1, 3)).toBeNull()
    expect(openComposerLightbox(1.5, 3)).toBeNull()
  })
})
