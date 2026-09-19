import { expect, test } from 'bun:test'
import { MEDIA_VIEW_LIMITS, planMediaView, planRange } from './editor-media'

test('the three kinds render, and the kind comes from the closed table', () => {
  expect(planMediaView('/r/bryan-home.png', 216 * 1024)).toEqual({
    kind: 'render', media: 'image', mime: 'image/png',
  })
  expect(planMediaView('/r/doc/report.PDF', 1024)).toEqual({
    kind: 'render', media: 'pdf', mime: 'application/pdf',
  })
  expect(planMediaView('/r/clip.webm', 1024)).toEqual({
    kind: 'render', media: 'video', mime: 'video/webm',
  })
})

test('anything not on the table is not media — including the ones it refuses on purpose', () => {
  expect(planMediaView('/r/build.tar.gz', 10).kind).toBe('not-media')
  expect(planMediaView('/r/Makefile', 10).kind).toBe('not-media')
  // SVG is media-SHAPED and deliberately absent from the table: it can carry script, and served
  // inline from this origin it would run there. The Studio opens it as TEXT instead, which is what
  // `not-media` routes it to.
  expect(planMediaView('/r/diagram.svg', 10).kind).toBe('not-media')
  expect(planMediaView('/r/page.html', 10).kind).toBe('not-media')
})

test('the ceiling is per KIND, and the refusal carries the one it hit', () => {
  expect(planMediaView('/r/huge.png', MEDIA_VIEW_LIMITS.image + 1)).toEqual({
    kind: 'too-big', media: 'image', limit: MEDIA_VIEW_LIMITS.image,
  })
  // The same byte count that refuses an image is well inside the video ceiling: a `<video>` is
  // streamed and range-served, an `<img>` is decoded whole.
  expect(planMediaView('/r/clip.mp4', MEDIA_VIEW_LIMITS.image + 1).kind).toBe('render')
  expect(planMediaView('/r/clip.mp4', MEDIA_VIEW_LIMITS.video + 1)).toEqual({
    kind: 'too-big', media: 'video', limit: MEDIA_VIEW_LIMITS.video,
  })
  expect(MEDIA_VIEW_LIMITS.image).toBeLessThan(MEDIA_VIEW_LIMITS.pdf)
  expect(MEDIA_VIEW_LIMITS.pdf).toBeLessThan(MEDIA_VIEW_LIMITS.video)
})

test('exactly AT the ceiling renders — the limit is a maximum, not a ceiling it must stay under', () => {
  expect(planMediaView('/r/exact.png', MEDIA_VIEW_LIMITS.image).kind).toBe('render')
})

test('a size that is not a size is over the limit, never under it', () => {
  expect(planMediaView('/r/a.png', -1).kind).toBe('too-big')
  expect(planMediaView('/r/a.png', Number.NaN).kind).toBe('too-big')
  expect(planMediaView('/r/a.png', Number.POSITIVE_INFINITY).kind).toBe('too-big')
})

test('a zero-byte image still renders — 0 is a size, and the browser will say what it found', () => {
  expect(planMediaView('/r/empty.png', 0).kind).toBe('render')
})

test('no range header is the whole file', () => {
  expect(planRange(null, 1000)).toEqual({ kind: 'full' })
})

test('the two forms a media element actually sends', () => {
  expect(planRange('bytes=0-499', 1000)).toEqual({ kind: 'partial', start: 0, end: 499 })
  expect(planRange('bytes=500-', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 })
})

test('an end past the file is clamped to the file, not refused', () => {
  expect(planRange('bytes=900-99999', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 })
})

test('a start past the end is unsatisfiable, and is not answered with the whole file', () => {
  // HTTP has a status for exactly this. Answering it with a 200 and the whole body leaves the
  // element believing it seeked to a position it never reached.
  expect(planRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' })
  expect(planRange('bytes=5000-6000', 1000)).toEqual({ kind: 'unsatisfiable' })
})

test('a form this route does not serve falls back to the whole file', () => {
  // A suffix range and a multipart range are both legitimate requests this route declines to
  // special-case; a 200 with the whole body is a correct answer to either.
  expect(planRange('bytes=-500', 1000)).toEqual({ kind: 'full' })
  expect(planRange('bytes=0-99,200-299', 1000)).toEqual({ kind: 'full' })
  expect(planRange('items=0-10', 1000)).toEqual({ kind: 'full' })
  expect(planRange('', 1000)).toEqual({ kind: 'full' })
})

test('an empty file has no range to serve', () => {
  expect(planRange('bytes=0-', 0)).toEqual({ kind: 'full' })
})
