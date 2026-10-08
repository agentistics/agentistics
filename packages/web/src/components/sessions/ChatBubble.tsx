/**
 * ChatBubble — one turn of a session's conversation.
 *
 * IT SHOWS WHAT WAS SAID, AND NOTHING ELSE. The transcript also carries the assistant's reasoning
 * and every tool call it made, and an earlier pass rendered both. It was wrong: a session that runs
 * forty commands produces forty entries nobody asked to read, and the two or three sentences that
 * were actually addressed to the user are lost in them. The reasoning is not a message either — it
 * is the assistant thinking, which the terminal view shows in full for anyone who wants it.
 *
 * So a turn with no text renders NOTHING. A turn that is only tool calls is work in progress, and
 * the state on the row already says the session is working.
 *
 * Both sides get a surface. An assistant turn rendered as bare text on the page background reads as
 * the page itself talking; the two sides are told apart by alignment and colour rather than by one
 * having a box and the other not.
 *
 * WIDE CONTENT SCROLLS INSIDE ITS OWN BOX. A code fence, a table or a long URL is routinely wider
 * than the bubble, and letting it set the width is how a message ends up outside its own card.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { stripDictatedMark } from '../../lib/dictationMark'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
// A single newline is a LINE BREAK here. Without this plugin markdown collapses it to a space, so a
// message written across several lines renders as one run-on paragraph — which is what "the
// messages are not formatted" turned out to mean. `HarnessChat` has always used it.
import remarkBreaks from 'remark-breaks'
import { ArrowUpRight, Check, ChevronDown, Clock, Copy, CornerUpLeft, Ellipsis, Forward, Image as ImageIcon, KeyRound, ListChecks, Loader, Mic, User } from 'lucide-react'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { chatNote, type ChatNoteTab } from '../../lib/chatNote'
import { openArtifacts } from '../../lib/artifactsStore'
import { useIsMobile } from '../../hooks/useIsMobile'
import { splitSlashLine } from '../../lib/slashLine'
import { hasPastedContent, pastePreview, splitPastedContent, stripInjectedBlocks, unwrapPastedContent, isQuoteOnlyPastedBlob } from '../../lib/pastedContent'
import { resolveMarkerPaths, splitImageAttachments, splitImageMarkers } from '../../lib/attachmentPreview'
import type { AttachmentMessage, AttachmentSend } from '@agentistics/core'
import { copyText } from '../../lib/clipboard'
import { bubbleMenuHeight, bubbleMenuTop } from '../../lib/bubbleMenu'
import { echoStatus } from '../../lib/echoStatus'
import { messageTime } from '../../lib/messageTime'
import { attachmentUrl, sessionViewedUrl } from '../../lib/attachmentUrl'
import { AttachmentLightbox } from './AttachmentLightbox'
import { HarnessMark } from './HarnessMark'
import type { VaultGrantMessage } from '../../lib/vaultChip'
import { card, overlay } from '../MfaSetup'
import { dialogButtonStyle } from '../../pages/settings/primitives'
import { sentSegments } from '../../lib/replyQuote'
import { QuoteBlock } from '../chat/QuoteBlock'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** The server matched this turn to a recent send from our composer. */
  composer?: boolean
  pending?: boolean
  /**
   * A background TASK this turn started, by the label the assistant gave it.
   *
   * A watcher is the one tool call worth a line in a conversation: it is long, it is usually the
   * thing the reader is waiting for, and its END is already reported. Rendered as a status line and
   * never as a message — nobody said it.
   */
  task?: { label: string; running: boolean }
  /**
   * This sat under the `user` role and no person wrote it — a background task reporting back, an
   * injected reminder, a `!` command's stdout. The value NAMES the kind; it is never the body.
   *
   * It may not render as a message: it went out over the user's own avatar, and one of them was
   * circled in a screenshot with "I didn't send that". See `chat-envelope.ts`.
   */
  system?: string
  /**
   * WHICH thing that note is about, where its body named one — a skill's invocation name today.
   *
   * `system` names a KIND, so the chip could only open the aside tab and leave the reader hunting
   * the list. Passed to `openArtifacts` so the row that was actually used scrolls into view and
   * flashes. Absent for every note whose body names nothing resolvable, and the chip then behaves
   * exactly as it always has.
   */
  systemRef?: string
  /** Carried by the transcript; deliberately not rendered here. See the header. */
  tools?: Array<{ name: string; detail?: string }>
  /** Carried by the transcript; deliberately not rendered here. See the header. */
  thinking?: string
  /**
   * The model's REASONING on its own channel (the native runtime's `reasoning` frame, TOOLS-NATIVE
   * item 5) — drawn as a COLLAPSED block above the answer, never as answer text. A separate field
   * from `thinking`, whose not-rendering above is a decision about the CLI transcripts this does not
   * revisit.
   */
  reasoning?: string
  /**
   * When this turn was written, ISO, as the transcript recorded it.
   *
   * The server has always sent it — 400 of 400 turns on a measured session — and nothing drew it.
   * Rendered under the message, the way a chat client does. Absent on a turn whose transcript
   * carried no time; the stamp is then simply not drawn, never replaced by "now".
   */
  at?: string
  /**
   * The real files behind this turn's `[Image #N]` markers, ALREADY resolved on the server through
   * the harness's own companion entry — see `chat-turn.ts`'s own doc on the field. Preferred over
   * `resolveMarkerPaths`'s own heuristic whenever present; that heuristic remains the fallback for
   * a turn this was not resolved for.
   */
  imagePaths?: string[]
  /**
   * A `!` command the person ran in Claude Code's bash mode, with what it printed — see the
   * server's `bash-mode.ts`. `text` is then the `!line` as typed. Drawn as an EXECUTED command with
   * its output folded under a chip, never as prose: markdown would eat a `*` or a `#` in it.
   */
  shell?: {
    command: string
    summary: string
    running: boolean
    output?: { stdout: string; stderr: string; truncated?: boolean }
  }
}

