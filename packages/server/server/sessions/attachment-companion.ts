/**
 * attachment-companion.ts — PURE: the harness's OWN link between a `[Image #N]` marker turn and
 * the files behind it.
 *
 * Claude Code writes a marker turn's images as a SEPARATE entry immediately beside it in the
 * transcript: the same `promptId`, `isMeta: true`, `turnCompanion: true`, and one
 * `{ type: 'text', text: '[Image: source: <path>]' }` block per image, IN ORDER. Measured over 30
 * days of real transcripts: 94 marker turns, 86 with a companion whose count matched exactly.
 *
 * `turnCompanion` is not exclusively an image thing — the same flag marks a skill's loaded body
 * beside the turn that invoked it (see `chat-envelope.ts`'s `META_KINDS`, `^Base directory for this
 * skill:`), so `parseImageCompanion` refuses anything that is not made ENTIRELY of image lines: a
 * companion half image and half something else is not a link this module can vouch for, and a
 * half-read link published as a measurement is the same defect `parseDialogOptions` refuses a
 * half-read option list for.
 *
 * `resolveCompanionImages` is the whole of the correction over the write-side attachment log this
 * replaces: the harness ALREADY recorded which files a marker turn came from, so nothing needs to
 * be typed into the pane and remembered against a time window to find them again. What still has to
 * be checked is exactly what always had to be checked — a wrong thumbnail is false and convincing,
 * where a chip is merely useless, so resolution is ALL-OR-NOTHING:
 *
 * - the companion's own path count must equal what the marker turn ITSELF claims, on BOTH of its
 *   own countable facts — its leading `[Image #N]` run (`splitImageMarkers`) and its `imagePasteIds`
 *   array. A companion is only proof of what THIS entry says; the marker turn is the one source of
 *   how many images it claims to have, and two independent counts agreeing is a stronger link than
 *   trusting the companion's length alone.
 * - every path must resolve inside `ATTACHMENT_DIR` (`resolveAttachmentRead`) — a path this machine
 *   cannot serve back is not evidence for a marker, it is the reason the chip exists.
 */

import { resolveAttachmentRead } from './attachment-web'

const IMAGE_SOURCE_LINE = /^\[Image: source: (.+)\]$/

/** One content block of a `turnCompanion` entry, whichever shape the transcript wrote it in. */
function blockText(block: unknown): string | null {
  if (typeof block === 'string') return block
  if (
    block !== null && typeof block === 'object'
    && (block as Record<string, unknown>).type === 'text'
    && typeof (block as Record<string, unknown>).text === 'string'
  ) {
    return (block as Record<string, unknown>).text as string
  }
  return null
}

/**
 * The paths one `turnCompanion` entry names, IN ORDER — or `null` when it is not EXCLUSIVELY an
 * image list (a skill load, a resumed-session notice, anything this build does not recognise, or a
 * companion mixing an image line with something else).
 */
export function parseImageCompanion(content: unknown): string[] | null {
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content : null
  if (!blocks || blocks.length === 0) return null
  const paths: string[] = []
  for (const block of blocks) {
    const text = blockText(block)
    if (text === null) return null
    const m = IMAGE_SOURCE_LINE.exec(text.trim())
    if (!m) return null
    paths.push(m[1]!)
  }
  return paths
}

/**
 * The files behind a marker turn's images, resolved through its OWN companion — or `null` when it
 * cannot be said EXACTLY.
 *
 * `markerCount` and `pasteIdCount` are the turn's two independent claims about how many images it
 * carries (see the module header); the companion's own path count must equal BOTH, and every path
 * must be one this machine can actually serve back.
 */
export function resolveCompanionImages(
  companionPaths: readonly string[],
  markerCount: number,
  pasteIdCount: number,
): string[] | null {
  if (companionPaths.length === 0) return null
  if (companionPaths.length !== markerCount || companionPaths.length !== pasteIdCount) return null
  const resolved = companionPaths.map(p => resolveAttachmentRead(p))
  return resolved.every((p): p is string => p !== null) ? resolved : null
}
