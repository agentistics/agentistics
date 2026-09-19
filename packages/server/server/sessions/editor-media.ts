/**
 * editor-media.ts — PURE: may the Studio SHOW this file instead of refusing it, and under what ceiling?
 *
 * The Studio refused every binary file with one sentence ("it is not opened as text here, so it
 * cannot be saved back mangled"). That sentence is right for a `.zip` and wrong for a PNG: the
 * reason it gives is about SAVING, and nobody is saving a PNG — they are looking at it. Reported as
 * "imagens nao estao sendo suportadas pra abrir, quero que pelo menos imagens videos e pdfs tbm
 * renderizem de inicio".
 *
 * THE CONTENT TABLE IS NOT REDECLARED HERE. `artifact-media.ts` already owns which extension is
 * served as what, and owns it as a CLOSED table with SVG deliberately refused — an SVG is a
 * document that can carry script, and served inline from the dashboard's own origin it runs there.
 * A repository is full of SVGs, so that refusal matters MORE here than it did for the artifacts
 * gallery it was written for. Nothing is added to the table for the Studio: `image`, `pdf` and
 * `video` are all already on it, and an extension it does not know stays refused rather than
 * becoming `application/octet-stream`, which would make this route a general file download.
 *
 * WHAT THIS MODULE ADDS IS THE CEILING, and it is per KIND because the three are not the same
 * proposition. An `<img>` is decoded whole into a bitmap by the browser; a PDF is handed to the
 * browser's own viewer, which pages through it; a `<video>` is STREAMED and, because the route
 * answers byte ranges, pulls only the part being played. So one number for all three would either
 * refuse a perfectly ordinary screen recording or let a 200 MB still image be decoded in an aside
 * panel.
 *
 * A FILE OVER ITS CEILING IS NOT "NOT MEDIA". It gets its own answer carrying the ceiling it hit,
 * so the pane can say WHICH limit refused it rather than falling back to the generic binary
 * sentence — the same N/A-versus-a-confident-wrong-result rule this feature keeps everywhere else.
 */
import { mediaTypeFor, type MediaKind } from './artifact-media'

/**
 * How many bytes of each kind the Studio will show.
 *
 * Stated here, in one place, and enforced TWICE on purpose: the read route reports the plan so the
 * pane can word its refusal before any bytes move, and the bytes route re-checks it, because a
 * ceiling a client is trusted to apply is not a ceiling.
 */
export const MEDIA_VIEW_LIMITS: Record<MediaKind, number> = {
  /** Decoded whole into a bitmap by the browser, so the cost is the DIMENSIONS as much as the bytes. */
  image: 25 * 1024 * 1024,
  /** Handed to the browser's own viewer, which pages through it rather than rendering it all. */
  pdf: 50 * 1024 * 1024,
  /** Streamed, and range-served, so the browser pulls only what is being played. */
  video: 512 * 1024 * 1024,
}

export type MediaViewPlan =
  | { kind: 'render'; media: MediaKind; mime: string }
  | { kind: 'too-big'; media: MediaKind; limit: number }
  | { kind: 'not-media' }

/**
 * What to do with a file of this name and this size.
 *
 * `size` is the `stat` the caller already has. A NEGATIVE or non-finite size is not a size, and is
 * treated as over the ceiling rather than under it: the failing direction here is showing something
 * unbounded, and a pane that says "too large" about a file whose size could not be read is closer to
 * the truth than one that tries to render it.
 */
export function planMediaView(path: string, size: number): MediaViewPlan {
  const type = mediaTypeFor(path)
  if (!type) return { kind: 'not-media' }
  const limit = MEDIA_VIEW_LIMITS[type.kind]
  if (!Number.isFinite(size) || size < 0 || size > limit) {
    return { kind: 'too-big', media: type.kind, limit }
  }
  return { kind: 'render', media: type.kind, mime: type.mime }
}

/**
 * One `Range: bytes=…` header, resolved against a known size — what makes `<video>` seekable.
 *
 * Deliberately narrow: ONE range, and the only forms accepted are the two a media element actually
 * sends (`bytes=N-`, `bytes=N-M`). A multipart range needs a multipart body, and a suffix range
 * (`bytes=-N`) is answered by `null` — the caller then sends the whole file with a 200, which is a
 * correct answer to any range request a server may decline. An UNSATISFIABLE range (start past the
 * end) is its own outcome, because HTTP has a status for exactly that and answering it with the
 * whole file would leave the element seeking to a position it never reached.
 */
export type RangePlan =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

export function planRange(header: string | null, size: number): RangePlan {
  if (header === null || size <= 0) return { kind: 'full' }
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!m) return { kind: 'full' }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Number(m[2])
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end: Math.min(end, size - 1) }
}