export interface ChatBubbleProps {
  turn: ChatTurn
  /** Session id for assistant-viewed Codex images, served by the transcript-bound route. */
  sessionId?: string
  /** What agentop typed into this session's pane, so a `[Image #N]` marker can find its file. */
  attachmentSends?: readonly AttachmentSend[]
  /** What each delivered message carried, for this conversation — see `AttachmentMessage`. */
  attachmentMessages?: readonly AttachmentMessage[]
  /**
   * When the previous PERSON's turn was recorded (`previousPersonTurnMs`) — the lower bound of the
   * messages this turn's markers may be made of. Only the list knows it; a bubble sees one turn.
   */
  markerSinceMs?: number | null
  lang: 'pt' | 'en'
  /** Which assistant said it, for the mark beside an assistant turn. */
  harness: string
  /** Read off the terminal screen and not yet committed to the transcript. Labelled as such. */
  provisional?: boolean
  /**
   * SENT, and the session has not taken it yet.
   *
   * The echo already knew this — it is retired the moment the transcript carries the same text —
   * and drew a bubble identical to a delivered one, so a message queued behind a working turn was
   * indistinguishable from one already read. On a session mid-turn that wait is minutes, and the
   * reader's only options were to assume or to send it again. Dim plus a word, never a spinner:
   * the message IS there, it is the reading that has not happened.
   */
  awaiting?: boolean
  /** How long ago the message was handed to the session, ms. Absent when that is not known. */
  awaitingSinceMs?: number
  /** Whether the session is mid-turn — the reason an unread message is normal rather than stuck. */
  awaitingWorking?: boolean
  /**
   * Quote THIS turn in the composer. Absent where the session cannot be written to — a reply
   * control on a row that will refuse the message is a control that teaches the wrong thing.
   *
   * Takes the turn rather than closing over it, so the PARENT can hand every bubble the SAME
   * function reference (one `useCallback`, not one closure per row) — the memo above only pays off
   * if `onReply` is actually stable across a re-render caused by something unrelated, like typing.
   */
  onReply?: (turn: ChatTurn) => void
  /**
   * Reply to the SELECTED PART of this turn.
   *
   * Offered only on the assistant's own messages, and only while a selection actually sits inside
   * this bubble. Same stability requirement as `onReply` — see the note above.
   */
  onReplyExcerpt?: (turn: ChatTurn, excerpt: string) => void
  /** Open the source message for a markdown quote in a sent user bubble. */
  onQuoteClick?: (quote: string, turn: ChatTurn) => void
  /**
   * A DOM id for this bubble, so something outside the conversation can scroll to it.
   *
   * The id is composed by `lastSent.ts`'s `turnAnchorId` — one rule shared by whatever renders the
   * bubble and whatever goes looking for it, so "go to message" can never hunt an id nothing wrote.
   */
  anchorId?: string
  /**
   * FORWARD this turn to other sessions (`chatForward.ts`). Offered on every settled message, the
   * source's own state notwithstanding — forwarding READS this conversation and writes elsewhere,
   * so a session that cannot take a prompt can still hand its words on. Same stability rule as
   * `onReply`.
   */
  onForward?: (turn: ChatTurn) => void
  /** Enter SELECTION MODE with this turn ticked. Same stability rule as `onReply`. */
  onSelectStart?: (turn: ChatTurn) => void
  /**
   * The conversation is in selection mode: the bubble draws a checkbox, a tap anywhere on it
   * toggles, and the per-message menu stands down — one gesture per mode.
   */
  selectMode?: boolean
  /** This turn is ticked. Only meaningful while `selectMode`. */
  selected?: boolean
  onToggleSelect?: (turn: ChatTurn) => void
  /** Metadata for a user message that granted vault credentials. Values are never carried here. */
  vaultGrant?: VaultGrantMessage
}

/** How long a finger must rest on a bubble before its menu opens, ms — the platform's own feel. */
const LONG_PRESS_MS = 480

/**
 * Memoized: a long conversation renders hundreds of these, and every one of them re-rendered on
 * every keystroke in the composer, because `draft` lives in the same component as the turns list —
 * a state change anywhere re-renders every child unless the child says it doesn't need to. That is
 * what "typing is slow and stuck" turned out to mean on a session with a real amount of history.
 * `onReply` is a fresh closure per render in the parent, so this alone would not have been enough —
 * see `SessionChat.tsx`'s `useCallback` on it.
 */

/**
 * A SYSTEM NOTE — the harness acting under the user's role, named in one phrase.
 *
 * Reported as "eu nunca sei o que eles significam": the note names a KIND and the body is
 * deliberately dropped (a `system-reminder` is a page of text nobody wants in their chat), which
 * leaves a chip whose whole content is a label about something the reader cannot see or reach.
 *
 * TWO SHAPES, and they look different on purpose. A note whose action HAS a place in the aside is
 * a button that takes you there — `openArtifacts`, the same call the edge strip makes, so it opens
 * the ASIDE and not a full screen — and it wears an arrow so the affordance is visible before the
 * click. A note with nowhere to go TELLS you instead, on tap or hover. One appearance for both
 * would make half the chips silently inert, which this product treats as indistinguishable from
 * broken.
 *
 * The explanation of a NAVIGATING chip lives in its `title`/`aria-label` rather than inline: its
 * answer is the place it takes you to, and a sentence plus a destination on one 10px chip is two
 * targets in a control that has room for one.
 */
/** A paste the harness wrapped in `<pasted_content>`: first lines, expandable. Tags and id never shown. */
function PastedBlock({ text, pt }: { text: string; pt: boolean }) {
  const [open, setOpen] = useState(false)
  const { head, total, truncated } = pastePreview(text)
  return (
    <div style={{
      margin: '6px 0', border: '1px solid var(--border-subtle)', borderRadius: 8,
      background: 'var(--bg-elevated)', overflow: 'hidden', minWidth: 0,
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 32,
          padding: '4px 10px', background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 11.5, textAlign: 'left',
        }}
      >
        <ChevronDown size={12} style={{ flexShrink: 0, transform: open ? 'none' : 'rotate(-90deg)' }} />
        <span style={{ fontWeight: 600 }}>{pt ? 'Texto colado' : 'Pasted text'}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>
          {pt ? `${total} ${total === 1 ? 'linha' : 'linhas'}` : `${total} ${total === 1 ? 'line' : 'lines'}`}
        </span>
      </button>
      <div className="ag-chat-md" style={{
        padding: '0 10px 8px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-primary)',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: open ? 360 : undefined, overflowY: open ? 'auto' : 'hidden',
      }}>
        {open ? text : head}{!open && truncated ? ' …' : ''}
      </div>
    </div>
  )
}

