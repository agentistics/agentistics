/**
 * attachmentPreview.ts — PURE. Which parts of a turn's text are image ATTACHMENTS, not prose.
 *
 * An attachment here is a PATH — see `attachment-web.ts`'s header: the composer types a line into a
 * tmux pane, so `send()` joins the quote, then one line per attachment's own path, then whatever was
 * typed. The transcript records exactly that, verbatim, so the same rule reads the same turn text
 * whether it is the client's own echo or the harness's own record — one rule, not two.
 *
 * The PATH rule itself (`isImagePath`, `splitImageAttachments`) now lives in `@agentistics/core` and
 * is re-exported here unchanged: the server reads a delivered message with it to record what that
 * message carried, and a second copy would let the record and the render disagree.
 *
 * The MARKER rule (`splitImageMarkers`) lives there too, for the same reason: the server counts a
 * turn's own leading markers to check them against its `imagePasteIds` and its companion entry
 * (`attachment-companion.ts`) before it will ever hand back a real thumbnail, and a second copy of
 * the count here could disagree with the one that gated the resolution.
 */

import type { AttachmentMessage, AttachmentSend } from '@agentistics/core'

export {
  isImagePath, splitImageAttachments, type SplitAttachments,
  splitImageMarkers, type SplitMarkers,
} from '@agentistics/core'


// --- a marker that CAN find its file ----------------------------------------

/**
 * How far back a turn may look for its own sends.
 *
 * Generous, because the whole point is the QUEUED case: the harness holds a message until its
 * current turn ends, which is minutes on a working session and occasionally much longer. Being
 * generous costs nothing — a window that catches a neighbouring message makes the count disagree,
 * and a disagreeing count resolves to nothing.
 */
export const SEND_WINDOW_MS = 60 * 60_000

/**
 * The files behind a turn's markers, in order — or `null` when it cannot be said.
 *
 * The comment above says a marker has no file behind it. That was WRONG, and this is the
 * correction: agentop wrote those files itself (185 of them on the machine this was measured on)
 * and knew the session it was typing them into. What was missing was never the file — it was the
 * record that we sent it, which `attachment-web.ts` now keeps.
 *
 * ALL-OR-NOTHING, deliberately. Drawing the WRONG image under a message is worse than drawing a
 * chip: a chip says "an image was here", which is true and useless, while a wrong thumbnail is
 * false and convincing. So markers resolve only when the record accounts for them EXACTLY — same
 * count, one file per marker — and every case that cannot be settled answers `null`.
 *
 * The ordinals are the harness's numbering across its WHOLE conversation, so they are a count here
 * and never an index into anything of ours.
 *
 * TWO RECORDS, and which one is asked is decided by WHEN the turn happened:
 *
 * - **Messages** (`AttachmentMessage`) — what each delivered message carried, read off the text at
 *   the moment it was typed. Once a conversation has ONE such record, this build is the one writing
 *   them and every message it delivers is recorded, so for every turn from then on they are the only
 *   evidence. The turn's markers must equal the images of the messages delivered AFTER the previous
 *   person's turn (`sinceMs`) and at or before this one: a harness commits its queue as one turn, so
 *   everything sent in that interval is this turn, and everything sent before the previous turn was
 *   that turn's. That bound is load-bearing — most messages arrive with their paths intact (185
 *   turns kept them against 34 that became markers on the machine this was measured on), and a
 *   message already SHOWN as paths in an earlier turn must never be offered to a later marker.
 * - **Uploads** (`AttachmentSend`) — the older record, stamped when a file was written rather than
 *   when it was sent. A turn from before the conversation's first message record is resolved exactly
 *   as it always was, by counting uploads in the window. That rule could not tell a previous
 *   message's files, or one removed from the composer, from this turn's: measured, a message with
 *   four markers sat in a window holding seven uploads, and it drew chips. It is kept for history,
 *   never extended.
 */
