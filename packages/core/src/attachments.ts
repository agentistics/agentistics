/**
 * attachments.ts — PURE. Which lines of a message are attachment PATHS rather than prose.
 *
 * An attachment here is a PATH (see the server's `attachment-web.ts` header): the composer types a
 * line into a tmux pane, so a message is the quote, then one line per attachment's own path, then
 * whatever was typed. The transcript records exactly that, verbatim.
 *
 * The heuristic is deliberately narrow: a line that is JUST a path (no spaces) ending in a known
 * image extension. Prose that happens to mention "see diagram.png in the repo" has spaces around
 * the name and is left alone; a bare attachment line never does, because that is how it was built.
 *
 * It lived in the web's `attachmentPreview.ts` while the browser was the only thing that asked. The
 * SERVER asks it too now: what a message CARRIED is recorded at the moment it is delivered, read
 * off the very text being typed into the pane, so a `[Image #N]` marker pairs with the files of
 * THAT message instead of with whatever else was uploaded in the same hour. Two implementations of
 * that one rule would let the record and the render disagree about which lines were attachments.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** A path-shaped line: no whitespace, and not empty. Prose never qualifies. */
function looksLikeBarePath(line: string): boolean {
  return line !== '' && !/\s/.test(line)
}

export interface SplitAttachments {
  /** The image paths found, in the order they appeared. */
  images: string[]
  /** The remaining text, with those lines removed and no blank line left in their place. */
  text: string
}

export function splitImageAttachments(text: string): SplitAttachments {
  const images: string[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (looksLikeBarePath(trimmed) && isImagePath(trimmed)) images.push(trimmed)
    else kept.push(line)
  }
  return { images, text: kept.join('\n').trim() }
}

/**
 * `[Image #4]` — what the HARNESS writes where an image was, and it is not prose.
 *
 * A separate rule from `splitImageAttachments` because it answers about a different kind of thing.
 * That one finds a PATH the composer typed, which names a file this product can open. This one
 * finds a MARKER Claude Code substituted into the turn it recorded: an ordinal and nothing else.
 *
 * It exists because of what a QUEUED prompt looks like on arrival. A harness that is mid-turn holds
 * what arrives and commits the queue as ONE turn, so two prompts sent a minute apart come back
 * merged, with every image of both collected at the front:
 *
 *     [Image #4] [Image #5] [Image #6]1. a visao geral...
 *
 * — markers running straight into the first word, which is how a message with three screenshots on
 * it read as a message beginning with square brackets.
 *
 * LEADING ONLY: this repo's own conversations quote these markers while discussing them, so a rule
 * matching anywhere would eat a line somebody actually wrote. Every marker measured on real
 * transcripts sits at the very start.
 *
 * SHARED between the SERVER, which counts a turn's own markers to check them against its
 * `imagePasteIds` and its companion entry (`attachment-companion.ts`), and the BROWSER, which
 * strips them off the text it renders — one rule, so the two can never disagree about the count.
 */
export interface SplitMarkers {
  /** The ordinals, in the order the harness numbered them. */
  markers: number[]
  /** What is left once the leading run is removed. */
  text: string
}

const LEADING_MARKER = /^\s*\[Image #(\d+)\]/

export function splitImageMarkers(text: string): SplitMarkers {
  const markers: number[] = []
  let rest = text
  for (;;) {
    const m = LEADING_MARKER.exec(rest)
    if (!m) break
    markers.push(Number(m[1]))
    rest = rest.slice(m[0].length)
  }
  return { markers, text: markers.length > 0 ? rest.trim() : text }
}