/** The model's reasoning, folded above its answer — `PastedBlock`'s shape, closed until asked. */
export function ReasoningBlock({ text, pt }: { text: string; pt: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="reasoning-block" style={{
      margin: '2px 0 6px', border: '1px solid var(--border-subtle)', borderRadius: 8,
      background: 'var(--bg-elevated)', overflow: 'hidden', minWidth: 0,
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 32,
          padding: '4px 10px', background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 11.5, textAlign: 'left',
        }}
      >
        <ChevronDown size={12} style={{ flexShrink: 0, transform: open ? 'none' : 'rotate(-90deg)' }} />
        <span style={{ fontWeight: 600 }}>{pt ? 'Raciocínio' : 'Reasoning'}</span>
      </button>
      {open && (
        <div style={{
          padding: '0 10px 8px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto',
        }}>{text}</div>
      )}
    </div>
  )
}

function SystemNote({ note, noteRef, pt }: { note: string; noteRef?: string; pt: boolean }) {
  const { label, help, tab } = chatNote(note, pt)
  const [shown, setShown] = useState(false)
  const isMobile = useIsMobile()

  const chip: React.CSSProperties = {
    fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)',
    padding: '3px 10px', borderRadius: 999,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
    maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    // Sleek chip dimensions on mobile and desktop
    ...(isMobile ? { padding: '4px 10px', margin: '2px 0' } : {}),
  }

  if (tab !== null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
        <button
          // The REFERENCE goes with the tab. Without it this lands at the top of a list to be
          // searched — the limitation CLAUDE.md records — and the body named the thing all along.
          onClick={() => openArtifacts(tab satisfies ChatNoteTab, noteRef)}
          {...(help ? { title: help, 'aria-label': `${label} — ${help}` } : {})}
          style={{ ...chip, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          <ArrowUpRight size={11} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
        </button>
      </div>
    )
  }

  // Nothing to go to. The chip tells you what it was instead — on TAP as well as hover, because a
  // phone has no hover and this is the half of the report that is about not understanding.
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '2px 0',
    }}>
      <button
        onClick={() => setShown(v => !v)}
        aria-expanded={shown}
        disabled={help === null}
        {...(help ? { title: help } : {})}
        style={{ ...chip, cursor: help === null ? 'default' : 'help' }}
      >
        {label}{help !== null && ' ⓘ'}
      </button>
      {shown && help !== null && (
        <span role="note" style={{
          fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
          maxWidth: '80%', textAlign: 'center',
        }}>{help}</span>
      )}
    </div>
  )
}