export function resolveMarkerPaths(input: {
  markers: readonly number[]
  turnAtMs: number
  sends: readonly AttachmentSend[]
  /** What delivered messages carried, for this turn's conversation. */
  messages?: readonly AttachmentMessage[]
  /** When the previous PERSON's turn was recorded — see `previousPersonTurnMs`. */
  sinceMs?: number | null
}): string[] | null {
  if (input.markers.length === 0) return null
  const messages = input.messages ?? []
  const firstMessageAt = messages.reduce((min, m) => Math.min(min, m.atMs), Number.POSITIVE_INFINITY)
  if (input.turnAtMs >= firstMessageAt) {
    return resolveFromMessages(input.markers.length, input.turnAtMs, messages, input.sinceMs ?? null)
  }
  const inWindow = input.sends
    .filter(s => s.atMs <= input.turnAtMs && input.turnAtMs - s.atMs <= SEND_WINDOW_MS)
    .sort((a, b) => a.atMs - b.atMs)
  if (inWindow.length !== input.markers.length) return null
  return inWindow.map(s => s.path)
}

function resolveFromMessages(
  count: number,
  turnAtMs: number,
  messages: readonly AttachmentMessage[],
  sinceMs: number | null,
): string[] | null {
  const mine = messages
    .filter(m => m.atMs <= turnAtMs && turnAtMs - m.atMs <= SEND_WINDOW_MS)
    .filter(m => sinceMs === null || m.atMs > sinceMs)
    .sort((a, b) => a.atMs - b.atMs)
  if (mine.length === 0) return null
  // A message that named an image this machine cannot serve is short, and a short message cannot be
  // accounted for — pairing around the gap would put a neighbour's file under the wrong marker.
  if (mine.some(m => m.paths.length !== m.images)) return null
  const paths = mine.flatMap(m => m.paths)
  return paths.length === count ? paths : null
}

/**
 * When the last turn a PERSON wrote before `index` was recorded, in ms.
 *
 * The lower bound of the messages a marker turn may be made of (see `resolveMarkerPaths`). A turn
 * the HARNESS wrote under the user's role — a system note, a background task line — is not a
 * message anybody sent, so it closes no interval. A person's turn with no timestamp closes it
 * without saying where, and NEITHER CASE MAY EVER READ AS "NO BOUND": both are answered with
 * `Infinity`, because nothing after an unknown boundary can be proven to belong to this turn, so
 * nothing resolves, and the chip stays.
 *
 * This used to return `null` when the loop ran off the front of `turns` — a person's earlier turn
 * that is simply OUT OF VIEW, which is the ordinary case after a long agentic run: the chat view
 * caps a read at 400 turns, and `resolveMarkerPaths` reads `null` as "no bound", accepting every
 * message before this one INCLUDING a previous person turn's, wherever it actually was. A wrong
 * pairing there is not merely a wrong chip, it can be a WRONG THUMBNAIL when the counts happen to
 * agree. "Out of view" and "no message could exist before this" are indistinguishable from here —
 * `turns` is a window, not the whole conversation — so both answer the same way the harness's own
 * unstamped turn already does: an unknown boundary is `Infinity`, never a bound of nothing at all.
 */
export function previousPersonTurnMs(
  turns: readonly { role: 'user' | 'assistant'; at?: string; system?: string; task?: unknown }[],
  index: number,
): number {
  for (let i = Math.min(index, turns.length) - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role !== 'user' || t.system !== undefined || t.task !== undefined) continue
    const ms = t.at ? Date.parse(t.at) : Number.NaN
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
  }
  return Number.POSITIVE_INFINITY
}

/**
 * Which image the composer's lightbox is showing, or `null` for closed.
 *
 * The composer's attachment list is editable while the overlay is open, so the index it was opened
 * at can stop naming anything — and `AttachmentLightbox` renders nothing for a missing path, which
 * leaves a black overlay with no picture in it. This is the one place that decides, so the rule is
 * stated once rather than re-derived at the render.
 *
 * It CLOSES rather than clamps. Sliding to the last remaining image after the reader removed the
 * one they were looking at answers a question nobody asked, and it does it silently — the same
 * reason `parseDialogOptions` refuses a half-read option list instead of offering what it managed
 * to read.
 */
export function openComposerLightbox(open: number | null, count: number): number | null {
  if (open === null) return null
  if (!Number.isInteger(open) || open < 0) return null
  return open < count ? open : null
}
