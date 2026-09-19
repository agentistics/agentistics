/**
 * attachment-web.ts — attaching a file to a message sent from the dashboard.
 *
 * WHAT AN ATTACHMENT ACTUALLY IS HERE. The composer types a line into a tmux pane; there is no
 * channel through which a byte array could reach an assistant. What every one of these CLIs does
 * understand is a PATH — reading a file it is pointed at is the most ordinary thing they do. So an
 * attachment is written to this machine's disk and its path is what travels in the message.
 *
 * That is worth stating plainly in the UI too, because it is not what "attach" means in a chat
 * application: the file lands on the machine running the session, not inside the conversation.
 *
 * The write goes to ONE directory under `~/.agentistics`, which is agentop's own — the rule that
 * anything written outside its own directories is an explicit act of the user is not bent here. The
 * filename is REBUILT by the pure `attachment-name.ts` rather than sanitised, because a name from a
 * browser is attacker-controlled and joining it to a directory is how an upload becomes an
 * arbitrary write.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTISTICS_DATA_DIR } from '../config'
import { storedAttachmentName } from './attachment-name'
import { realContained } from './real-contained'
import { splitImageAttachments } from '@agentistics/core'
import type { AttachmentMessage, AttachmentSend } from '@agentistics/core'

/** Where uploads land. Inside agentop's own directory, never beside the user's project. */
export const ATTACHMENT_DIR = join(AGENTISTICS_DATA_DIR, 'attachments')

/**
 * What was sent, and where to — the FALLBACK record for a `[Image #4]` marker Claude Code's OWN
 * transcript does not already answer.
 *
 * A harness that is mid-turn queues an arriving message and substitutes markers for its images, so
 * the PATH that normally survives into the transcript is gone and the chat can only draw a chip.
 * The file is still here; the link was what was missing. For Claude Code, the link is now usually
 * the harness's OWN answer: it writes a `turnCompanion` entry beside the marker turn naming exactly
 * which files it was — see `attachment-companion.ts`, resolved in `chat-tail.ts` before a turn ever
 * reaches the browser. THIS log is what a turn falls back to when that companion is missing or
 * cannot account for it exactly (an older turn from before this log existed, one whose companion did
 * not survive a truncated read window) — asked through the web's `attachmentPreview.ts`'s
 * `resolveMarkerPaths`, which sits beside the marker parsing it serves.
 *
 * APPEND-ONLY JSONL. TWO KINDS OF LINE, and the second one is the one that answers the question:
 *
 * - `AttachmentSend` — one UPLOAD, stamped when the file was written. That is the moment a person
 *   attached it, not the moment they sent it, so a turn's markers could only ever be paired with it
 *   by guessing a time window, and the guess was measurably wrong: seven uploads recorded in the
 *   hour before a message carrying four markers, three of them belonging to a message forty minutes
 *   earlier. Kept for the records already on disk and for uploads no message ever claimed.
 * - `AttachmentMessage` — one MESSAGE, stamped when it was handed to the session, carrying the very
 *   paths it named. No inference left: a marker is paired against the files of the message it came
 *   in, or against nothing.
 *
 * A line that cannot be parsed — or that is of the kind a reader does not know — is SKIPPED rather
 * than discarding the log: this is a convenience for drawing a thumbnail, and no part of the
 * product may fail because of it. That is also what makes the second kind safe to add to a file an
 * older build is still reading: it has no `path`, so that build ignores it.
 */
export const ATTACHMENT_LOG = join(AGENTISTICS_DATA_DIR, 'attachment-sends.jsonl')

async function appendLog(line: string): Promise<void> {
  await mkdir(AGENTISTICS_DATA_DIR, { recursive: true }).catch(() => {})
  await appendFile(ATTACHMENT_LOG, `${line}\n`, { mode: 0o600 }).catch(() => {})
}

/** Records one stored file. Never throws: a thumbnail is not worth failing an upload over. */
export async function recordAttachmentSend(sessionId: string, path: string): Promise<void> {
  if (sessionId === '') return
  await appendLog(JSON.stringify({ sessionId, atMs: Date.now(), path } satisfies AttachmentSend))
}