export const ChatBubble = memo(function ChatBubble({ turn, lang, harness, sessionId, provisional, awaiting, awaitingWorking, awaitingSinceMs, onReply, onReplyExcerpt, onQuoteClick, anchorId, attachmentSends, attachmentMessages, markerSinceMs, onForward, onSelectStart, selectMode, selected, onToggleSelect, vaultGrant }: ChatBubbleProps) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const mine = turn.role === 'user'
  const imageUrl = useCallback((path: string) => (
    !mine && sessionId ? sessionViewedUrl(sessionId, path) : attachmentUrl(path)
  ), [mine, sessionId])
  /**
   * The stamp under this message. `null` when the transcript carried no time for the turn — the
   * bubble then simply has none, which is the honest answer.
   *
   * Computed on every render on purpose: it is one `Date` and a `toLocaleTimeString`, and memoising
   * it against `Date.now()` would freeze "today" for a page left open across midnight — the one
   * case the relative wording exists to get right.
   */
  const stamp = messageTime(turn.at, pt ? 'pt' : 'en')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [grantOpen, setGrantOpen] = useState(false)
  /**
   * The RIGHT-CLICK menu, positioned where the click landed inside this bubble.
   *
   * The hover control is the discoverable way in and stays exactly where it was; this is the one
   * every messaging application has taught, and it is reachable without first finding a 24px
   * button that only appears when the pointer is over the right message.
   *
   * TWO ENTRIES. It was one, deliberately — a context menu on a conversation invites "quote",
   * "open in the terminal" and four more, each a decision about what a session can do that has not
   * been made. COPY was asked for and is not one of those: it takes text the reader has already
   * selected and puts it on their own clipboard. It touches no session, decides nothing, and is the
   * gesture the right-click was reached for in the first place. The rest of the list stays refused.
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  /** The last copy's outcome, cleared on a timer — see the note beside the button. */
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(t)
  }, [copied])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /**
   * The ONE per-message menu: `⋯` (hover on a desktop, always visible on touch), right click, and a
   * LONG PRESS on a phone all open it. Reply used to be its own corner button; it moved in here with
   * Forward, Select and Copy so a message carries one control, not four.
   */
  const hasMenu = !provisional && !awaiting && Boolean(onReply || onForward || onSelectStart)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressAt = useRef<{ x: number; y: number } | null>(null)
  /** The long press OPENED the menu — so the touch's end must not become a click. */
  const longFired = useRef(false)
  const cancelPress = useCallback(() => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }, [])
  useEffect(() => cancelPress, [cancelPress])
  /** Open the menu at a point inside this bubble, flipping it up when it would go under the composer. */
  const openMenuAt = useCallback((x: number, localY: number) => {
    const r = bodyRef.current?.getBoundingClientRect()
    const rows = [onReply, onForward, onSelectStart].filter(Boolean).length + 1
    const ground = document.querySelector('.ag-composer-ground')?.getBoundingClientRect().top
    const floor = Math.min(window.innerHeight, ground ?? window.innerHeight)
    const y = r
      ? bubbleMenuTop({ localY, anchorViewportY: r.top + localY, menuHeight: bubbleMenuHeight(rows, isMobile), floor })
      : localY
    // Inside the viewport horizontally too — a narrow bubble on the right of a phone put the menu's
    // right half off screen. 170 is the menu's own `minWidth`.
    const left = r ? Math.max(8 - r.left, Math.min(x, window.innerWidth - 8 - 170 - r.left)) : x
    setMenuAt({ x: left, y })
  }, [onReply, onForward, onSelectStart, isMobile])
  useEffect(() => {
    if (menuAt === null) return
    const close = () => setMenuAt(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuAt(null) }
    // `mousedown` rather than `click`, so it closes on the press; and on SCROLL too, because the
    // menu is anchored to a bubble that moves while the conversation does.
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menuAt])

  /**
   * The floating "reply to this excerpt" control, anchored where the selection ended.
   *
   * WHY IT EXISTS: a reply quotes the message, and the assistant's messages are long. Somebody
   * answering one sentence of a forty-line answer pays for the other thirty-nine in context they
   * are asking about nothing. Selecting the sentence is what they already do to read it.
   *
   * THE SELECTION MUST BE INSIDE THIS BUBBLE, both ends of it. A drag that starts in one message
   * and ends in another has a `toString()` that reads perfectly and belongs to neither turn, and
   * attributing it to one of them is inventing a quote. Containment is asked of the DOM rather
   * than by matching text: the bubble renders markdown, so what was selected legitimately differs
   * from `turn.text`, which is also why `markExcerpt` marks an unlocatable excerpt at both ends.
   *
   * THE TEXT IS CAPTURED NOW, not when the button is pressed: pressing a button collapses the
   * selection in some browsers, so reading it at click time reads an empty one.
   */
  const [excerpt, setExcerpt] = useState<{ x: number; y: number; text: string } | null>(null)
  const readSelection = useCallback(() => {
    if (!onReplyExcerpt || provisional || selectMode) return
    const sel = window.getSelection()
    const body = bodyRef.current
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !body) { setExcerpt(null); return }
    if (!body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) { setExcerpt(null); return }
    const text = sel.toString().trim()
    if (text === '') { setExcerpt(null); return }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const box = body.getBoundingClientRect()
    setExcerpt({
      // Below the selection's own end, clamped inside the bubble so a selection at the right edge
      // does not put the control off the pane.
      x: Math.max(0, Math.min(rect.right - box.left, box.width - 150)),
      y: Math.min(rect.bottom - box.top + 6, box.height),
      text,
    })
  }, [onReplyExcerpt, provisional, selectMode])
  useEffect(() => {
    if (excerpt === null) return
    // It goes away when the selection does — clicking elsewhere, or a keystroke that moves the
    // caret. A control offering to quote a selection that no longer exists quotes the old one.
    const check = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') setExcerpt(null)
    }
    document.addEventListener('selectionchange', check)
    window.addEventListener('scroll', () => setExcerpt(null), true)
    return () => {
      document.removeEventListener('selectionchange', check)
      window.removeEventListener('scroll', () => setExcerpt(null), true)
    }
  }, [excerpt])

  // An attachment is a PATH the composer typed into the pane (see `attachmentPreview.ts`'s header),
  // so it arrives in `turn.text` like any other line — pulled out here rather than at the source, so
  // the SAME rule reads an echoed message and its later transcript copy identically.
  // A DICTATED message carries a one-line mark for the model (`dictationMark.ts`); the person sees
  // their words and a small microphone instead of the mark.
  const { text: spokenText, dictated } = mine ? stripDictatedMark(turn.text) : { text: turn.text, dictated: false }
  // Only the person's message has composer attachment lines. Scanning assistant prose here turns
  // example names (including `{uuid}-arquivo.jpg`) and code samples into broken image chips.
  const { images, text: prose } = mine
    ? splitImageAttachments(stripInjectedBlocks(spokenText))
    : { images: [] as string[], text: spokenText }

  // And `[Image #4]` — the same question asked of what the HARNESS substituted rather than what the
  // composer typed; without this it ran into the first word of the prose (see `splitImageMarkers`).
  const { markers, text } = splitImageMarkers(prose)

  // THE SERVER'S OWN LINK WINS WHEN IT HAS ONE. Claude Code writes a marker turn's images into a
  // companion entry beside it — see `chat-turn.ts`'s `imagePaths` — which the server already
  // resolved and validated exactly, so there is nothing left to infer here. Only a turn this was
  // NOT resolved for (an older read, a companion that did not survive a truncated window, a turn
  // whose companion could not account for it exactly) falls back to `resolveMarkerPaths`'s own
  // heuristic over what agentop itself sent — otherwise null, and the chip stays, because a wrong
  // thumbnail is false and convincing where a chip is merely useless.
  const markerImages = turn.imagePaths ?? resolveMarkerPaths({
    markers,
    turnAtMs: turn.at ? Date.parse(turn.at) || 0 : 0,
    sends: attachmentSends ?? [],
    ...(attachmentMessages ? { messages: attachmentMessages } : {}),
    ...(markerSinceMs !== undefined ? { sinceMs: markerSinceMs } : {}),
  })
  const shownImages = markerImages ? [...images, ...markerImages] : images

  // A turn that said nothing AND attached nothing is not a message. Tool calls and reasoning are
  // the work between messages, and the row's state already reports that the session is working.
  if (text.trim() === '' && images.length === 0 && markers.length === 0) return null

  // NOT a message, and not drawn as one: no avatar, no bubble, no side. A dim centred note naming
  // what the harness put in the transcript, so the reply below it still has something above it
  // while nobody is credited with having typed it.
  // A BACKGROUND TASK: a dim line, unattributed, that says whether it is still going. Drawn before
  // the system note below because it is the same kind of thing — a fact about the session rather
  // than something either side said — and it carries no bubble for the same reason.
  if (turn.task) {
    const running = turn.task.running
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 10.5, lineHeight: 1.4,
          color: running ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          padding: '3px 10px', borderRadius: 999,
          background: 'var(--bg-elevated)',
          border: `1px solid ${running ? 'color-mix(in srgb, var(--anthropic-orange) 40%, transparent)' : 'var(--border-subtle)'}`,
          maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {running
            ? <Loader size={11} className="ag-working-spin" style={{ flexShrink: 0 }} />
            : <Check size={11} style={{ flexShrink: 0 }} />}
          <span>
            {running
              ? (pt ? `em segundo plano: ${turn.task.label}` : `in the background: ${turn.task.label}`)
              : (pt ? `terminou: ${turn.task.label}` : `finished: ${turn.task.label}`)}
          </span>
        </span>
      </div>
    )
  }

  if (turn.system) {
    return <SystemNote note={turn.system} noteRef={turn.systemRef} pt={pt} />
  }

  const color = (HARNESS_COLORS as Record<string, string>)[harness] ?? 'var(--text-secondary)'
  const name = (HARNESS_LABELS as Record<string, string>)[harness] ?? harness

  return (
    <div className="ag-bubble" {...(anchorId ? { id: anchorId } : {})} style={{
      display: 'flex', minWidth: 0,
      flexDirection: mine ? 'row-reverse' : 'row',
      alignItems: 'flex-start',
    }}>
      <div
        ref={bodyRef}
        onMouseUp={readSelection}
        onTouchStart={e => {
          if (!hasMenu || selectMode) return
          const t = e.touches[0]
          const r = bodyRef.current?.getBoundingClientRect()
          pressAt.current = t && r ? { x: t.clientX - r.left, y: t.clientY - r.top } : { x: 8, y: 8 }
          cancelPress()
          longFired.current = false
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null
            longFired.current = true
            if (pressAt.current) openMenuAt(pressAt.current.x, pressAt.current.y)
          }, LONG_PRESS_MS)
        }}
        onTouchMove={cancelPress}
        onTouchEnd={e => {
          cancelPress()
          // The browser follows a touch with COMPAT mouse events; that `mousedown` is exactly what
          // closes the menu (see the effect above), so a menu opened by the press closed on release.
          if (longFired.current) { longFired.current = false; e.preventDefault(); return }
          readSelection()
        }}
        onTouchCancel={cancelPress}
        onClick={selectMode && onToggleSelect ? () => onToggleSelect(turn) : undefined}
        role={selectMode ? 'checkbox' : undefined}
        aria-checked={selectMode ? Boolean(selected) : undefined}
        onContextMenu={e => {
          // Only where a reply is actually possible. Swallowing the browser's own menu to offer
          // one entry that is not there would be a control that teaches the wrong thing.
          if (!hasMenu || selectMode) return
          e.preventDefault()
          const r = bodyRef.current?.getBoundingClientRect()
          if (r) openMenuAt(e.clientX - r.left, e.clientY - r.top); else setMenuAt({ x: 8, y: 8 })
        }}
        style={{
        // `minWidth: 0` is what actually keeps wide content inside the card: without it a flex item
        // refuses to shrink below its content, and a long line pushes the bubble off the pane.
        minWidth: 0, maxWidth: mine ? (isMobile ? '85%' : '82%') : '100%',
        display: 'flex', flexDirection: 'column', gap: isMobile ? 4 : 6,
        background: mine ? 'var(--bg-elevated)' : 'var(--bg-card)',
        border: `1px solid ${selectMode && selected ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
        boxShadow: selectMode && selected ? '0 0 0 1px var(--anthropic-orange)' : undefined,
        cursor: selectMode ? 'pointer' : undefined,
        // A long press opens the menu; the platform's own callout would open over it.
        WebkitTouchCallout: hasMenu ? 'none' : undefined,
        borderRadius: isMobile ? 12 : 14,
        padding: isMobile ? (mine ? '8px 11px' : '9px 12px') : '11px 14px',
        position: 'relative',
        // Faded while the session has not read it. The TEXT stays fully legible — this is a
        // statement about delivery, not about the message being less important to read back.
        opacity: awaiting ? 0.62 : 1,
        transition: 'opacity 0.2s',
      }}>
        {/* THE HARNESS ICON MOVED INSIDE THE BUBBLE, immediately left of the name, on the same
            line (owner follow-up, screenshot 4 — "I want the harness icon on the LEFT of the
            name"). It used to sit OUTSIDE the bubble as a flex sibling, at the row's own edge —
            reported as reading like a stray mark beside the message rather than part of it. */}
        {!mine && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
            color: provisional ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
            // Room for the `⋯` / checkbox in this corner, so it never sits on the name.
            paddingRight: hasMenu || selectMode ? 24 : 0,
          }}>
            <HarnessMark harness={harness} size={14} />
            <span style={{ color }}>{name}</span>
            {provisional && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                {/* Said in words: this text was read off a terminal screen, and the transcript's
                    own version replaces it the moment the turn lands. */}
                <span>{pt ? 'escrevendo — lido da tela' : 'writing — read from the screen'}</span>
              </>
            )}
          </div>
        )}

        {/* THE USER'S AVATAR MOVED THE SAME WAY, to the TOP-RIGHT CORNER of their own bubble
            (owner follow-up, screenshot 4) — its own header line, mirroring the assistant's, with
            nothing beside it: a user message carries no name to show and no header line of its
            own before this change, so the icon is the whole of it. */}
        {mine && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 5 }}>
            {vaultGrant && (
              <button
                type="button"
                onClick={() => setGrantOpen(true)}
                title={pt ? 'Credencial anexada' : 'Credential attached'}
                aria-label={pt ? 'Credencial anexada' : 'Credential attached'}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 22, padding: 0, borderRadius: 5,
                  border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)',
                  color: 'var(--anthropic-orange)', cursor: 'pointer',
                }}
              ><KeyRound size={12} /></button>
            )}
            <span
              aria-hidden
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                width: 18, height: 18, borderRadius: 5,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
                color: 'var(--text-tertiary)',
              }}
            >
              <User size={10} />
            </span>
          </div>
        )}

        {/* THE MESSAGE'S MENU, `⋯`. Revealed with the bubble rather than standing on every message
            — a column of controls down a conversation competes with the words — and always visible
            on a touch screen (`.ag-bubble-reply`'s own rule). Always reachable by keyboard.

            THE SELECTION STILL WINS: with part of this bubble selected, Reply in the menu answers the
            excerpt and Copy copies it, exactly as the old corner button did. */}
        {hasMenu && !selectMode && (
          <button
            className="ag-bubble-reply"
            onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
            onClick={e => {
              e.stopPropagation()
              if (menuAt) { setMenuAt(null); return }
              const r = bodyRef.current?.getBoundingClientRect()
              const b = e.currentTarget.getBoundingClientRect()
              const x = r ? (mine ? b.left - r.left : Math.max(0, b.right - r.left - 170)) : 8
              openMenuAt(x, r ? b.bottom - r.top + 4 : 30)
            }}
            aria-label={pt ? 'Ações da mensagem' : 'Message actions'}
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            title={pt ? 'Responder, encaminhar, selecionar, copiar' : 'Reply, forward, select, copy'}
            // POSITION only — see `.ag-bubble-reply` for why the rest lives in the stylesheet.
            style={{ position: 'absolute', top: 6, [mine ? 'left' : 'right']: 6 } as React.CSSProperties}
          >
            <Ellipsis size={13} />
          </button>
        )}

        {/* SELECTION MODE: a checkbox in the corner the menu button used. The whole bubble is the
            target (see `onClick` above); this box only SAYS which state it is in. */}
        {selectMode && (
          <span aria-hidden style={{
            position: 'absolute', top: 7, [mine ? 'left' : 'right']: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: 5,
            border: `1.5px solid ${selected ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'}`,
            background: selected ? 'var(--anthropic-orange)' : 'transparent', color: '#fff',
          } as React.CSSProperties}>
            {selected && <Check size={12} strokeWidth={3} />}
          </span>
        )}

        {/* The right-click menu. Anchored inside the bubble at the point that was clicked. */}
        {menuAt && hasMenu && !selectMode && (
          <div
            role="menu"
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: menuAt.y, left: menuAt.x, zIndex: 40,
              minWidth: 170, padding: 4, borderRadius: 9,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            }}
          >
            {onReply && (
            <button
              role="menuitem"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setMenuAt(null)
                if (excerpt && onReplyExcerpt) { const t = excerpt.text; setExcerpt(null); onReplyExcerpt(turn, t); return }
                onReply(turn)
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 6, border: 'none',
                background: 'transparent', color: 'var(--text-primary)',
                fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              <CornerUpLeft size={13} style={{ flexShrink: 0 }} />
              {excerpt
                ? (pt ? 'Responder ao trecho' : 'Reply to excerpt')
                : (pt ? 'Responder' : 'Reply')}
            </button>
            )}

            {onForward && (
              <button
                role="menuitem"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { setMenuAt(null); onForward(turn) }}
                style={menuItemStyle(isMobile)}
              >
                <Forward size={13} style={{ flexShrink: 0 }} />
                {pt ? 'Encaminhar' : 'Forward'}
              </button>
            )}

            {onSelectStart && (
              <button
                role="menuitem"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { setMenuAt(null); setExcerpt(null); onSelectStart(turn) }}
                style={menuItemStyle(isMobile)}
              >
                <ListChecks size={13} style={{ flexShrink: 0 }} />
                {pt ? 'Selecionar' : 'Select'}
              </button>
            )}

            {/* COPY. What it copies is what the reader can SEE they selected — the excerpt when
                there is one, the whole message otherwise — so the menu never quietly takes more
                than the highlight promised. The label says which, because "copy" over a selection
                that is about to be ignored is the wrong answer given confidently. */}
            <button
              role="menuitem"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                const text = excerpt ? excerpt.text : turn.text
                setMenuAt(null)
                // Best effort, and SAID either way: `navigator.clipboard` is unavailable over plain
                // http on a non-localhost origin — which is exactly how this dashboard is reached
                // from another machine on the LAN — and a menu item that silently does nothing
                // there is the control-that-reads-as-broken this codebase argues against.
                void copyText(text).then(ok => setCopied(ok ? 'ok' : 'fail'))
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 6, border: 'none',
                background: 'transparent', color: 'var(--text-primary)',
                fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              <Copy size={13} style={{ flexShrink: 0 }} />
              {excerpt
                ? (pt ? 'Copiar trecho' : 'Copy excerpt')
                : (pt ? 'Copiar mensagem' : 'Copy message')}
            </button>
          </div>
        )}

        {/* The outcome of a copy, where the copy happened. `role="status"` so it is announced. */}
        {copied && (
          <p role="status" style={{
            margin: '4px 0 0', fontSize: 10.5, lineHeight: 1.4,
            color: copied === 'ok' ? 'var(--text-tertiary)' : 'var(--accent-red)',
            alignSelf: mine ? 'flex-end' : 'flex-start',
          }}>
            {copied === 'ok'
              ? (pt ? 'copiado' : 'copied')
              : (pt ? 'o navegador não liberou a área de transferência aqui' : 'the browser did not allow the clipboard here')}
          </p>
        )}

        {/* Reply to just what is selected. It is the only control that appears ON a selection, so
            it says which of the two replies it is in words — an icon alone here reads as the same
            button that is already sitting in the bubble's corner.

            NOT WHILE THE MENU IS OPEN. The right-click menu offers the very same verb, and both are
            anchored to the same selection, so they landed on top of each other — two "Reply to
            excerpt" for one act, one of them half-covered. Reported with a screenshot. The menu
            wins because it was opened deliberately and carries the other verbs too; the pill is the
            discoverable route for somebody who never right-clicks. */}
        {excerpt && onReplyExcerpt && menuAt === null && (
          <button
            onMouseDown={e => {
              // The press must not collapse the selection before the click lands, and must not
              // reach the document listener that closes the menu.
              e.preventDefault(); e.stopPropagation()
            }}
            onClick={() => { const t = excerpt.text; setExcerpt(null); onReplyExcerpt(turn, t) }}
            style={{
              position: 'absolute', top: excerpt.y, left: excerpt.x, zIndex: 41,
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 9px', borderRadius: 8, minHeight: 30,
              background: 'var(--bg-elevated)', border: '1px solid var(--anthropic-orange)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <CornerUpLeft size={12} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
            {pt ? 'Responder ao trecho' : 'Reply to excerpt'}
          </button>
        )}

        {/* Small squares ABOVE the text — what was attached, rendered rather than left as a bare
            path nobody can read at a glance. Absent rows carry no rule of their own: an image that
            fails to load (moved, or outside `ATTACHMENT_DIR`) falls back to a plain chip with its
            name, never a broken-image icon with nothing to click. */}
        {shownImages.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {shownImages.map((path, i) => (
              <AttachmentThumb key={path} path={path} src={imageUrl(path)} onOpen={() => setLightboxIndex(i)} />
            ))}
          </div>
        )}

        {/* The harness's own markers, as chips. There is no file behind an ordinal, so the chip says
            exactly what is known — which image of the turn this was — and offers nothing to click. */}
        {markers.length > 0 && markerImages === null && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {markers.map(n => (
              <span
                key={n}
                title={pt ? 'imagem anexada no assistente' : 'attached in the assistant'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 7px', borderRadius: 6,
                  border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)',
                  fontSize: 10.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap',
                }}
              >
                <ImageIcon size={11} style={{ flexShrink: 0 }} />
                {pt ? 'Imagem' : 'Image'} #{n}
              </span>
            ))}
          </div>
        )}

        {turn.role === 'assistant' && turn.reasoning && turn.reasoning.trim() !== '' && (
          <ReasoningBlock text={turn.reasoning.trim()} pt={pt} />
        )}

        {text.trim() !== '' && (
          <div
            className="ag-chat-md"
            style={{
              // The base is inline as well as in the sheet: a bubble whose stylesheet failed should
              // still read as a message rather than as unstyled 14px page text.
              minWidth: 0, overflowWrap: 'anywhere',
              fontSize: 13.5, lineHeight: 1.65, color: 'var(--text-primary)',
            }}
          >
            {/* AN INVOCATION IS NOT PROSE. A message that opens with `/name` is a command to the
                harness, and in a column of prose it reads as prose. It is split off and drawn in
                the accent — the same colour the panel's "use this skill" button wears, so the
                thing you pressed and the thing that appears are visibly the same act. The rule is
                `slashLine.ts` and it is anchored: a `/home/...` path is not a command. */}
            {turn.shell ? <ShellRunBlock run={turn.shell} pt={pt} /> : (() => {
              const ownComposerMessage = turn.composer === true || isQuoteOnlyPastedBlob(text)
              const renderedText = ownComposerMessage ? unwrapPastedContent(text) : text
              if (!ownComposerMessage && hasPastedContent(text)) {
                return (
                  <>
                    {splitPastedContent(text).map((seg, i) => seg.kind === 'paste'
                      ? <PastedBlock key={i} text={seg.text} pt={pt} />
                      : <ReactMarkdown key={i} remarkPlugins={[remarkGfm, remarkBreaks]}>{seg.text}</ReactMarkdown>)}
                  </>
                )
              }
              const { command, rest } = splitSlashLine(renderedText)
              if (command === '' && mine && onQuoteClick) {
                // EVERY quote, each its own collapsible block that goes back to its source, and
                // each REPLY right under the passage it answers, in the order it was written —
                // `[quote 1] reply 1 [quote 2] reply 2` (`sentSegments`), read from the text as the
                // person typed it (`renderedText` unwraps a composer paste).
                const segs = sentSegments(renderedText)
                if (segs.some(seg => seg.kind === 'quote')) {
                  return (
                    <>
                      {segs.map((seg, i) => seg.kind === 'quote' ? (
                        <div key={i} style={{ marginBottom: 8 }}>
                          <QuoteBlock text={seg.text} pt={pt} onOpen={() => onQuoteClick(seg.text, turn)} />
                        </div>
                      ) : (
                        <div key={i} style={{ marginBottom: i < segs.length - 1 ? 8 : 0 }}>
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{seg.text}</ReactMarkdown>
                        </div>
                      ))}
                    </>
                  )
                }
              }
              if (command === '') {
                return <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{renderedText}</ReactMarkdown>
              }
              return (
                <>
                  <span style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontWeight: 650, color: 'var(--anthropic-orange)',
                  }}>{command}</span>
                  {rest.trim() !== '' && (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{rest}</ReactMarkdown>
                  )}
                </>
              )
            })()}
          </div>
        )}

        {/* WHEN IT WAS SAID, under the message, the way a chat client does it. Asked for directly.
            
            Inside the bubble and aligned to its own side, so it reads as a fact about THIS message
            rather than as a line between two of them. It is not drawn while the message is still
            awaiting delivery: the status line below already occupies that spot and says something
            more urgent, and a message that has not landed has no send time to state. The `title`
            carries the whole instant — the stamp is abbreviated by design. */}
        {!awaiting && stamp && (
          <time
            dateTime={turn.at}
            title={stamp.full}
            style={{
              fontSize: 9.5, lineHeight: 1.2, color: 'var(--text-tertiary)',
              alignSelf: mine ? 'flex-end' : 'flex-start',
              // Never wraps and never widens the bubble: it is four to twelve characters, and a
              // stamp that pushed a narrow bubble wider would make every short message look long.
              whiteSpace: 'nowrap', flexShrink: 0, opacity: 0.75,
            }}
          >{stamp.label}</time>
        )}
        {dictated && (
          <span
            title={pt ? 'Mensagem ditada pelo microfone' : 'Dictated message'}
            aria-label={pt ? 'Mensagem ditada pelo microfone' : 'Dictated message'}
            style={{ display: 'inline-flex', alignSelf: 'flex-end', color: 'var(--text-tertiary)', opacity: 0.75 }}
          >
            <Mic size={10} />
          </span>
        )}

        {/* The label sits INSIDE the bubble, under the text: it is a fact about this message, and
            a line floating beside the bubble would read as another message. `role="status"` so a
            screen reader is told, since the fading alone says nothing to one. */}
        {awaiting && (() => {
          // The wording is `echoStatus`'s, not this file's — see it for why the sentence leads with
          // DELIVERY rather than with waiting.
          const st = echoStatus(awaitingSinceMs ?? null, awaitingWorking === true, pt ? 'pt' : 'en')
          return (
            <div role="status" style={{
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10,
              // A wait long enough to be worth a second look is the ONLY one that changes colour.
              // Colouring every unread message would make the ordinary case look like a fault,
              // which is the mistake the old wording already made.
              color: st.notable ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              alignSelf: mine ? 'flex-end' : 'flex-start',
            }}>
              <Clock size={10} style={{ flexShrink: 0 }} />
              <span>{st.text}</span>
            </div>
          )
        })()}
      </div>

      {lightboxIndex !== null && (
        <AttachmentLightbox
          paths={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          lang={lang}
          srcFor={imageUrl}
        />
      )}
      {grantOpen && vaultGrant && (
        <VaultGrantModal grant={vaultGrant} pt={pt} isMobile={isMobile} onClose={() => setGrantOpen(false)} />
      )}
    </div>
  )
})

