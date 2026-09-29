/**
 * promptHistory.ts — PURE: the person's own prompts in one conversation, the anchors that find them
 * again, and the three small rules the composer's "send now" and "restore" controls stand on.
 *
 * WHY THIS REPLACES A POSITION. The old "go to message" built its DOM id from the turn's POSITION in
 * the list (`ag-chat-turn-<index>`). A position is not an identity: the server answers with the END
 * of a long conversation, so when an older turn falls out of the window on a re-fetch every index
 * shifts by one and the same id names a different bubble; when an echo becomes a real turn it moves
 * from one run of bubbles to the other. The jump then landed on the wrong message, or on none. An
 * ANCHOR is built from what does not change on a re-fetch instead — who said it, when the transcript
 * recorded it, and a hash of what was said — and is resolved against the CURRENT turns at the moment
 * of the click, so a target that has left the window is reported as gone rather than scrolled
 * somewhere wrong.
 *
 * NAMESPACED BY SESSION, because two chats can be mounted at once (the workspace keeps the previous
 * one alive while the next paints) and `document.getElementById` is global.
 *
 * Nothing here touches the DOM, the network or React.
 */

import { isPersonMessage, type SentTurn } from './lastSent'
import { stripDictatedMark } from './dictationMark'
import { attachmentName, splitMessage } from './messageAttachments'

/** The fields an anchor is derived from. Structural: the chat's turns and the aside's both fit. */
export interface AnchorTurn {
  role?: string | undefined
  text?: string | undefined
  at?: string | undefined
}

/** 32-bit FNV-1a, base 36. Not a security hash — a short stable fingerprint of a message body. */
export function hashText(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** A DOM id fragment: anything outside `[A-Za-z0-9_-]` becomes `_`, so no id ever needs escaping. */
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** What identifies a turn without saying WHERE it is: role, recorded instant, body fingerprint. */
function turnKey(t: AnchorTurn): string {
  return `${(t.role ?? '?').slice(0, 1)}-${t.at ?? 'na'}-${hashText(t.text ?? '')}`
}

/**
 * One stable DOM id per turn, in the turns' own order.
 *
 * Two turns can share a key (the same words, no timestamp — two identical `continue`s), and they
 * must still get different ids, so a repeat is told apart by its ORDINAL COUNTED FROM THE NEWEST.
 * From the newest and not the oldest, because the window is trimmed at the OLD end: counting from
 * the start would renumber every repeat each time an older turn scrolled out, which is the very
 * instability this module exists to remove.
 */
export function turnAnchorIds(ns: string, turns: readonly AnchorTurn[]): string[] {
  const seen = new Map<string, number>()
  const out = new Array<string>(turns.length)
  for (let i = turns.length - 1; i >= 0; i--) {
    const key = turnKey(turns[i]!)
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    out[i] = `ag-chat-${safe(ns)}-${safe(key)}-${n}`
  }
  return out
}

/** The id of a not-yet-read message's bubble. The queue is de-duplicated by text, so text is a key. */
export function echoAnchorId(ns: string, text: string): string {
  return `ag-chat-${safe(ns)}-echo-${hashText(text)}`
}

/** One of the person's prompts, as the recent-prompts panel lists it. */
export interface PromptEntry {
  /** The bubble's DOM id RIGHT NOW — resolved from the current turns, never remembered. */
  anchor: string
  /** `echo`: sent and not in the transcript yet. `turn`: committed. */
  kind: 'turn' | 'echo'
  /** The whole message as sent, attachment lines included. */
  text: string
  /** ISO, when the transcript recorded it. Absent for an echo (it has no recorded time yet). */
  at?: string
  /** When an echo was handed over, ms — the only time a not-yet-read message has. */
  atMs?: number
  /**
   * Which appearance of THIS exact text it is, counting from the LATEST (0 = the most recent one).
   * It is what the server's rewind takes to tell two identical prompts apart. `null` for an echo:
   * it is not in the conversation's history yet, so there is nothing to rewind to.
   */
  occurrence: number | null
  /** The first row: the most recent message. */
  latest: boolean
}

export interface QueuedPrompt { text: string; at?: number }

/**
 * Every message the person sent, NEWEST FIRST.
 *
 * Not-yet-read echoes lead — by construction they are newer than anything in the transcript — and
 * are marked `echo`. Then the transcript's user turns from the end, through `isPersonMessage`, the
 * same filter `lastSentMessage` uses: a system reminder, a background-task line and a turn with no
 * text are not something anybody sent, and listing one is the "I didn't send that" defect.
 */
export function buildPromptList(
  ns: string,
  turns: readonly (SentTurn & AnchorTurn)[],
  queued: readonly QueuedPrompt[] = [],
): PromptEntry[] {
  const ids = turnAnchorIds(ns, turns)
  const out: PromptEntry[] = []
  for (let i = queued.length - 1; i >= 0; i--) {
    const q = queued[i]!
    if (q.text.trim() === '') continue
    out.push({
      anchor: echoAnchorId(ns, q.text),
      kind: 'echo',
      text: stripDictatedMark(q.text).text,
      ...(q.at !== undefined ? { atMs: q.at } : {}),
      occurrence: null,
      latest: false,
    })
  }
  const seenText = new Map<string, number>()
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (!isPersonMessage(t)) continue
    const n = seenText.get(t.text) ?? 0
    seenText.set(t.text, n + 1)
    out.push({
      anchor: ids[i]!,
      kind: 'turn',
      // Shown without the dictation mark; the rewind anchor is the FIRST line, which it never touches.
      text: stripDictatedMark(t.text).text,
      ...(t.at !== undefined ? { at: t.at } : {}),
      occurrence: n,
      latest: false,
    })
  }
  if (out[0]) out[0] = { ...out[0], latest: true }
  return out
}