/**
 * What ONE delivered message carried — PURE, and the whole correction.
 *
 * The text is what agentop is typing into the pane, so the attachment lines in it ARE the message's
 * attachments; `splitImageAttachments` is the same rule the browser reads them back with, shared
 * through `@agentistics/core` rather than written twice.
 *
 * `paths` holds only what this machine STORED and can serve back (`resolveAttachmentRead`), because
 * a path we cannot serve would resolve a marker to a broken image — worse than the chip it
 * replaced. `images` counts them ALL, so a message this record cannot account for exactly is
 * visibly short rather than silently pairing the markers it can name against the wrong files.
 *
 * `null` when the message named no image at all: an ordinary message writes no line.
 */
export function attachmentMessageOf(
  conversationId: string,
  atMs: number,
  text: string,
): AttachmentMessage | null {
  if (conversationId === '') return null
  const { images } = splitImageAttachments(text)
  if (images.length === 0) return null
  const paths = images.filter(p => resolveAttachmentRead(p) !== null)
  return { conversationId, atMs, paths, images: images.length }
}

/** Records one delivered message's attachments. Never throws, for the reason above. */
export async function recordAttachmentMessage(msg: AttachmentMessage): Promise<void> {
  await appendLog(JSON.stringify(msg satisfies AttachmentMessage))
}

/**
 * Everything recorded for one conversation, in ONE pass over the file.
 *
 * The two kinds are keyed differently ON PURPOSE. An upload names the managed SESSION it was
 * attached to, because that is all the upload route knows; a message names the CONVERSATION,
 * because a reopen mints a new managed row while the harness's image numbering runs on. Asking for
 * both at once is what keeps that a one-line difference rather than two reads of the same file.
 */
export async function readAttachmentLog(
  key: { sessionId: string; conversationId: string },
): Promise<{ sends: AttachmentSend[]; messages: AttachmentMessage[] }> {
  return parseAttachmentLog(await readFile(ATTACHMENT_LOG, 'utf-8').catch(() => ''), key)
}

/** The parse behind `readAttachmentLog` — PURE, so the keying is testable without a data dir. */
export function parseAttachmentLog(
  raw: string,
  key: { sessionId: string; conversationId: string },
): { sends: AttachmentSend[]; messages: AttachmentMessage[] } {
  const sends: AttachmentSend[] = []
  const messages: AttachmentMessage[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const d = JSON.parse(line) as Partial<AttachmentSend & AttachmentMessage>
      if (typeof d.atMs !== 'number') continue
      if (d.sessionId === key.sessionId && d.sessionId !== '' && typeof d.path === 'string') {
        sends.push({ sessionId: d.sessionId, atMs: d.atMs, path: d.path })
      } else if (
        d.conversationId === key.conversationId && d.conversationId !== ''
        && Array.isArray(d.paths) && typeof d.images === 'number'
      ) {
        messages.push({
          conversationId: d.conversationId,
          atMs: d.atMs,
          paths: d.paths.filter((p): p is string => typeof p === 'string'),
          images: d.images,
        })
      }
    } catch { /* one bad line is not a reason to lose the rest */ }
  }
  return { sends, messages }
}

/**
 * Is `requested` actually inside `ATTACHMENT_DIR` — PURE, and the only thing standing between
 * "show this attachment back" and an arbitrary local file read.
 *
 * A message's text carries the attachment's own path VERBATIM (that is what an attachment IS
 * here — see the module header), so the read endpoint has to accept a path, not just a bare name.
 * `resolve()` collapses every `..`/`.`/doubled separator BEFORE the prefix check, so a request for
 * `ATTACHMENT_DIR/../../.ssh/id_rsa` resolves to a path that no longer starts with `ATTACHMENT_DIR`
 * and is refused — checking the prefix on the RAW string first would miss exactly that case.
 */
export function resolveAttachmentRead(requested: string): string | null {
  if (requested === '') return null
  const base = resolve(ATTACHMENT_DIR) + sep
  const resolved = resolve(requested)
  return resolved.startsWith(base) ? resolved : null
}