function VaultGrantModal({ grant, pt, isMobile, onClose }: { grant: VaultGrantMessage; pt: boolean; isMobile: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div style={{ ...overlay, zIndex: 3000 }} role="dialog" aria-modal="true" aria-label={pt ? 'Credencial anexada' : 'Credential attached'} onClick={onClose}>
      <div style={{ ...card, maxWidth: 520, width: '100%', maxHeight: '88vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700 }}>
          <KeyRound size={16} /> {pt ? 'Credencial anexada' : 'Credential attached'}
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Mensagem' : 'Message'}</div>
        <div style={{ marginTop: 5, padding: '9px 10px', borderRadius: 7, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{grant.excerpt}</div>
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Credenciais liberadas' : 'Credentials granted'}</div>
        <div style={{ marginTop: 5, display: 'grid', gap: 6 }}>
          {grant.credentials.map((c, i) => (
            <div key={`${c.env}-${i}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 7, fontSize: 12 }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{c.name}</strong> · {c.field}</span>
              <code style={{ color: 'var(--anthropic-orange)' }}>${c.env}</code>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)' }}>{pt ? 'Liberado em' : 'Granted at'}: {new Date(grant.grantedAt).toLocaleString(pt ? 'pt-BR' : 'en-US')}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{pt ? 'Fechar' : 'Close'}</button>
        </div>
      </div>
    </div>
  )
}

/** One attachment, as a small square. Falls back to a plain chip when the image fails to load. */
function AttachmentThumb({ path, src, onOpen }: { path: string; src: string; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const name = path.split('/').pop() ?? path

  if (broken) {
    return (
      <span
        title={path}
        style={{
          display: 'inline-flex', alignItems: 'center', maxWidth: 160,
          padding: '5px 8px', borderRadius: 8, minWidth: 0,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          fontSize: 11, color: 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
    )
  }

  return (
    <button
      onClick={onOpen}
      title={name}
      aria-label={name}
      style={{
        display: 'block', width: 72, height: 72, padding: 0, borderRadius: 9, overflow: 'hidden',
        border: '1px solid var(--border-subtle)', cursor: 'pointer', flexShrink: 0,
        background: 'var(--bg-elevated)',
      }}
    >
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </button>
  )
}

/** One row of the message menu. 44px on a phone, where it is opened with a thumb. */
function menuItemStyle(isMobile: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 6, border: 'none',
    background: 'transparent', color: 'var(--text-primary)',
    fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
  }
}

/**
 * A `!` command, EXECUTED: the line as typed, then a chip — `commandSummary`'s one line, plus how
 * much it printed — that unfolds the output. Folded by default: a build's log is the reason the
 * terminal exists, and a conversation that unrolls it for every `!ls` stops being a conversation.
 * The output scrolls inside its own box, never the page (a 390px screen and a 200-column log).
 */
function ShellRunBlock({ run, pt }: { run: NonNullable<ChatTurn['shell']>; pt: boolean }) {
  const [open, setOpen] = useState(false)
  const out = run.output
  const lines = out ? [out.stdout, out.stderr].filter(t => t !== '').join('\n').split('\n').length : 0
  const hasOut = out !== undefined && (out.stdout !== '' || out.stderr !== '')
  const mono = 'var(--font-mono, ui-monospace, monospace)'
  const status = run.running
    ? (pt ? 'executando…' : 'running…')
    : out === undefined
      ? (pt ? 'executado' : 'ran')
      : !hasOut
        ? (pt ? 'sem saída' : 'no output')
        : pt ? `${lines} ${lines === 1 ? 'linha' : 'linhas'}` : `${lines} ${lines === 1 ? 'line' : 'lines'}`
  const pre: React.CSSProperties = {
    margin: 0, padding: '8px 10px', borderRadius: 8,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
    fontFamily: mono, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-secondary)',
    whiteSpace: 'pre', overflow: 'auto', maxHeight: 320, maxWidth: '100%',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ fontFamily: mono, fontWeight: 600, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        <span style={{ color: 'var(--anthropic-orange)' }}>!</span>{run.command}
      </div>
      <button
        type="button"
        className="ag-tap"
        onClick={() => { if (hasOut) setOpen(o => !o) }}
        aria-expanded={hasOut ? open : undefined}
        disabled={!hasOut}
        title={hasOut ? (pt ? 'Mostrar/ocultar a saída' : 'Show/hide the output') : undefined}
        style={{
          alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
          padding: '3px 9px', borderRadius: 999, cursor: hasOut ? 'pointer' : 'default',
          background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
          color: run.running ? 'var(--anthropic-orange)' : 'var(--text-secondary)', fontSize: 11,
        }}
      >
        {run.running
          ? <Loader size={11} className="ag-working-spin" style={{ flexShrink: 0 }} />
          : <Check size={11} style={{ flexShrink: 0 }} />}
        <span style={{ fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {run.summary}
        </span>
        <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>· {status}</span>
        {hasOut && <ChevronDown size={12} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />}
      </button>
      {open && out && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          {out.truncated && (
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
              {pt ? 'Saída longa — mostrando o final.' : 'Long output — showing the end.'}
            </span>
          )}
          {out.stdout !== '' && <pre style={pre}>{out.stdout}</pre>}
          {out.stderr !== '' && (
            <>
              <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>stderr</span>
              <pre style={pre}>{out.stderr}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