/** Lowercase, diacritics removed, whitespace collapsed — so `acao` finds `ação` and case is moot. */
export function normalizeSearch(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The words plus the attachments' file names: what somebody remembers of a message and types. */
function searchable(text: string): string {
  const parts = splitMessage(text)
  return normalizeSearch([parts.text, ...parts.attachments.map(attachmentName)].join(' '))
}

/** Keep the entries whose message contains the query. An empty query keeps everything. */
export function filterPrompts(list: readonly PromptEntry[], query: string): PromptEntry[] {
  const q = normalizeSearch(query)
  if (q === '') return [...list]
  return list.filter(e => searchable(e.text).includes(q))
}

/** A one/two-line preview: the words only (attachments are drawn separately), whitespace collapsed. */
export function promptPreview(text: string, max = 240): string {
  const flat = splitMessage(text).text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/**
 * Is the anchor still one of the CURRENT turns' (or echoes')? The click-time check: an anchor that
 * is not in the loaded window is reported as gone, never handed to a scroll that would land nowhere.
 */
export function anchorIsLoaded(
  anchor: string,
  ns: string,
  turns: readonly AnchorTurn[],
  queued: readonly QueuedPrompt[],
): boolean {
  if (turnAnchorIds(ns, turns).includes(anchor)) return true
  return queued.some(q => echoAnchorId(ns, q.text) === anchor)
}

// ---------------------------------------------------------------------------------------------
// Restore

export interface RestoreVerdict {
  /** `hidden`: the harness cannot do it — draw NO control. `off`: draw it disabled, with `reason`. */
  state: 'ok' | 'off' | 'hidden'
  reason?: { pt: string; en: string }
}

/**
 * May "restore the conversation from here" be offered on a row of this session?
 *
 * ABSENT (not disabled) off Claude Code: the rewind is claude's own and nothing else has an
 * equivalent, so a disabled control would say "not now" about something that is never. Disabled with
 * a sentence while a dialog is open (the keys would land in the dialog) or the session is not
 * running (there is no pane to rewind). An echo has no place in the history to go back to.
 */
export function restoreVerdict(input: {
  harness: string
  state: string
  dialogOpen: boolean
  entryKind: 'turn' | 'echo'
}): RestoreVerdict {
  if (input.harness !== 'claude') return { state: 'hidden' }
  if (input.entryKind === 'echo') {
    return { state: 'off', reason: {
      pt: 'A sessão ainda não leu esta mensagem — não há ponto da conversa para voltar.',
      en: 'The session has not read this message yet — there is no point in the conversation to go back to.',
    } }
  }
  const running = input.state === 'working' || input.state === 'waiting' || input.state === 'waiting-approval'
  if (!running) return { state: 'off', reason: {
    pt: 'A sessão não está em execução. Reabra-a para restaurar a conversa.',
    en: 'The session is not running. Reopen it to restore the conversation.',
  } }
  if (input.dialogOpen) return { state: 'off', reason: {
    pt: 'Há uma pergunta aberta na sessão. Responda-a antes de restaurar a conversa.',
    en: 'The session has a question open. Answer it before restoring the conversation.',
  } }
  return { state: 'ok' }
}

// ---------------------------------------------------------------------------------------------
// Send now

/**
 * Is "send now" shown? Only where a queue can exist and be flushed: claude, mid-turn, with at least
 * one message waiting and no dialog open. Idle, nothing is held; on another harness the keystroke
 * does not exist.
 */
export function sendNowShown(input: {
  harness: string
  working: boolean
  queuedCount: number
  dialogOpen: boolean
}): boolean {
  return input.harness === 'claude' && input.working && input.queuedCount > 0 && !input.dialogOpen
}

/** The button's label. The count is said when it is more than one — the action is the WHOLE queue. */
export function sendNowLabel(count: number, pt: boolean): string {
  const base = pt ? 'Enviar agora' : 'Send now'
  return count > 1 ? `${base} (${count})` : base
}

/** The tooltip: what will really happen, including that earlier queued messages go with it. */
export function sendNowHint(count: number, pt: boolean): string {
  if (count > 1) {
    return pt
      ? `Envia agora as ${count} mensagens da fila, em ordem — não só a última.`
      : `Sends all ${count} queued messages now, in order — not only the last one.`
  }
  return pt
    ? 'Envia agora a mensagem da fila, sem esperar o fim do turno.'
    : 'Sends the queued message now, without waiting for the turn to end.'
}

// ---------------------------------------------------------------------------------------------
// Tail following

/**
 * Should the conversation follow its tail right now?
 *
 * A jump to an older message clears `atTail`, but the scroll events of the smooth scroll that
 * follow can set it straight back while the view is still near the bottom, and the next poll then
 * yanks the reader off the message they asked for. `holdUntil` (epoch ms) is the short window after
 * a jump in which the tail is not followed whatever the scroll position says.
 */
export function tailFollows(atTail: boolean, holdUntil: number, now: number): boolean {
  return atTail && now >= holdUntil
}