/**
 * The REAL containment recheck for `resolveAttachmentRead` — the same `realContained` rule the
 * Studio's own tree applies (`editor-fs.ts`, lifted into `real-contained.ts`), applied here.
 *
 * `resolveAttachmentRead` above is a LEXICAL check only — it never touches disk — so a symlink
 * planted inside `ATTACHMENT_DIR` that points somewhere else resolves the prefix check and would
 * then be served straight off its target. This is the one route that actually reads the bytes back
 * (`GET /api/fleet/attachment`), so it is the one place this recheck has to run: `resolveAttachmentRead`
 * itself stays lexical-only for its other two callers (`attachmentMessageOf`, the companion
 * resolver), which only decide what to RECORD, never what to serve.
 */
export async function resolveAttachmentReadReal(requested: string): Promise<string | null> {
  const lexical = resolveAttachmentRead(requested)
  if (lexical === null) return null
  return realContained(ATTACHMENT_DIR, lexical)
}

/**
 * ONE stored attachment, named the way it is stored — PURE, and half of the security model of
 * `GET /api/fleet/attachment/by-name` (the other half is `attachmentPathByNameReal`, below).
 *
 * This is the NARROWER twin of `resolveAttachmentRead`. That one has to accept a whole path,
 * because a message carries the attachment's path verbatim and the chat shows it back from the
 * message. The GALLERY does not need that: it is a grid of this directory's own files, so it can
 * ask by NAME, and a name that is a single segment cannot express a traversal at all — there is no
 * `resolve()` race to reason about.
 *
 * That rules out an ESCAPE SPELLED IN THE REQUEST, which is all a LEXICAL check can ever rule out —
 * it says nothing about what `ATTACHMENT_DIR/<name>` actually IS on disk, so a symlink planted
 * inside the directory (by anything else with write access to it) resolves this check exactly like
 * an ordinary file. The REAL recheck for that is `attachmentPathByNameReal`; this function alone is
 * not enough to decide what gets served.
 *
 * The accepted set is exactly what `storedAttachmentName` produces: one segment of
 * `[A-Za-z0-9._-]`. Anything this machine could not itself have written is refused, which is a
 * stronger statement than "contains no separator" and costs nothing — the names are minted here.
 * The separator, NUL and dot-segment cases are still checked and named, because they are the ones a
 * reader comes here to check for.
 */
export function attachmentPathByName(name: string): string | null {
  if (name === '' || name.length > 200) return null
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (name === '.' || name === '..') return null
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null
  return join(ATTACHMENT_DIR, name)
}

/**
 * The REAL containment recheck for `attachmentPathByName` — the same `realContained` rule
 * `resolveAttachmentReadReal` applies above, applied here.
 *
 * The single-segment name refuses a traversal BY CONSTRUCTION, but that only rules out an escape
 * spelled in the request; it says nothing about what `ATTACHMENT_DIR/<name>` actually IS on disk.
 * A symlink planted inside the directory — by anything else with write access to it, since the
 * directory is shared by every session on this machine — resolves the lexical check exactly like an
 * ordinary file and would then be served straight off its target. `GET /api/fleet/attachment/by-name`
 * is the second route that reads attachment bytes back, so it gets the identical recheck rather than
 * a second hand-rolled copy of the rule.
 */
export async function attachmentPathByNameReal(name: string): Promise<string | null> {
  const lexical = attachmentPathByName(name)
  if (lexical === null) return null
  return realContained(ATTACHMENT_DIR, lexical)
}

/**
 * The content type to serve a stored attachment as, or `null` when it is not one this route shows
 * — PURE.
 *
 * A CLOSED TABLE, never a default. That is what stops a preview route becoming a general reader of
 * agentop's own directory, and it is why adding a kind is a deliberate act rather than a fallthrough
 * — an extension absent here is refused. The type is read off the EXTENSION and never sniffed: the
 * answer must be decidable before anything is opened, and it is paired with `nosniff` on the
 * response so the browser cannot decide differently.
 *
 * IT SERVES MORE THAN IMAGES, and that was a real gap. A person can attach a PDF or a video — the
 * composer accepts both — and the gallery then showed a card saying "no preview" beside a file it
 * had itself stored, with no way to open it at all. Both are now served, each declared as exactly
 * what it is:
 *
 * - **video** is a `<video>` element's business. It is inert content: the browser decodes it, there
 *   is no document and no script.
 * - **pdf** is a document, so it is served with `Content-Disposition: inline` and viewed in the
 *   browser's own PDF viewer, under the same `default-src 'none'` policy every response here
 *   carries — the policy is what stops an embedded PDF reaching anything of ours.
 * - **svg** stays in the IMAGE row it has always been in, and its script still never runs inside an
 *   `<img>`; the CSP covers the case where somebody opens the URL directly.
 *
 * The `kind` travels with the mime because the CALLER needs it: a route that must decide between a
 * `Content-Disposition` and none, and a client that must decide between `<img>`, `<video>` and a
 * viewer. Deriving it from the mime string at each of those points would be the same table written
 * twice more.
 *
 * The set matches the browser side's `attachmentKind` deliberately — a preview the client believes
 * exists and the server refuses is a broken tile, which is the one thing the panel may not show.
 */
export type AttachmentKind = 'image' | 'video' | 'pdf'

export interface AttachmentType {
  mime: string
  kind: AttachmentKind
}

const ATTACHMENT_TYPES: Record<string, AttachmentType> = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  avif: { mime: 'image/avif', kind: 'image' },
  bmp: { mime: 'image/bmp', kind: 'image' },
  svg: { mime: 'image/svg+xml', kind: 'image' },
  mp4: { mime: 'video/mp4', kind: 'video' },
  m4v: { mime: 'video/mp4', kind: 'video' },
  mov: { mime: 'video/quicktime', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
  ogv: { mime: 'video/ogg', kind: 'video' },
  pdf: { mime: 'application/pdf', kind: 'pdf' },
}

/** What to serve this stored attachment as, or `null` when this route does not show it. */
export function attachmentMediaType(name: string): AttachmentType | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return ATTACHMENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * The image half of the table, kept because two callers ask exactly that question — the composer's
 * own preview and the chat bubble's thumbnail, neither of which can render a video or a PDF.
 * Derived from the one table rather than restated, so the two can never drift.
 */
export function attachmentImageType(name: string): string | null {
  const t = attachmentMediaType(name)
  return t && t.kind === 'image' ? t.mime : null
}

/**
 * The ceiling on one upload.
 *
 * Generous enough for a screenshot or a log, far below anything that would make writing it a
 * problem. The transport enforces its own limit as well; this is the one that decides what this
 * feature is for.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export interface AttachmentResult {
  ok: boolean
  /** The absolute path to reference in a message. Present only on success. */
  path?: string
  /** The stored name, for the chip in the composer. */
  name?: string
  /** Already-localized. Always present on failure, and on a name that had to be rewritten. */
  message?: string
}

export async function storeAttachment(
  lang: 'pt' | 'en',
  file: { name: string; bytes: Uint8Array },
  /** The session this is being attached to, when the caller knows it — see `ATTACHMENT_LOG`. */
  sessionId = '',
): Promise<AttachmentResult> {
  const pt = lang === 'pt'

  if (file.bytes.byteLength === 0) {
    return { ok: false, message: pt ? 'O arquivo está vazio.' : 'The file is empty.' }
  }
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
    return {
      ok: false,
      message: pt
        ? `O arquivo passa do limite de ${mb} MB para anexos.`
        : `The file is over the ${mb} MB attachment limit.`,
    }
  }

  const name = storedAttachmentName(file.name, randomBytes(4).toString('hex'))
  const path = join(ATTACHMENT_DIR, name)

  try {
    await mkdir(ATTACHMENT_DIR, { recursive: true })
    // 0600: an attachment can be anything the user had open, and the directory is shared by every
    // session on this machine.
    await writeFile(path, file.bytes, { mode: 0o600 })
  } catch {
    return {
      ok: false,
      message: pt
        ? 'Não foi possível gravar o anexo nesta máquina.'
        : 'The attachment could not be written on this machine.',
    }
  }

  // Recorded AFTER the write succeeded, so the log never claims a file that is not there. It is a
  // convenience for drawing a thumbnail later; a failure to record is not a failure to attach.
  await recordAttachmentSend(sessionId, path)

  return { ok: true, path, name }
}
