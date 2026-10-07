/**
 * SessionChat — one live session, read as a conversation.
 *
 * TWO SOURCES, each used for what it is good at, because neither can do the whole job:
 *
 * - The TRANSCRIPT (`/api/fleet/chat`) is the truth — role-tagged, complete, exactly what the
 *   assistant wrote. It arrives per TURN, because Claude writes a message to its JSONL once the
 *   message is finished. It can never stream token by token.
 * - The FRAME (`/api/fleet/stream`, captured twice a second) is live — it is the terminal, and the
 *   text appears on it as it is produced. But it is a rendered TUI, wrapped to the pane width with
 *   a status strip and an input box in it.
 *
 * So completed turns are bubbles from the transcript, and the turn IN FLIGHT is drawn from the
 * frame and replaced by the transcript's version the moment it lands. The live bubble is labelled
 * as read-from-the-screen and never becomes history: a misread frame is corrected within seconds,
 * while a misread turn kept as history would be wrong forever.
 *
 * A SENT MESSAGE IS ECHOED IMMEDIATELY. It reaches the session the instant it is typed into the
 * pane, but it only enters the transcript when the harness writes it, which is a poll or two later
 * — so pressing enter appeared to do nothing while the message had in fact been delivered. That was
 * reported. The echo is dropped as soon as the transcript carries the same text, so it can never
 * become a duplicate or survive a send that silently failed.
 *
 * WHERE IT CANNOT EXIST IT SAYS SO. The link from a live session to its transcript is exact only
 * for Claude Code, which names our tmux session in its own record. Everywhere else the server
 * refuses in words rather than showing some other conversation from the same directory under this
 * session's name — a confident wrong answer the reader has no way to detect.
 */

import { reopeningLabel, withReopening } from '../../lib/reopeningStore'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { flushSync } from 'react-dom'
import { GROW_AT_PX, GROW_TURNS, INITIAL_TURNS, shownToInclude, windowStart } from '../../lib/turnWindow'
import { ComposerAttachButton, ComposerAttachments, ComposerMicButton, ComposerSendButton, ComposerShell, ComposerToolbar, composerFieldStyle } from '../chat/ComposerShell'
import { mutedTooltip, useMutedKeys } from '../../lib/notifyMenu'
import { toggleSessionMuted } from '../../lib/mutedSessions'
import { markDictated, stripDictatedMark } from '../../lib/dictationMark'
import { AlertTriangle, ArrowDown, Bell, BellOff, ChevronUp, CornerUpLeft, History, Loader, Mic, Paperclip, RotateCcw, Send, SlidersHorizontal, Square, X } from 'lucide-react'
import { hasSomethingToSend, stopShown as isStopShown } from '../../lib/composerAction'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { AttentionMarkLine, RecordedBlock } from './AttentionMarks'
import { placeAttention, type ChatAttentionMark, type ChatRecorded } from '../../lib/sessionRecorded'
import type { FleetActionId, FleetRow } from '../../lib/fleet'
import { modeStyle } from '../../lib/modeStyle'
import { modeCycles, modeMenuFor, modeMenuPlacement, type MenuPlacement } from '../../lib/modeMenu'
import { ApprovalCard } from './ApprovalCard'
import { TypedModel } from './ModelSelect'
import { approvalIdentity } from '../../lib/approvalQuestion'
import { dialogAnswersToRetire } from '../../lib/dialogAnswerEcho'
import { ChatBubble, type ChatTurn } from './ChatBubble'
import { WorkingNote } from './WorkingNote'
import { useTerminalStream } from '../../hooks/useTerminalStream'
import { isImagePath, openComposerLightbox, previousPersonTurnMs } from '../../lib/attachmentPreview'
import { promptCountLabel } from '../../lib/promptCount'
import { splitImageAttachments } from '../../lib/attachmentPreview'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { AttachmentLightbox } from './AttachmentLightbox'
import { detectCompacting, liveTurnText, stripAnsi } from '../../lib/liveTurn'
import { scratchKey, sessionScratch } from '../../lib/sessionScratch'
import { chatReadAt, firstFrameStale, refreshChat, subscribeChat } from '../../lib/chatFeed'
import { composerMaxHeight } from '../../lib/composerHeight'
import { isPickerSelectKey } from '../../lib/pickerKeys'
import { nudgeFleet } from '../../lib/fleet'
import { artifactsFromTurns, hasUnlistedWrites, type Artifact } from '../../lib/sessionArtifacts'
import type { LiveTurn } from '../../lib/artifactTabs'
import { MAX_ATTACHMENTS, attachmentRoom, planPaste } from '../../lib/pastePlan'
import { appendDictation, dictationError, dictationLocale, dictationSupport, insecureAlternative, splitDictation } from '../../lib/dictation'
import { modelSwitchLine, modelSwitchReason } from '../../lib/modelSwitch'
import {
  applySkill, emptyPickerReason, filterSkills, flattenGroups, groupSkills, slashMisplaced,
  slashQuery, stepSkill,
} from '../../lib/skillMenu'
import {
  applyAtServer, applyAtTool, atLevel, atQuery, atServerStatusText, atToolViewReason,
  emptyAtServerReason, emptyAtToolReason, filterAtServers, findAtServer, resolveAtToolView,
  type MenuMcpServer, dropEmptyAtTrigger,
} from '../../lib/atMenu'
import { addReply, composeReply, markExcerpt, normalizeComposer, quoteAll, quoteFor, splitQuotedDraft, unquoteLines, stripQuotedLines, type ReplyTarget } from '../../lib/replyQuote'
import { QuoteBlock } from '../chat/QuoteBlock'
import {
  composeQuoted, locateExcerpt,
} from '../../lib/quoteCards'
import { ROW_FLASH } from '../../lib/noteFocus'
import { pendingEchoes, sessionIdentityKey } from '@agentistics/core'
import { SendNowControl, type SendNowRun } from './SendNowControl'
import { AgentisticsLoader } from '../AgentisticsLoader'

import {
  applyDraftRequest, consumeDraftRequest, getDraftRequest, useDraftRequest,
} from '../../lib/composerStore'
import { commandToken, knownCommands } from '../../lib/commandToken'
import { draftSegments, mirrorScrollTop, needsMirror } from '../../lib/commandMirror'
import { knownServers, mentionTokens } from '../../lib/mentionTokens'
import { commandNotFoundNotice } from '../../lib/commandNotice'
import {
  anchorIsLoaded, buildPromptList, echoAnchorId, sendNowHint, sendNowLabel, sendNowShown,
  tailFollows, turnAnchorIds, type PromptEntry,
} from '../../lib/promptHistory'
import { RecentPromptsPanel } from './RecentPromptsPanel'
import { goToTurn } from '../../lib/turnScroll'
import { findTurnIndex, registerChatSearchTarget } from '../../lib/chatSearchBridge'
import { attachmentName, splitMessage } from '../../lib/messageAttachments'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { handleComposerDrop } from '../../lib/mentionInsert'
import { REPO_DRAG_MIME, readRepoDrag } from '../../lib/repoDrag'
import { useNavigate } from 'react-router-dom'
import { useFleet } from '../../lib/fleet'
import {
  applySessionMention, expandSessionMentions, filterMentionCandidates, hashPickerShown, hashQuery, isSameSession,
  sessionMentionTokens, shortSessionId,
} from '../../lib/sessionMention'
import {
  appendToDraft, composeForward, copyTurnsText, draftedNotice, forwardBlock, forwardable,
  selectedTurns, toggleTurn,
} from '../../lib/chatForward'
import { chatSelection } from '../../lib/chatSelection'
import { turnKey as turnKeyOf } from '../../lib/chatForward'
import { buildPickRows } from '../../lib/sessionPick'
import { sessionPath } from '../../lib/sessionRoute'
import { copyText } from '../../lib/clipboard'
import { SessionPickModal } from './SessionPickModal'
import { VaultCodeAsk, VaultPicker } from '../vault/VaultPicker'
import { loadVault } from '../../lib/vaultApi'
import { grantStep, UNLOCK_FIRST_LINE } from '../../lib/vaultGrantFlow'
import { ensureVaultOpen } from '../vault/VaultUnlockHost'
import { applyVaultChip, expandVaultChip, hasVaultChip, removeVaultChip, vaultChipTokens, vaultGrantMessage, vaultTrigger, type VaultSelection } from '../../lib/vaultChip'
import { grantSession, listGrantRecords, withStepUp, type GrantRecord } from '../../lib/vaultPersonal'
import { hasPasskeyHere, mobileState, passkeySupport, phoneGesture } from '../../lib/passkey'

import type { AttachmentMessage, AttachmentSend, CostBasis, HarnessId, SessionMeta } from '@agentistics/core'
import { SessionStatsMenu } from './SessionStatsMenu'
import type { SessionStats } from '../../lib/sessionStats'
import type { ChatSource } from './chatSource'
import { ConfirmModal } from '../../pages/settings/primitives'
import { caretOfSelection } from '../../lib/selectionCaret'
import { SourceSettings } from './SourceSettings'

/** How long a successful "send now" keeps its sentence on screen. */
const SEND_NOW_RESULT_MS = 6000

interface ChatPayload {
  turns: ChatTurn[]
  unavailable?: string
  /** LIVE.2: the times a person was asked something, from the journal. HISTORY — never a control. */
  attention?: ChatAttentionMark[]
  /** LIVE.2: numbers only, for a conversation whose transcript is gone (accompanies `unavailable`). */
  recorded?: ChatRecorded
  live: boolean
  /** Already-localized: these turns are the END of a longer conversation. See `chat-web.ts`. */
  older?: string
  /** Messages the SERVER is holding for this conversation — see `pending-prompts.ts`. */
  pending?: { text: string; at: number }[]
  /**
   * What agentop typed into this session's pane, and when — so a `[Image #N]` marker the harness
   * substituted for a path can find its file again. Absent when nothing was ever attached here.
   */
  attachmentSends?: AttachmentSend[]
  /** What each delivered message CARRIED, for this conversation — see `AttachmentMessage`. */
  attachmentMessages?: AttachmentMessage[]
}

/**
 * WHAT THE COMPOSER'S CONTEXT GAUGE NEEDS to open the SAME card the desktop header's old metrics
 * tab opened (design item 3, owner 2026-09-27: "círculo de métricas no composer, que abre pra
 * cima"). `session` (a `ControlSession`) already carries `task`/`model`/`effort`/`conversationId`/
 * `id`/`harness` directly, so this bundle only holds what it does NOT — the store's own record for
 * the conversation and the money settings, neither of which lives on the fleet row.
 *
 * Deliberately a bundle and not five loose props: it is the exact same reading `SessionStatsMenu`
 * has always taken (`sessions/SessionsPage.tsx`'s own mobile header call is the template this
 * mirrors), so a caller with no data source for it simply omits the prop and the gauge does not
 * render — never a control open on numbers nobody supplied.
 */

/**
 * The composer's saved state for one conversation, normalised: quotes in the list, words in the
 * field (`normalizeComposer`). A draft from the marker/card composer is first turned back into plain
 * `> ` text (`composeQuoted`). Written back when it changed, so the old shape is converted once.
 */
function loadComposer(id: string): { draft: string; replies: ReplyTarget[] } {
  const rawDraft = sessionScratch.readDraft(id)
  const rawReplies = sessionScratch.readReply(id)
  const plain = rawDraft.includes('\u2063') && rawReplies.length > 0 ? composeQuoted(rawDraft, rawReplies) : rawDraft
  const out = normalizeComposer(plain, rawReplies)
  if (out.draft !== rawDraft) sessionScratch.writeDraft(id, out.draft)
  if (JSON.stringify(out.replies) !== JSON.stringify(rawReplies)) sessionScratch.writeReply(id, out.replies)
  return out
}

export interface SessionComposerMetrics {
  /** The store's record for this conversation, or `undefined` when it has none yet. */
  meta: SessionMeta | undefined
  currency: 'USD' | 'BRL'
  brlRate: number
  costBasis: CostBasis
  /** `C/A` for this session's OWN harness — `null` when no plan covers it, which removes the
   *  basis toggle inside the card rather than offering one whose only outcome is "no plan". */
  planFactor: number | null
  /** Open the delivery this session is filed under — absent where there is nowhere to go. */
  onOpenTask?: (ref: string) => void
  /** Open the aside's Live tab, on the step running right now when there is one. */
  onOpenLive?: (ref?: string) => void
  /** Open the full reading — the aside's own Metrics tab. Absent when the store has no record of
   *  this conversation, the same fact that decides whether that tab exists at all. */
  onOpenFull?: () => void
  /** The card's figures already computed (a NATIVE session's engine usage) — see `SessionStatsMenu`. */
  stats?: SessionStats
}

export interface SessionChatProps {
  session: ControlSession
  /** The shaped row, which carries the parsed dialog and what may be done about it. */
  row?: FleetRow
  lang: 'pt' | 'en'
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number; occurrence?: number; confirm?: boolean })
    => Promise<{ ok: boolean; message: string; id?: string; confirm?: boolean }>
  /**
   * The files this session has touched, reported up as the conversation is read.
   *
   * The artifacts panel is a sibling of this component, not a child, and the list is derived from
   * the very turns this one already polls. Fetching the conversation a second time to build the
   * same list would be two pollers disagreeing about one session — so it is handed over instead.
   */
  /**
   * A REOPEN LANDED, and its NEW id.
   *
   * The composer's Reopen button used to keep only the message, on the belief that "the page
   * follows it there". Nothing followed it: a reopen retires the row it was asked about, so the id
   * in the URL stopped naming anything and the page fell through to the fleet overview — reported
   * as "reabro uma sessão e ele me joga pra tela de sessions".
   *
   * A CALLBACK and not a `navigate()` here, for the reason the old comment gave and was right
   * about: navigating from inside the composer would be this component deciding where the app
   * goes. It reports the id; the page decides. The same callback the row's own menu already gets
   * (`SessionActions.onOpened`), so the two Reopen buttons on one screen cannot land differently.
   */
  onReopened?: (id: string) => void
  onArtifacts?: (a: {
    artifacts: Artifact[]
    loading: boolean
    unavailable?: string
    /**
     * Already-localized: the conversation is a WINDOW onto a longer one.
     *
     * Handed over for the same reason the turns are: every list the panel builds is built from
     * these turns and inherits their cap, so the panel has to be able to say so instead of showing
     * an empty gallery that reads as "there was never anything here".
     */
    older?: string
    /** Writes this reader cannot name — see `hasUnlistedWrites`. */
    unlisted: boolean
    /** The turns themselves, for the panel's LIVE tab. Handed over rather than re-fetched. */
    turns: readonly LiveTurn[]
  }) => void
  /** The composer's context gauge (design item 3) — see `SessionComposerMetrics`'s own header.
   *  Absent means the caller has no data source for it and the gauge does not render. Desktop
   *  only: mobile keeps its existing header metrics button (`SessionsPage.tsx`'s own `touch`
   *  variant), so this is never a second, redundant control on a phone. */
  metrics?: SessionComposerMetrics
  /**
   * WHERE THE CONVERSATION COMES FROM (UI.UNIFY, `chatSource.ts`). Absent = the harness transcript,
   * the terminal screen and the fleet's verbs, exactly as before. The native runtime passes one.
   */
  source?: ChatSource
  /** Focus the existing composer once when a compact overlay opens it. */
  focusComposerOnMount?: boolean
}

// How often the conversation is re-read — and for how long it keeps being read after you leave —
// belongs to `chatFeed.ts`, which is the one place that decides it for every surface.

/** How long a stale first frame goes unannounced before the "updating" line appears. */
const REFRESH_NOTICE_MS = 400

// How tall the composer's field may grow is `composerHeight.ts` — a share of the viewport rather
// than a constant, because a fixed number is most of a phone and a sliver of a desktop.

/**
 * How far from the bottom still counts as "at the tail", in px.
 *
 * Kept small on purpose: a working session's live terminal frame re-renders this view on every
 * frame the SSE channel delivers (`useTerminalStream`), and each one re-runs the follow effect
 * below. At the old 120px, scrolling up by less than one ordinary message bubble still read as
 * "at the tail" — so the very next frame yanked the reader straight back down mid-reply, which is
 * exactly the thing this whole mechanism exists to prevent.
 */
const TAIL_SLACK = 24

interface Attachment { name: string; path: string }

export function SessionChat({ session, row, lang, act: actProp, onArtifacts, onReopened, metrics, source, focusComposerOnMount }: SessionChatProps) {
  // Every verb goes through the source when there is one (the native runtime's send/stop/answer).
  const act = source?.act ?? actProp
  const pt = lang === 'pt'
  /** Touch targets grow on a phone and nowhere else — 44px on a desktop is a row of buttons. */
  const isMobile = useIsMobile()
  /**
   * Both of these OUTLIVE this component, in `sessionScratch` — see that module for why they get
   * different storage.
   *
   * The conversation starts from the cache so returning to a session paints immediately instead of
   * showing an empty column while a fetch that reads a local file completes. The poll below still
   * fires on mount and replaces it, so the cache is never the answer, only the first frame.
   *
   * The draft starts from the person's own words. Losing typed text to a click is the one thing
   * here that cannot be recovered from anywhere — a conversation re-fetches, a paragraph does not.
   */
  /**
   * WHAT THE SCRATCH BELONGS TO — the conversation, never this row.
   *
   * One conversation is reachable through several rows: an `exited` managed row deliberately does
   * not cover its conversation, so the same conversation is also listed as a `closed:<id>` row you
   * can reopen, and every reopen mints a new managedId for it. Keyed on the row, closing a session
   * threw away its cached turns and the paragraph somebody had typed into it. See `scratchKey`.
   */
  const scratchId = scratchKey(session)

  const [feedPayload, setPayload] = useState<ChatPayload | null>(() => sessionScratch.readChat(scratchId) as ChatPayload | null)
  // A SOURCE's turns ARE the payload (`chatSource.ts`) — derived, not copied in an effect, so the
  // first paint already shows them.
  const sourceTurns = source?.turns
  const sourceUnavailable = source?.unavailable
  const hasSource = source !== undefined
  const sourcePayload = useMemo<ChatPayload | null>(() => (
    sourceTurns === null || sourceTurns === undefined
      ? (sourceUnavailable ? { turns: [], live: true, unavailable: sourceUnavailable } : null)
      : { turns: sourceTurns, live: true }
  ), [sourceTurns, sourceUnavailable])
  const payload = hasSource ? sourcePayload : feedPayload
  /**
   * The frame on screen is one this session cached a while ago, and a fresh read is on its way.
   *
   * Only ever true for a first frame that is genuinely BEHIND (`firstFrameStale`) — the tab was
   * hidden, or the warm window closed while you were away. Saying nothing there is what makes the
   * conversation appear to change on its own; saying it on every mount would be a label that
   * flashes for 150 ms and means nothing, which is why the marker itself also waits (see
   * `showRefreshing`).
   */
  const [refreshing, setRefreshing] = useState(() => firstFrameStale(chatReadAt(scratchId), Date.now()))
  /**
   * The draft and its quote stack, READ TOGETHER and normalised: quotes live in the list drawn above
   * the field, never as `> ` text inside it (`normalizeComposer`). A draft saved by an older version
   * kept them inline; this lifts them out on the way in, and writes the result back once.
   */
  const [loaded] = useState(() => loadComposer(scratchId))
  const [draft, setDraft] = useState(loaded.draft)

  /**
   * Every change to the draft, PERSISTED against the session it belongs to.
   *
   * A `useEffect` on `[session.id, draft]` was the obvious shape and is wrong: on a switch it runs
   * once with the NEW id and the OLD draft still in state, which writes one session's half-written
   * prompt into another's slot. Naming the session at the moment of the edit removes that window
   * entirely — the id and the text are read together, so they can never disagree.
   */
  const editDraft = useCallback((next: string | ((prev: string) => string)) => {
    setDraft(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeDraft(scratchId, v)
      return v
    })
  }, [scratchId])


  /**
   * A KEY CHANGE IS NOT ALWAYS A SESSION CHANGE, and treating it as one is what took the focus.
   *
   * `scratchKey` answers `row:<id>` while a row has no `conversationId` and `conv:<id>` once it
   * learns one — and a live session learns it MID-USE, the moment the poller can prove the link.
   * The reload then ran while somebody was typing: every read moved to a slot holding nothing, so
   * `payload` came back `null`, the composer's whole subtree was replaced by the "loading"
   * paragraph, and the focused textarea left the DOM — taking the half-written draft with it.
   * Reported as "eu to digitando e do nada o foco sai do campo de input".
   *
   * The ROW is what says whether this is the same session. When it is, the scratch is CARRIED to
   * the new key and nothing else moves, so the change becomes invisible — which is what it always
   * should have been.
   *
   * ONE effect decides this, not two: a second effect on the same key cannot ask "is this a switch"
   * after the first has already recorded the answer.
   */
  const shownId = useRef(scratchId)
  const shownRow = useRef(session.id)
  useEffect(() => {
    if (shownId.current === scratchId) return
    const sameSession = shownRow.current === session.id
    if (sameSession) sessionScratch.migrate(shownId.current, scratchId)
    shownId.current = scratchId
    shownRow.current = session.id
    if (sameSession) return
    // A GENUINE switch. Everything per-conversation is read back from the other session's own slot;
    // the scroll position is the one thing not restored, because opening mid-history is
    // disorienting.
    landedRef.current = false
    setAtTail(true)
    setPayload(sessionScratch.readChat(scratchId) as ChatPayload | null)
    setRefreshing(firstFrameStale(chatReadAt(scratchId), Date.now()))
    const next = loadComposer(scratchId)
    setDraft(next.draft)
    setReplyTo(next.replies)
    setEcho(sessionScratch.readEchoes(scratchId))
    setAttached(sessionScratch.readAttachments(scratchId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scratchId])
  const [sending, setSending] = useState(false)
  /** Dictation. `recognitionRef` holds the live recogniser so a second click stops it. */
  const [listening, setListening] = useState(false)
  /**
   * What the recogniser is hearing RIGHT NOW, before it has settled on it.
   *
   * Shown beside the field and never written into the draft: an interim result is a guess the
   * recogniser replaces as it hears more. It is the whole of "see the capture happening" — with
   * `interimResults` off, a person speaking saw an unchanged field and concluded the microphone was
   * broken, which is exactly what was reported.
   */
  const [heard, setHeard] = useState('')
  /**
   * THIS DRAFT HOLDS DICTATED TEXT — set when the recogniser settles on words, cleared when the
   * message goes or the draft is emptied. The send then tells the model the message was transcribed
   * (`dictationMark.ts`), so a misheard name reads as a mishearing, not as what was meant.
   */
  const dictatedRef = useRef(false)
  // A draft emptied by hand no longer holds anything dictated.
  useEffect(() => { if (draft === '') dictatedRef.current = false }, [draft])
  const recognitionRef = useRef<{ stop: () => void; abort?: () => void; onresult: unknown } | null>(null)
  const dictation = useMemo(
    () => dictationSupport(typeof window === 'undefined' ? undefined : (window as never), pt ? 'pt' : 'en'),
    [pt],
  )
  /** The composer's "more options" menu — dictation and the model live in it. */
  const [moreOpen, setMoreOpen] = useState(false)
  /** The menu AND its button, so an outside-click handler can tell "inside" from "outside". */
  const moreMenuRef = useRef<HTMLDivElement | null>(null)
  const modeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [modeMenuPos, setModeMenuPos] = useState<MenuPlacement | null>(null)
  /** This session's notification switch — the mute follows the conversation (`sessionIdentityKey`). */
  const notifyKey = sessionIdentityKey(session)
  const notifyMuted = useMutedKeys().includes(notifyKey)

  /**
   * Start or stop dictation.
   *
   * The recognised text is APPENDED to the draft and nothing is sent: what reaches the session is
   * still what the user chose to send, exactly as if they had typed it. No audio leaves the
   * browser — the recognition is the browser's own, and this product uploads nothing.
   */
  const toggleDictation = useCallback(() => {
    if (listening) { recognitionRef.current?.stop(); return }
    const w = window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    try {
      const rec = new Ctor() as unknown as {
        lang: string; continuous: boolean; interimResults: boolean
        start: () => void; stop: () => void
        onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
        onend: (() => void) | null
        onerror: ((e: { error?: string }) => void) | null
      }
      rec.lang = dictationLocale(pt ? 'pt' : 'en')
      rec.continuous = true
      // ON. See `heard`: without it nothing reaches the screen until a phrase is over.
      rec.interimResults = true
      // Both decisions are PURE and tested (`dictation.ts`): which results this event contributed,
      // and where they land in what is already typed. This loop used to read `e.results` from index
      // 0 on every event while `continuous` is true — and that list is CUMULATIVE, so every event
      // re-emitted the whole session and the draft grew "one", "one one two", "one one two one two
      // three". `resultIndex` is the index of the first result the event changed, which is exactly
      // what this event contributed.
      rec.onresult = e => {
        const { final, interim } = splitDictation(e)
        // Only the settled half is kept. The rest is shown and thrown away on the next event.
        if (final !== '') { dictatedRef.current = true; editDraft(d => appendDictation(d, final)) }
        setHeard(interim)
      }
      // Both end the same way. A recogniser that stopped on its own (a timeout, a denied
      // permission) must not leave the button lit — a control that says it is listening when it
      // is not is worse than one that never started.
      rec.onend = () => { setListening(false); setHeard(''); recognitionRef.current = null }
      rec.onerror = e => {
        setListening(false)
        setHeard('')
        recognitionRef.current = null
        // The REASON reaches the screen. This handler used to discard its event, so a refused
        // permission, an unreachable recognition service, a missing microphone and a moment of
        // silence all looked identical: the button lit up and went out. A button that fails
        // silently is indistinguishable from a broken one.
        // `aborted` (our own stop, or the send ending it) has no sentence and must not clear another notice.
        const why = dictationError(e?.error ?? 'unknown', pt ? 'pt' : 'en')
        if (why) setNotice(why)
      }
      rec.start()
      recognitionRef.current = rec
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [listening, pt])

  /**
   * SENDING ENDS THE DICTATION.
   *
   * The microphone used to stay on after a send, so it went on listening into a composer that had
   * just been emptied: the tail of a sentence still being recognised landed in the NEXT draft, and
   * the tab's microphone indicator stayed lit for a message already delivered. What was said up to
   * the send is what was sent — so the recogniser is detached FIRST (a result arriving on the way
   * down would otherwise be appended to the fresh draft) and then aborted, which, unlike `stop`,
   * discards whatever it had not settled on yet. Pressing the microphone again starts a new one.
   */
  const endDictationForSend = useCallback(() => {
    const rec = recognitionRef.current
    if (!rec) return
    rec.onresult = null
    recognitionRef.current = null
    try { (rec.abort ?? rec.stop).call(rec) } catch { /* already ended */ }
    setListening(false)
    setHeard('')
  }, [])

  // A click anywhere else closes the model menu. Requiring a second click on the button is the
  // behaviour of a toggle, and a dropdown is not one — every menu in this app and every menu the
  // reader has used elsewhere dismisses on an outside click, so needing to find the button again
  // reads as the menu being stuck. `mousedown` rather than `click`, so it closes on the press
  // instead of waiting for a release that may land somewhere else.
  useEffect(() => {
    if (!moreOpen) return
    const close = (e: MouseEvent) => {
      // A click INSIDE the menu (picking a model) must not be eaten by this — that path closes the
      // menu itself, and closing here first would cancel the pick.
      if (moreMenuRef.current?.contains(e.target as Node)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    // Escape too: a menu that can only be dismissed with the mouse is one a keyboard cannot leave.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  useEffect(() => {
    if (!modeMenuOpen) return
    const close = (e: MouseEvent) => {
      const target = e.target as Element
      if (!modeButtonRef.current?.contains(target) && !target.closest?.('[data-mode-menu]')) {
        setModeMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModeMenuOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [modeMenuOpen])

  // A recogniser left running after this panel unmounts keeps the tab's microphone indicator on
  // for a session nobody is looking at.
  useEffect(() => () => { recognitionRef.current?.stop() }, [])

  /**
   * The models this harness offers, from `/api/fleet/new` — the SAME source the New session wizard
   * reads, so the two lists cannot disagree about what a harness accepts. Fetched once when the
   * picker is first opened rather than on mount: most sessions are read, not re-modelled.
   *
   * The LABEL is displayed and the ID is sent. `modelSwitch.ts` records what happens if that is
   * reversed: `/model` matches the id, so "Opus 5" typed into a live session answers
   * `Model 'Opus 5' not found` — a silent no-op the user reads as a successful switch.
   *
   * TWO SHAPES, because the labelled one may not be there. A server carrying `models`
   * (`{ id, label }`) is read as such; one that only knows `modelSuggestions` (bare ids) is read
   * as ids labelled by themselves, which is exactly today's behaviour. The web bundle can be newer
   * than the server it is talking to — that is the same reasoning `chatEnabled` and the BSON date
   * readers already follow — and the wrong answer here would be an EMPTY picker on a machine whose
   * `/model` works perfectly.
   */
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  /** The list is the server's fallback table, so a typed id is offered too — see `ModelSelect`. */
  const [modelFreeText, setModelFreeText] = useState(false)
  // A SOURCE with its own settings (the native runtime) gives its model list and switch itself.
  const sourceControls = source?.controls
  const modelReason = useMemo(
    () => (sourceControls?.model ? null : modelSwitchReason(row?.harness ?? '', pt ? 'pt' : 'en')),
    [row, pt, sourceControls?.model],
  )
  useEffect(() => {
    if (sourceControls?.model || modelReason || !row?.harness) return
    let alive = true
    fetch(`/api/fleet/new?lang=${pt ? 'pt' : 'en'}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: {
        harnesses?: { id: string; models?: { id: string; label: string }[]; modelSuggestions?: string[]; modelFreeText?: boolean }[]
      } | null) => {
        if (!alive || !d?.harnesses) return
        const h = d.harnesses.find(x => x.id === row.harness)
        setModels(h?.models ?? (h?.modelSuggestions ?? []).map(id => ({ id, label: id })))
        setModelFreeText(h?.modelFreeText === true)
      })
      .catch(() => { /* no list, no picker — the control simply does not appear */ })
    return () => { alive = false }
  }, [row?.harness, modelReason, pt, sourceControls?.model])
  const menuModels = sourceControls?.model ? sourceControls.model.options : models
  const menuFreeText = sourceControls?.model ? sourceControls.model.freeText : modelFreeText

  /**
   * The session's skills. Fetched when the menu is FIRST opened, not on mount: most sessions are
   * read rather than driven, and answering this walks directories on the host.
   *
   * `null` means "not asked yet" and is not the same as `[]`, which is a real "this harness has
   * none" — the same distinction the fleet's own pollers keep between a failed read and an empty
   * one. `skillsNote` carries the server's sentence when there is one.
   */
  const [skills, setSkills] = useState<{ name: string; description: string }[] | null>(null)
  const [skillsNote, setSkillsNote] = useState<string | null>(null)

  /**
   * TYPING `/` OPENS THE PICKER. Every decision it can get wrong is in `skillMenu.ts` — when the
   * trigger is live, how the list groups, how it filters, and what an insertion writes.
   *
   * The caret is tracked because the trigger is read from the text BEFORE it, not from the whole
   * draft: a `/` typed into the middle of a paragraph is not an invocation, and a picker that
   * opened there would take the arrow keys from someone writing prose.
   */
  const [caret, setCaret] = useState(0)
  /**
   * Escape closes the picker while the `/word` it was triggered by is still on screen. Reset when
   * the trigger goes away, so the NEXT command opens it again — a picker dismissed once and
   * permanently is a control that stops working with no way to tell why.
   */
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const skillPickerRef = useRef<HTMLDivElement | null>(null)
  const slashText = useMemo(() => slashQuery(draft.slice(0, caret)), [draft, caret])
  useEffect(() => { if (slashText === null) setSlashDismissed(false) }, [slashText])
  // A new query is a new list; keeping the old index would leave the highlight on whichever entry
  // happens to sit at that position now, which is not the one anybody was looking at.
  useEffect(() => { setSlashIndex(0) }, [slashText])
  const slashGroups = useMemo(() => {
    if (slashText === null || skills === null) return []
    return groupSkills(filterSkills(skills, slashText), pt ? 'pt' : 'en')
  }, [skills, slashText, pt])
  const slashFlat = useMemo(() => flattenGroups(slashGroups), [slashGroups])
  // Keep the highlighted entry in view. The list scrolls internally, so a cursor stepped past the
  // fold is invisible and still the thing enter acts on — the same defect the cockpit's own lists
  // record. `nearest`, so it never yanks the list around for an entry already on screen.
  useEffect(() => {
    const el = skillPickerRef.current?.querySelector(`[data-skill-index="${slashIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashGroups])
  /**
   * Narrow the skill list.
   *
   * A real machine here has 49 of them, in a box 180px tall — scrolling that to find one is the
   * same as not having the list. Matching is on the NAME and the DESCRIPTION, because half of these
   * are named for what they are (`superpowers:brainstorming`) and half for a tool
   * (`wrangler`), and only the description tells you which is which.
   */
  const [skillQuery, setSkillQuery] = useState('')
  const shownSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase()
    if (q === '' || skills === null) return skills ?? []
    return skills.filter(sk =>
      sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q))
  }, [skills, skillQuery])
  useEffect(() => {
    // `session.id`, never `row?.id`: `row` is an OPTIONAL prop and its absence silently skipped the
    // fetch, so the menu sat on "Reading…" forever and looked like a machine with no skills
    // installed. The route takes a session id, and `session` is the required prop — there is no
    // reason for this to depend on the other one being present.
    // TWO ways in now: the menu, and a `/` typed into the field. The list is the same list, so it
    // is read once and shared — a second fetch per door would walk the host's directories twice.
    if ((!moreOpen && slashText === null) || skills !== null) return
    let alive = true
    fetch(`/api/fleet/skills?id=${encodeURIComponent(session.id)}&lang=${pt ? 'pt' : 'en'}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { skills?: { name: string; description: string }[]; reason?: string } | null) => {
        if (!alive) return
        setSkills(d?.skills ?? [])
        setSkillsNote(d?.reason ?? null)
      })
      .catch(() => { if (alive) setSkills([]) })
    return () => { alive = false }
  }, [moreOpen, slashText, skills, session.id, pt])

  /**
   * TYPING `@` REFERENCES AN MCP SERVER — two levels, the second reached by typing `:` after a
   * server's name, exactly as asked for ("com : uma lista de ferramentas aparece"). Every decision
   * — the trigger, the two levels, the filter, what a pick writes — lives in `atMenu.ts`; this is
   * only the wiring, mirroring the `/` picker above rather than inventing a second interaction
   * model.
   *
   * `null` is "not asked yet", same distinction `skills` keeps: `/api/mcp/tools` answers server
   * NAMES instantly but a `pending` one's tool count arrives later, which is why this keeps
   * POLLING (below) for as long as the picker could still be showing one.
   */
  const [mcpServers, setMcpServers] = useState<MenuMcpServer[] | null>(null)
  /**
   * The references in the draft that point at a server this machine actually has.
   *
   * Derived on every render from the draft and the server list, exactly like `cmdToken` — which is
   * what makes deleting a character un-mark a reference with nothing to invalidate. Empty while the
   * list has not arrived: a mark is read at a glance and believed, so it may never stand over
   * something unverified. See `mentionTokens.ts`.
   */
  const mentions = useMemo(
    // Session chips (`#«title · id»`, `sessionMention.ts`) are references too, and are painted by
    // the same mirror as the MCP ones. They need no list to vouch for them: the chip carries its
    // own id, and an edited chip simply stops matching.
    () => [...mentionTokens(draft, knownServers(mcpServers)), ...sessionMentionTokens(draft), ...vaultChipTokens(draft)],
    [draft, mcpServers],
  )

  /**
   * VAULT.PERSONAL §8.5 — the `:vault` chip. Typing `:vault` opens the picker; "Confirm" writes ONE chip
   * carrying names only, and the ids stay here. Clicking the chip reopens the picker. On send the
   * session is granted exactly this selection (the gesture, fresh) and the chip becomes the granted
   * `vault://` references plus a briefing — never a value.
   */
  const [vaultSel, setVaultSel] = useState<VaultSelection | null>(null)
  const [vaultPickerOpen, setVaultPickerOpen] = useState(false)
  const [vaultTriggerSeen, setVaultTriggerSeen] = useState<number | null>(null)
  const [vaultCodeAsk, setVaultCodeAsk] = useState<null | ((c: string | null) => void)>(null)
  const askVaultCode = useCallback(() => new Promise<string | null>(res => setVaultCodeAsk(() => (c: string | null) => { setVaultCodeAsk(null); res(c) })), [])
  useEffect(() => {
    const at = vaultTrigger(draft.slice(0, caret))
    if (at !== null && at !== vaultTriggerSeen) { setVaultTriggerSeen(at); setVaultPickerOpen(true) }
    if (at === null && vaultTriggerSeen !== null) setVaultTriggerSeen(null)
  }, [draft, caret, vaultTriggerSeen])
  useEffect(() => { if (!hasVaultChip(draft) && vaultSel && !vaultPickerOpen) setVaultSel(null) }, [draft, vaultSel, vaultPickerOpen])
  /** The grant for THIS session: on a phone with its passkey the gesture is the passkey; otherwise the service asks (Windows Hello). */
  async function grantVault(sel: VaultSelection) {
    const ids = sel.items.map(i => i.id), gids = sel.groups.map(g => g.id)
    const ms = await mobileState()
    // VAULT.UI2: open + this computer → no gesture; locked → say why, unlock ONCE, then no more prompts.
    const here = ms.ok && ms.loopback
    if (here) {
      const v = await loadVault()
      if (grantStep({ loopback: true, locked: v.kind !== 'failed' && v.view.state === 'locked' }) === 'unlock-first') {
        setNotice(UNLOCK_FIRST_LINE[pt ? 'pt' : 'en'])
        if (!(await ensureVaultOpen(`personal-grant:${session.id}`))) return { ok: false as const, code: 'locked', sentence: pt ? 'O cofre continua trancado; nada foi enviado.' : 'The vault is still locked; nothing was sent.', status: 423 }
      }
      return withStepUp(c => grantSession(session.id, ids, gids, c), askVaultCode)
    }
    if (ms.ok && !ms.loopback && passkeySupport(window) === 'ok' && hasPasskeyHere(ms, window.location.hostname)) {
      const g = await withStepUp(c => phoneGesture('personal-grant', session.id, c), askVaultCode)
      if (!g.ok) return g
      return withStepUp(c => grantSession(session.id, ids, gids, c, g.gestureToken), askVaultCode)
    }
    return withStepUp(c => grantSession(session.id, ids, gids, c), askVaultCode)
  }
  /** Escape closes the picker while the `@word` it was triggered by is still on screen — see `slashDismissed`. */
  const [atDismissed, setAtDismissed] = useState(false)
  const [atIndex, setAtIndex] = useState(0)
  const atPickerRef = useRef<HTMLDivElement | null>(null)
  const atText = useMemo(() => atQuery(draft.slice(0, caret)), [draft, caret])
  useEffect(() => { if (atText === null) setAtDismissed(false) }, [atText])
  // A new query (server filter OR tool filter) is a new list — see `slashIndex`'s own reasoning.
  useEffect(() => { setAtIndex(0) }, [atText])
  const atLvl = useMemo(() => (atText === null ? null : atLevel(atText)), [atText])

  useEffect(() => {
    // Fetched once, the first time the `@` picker opens — same reasoning as the skill fetch just
    // above: most sessions are read rather than driven, and answering this starts every configured
    // server's command.
    if (atText === null || mcpServers !== null) return
    let alive = true
    const q = session.cwd ? `?projectPath=${encodeURIComponent(session.cwd)}` : ''
    fetch(`/api/mcp/tools${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { servers?: MenuMcpServer[] } | null) => { if (alive) setMcpServers(d?.servers ?? []) })
      .catch(() => { if (alive) setMcpServers([]) })
    return () => { alive = false }
  }, [atText, mcpServers, session.cwd])

  useEffect(() => {
    // A `pending` server's tool count is not yet known — `/api/mcp/tools` never waits for it (see
    // its own header), so getting past `pending` means asking again. Only while the picker could
    // still be showing the answer, and stopped the moment nothing is pending any more.
    if (atText === null || mcpServers === null || !mcpServers.some(s => s.status === 'pending')) return
    const q = session.cwd ? `?projectPath=${encodeURIComponent(session.cwd)}` : ''
    const t = setTimeout(() => {
      fetch(`/api/mcp/tools${q}`)
        .then(r => (r.ok ? r.json() : null))
        .then((d: { servers?: MenuMcpServer[] } | null) => { if (d?.servers) setMcpServers(d.servers) })
        .catch(() => { /* the next poll tries again */ })
    }, 1500)
    return () => clearTimeout(t)
  }, [atText, mcpServers, session.cwd])

  /** The SERVER level's filtered list — empty until `mcpServers` has answered. */
  const atServers = useMemo(() => {
    if (mcpServers === null || atLvl === null || atLvl.level !== 'server') return []
    return filterAtServers(mcpServers, atLvl.serverText)
  }, [mcpServers, atLvl])
  /** The TOOL level's resolved view — `null` until both the servers and the level are known. */
  const atTools = useMemo(() => {
    if (mcpServers === null || atLvl === null || atLvl.level !== 'tool') return null
    return resolveAtToolView(mcpServers, atLvl.serverText, atLvl.toolText)
  }, [mcpServers, atLvl])
  /** The flat, navigable list for THIS level — servers, or a ready server's tools. */
  const atFlatLen = atLvl?.level === 'tool'
    ? (atTools?.kind === 'tools' ? atTools.tools.length : 0)
    : atServers.length
  // Same reasoning as the skill picker's own scroll effect — a cursor stepped past the fold is
  // invisible and still the thing enter acts on.
  useEffect(() => {
    const el = atPickerRef.current?.querySelector(`[data-at-index="${atIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [atIndex, atServers, atTools])

  /** Rule 4: a bare server mention, no `:` typed. Writes `@name ` and closes. */
  const insertAtServer = useCallback((name: string) => {
    const at = textareaRef.current?.selectionStart ?? caret
    const out = applyAtServer(draft, at, name)
    editDraft(out.text)
    setCaret(out.caret)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(out.caret, out.caret)
    })
  }, [draft, caret, editDraft])

  /**
   * A tool picked at the tool level. Writes `@server:tool ` and REOPENS an empty `@server:`
   * trigger right after it — see `applyAtTool`'s own header for why that is the whole mechanism
   * behind choosing more than one before the picker closes.
   */
  const insertAtTool = useCallback((server: string, tool: string) => {
    const at = textareaRef.current?.selectionStart ?? caret
    const out = applyAtTool(draft, at, server, tool)
    editDraft(out.text)
    setCaret(out.caret)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(out.caret, out.caret)
    })
  }, [draft, caret, editDraft])

  /**
   * THE `#` PICKER — mention ANOTHER SESSION (`sessionMention.ts`). Same shape as the `@` picker
   * above: the trigger is read from the text before the caret, Escape dismisses it while the `#word`
   * is still on screen, and a pick writes a chip into the draft without sending anything.
   *
   * The candidates are the FLEET's own rows, read through the shared poll (`useFleet` is refcounted,
   * so this costs no request of its own), with this session left out.
   */
  const { fleet, act: fleetAct } = useFleet(lang)
  const [hashDismissed, setHashDismissed] = useState(false)
  const [hashIndex, setHashIndex] = useState(0)
  const hashPickerRef = useRef<HTMLDivElement | null>(null)
  const hashText = useMemo(() => hashQuery(draft.slice(0, caret)), [draft, caret])
  useEffect(() => { if (hashText === null) setHashDismissed(false) }, [hashText])
  useEffect(() => { setHashIndex(0) }, [hashText])
  const hashRows = useMemo(
    () => (hashText === null ? [] : filterMentionCandidates(fleet.sessions, hashText, session)),
    [hashText, fleet.sessions, session],
  )
  useEffect(() => {
    const el = hashPickerRef.current?.querySelector(`[data-hash-index="${hashIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hashIndex, hashRows])
  const insertMention = useCallback((row: FleetRow) => {
    const at = textareaRef.current?.selectionStart ?? caret
    const out = applySessionMention(draft, at, row, pt)
    if (!out) return
    editDraft(out.text)
    setCaret(out.caret)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(out.caret, out.caret)
    })
  }, [draft, caret, editDraft, pt])

  /** Switch the model mid-conversation by TYPING the harness's own command — see modelSwitch.ts. */
  const switchModel = useCallback(async (model: string) => {
    setMoreOpen(false)
    if (sourceControls?.model) {
      const refused = await sourceControls.model.switch(model)
      if (refused) setNotice(refused)
      return
    }
    const line = modelSwitchLine(row?.harness ?? '', model)
    if (!line) return
    await act({ id: row!.id, action: 'prompt', text: line })
  }, [row, act, sourceControls])

  const [notice, setNotice] = useState<string | null>(null)
  const [atTail, setAtTail] = useState(true)
  /**
   * THE RECENT-PROMPTS PANEL — open or not. It replaced the single-message recall dialog; its own
   * views (list, full message, restore confirmation) and its Escape handling live in the panel.
   * The History button is held so focus goes back to it when the panel closes: a dialog that drops
   * the keyboard on the page body is one a keyboard user has to find their way back from.
   */
  const [promptsOpen, setPromptsOpen] = useState(false)
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  /**
   * Until when the conversation must NOT follow its tail. A jump to an older message clears
   * `atTail`, but the smooth scroll that follows fires scroll events that can set it straight back
   * while the view is still near the bottom, and the next poll would then yank the reader off the
   * message they asked for. See `tailFollows`.
   */
  const holdTailUntil = useRef(0)
  /** Messages sent from here and not yet seen in the transcript. See the header. */
  const [echo, setEcho] = useState<string[]>(() => sessionScratch.readEchoes(scratchId))

  /**
   * Every change to the echo list, persisted against the session it belongs to.
   *
   * Same shape as `editDraft`, and the same reason: a message that was DELIVERED and has not
   * reached the transcript yet has no other copy anywhere. Losing it to a navigation is losing the
   * only record that it was sent — reported as "mandei pela interface e ele simplesmente sumiu".
   */
  const editEcho = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    setEcho(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeEchoes(scratchId, v)
      return v
    })
  }, [scratchId])

  /**
   * The message being replied to.
   *
   * There is no reply THREAD to send: the transport types a line into a pane, and these CLIs have
   * one linear conversation. So a reply is a QUOTE — the quoted lines are prefixed with `> ` and
   * sent above what you write, which is what the assistant will actually see and is the same thing
   * mail has always done. Saying it plainly beats a UI that implies threading the session cannot do.
   */
  const [replyTo, setReplyTo] = useState<ReplyTarget[]>(loaded.replies)

  /**
   * Every change to the reply target, PERSISTED against the session it belongs to.
   *
   * IT IS KEPT, and that is a decision rather than an oversight: the quote is PREPENDED at send
   * time, so a draft restored without its target sends a different message from the one that was
   * composed — the same half-restore the attachments already avoid. It is safe to keep because it
   * is TEXT and not a pointer: the quote is a copy of what the turn said, so nothing has to resolve
   * against a transcript that has since been re-fetched. Same shape as `editDraft`, and the same
   * reason for that shape — the id and the value are read together, so a session switch can never
   * write one conversation's reply into another's slot.
   */
  const editReply = useCallback((next: ReplyTarget[] | ((prev: ReplyTarget[]) => ReplyTarget[])) => {
    setReplyTo(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeReply(scratchId, v)
      return v
    })
  }, [scratchId])

  /**
   * Files written to THIS MACHINE, whose paths go into the message.
   *
   * That is what an attachment can be here: the composer types a line into a tmux pane, so there is
   * no channel a byte array could travel down — but every one of these CLIs reads a file it is
   * pointed at. The chip says the name; the message carries the path.
   */
  const [attached, setAttached] = useState<Attachment[]>(() => sessionScratch.readAttachments(scratchId))
  /**
   * Which attached image the composer is showing full-size, or `null`.
   *
   * A thumbnail here was a picture you could not open — reported exactly that way — while the very
   * same square in a SENT message opens `AttachmentLightbox`. The component is reused rather than
   * copied: what you attached and what you sent are the same picture, so they get the same viewer.
   * Its scope is what is attached RIGHT NOW, which is the caller's decision to make (see that
   * component's header) and is the only list this control can honestly step through.
   */
  const [composerLightbox, setComposerLightbox] = useState<number | null>(null)
  /**
   * The images among what is attached, in the order the strip draws them.
   *
   * Only images: a text attachment has no picture to step to, and including it would make
   * `ArrowRight` land on a blank frame. Derived at the render rather than stored, so removing one
   * cannot leave this disagreeing with the strip beside it.
   */
  const composerImages = attached.filter(a => isImagePath(a.path)).map(a => a.path)
  /** The character count under the caret's own field. `null` while it is empty — see `promptCount.ts`. */
  const countLabel = promptCountLabel(stripQuotedLines(draft), pt ? 'pt' : 'en')
  /** …and the index that survives an edit made while the overlay is open. See `openComposerLightbox`. */
  const composerLightboxAt = openComposerLightbox(composerLightbox, composerImages.length)

  /**
   * Every change to the attachment list, persisted against the session it belongs to — the same
   * shape and the same reason as `editDraft`. An attachment IS part of what somebody composed:
   * restoring the words and dropping the image is a half-restore, reported as exactly that.
   */
  const editAttached = useCallback((next: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    setAttached(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeAttachments(scratchId, v)
      return v
    })
  }, [scratchId])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!focusComposerOnMount) return
    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [focusComposerOnMount, session.id])
  /** Has this conversation been placed at its end yet? Opening mid-history is disorienting. */
  const landedRef = useRef(false)
  /**
   * THE MESSAGE SCROLLER'S OWN RESERVED GUTTER (owner: "simplesmente nao ta alinhado os cards de
   * mensagens como deveriam estar" — bubbles and the composer must share the same left/right
   * edges). `scrollbarGutter: 'stable'` on the scroller below keeps ITS OWN centred column from
   * shifting as the conversation grows past the viewport (see that style's own header), but the
   * composer sits in a SEPARATE, never-scrolling sibling box: reserving the gutter on only one of
   * the two is a defect wearing the shape of a fix — the scroller's content box is now narrower by
   * whatever the browser reserves, while the composer keeps centring in the FULL width, which is
   * the exact mismatch reported (a later bubble, inside the narrowed scroller, sits flush with the
   * composer; an earlier one measured before this fix — or on a wider render — does not).
   *
   * Measured ONCE, not tracked by a `ResizeObserver`: the reservation is a fact about the browser,
   * OS and zoom level, not about the conversation's own content, so — unlike the scroller's height —
   * it has no reason to change while this component is mounted. Spent as `paddingRight` on the
   * composer's own column, below, rather than giving that column a matching `overflow: hidden` (the
   * more obvious mirror of `scrollbarGutter`) — the skill picker floats ABOVE that exact box via
   * `position: absolute; bottom: 100%`, and clipping it was the one property this fix could not
   * reach for.
   */
  const [chatGutterPx, setChatGutterPx] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setChatGutterPx(el.offsetWidth - el.clientWidth)
  }, [])

  /**
   * THE SCROLL AREA RUNS THE FULL HEIGHT OF THE PANEL (owner, 2026-09-27: "a conversa deveria rolar
   * a altura toda do painel, com o composer flutuando por cima do fim da lista"). The composer used
   * to be a `flexShrink: 0` SIBLING of the scroller, which is what left its scrollbar's own track
   * stopping short at the composer's top edge instead of running to the panel's true bottom — a flex
   * column always hands the scroller `container height − composer height`, sibling or not. The
   * composer is now `position: absolute` (see its own style, below) — OUT of the flex flow entirely,
   * so the scroller (still the flex item that fills the column) gets the WHOLE height, and the
   * composer floats over its bottom edge instead of pushing it up.
   *
   * `composerHeight` is what keeps the LAST message (and the "trabalhando" line under it) from
   * landing behind that float: spent as the scroller's own bottom padding, below, plus `12` for
   * breathing room. MEASURED, never assumed — the composer grows with a multi-line draft
   * (`maxComposerH`, its own field's ceiling), and a constant sized for one line would let the
   * composer's own growth silently swallow the last visible line of the conversation, exactly the
   * "confident zero" this codebase refuses everywhere else applied to a pixel count instead of a
   * metric. A `ResizeObserver` on the composer's own ground element catches every cause it can grow
   * for — a longer draft wrapping to a new line, an attachment chip added, the language toggle
   * changing a label's width — without this component having to enumerate them.
   */
  const [composerHeight, setComposerHeight] = useState(0)
  const composerObserver = useRef<ResizeObserver | null>(null)
  const setComposerGroundEl = useCallback((el: HTMLDivElement | null) => {
    composerObserver.current?.disconnect()
    composerObserver.current = null
    if (el === null) return
    // `getBoundingClientRect().height`, not the observer entry's own `contentRect` — that one is the
    // CONTENT box (excludes this element's own padding), and the composer ground carries real
    // padding (`paddingTop`/`paddingBottom`, below) that has to count toward what the scroller
    // reserves for it, or the last message would still peek out from under the field by that much.
    const measure = () => setComposerHeight(el.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    composerObserver.current = ro
  }, [])
  useEffect(() => () => composerObserver.current?.disconnect(), [])

  /**
   * Insert the picked skill into the draft. IT DOES NOT SEND — that rule already exists in the
   * "more options" menu and does not change here: most skills take an argument, and what reaches
   * the session is what the person chose to send.
   *
   * The caret is restored on the NEXT frame because React has to have written the new value into
   * the field before a selection range inside it means anything.
   */
  const insertSkill = useCallback((name: string) => {
    const at = textareaRef.current?.selectionStart ?? caret
    const out = applySkill(draft, at, name)
    editDraft(out.text)
    setCaret(out.caret)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(out.caret, out.caret)
    })
  }, [draft, caret, editDraft])

  /**
   * A different session is a different conversation — but "different" is not "unknown".
   *
   * This used to blank everything, INCLUDING the payload, and it ran on mount as well as on a
   * switch: so a cached conversation was wiped one tick after it was read, and the empty column the
   * cache exists to remove came straight back. It restores from `sessionScratch` instead, which is
   * the single place a switch is handled now.
   *
   * What is genuinely per-conversation and NOT restorable still goes: the scroll position, because
   * opening mid-history is disorienting. Everything else is READ BACK from the other session's own
   * slot — including the reply target, which used to be blanked here: it names a turn in the OTHER
   * conversation, so it may never survive the switch, but each session keeps its own and gets it
   * back. What must never happen is one session's quote appearing under another's name, and a
   * per-id read is what rules that out.
   */


  /** The ceiling, re-measured when the window changes size. */
  const [maxComposerH, setMaxComposerH] = useState(() => composerMaxHeight(
    typeof window === 'undefined' ? 0 : window.innerHeight,
  ))
  useEffect(() => {
    const read = () => setMaxComposerH(composerMaxHeight(window.innerHeight))
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])

  /**
   * Grow the field WITH the draft, up to the ceiling, then let it scroll internally.
   *
   * `rows={1}` plus a CSS `maxHeight` alone never grows: a textarea's own height stays fixed at
   * its `rows` unless something sets it explicitly, so a multi-line draft either scrolled inside a
   * single visible line or was invisible past it — "I can't see my own prompt". Resetting to
   * `'auto'` before reading `scrollHeight` is required: skip it and a field that GREW once can only
   * ever read its own (already tall) scrollHeight back, so deleting text never shrinks it again.
   */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxComposerH)}px`
  }, [draft, maxComposerH])

  /**
   * Ask for the transcript NOW, outside the interval.
   *
   * The interval is tuned for watching (`CHAT_POLL_MS`), and the two moments a reader is actually
   * waiting are not on it: the instant a message is sent, and the instant a turn ends. On both, the
   * answer changed and the next scheduled read is up to three seconds away — which is the whole of
   * "as mensagens chegam de forma travada". A ref rather than state, so nudging never re-renders
   * and never restarts the interval it lives beside.
   */
  const nudgeChat = useRef<() => void>(() => {})

  /*
   * THE CONVERSATION IS READ BY `chatFeed`, NOT BY THIS COMPONENT.
   *
   * The poll used to live here, which meant it existed only while this view was mounted — and
   * mounting is what returning to a session IS. So the cached first frame was exactly as old as
   * the time spent elsewhere: leave mid-turn, come back two minutes later, and the conversation
   * on screen was the one you left, ending at your own last message, with every reply since
   * arriving in one jump a moment later. Reported as "por um instante fica meu último prompt ali
   * e, do nada, carrega todas as novas mensagens".
   *
   * The feed keeps reading it for a few minutes after the last watcher leaves, so the frame this
   * mount paints from the cache is current. Everything else is unchanged: it still asks on mount,
   * still polls at the same cadence while watched, and a failed read still keeps the conversation
   * on screen rather than blanking it.
   *
   * A BACKGROUND TAB still does not poll — Chrome throttles a hidden tab's timers to roughly once
   * a minute, and the warm read stands down there too — so coming back into view asks immediately,
   * which is the exact moment somebody wants what they missed.
   */
  // A SOURCE replaces the feed (`chatSource.ts`): no transcript subscription at all.
  useEffect(() => {
    if (hasSource) { setRefreshing(false); return }
    const stop = subscribeChat({ id: session.id, key: scratchId, lang }, next => {
      setPayload(next as unknown as ChatPayload)
      setRefreshing(false)
    })
    nudgeChat.current = () => { refreshChat(session.id) }
    const onVisible = () => { if (document.visibilityState === 'visible') refreshChat(session.id) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      nudgeChat.current = () => {}
      document.removeEventListener('visibilitychange', onVisible)
      stop()
    }
  }, [session.id, lang, scratchId, hasSource])

  /**
   * THE MARKER WAITS, and that is what keeps it from being noise.
   *
   * The read answers in 66-143 ms on this machine, so a label rendered the instant a mount starts
   * would appear and vanish inside a blink on almost every visit — a flicker announcing a flicker.
   * It is shown only once the wait is long enough to be felt, which on a phone reaching a member
   * machine over the LAN with a long transcript is where it actually earns its place.
   */
  const [showRefreshing, setShowRefreshing] = useState(false)
  useEffect(() => {
    if (!refreshing) { setShowRefreshing(false); return }
    const t = setTimeout(() => setShowRefreshing(true), REFRESH_NOTICE_MS)
    return () => clearTimeout(t)
  }, [refreshing])

  /**
   * IS THE LIVE SCREEN WORTH WATCHING RIGHT NOW?
   *
   * `session.state` alone was the answer, and it is up to a FLEET poll late — five seconds, plus
   * the confirmation `attention-confirm.ts` requires. So every turn began with a dead window: the
   * message was already in the pane and the assistant already producing, while the chat had not
   * opened the stream that shows it. Measured why it matters: Claude writes its JSONL once a
   * message is FINISHED (the file grows in one ~5 KB jump and then sits still for eight seconds),
   * so the transcript can never stream — the screen is the only place the text exists as it is
   * typed, and being late to it is being late to all of it.
   *
   * A PENDING ECHO is the signal the fleet does not have yet: we typed into that pane ourselves a
   * moment ago. It clears exactly when the transcript catches up, so this needs no timer and cannot
   * leak a capture loop — and the case where it holds longest, a message sitting in the harness's
   * queue, is precisely the one somebody is watching the screen to understand.
   */
  const working = source ? source.working : session.state === 'working'
  // No screen behind a source: the stream is never opened (a null id is the hook's "off").
  const { state: term } = useTerminalStream(source ? null : session.id)

  // A turn just ENDED. The live bubble is gone the moment `working` drops, and the real one is up
  // to `CHAT_POLL_MS` away — a gap where neither source is showing the answer that just finished.
  const wasWorking = useRef(working)
  useEffect(() => {
    if (wasWorking.current && !working) nudgeChat.current()
    wasWorking.current = working
  }, [working])

  const turns = useMemo(() => payload?.turns ?? [], [payload])
  const [grantRecords, setGrantRecords] = useState<GrantRecord[]>([])
  const hasGrantedMessage = useMemo(() => turns.some(t => t.role === 'user' && /vault:\/\//.test(t.text)), [turns])
  useEffect(() => {
    if (!hasGrantedMessage) { setGrantRecords([]); return }
    let alive = true
    void listGrantRecords().then(r => { if (alive) setGrantRecords(r.ok ? r.grants : []) })
    return () => { alive = false }
  }, [hasGrantedMessage, session.id])
  const sessionGrants = useMemo(() => grantRecords.filter(g => g.sessionId === session.id), [grantRecords, session.id])
  const placedAttention = useMemo(() => placeAttention(turns, payload?.attention ?? []), [turns, payload?.attention])

  /**
   * Stable, session-namespaced DOM ids for every turn — derived from identity (who, when, a hash of
   * what), never from position, so "go to message" still finds the bubble after the window slides.
   * See `promptHistory.ts`.
   */
  const turnAnchors = useMemo(() => turnAnchorIds(session.id, turns), [session.id, turns])
  // PERF.1: a long conversation renders its END first and grows as the reader scrolls up.
  const [shownTurns, setShownTurns] = useState(INITIAL_TURNS)
  useEffect(() => { setShownTurns(INITIAL_TURNS) }, [session.id])
  const firstShown = windowStart(turns.length, shownTurns)
  const turnsLenRef = useRef(turns.length)
  turnsLenRef.current = turns.length
  /** scrollHeight before an older block was added — restored after it renders, so nothing jumps. */
  const growFrom = useRef<number | null>(null)



  /**
   * When each echo was first seen, so its bubble can say how long it has been waiting.
   *
   * Not persisted, and that is deliberate: an echo restored from storage after a reload has an
   * age this tab cannot know, and `echoStatus` shows none rather than measuring from the reload —
   * a duration that restarts when you refresh is worse than no duration at all.
   */
  const echoSeen = useRef(new Map<string, number>())
  useEffect(() => {
    const m = echoSeen.current
    for (const t of echo) if (!m.has(t)) m.set(t, Date.now())
    for (const t of [...m.keys()]) if (!echo.includes(t)) m.delete(t)
  }, [echo])

  // DECLARED AFTER `echoSeen`, and that is not cosmetic. `useMemo` runs its factory DURING the
  // render, at the point it is called — so a memo that reads `echoSeen.current` written above the
  // `useRef` reads a binding still in its temporal dead zone. It threw
  // `ReferenceError: Cannot access 'W' before initialization` the moment `echo` had anything in
  // it, which is to say the moment a message was sent, and the error boundary caught it AFTER the
  // message had already gone — "dá esse erro (mas envia)". Hooks read like declarations and are
  // executed like statements; order is part of the meaning.
  /**
   * WHAT IS STILL WAITING, from BOTH sides, and the server's copy wins on age.
   *
   * The local echo is what makes a sent message appear instantly — it exists before any poll — and
   * the server's list is what makes it appear on every OTHER device, and survive this one being
   * closed and reopened. Neither replaces the other: without the local half the sender waits a poll
   * to see their own message, without the server half nobody else ever sees it.
   *
   * The union is by TEXT, which is the same key both sides already retire on. Where both have it,
   * the server's `at` is used: it is when the message was actually handed over, while the local
   * timestamp is when THIS tab first drew it — and after a reload the local one is the reload, which
   * is exactly how a queued message became a bubble with no age and no way to tell it from a lost
   * one. `at` may still be undefined for a purely local entry that has not been through a poll yet,
   * and the bubble then shows no age rather than inventing one.
   */
  /**
   * Texts a successful "send now" reported as handed over — `nothing` included, which means the
   * session had ALREADY taken them. They leave the screen at once instead of waiting for the next
   * transcript read or for the server to drop its copy.
   */
  const deliveredRef = useRef(new Set<string>())
  const [deliveredTick, setDeliveredTick] = useState(0)
  useEffect(() => { deliveredRef.current = new Set(); setDeliveredTick(n => n + 1) }, [session.id])
  const queued = useMemo(() => {
    const out: { text: string; at?: number }[] = []
    const server = new Map((payload?.pending ?? []).map(p => [p.text, p.at]))
    const seen = new Set<string>()
    for (const text of echo) {
      if (seen.has(text)) continue
      seen.add(text)
      const at = server.get(text) ?? echoSeen.current.get(text)
      out.push(at === undefined ? { text } : { text, at })
    }
    for (const p of payload?.pending ?? []) {
      if (seen.has(p.text)) continue
      seen.add(p.text)
      out.push({ text: p.text, at: p.at })
    }
    // IN THE ORDER THEY WERE SENT (owner report, 2026-09-30: the second message was drawn first).
    // A stable sort on the hand-over time; one with no time yet is the newest and goes last.
    const when = (q: { text: string; at?: number }) => q.at ?? echoSeen.current.get(q.text) ?? Number.MAX_SAFE_INTEGER
    out.sort((a, b) => when(a) - when(b))
    // RECONCILED AGAINST THE TRANSCRIPT, both halves. Only the local echo used to be retired when
    // its text showed up as a user turn; the SERVER's copy was drawn until the server dropped it,
    // so a message the session had already taken in stayed "delivered — not read yet" and kept
    // "Send now (N)" on offer. The same containment rule decides for both (`pendingEchoes`).
    const userTurns = turns.filter(t => t.role === 'user').map(t => t.text)
    const still = new Set(pendingEchoes(out.map(q => q.text), userTurns))
    return out.filter(q => still.has(q.text) && !deliveredRef.current.has(q.text))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [echo, payload?.pending, turns, deliveredTick])

  /** A clock, so an ageing echo ages on screen instead of freezing at its first render. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (echo.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [echo.length])

  // Retire an echo the moment the transcript carries it — CONTAINMENT, not equality, because a
  // busy harness commits its whole queue as ONE user turn and each message is then a substring of
  // what was stored. See `echoMatch.ts` for the measurement that forced this.
  useEffect(() => {
    if (echo.length === 0) return
    const userTurns = turns.filter(t => t.role === 'user').map(t => t.text)
    editEcho(list => {
      const kept = pendingEchoes(list, userTurns)
      return kept.length === list.length ? list : kept
    })
  }, [turns, echo.length, editEcho])

  // A finished background-task line is `role: 'assistant'` and carries no `pending` any more, so it
  // would otherwise be taken as the assistant's last MESSAGE — and its label would be compared
  // against the live terminal frame. It is a status line; nobody said it.
  const lastAssistant = [...turns].reverse()
    .find(t => t.role === 'assistant' && !t.pending && !t.task && t.text.trim() !== '')

  const live = useMemo(() => {
    if (source) return source.liveText
    if (!term.frame) return null
    return liveTurnText({
      // The frame carries the emulator's escape sequences; the chat wants the words.
      lines: stripAnsi(term.frame.content).split('\n'),
      ...(lastAssistant ? { lastCommitted: lastAssistant.text } : {}),
      working,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term.frame, lastAssistant, working, source?.liveText])

  /**
   * Whether the frame is showing Claude Code's OWN compaction screen right now — see
   * `detectCompacting`. Read over the RAW frame lines rather than `live`'s filtered text: the
   * progress bar is exactly the kind of line `liveTurnText` strips out as chrome, and compaction
   * writes nothing to the transcript while it runs, so this is the only signal there is.
   */
  const compacting = useMemo(() => {
    if (!working || !term.frame) return null
    return detectCompacting(stripAnsi(term.frame.content).split('\n'))
  }, [term.frame, working])

  const toTail = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])


  /**
   * A line the PANEL asked this composer to hold — the skills tab's "use this skill".
   *
   * Keyed on the STAMP, so asking twice for the same skill works; scoped to the session it named,
   * so a request can never land in another conversation's box. It APPENDS and never sends: what
   * reaches a session is what the person pressed enter on.
   */
  /**
   * The leading `/command` of what is typed, for the field's own marker — see `commandToken.ts`.
   * `knownCommands` carries `skills === null` through as `null` rather than an empty set, which is
   * what keeps a session's first command from being painted `missing` before the list has answered.
   */
  const cmdToken = useMemo(() => commandToken(draft, knownCommands(skills)), [draft, skills])
  /**
   * A `/` typed where a command cannot be — see `slashMisplaced`.
   *
   * The picker not opening there is CORRECT; the silence is what made it read as unreliable
   * ("nem sempre ele ta identificando"). One line, only while the slash is the last thing typed,
   * and it disappears the moment anything else is.
   */
  const slashHint = useMemo(() => slashMisplaced(draft.slice(0, caret)), [draft, caret])
  const underlayRef = useRef<HTMLDivElement | null>(null)
  const [composerScrollbarPx, setComposerScrollbarPx] = useState(0)

  // The mirror is a visual layer, but the textarea owns both wrapping and scrolling. The
  // textarea's scrollbar reduces its content width; reserve that exact gutter in the mirror or
  // a long chip changes the line breaks after the first overflow.
  const syncComposerMirror = useCallback(() => {
    const field = textareaRef.current
    const mirror = underlayRef.current
    if (!field || !mirror) return
    mirror.scrollTop = mirrorScrollTop(field.scrollTop, mirror.scrollHeight, mirror.clientHeight)
    setComposerScrollbarPx(field.offsetWidth - field.clientWidth)
  }, [])

  useLayoutEffect(() => {
    syncComposerMirror()
  }, [draft, maxComposerH, syncComposerMirror])

  const draftReq = useDraftRequest()
  const draftReqAt = draftReq?.sessionId === session.id ? draftReq.at : undefined
  /**
   * The stamp this composer arrived with, so a request made BEFORE it existed is never applied.
   *
   * Two guards, because they cover different halves of the same accident. The store is cleared when
   * a request is taken (`consumeDraftRequest`), which stops it being re-applied on every remount —
   * and mounting is what going back to a session is. This ref covers the moment before that: a
   * composer that mounts while a request is still in flight for ANOTHER session, or an ask that
   * was never consumed because nothing was mounted to take it.
   */
  const seenReqAt = useRef<number | undefined>(getDraftRequest()?.at)
  useEffect(() => {
    if (draftReqAt === undefined || !draftReq) return
    if (seenReqAt.current === draftReqAt) return
    seenReqAt.current = draftReqAt
    // A message handed back with `> ` lines gets its quotes back as BLOCKS, not as text.
    const req = splitQuotedDraft(draftReq.text)
    editDraft(d => applyDraftRequest(d, req.text))
    if (req.replies.length > 0) editReply(list => req.replies.reduce(addReply, list))
    textareaRef.current?.focus()
    consumeDraftRequest(draftReqAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReqAt])

  /**
   * ADD quotes to the STACK above the field. The textarea holds only what the person writes — a
   * quote typed into it as `> ` text read as raw markdown and had no collapse control; an overlay
   * painted over the field drifted from the caret. The quotes go out ahead of the words at send.
   */
  const addQuotes = useCallback((targets: readonly ReplyTarget[]) => {
    editReply(list => targets.reduce(addReply, list))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [editReply])

  /** ONE stable reference for every bubble's reply button — see `ChatBubble`'s memo. */
  const onReplyToTurn = useCallback((t: ChatTurn) => {
    addQuotes([{ role: t.role, text: t.text, key: turnKeyOf(t) }])
  }, [addQuotes])

  /**
   * Reply to the SELECTED PART of an assistant turn.
   *
   * The same act as `onReplyToTurn` with a different target, so it goes through the same composer
   * bar and the same send path — what changes is decided in `replyQuote.ts`: the excerpt travels
   * whole rather than capped at four lines, and is marked at whichever ends it does not reach.
   *
   * A selection that trims to nothing is dropped rather than clearing an existing reply target: a
   * stray drag must not throw away the message the user had already chosen to answer.
   */
  const onReplyToExcerpt = useCallback((t: ChatTurn, selected: string) => {
    const text = markExcerpt(t.text, selected)
    if (text === '') return
    addQuotes([{ role: t.role, text, excerpt: true, key: turnKeyOf(t) }])
  }, [addQuotes])

  /**
   * SELECTION MODE (WhatsApp's model) and FORWARDING — see `chatForward.ts`.
   *
   * `selecting` is the set of ticked turns, or `null` outside the mode. The selection is PUBLISHED
   * to `chatSelection` so the workspace's own header can turn into "N selected · Forward · Copy ·
   * Cancel"; the header is not this component's DOM. Every callback handed to a bubble is one stable
   * reference, for `ChatBubble`'s memo.
   */
  const navigate = useNavigate()
  const [selecting, setSelecting] = useState<Set<string> | null>(null)
  const [forwardTurns, setForwardTurns] = useState<ChatTurn[] | null>(null)
  const [forwardBusy, setForwardBusy] = useState(false)
  const onSelectStart = useCallback((t: ChatTurn) => setSelecting(toggleTurn(new Set(), t)), [])
  const onToggleSelect = useCallback((t: ChatTurn) => {
    setSelecting(prev => (prev === null ? prev : toggleTurn(prev, t)))
  }, [])
  const onForwardTurn = useCallback((t: ChatTurn) => setForwardTurns([t]), [])
  const selectedList = useMemo(
    () => (selecting === null ? [] : selectedTurns(turns, selecting)),
    [turns, selecting],
  )
  /** "Reply (N)": every ticked message becomes a card at the caret, in conversation order. */
  const replyToSelection = useCallback(() => {
    addQuotes(selectedList.map(t => ({ role: t.role, text: t.text, key: turnKeyOf(t) })))
    setSelecting(null)
  }, [selectedList, addQuotes])

  /**
   * A card was clicked: bring its passage into view and FLASH it — the same orange marker
   * (`ROW_FLASH`) the aside's lists use for "the one you asked for", which fades on its own. A
   * passage that is no longer in the loaded window is SAID, never a click that does nothing.
   */
  const jumpToQuote = useCallback((target: ReplyTarget) => {
    const i = target.key === undefined ? -1 : turns.findIndex(t => turnKeyOf(t) === target.key)
    // A turn above the rendered window is rendered first, so the jump lands on it.
    if (i >= 0 && i < windowStart(turns.length, shownTurns)) flushSync(() => setShownTurns(shownToInclude(turns.length, i)))
    const el = i >= 0 && turnAnchors[i] ? document.getElementById(turnAnchors[i]!) : null
    if (!el) {
      setNotice(pt
        ? 'Esse trecho não está mais na parte carregada da conversa — a citação continua no rascunho.'
        : 'That passage is no longer in the loaded part of the conversation — the quote stays in the draft.')
      return
    }
    const body = (el.firstElementChild as HTMLElement | null) ?? el
    // An EXCERPT is also marked word for word, when the browser can (CSS Custom Highlight) and the
    // text can be found on screen; the mark fades out in steps, like the flash around it.
    const range = target.excerpt ? excerptRange(body, target.text) : null
    // The registry is maplike in every browser that has it; this TS lib omits the Map methods.
    const hl = typeof CSS !== 'undefined' ? (CSS.highlights as unknown as Map<string, Highlight> | undefined) : undefined
    if (range && hl && typeof Highlight !== 'undefined') {
      hl.set('ag-quote', new Highlight(range))
      const root = document.documentElement
      const steps = [32, 32, 32, 24, 16, 8, 0]
      steps.forEach((pct, k) => setTimeout(() => {
        root.style.setProperty('--ag-quote-hl', `${pct}%`)
        if (pct === 0) hl.delete('ag-quote')
      }, k * 450))
      ;(range.startContainer.parentElement ?? el).scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    body.style.animation = 'none'
    void body.offsetWidth
    body.style.animation = ROW_FLASH
    body.addEventListener('animationend', () => { body.style.animation = '' }, { once: true })
  }, [turns, turnAnchors, pt, shownTurns])

  const onSentQuote = useCallback((quote: string, sentTurn: ChatTurn | null) => {
    const needle = quote.replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim()
    const sentAt = sentTurn ? turns.indexOf(sentTurn) : -1
    const candidates = turns.slice(0, sentAt >= 0 ? sentAt : turns.length)
      .filter(t => t.role === 'assistant' && t.text.replace(/\s+/g, ' ').includes(needle))
    const sourceTurn = candidates[candidates.length - 1] ?? turns.find(t => t.role === 'assistant' && t.text.replace(/\s+/g, ' ').includes(needle))
    if (sourceTurn) jumpToQuote({ role: 'assistant', text: quote, excerpt: true, key: turnKeyOf(sourceTurn) })
  }, [turns, jumpToQuote])
  /** A quote in the composer's stack was clicked: its own turn when known, else found by its text. */
  const openComposerQuote = useCallback((t: ReplyTarget) => {
    if (t.key !== undefined && turns.some(x => turnKeyOf(x) === t.key)) jumpToQuote(t)
    else onSentQuote(t.text, null)
  }, [turns, jumpToQuote, onSentQuote])
  // Leaving the conversation leaves the mode: a header still offering to forward messages from a
  // chat that is no longer on screen would forward something the reader cannot see.
  useEffect(() => () => chatSelection.clear(scratchId), [scratchId])
  useEffect(() => { setSelecting(null); setForwardTurns(null) }, [scratchId])
  // Esc leaves the mode wherever the focus is — the composer's own handler checks first, so the key
  // never also reaches the stop verb.
  useEffect(() => {
    if (selecting === null || forwardTurns !== null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setSelecting(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selecting, forwardTurns])

  const harnessLabel = (HARNESS_LABELS as Record<string, string>)[session.harness] ?? session.harness
  const forwardSource = useMemo(() => ({ title: session.title, harness: harnessLabel }), [session.title, harnessLabel])
  /**
   * Where a forward may go: the whole fleet but this session, every row PICKABLE — a draft is written
   * in this browser and needs nothing from the session, and a direct send is the server's to refuse
   * (`broadcast` says what it skipped). The picker's own rows, so its search is the same everywhere.
   */
  const forwardRows = useMemo(() => {
    if (forwardTurns === null) return []
    const others = fleet.sessions.filter(r => !isSameSession(r, session))
    return buildPickRows(others, pt).sendRows.map(({ reason: _reason, ...r }) => ({ ...r, enabled: true }))
  }, [forwardTurns, fleet.sessions, session, pt])

  const deliverForward = useCallback(async (ids: string[], comment: string, opts?: { direct: boolean }) => {
    const body = composeForward({ from: forwardSource, turns: forwardTurns ?? [], comment, pt })
    if (body === '' || ids.length === 0) { setForwardTurns(null); return }
    if (opts?.direct) {
      setForwardBusy(true)
      const out = await fleetAct({ id: ids[0]!, action: 'broadcast', ids, text: body })
      setForwardBusy(false)
      setNotice(out.message)
      if (out.ok) { setForwardTurns(null); setSelecting(null) }
      return
    }
    // THE DEFAULT: into each target's DRAFT, appended — never replacing — under the same key the
    // target's own composer reads (`scratchKey`), so opening it shows the forward ready to finish.
    const titles: string[] = []
    for (const id of ids) {
      const row = fleet.sessions.find(r => r.id === id)
      if (!row) continue
      const key = scratchKey(row)
      sessionScratch.writeDraft(key, appendToDraft(sessionScratch.readDraft(key), body))
      titles.push(row.title)
    }
    setForwardTurns(null)
    setSelecting(null)
    setNotice(draftedNotice(titles, pt))
    // One destination: go there — the instruction is finished in that composer. Several: stay, and
    // the notice names where they went.
    if (ids.length === 1 && titles.length === 1) navigate(sessionPath(ids[0]!))
  }, [forwardSource, forwardTurns, pt, fleetAct, fleet.sessions, navigate])

  /**
   * Land at the END on first paint, then follow the tail only while the reader is already there.
   *
   * `useLayoutEffect` for the landing: with a plain effect the conversation paints at the top and
   * then jumps, which is exactly the flash this exists to avoid. Following is conditional because
   * yanking the view down while somebody reads earlier history is the worst thing a live view does.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || payload === null) return
    if (!landedRef.current) { el.scrollTop = el.scrollHeight; landedRef.current = true; return }
    if (tailFollows(atTail, holdTailUntil.current, Date.now())) el.scrollTop = el.scrollHeight
  }, [turns.length, live, payload, atTail, echo.length])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || growFrom.current === null) return
    el.scrollTop += el.scrollHeight - growFrom.current
    growFrom.current = null
  }, [shownTurns])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLACK
    // Near the top with older turns not rendered yet: render the next block (position kept below).
    if (el.scrollTop < GROW_AT_PX && growFrom.current === null) {
      setShownTurns(n => {
        if (windowStart(turnsLenRef.current, n) === 0) return n
        growFrom.current = el.scrollHeight
        return n + GROW_TURNS
      })
    }
    // Right after a jump the view can still be near the bottom while it scrolls away; reading that
    // as "at the tail" would re-arm the follow and pull the reader back. See `holdTailUntil`.
    if (near && Date.now() < holdTailUntil.current) return
    setAtTail(near)
  }, [])

  /**
   * IS THE PERSON TYPING RIGHT NOW.
   *
   * It exists for one rule, asked for in these words: "enquanto eu estiver digitando no input NADA
   * tira o foco dele". A `disabled` attribute is not a style — the browser BLURS an element the
   * moment it becomes disabled — and this field was disabled from `canPrompt`, which is recomputed
   * on every 5s fleet poll. So a poll that briefly reported the session blocked, or not live, or
   * mid-send took the caret out from under someone mid-sentence, and they had to tap back in. "Do
   * nada o foco sai do input."
   *
   * DECLARED HERE, above everything that reads it, because it now guards more than `disabled`:
   * `showReopen` reads it too, and a rule about the caret that half the file cannot see is a rule
   * that gets forgotten by the next thing that hides the composer.
   */
  const [typing, setTyping] = useState(false)

  // A source's questions are its own slot (`approvals`), never the fleet row's dialog.
  const blocked = !source && (session.approvalLines?.length ?? 0) > 0
  const loading = payload === null

  /**
   * ANSWERING THE QUESTION IN THE COMPOSER, rather than in a field of its own.
   *
   * Asked for in these words: "ao clicar na opção de digitar o input fica disponível pro usuário
   * usar (pq daí consigo usar recurso de voz, ctrl+v, anexos etc.)". The card used to grow its own
   * one-line `<input>`, which is a second composer with none of the composer's features — no
   * dictation, no paste-an-image, no attachments, no auto-grow, and its own separate rules about
   * what Enter does.
   *
   * It holds the option's NUMBER because that is what the server needs (`approve` with a `choice`),
   * its LABEL so the banner can name what is being answered, and the dialog's SHAPE so the mode
   * cannot outlive the question: a dialog that changes under it would leave the composer sending an
   * answer to a question nobody asked.
   */
  const [answering, setAnswering] = useState<{ number: number; label: string; shape: string } | null>(null)
  /**
   * The dialog's identity — the same `approvalIdentity` `ApprovalCard` compares, for the same
   * reason (see that module's header): options ALONE are not an identity, because claude's
   * permission prompt is a fixed template across every command it asks about.
   */
  const dialogShape = useMemo(
    () => approvalIdentity(row?.approvalLines ?? [], row?.dialogOptions ?? []),
    [row?.approvalLines, row?.dialogOptions],
  )
  useEffect(() => {
    // The question went away, or became a different question. Either way this is no longer an
    // answer to it, and the composer goes back to being a composer.
    setAnswering(a => (a === null || (blocked && a.shape === dialogShape) ? a : null))
  }, [blocked, dialogShape])

  /**
   * FREE-TEXT DIALOG ANSWERS WAITING FOR THEIR ECHO TO RETIRE — see `dialogAnswerEcho.ts`.
   *
   * Keyed by the exact text sent, valued by `dialogShape` AT THE MOMENT it was sent: the one thing
   * that tells this echo apart from an ordinary prompt's, whose transcript containment check
   * (`pendingEchoes`, below) can never match it — the answer lands as a `tool_result`, never a user
   * turn. A ref, not state: it is bookkeeping for the effect below and must never itself trigger a
   * render.
   */
  const dialogAnswerEchoes = useRef(new Map<string, string>())
  useEffect(() => {
    const pending = dialogAnswerEchoes.current
    if (pending.size === 0) return
    // No dialog on screen at all reads exactly like a dialog that moved on to a different one: in
    // both cases the harness has necessarily consumed whatever it was sitting on.
    const done = dialogAnswersToRetire(pending, blocked ? dialogShape : null)
    if (done.length === 0) return
    for (const text of done) pending.delete(text)
    editEcho(list => list.filter(t => !done.includes(t)))
  }, [blocked, dialogShape, editEcho])

  /**
   * Hand the artifact list to whoever is drawing the panel.
   *
   * Derived from the same `turns` the conversation renders, so the two can never disagree about
   * what this session wrote.
   */
  const artifacts = useMemo(() => artifactsFromTurns(turns), [turns])
  useEffect(() => {
    onArtifacts?.({
      artifacts,
      loading,
      unlisted: hasUnlistedWrites(turns),
      turns,
      ...(payload?.unavailable ? { unavailable: payload.unavailable } : {}),
      ...(payload?.older ? { older: payload.older } : {}),
    })
  }, [artifacts, loading, turns, payload?.unavailable, payload?.older, onArtifacts])

  /**
   * The composer is being used to answer the dialog, so it must accept text.
   *
   * `blocked` normally denies `canPrompt`, and that rule stays exactly as it was: a PROMPT typed
   * into a session sitting on a dialog goes into that dialog's own filter and the submit takes the
   * highlighted option. This is not a prompt. `send()` routes an answer through `approve` with the
   * option's number, which is the one path the server has verified for it — the invariant is kept,
   * and what changes is only which field the words are typed into.
   */
  const answeringNow = blocked && answering !== null
  // EXT.OPEN: an EXTERNAL row is not `actionable` (nothing of agentop's runs it), but its `prompt`
  // verb is ENABLED when a write can continue it here — the server decides, the row says so.
  const promptOffered = session.actionable || row?.verbs.some(v => v.action === 'prompt' && v.enabled) === true
  const canPrompt = !loading && promptOffered && (!blocked || answeringNow) && payload.live !== false
  const modeOptions = useMemo(() => modeMenuFor(row?.harness), [row?.harness])
  const chooseMode = useCallback(async (target: string) => {
    if (!row?.mode || !canPrompt) return
    const cycles = modeCycles(row.mode.id, target, modeOptions)
    setModeMenuOpen(false)
    for (let i = 0; i < cycles; i += 1) {
      const out = await act({ id: session.id, action: 'cycleMode' })
      if (!out.ok) {
        setNotice(out.message)
        return
      }
    }
    if (cycles > 0) {
      setNotice(modeOptions.find(mode => mode.id === target)?.label ?? target)
      nudgeFleet()
    }
  }, [act, canPrompt, modeOptions, row?.mode, session.id])
  /** EXT.OPEN: the one question before a write continues an external session here. */
  const [continueAsk, setContinueAsk] = useState<{ message: string; text: string } | null>(null)
  const [continuing, setContinuing] = useState(false)
  async function continueHere() {
    if (!continueAsk || continuing) return
    setContinuing(true)
    const out = await act({ id: session.id, action: 'prompt', text: continueAsk.text, confirm: true })
    setContinuing(false)
    setContinueAsk(null)
    setNotice(out.message)
    if (out.ok) {
      setDraft('')
      sessionScratch.clearDraft(scratchId)
      setAttached([])
      sessionScratch.writeAttachments(scratchId, [])
      // The conversation is a managed session now, under a NEW id — the page follows it there, the
      // same callback both Reopen buttons use.
      if (out.id) onReopened?.(out.id)
    }
  }

  /** Everything the person sent, newest first — the recent-prompts panel's rows. */
  const promptList = useMemo(() => buildPromptList(session.id, turns, queued), [session.id, turns, queued])

  const closePrompts = useCallback(() => {
    setPromptsOpen(false)
    // Back to the control that opened the panel, once the dialog has unmounted.
    requestAnimationFrame(() => historyBtnRef.current?.focus())
  }, [])

  /**
   * Take the reader to one of their messages and MARK it.
   *
   * RESOLVED AT CLICK TIME against the turns as they are NOW: the entry carries an identity-based
   * anchor, and if it is no longer among the loaded turns (the window slid past it) the reader is
   * told so instead of being scrolled somewhere else. `goToTurn` is the ONE implementation of the
   * gesture — the gallery's menu uses it too.
   */
  const goToPrompt = useCallback((entry: PromptEntry) => {
    const loadedNow = anchorIsLoaded(entry.anchor, session.id, turns, queued)
    // Hold the tail off so the follow-the-tail effect cannot pull the view back after the jump.
    holdTailUntil.current = Date.now() + 4000
    setAtTail(false)
    if (!loadedNow || !goToTurn(entry.anchor)) {
      setNotice(pt
        ? 'Essa mensagem não está mais na conversa carregada.'
        : 'That message is no longer in the loaded conversation.')
    }
  }, [session.id, turns, queued, pt])

  /**
   * "BUSCAR NA CONVERSA" asks this chat for one message (`chatSearchBridge.ts`): forward it through
   * this chat's own forward modal, or go to it — widening the rendered window first, exactly as a
   * quote card's jump does, then `goToTurn`'s scroll and flash. Resolved against the turns as they
   * are NOW (a ref, so the registration does not churn on every poll). A message older than the
   * loaded window is `not-loaded`; one that is loaded but has no bubble on screen (the terminal view)
   * is `no-chat` — the panel says each in its own words.
   */
  const SEARCH_JUMP_CONTEXT = 40
  const searchView = useRef({ turns, shownTurns, turnAnchors })
  searchView.current = { turns, shownTurns, turnAnchors }
  useEffect(() => registerChatSearchTarget(session.id, req => {
    const { turns: now, shownTurns: shown, turnAnchors: anchors } = searchView.current
    const i = findTurnIndex(now, req.turn)
    if (i < 0) return 'not-loaded'
    if (req.kind === 'forward') { setForwardTurns([now[i]!]); return 'done' }
    // GENEROUS context above the target: with the default ten, the target sits inside the
    // grow-at-top zone (`GROW_AT_PX`), the smooth scroll toward it renders yet another older block,
    // and the content shifts under the scroll — measured landing ~460px past the message.
    if (i < windowStart(now.length, shown)) flushSync(() => setShownTurns(shownToInclude(now.length, i, SEARCH_JUMP_CONTEXT)))
    holdTailUntil.current = Date.now() + 4000
    setAtTail(false)
    const anchor = searchView.current.turnAnchors[i] ?? anchors[i]
    // A search jump is usually LONG: a smooth scroll across hundreds of bubbles outlasts the flash,
    // so the reader arrives after the mark has faded. Land instantly; `goToTurn` then only marks it.
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'center' })
    return goToTurn(anchor) ? 'done' : 'no-chat'
  }), [session.id])

  /**
   * RESTORE the conversation from just before a prompt (claude's own rewind), then hand the message
   * back to the composer to edit and resend. The server clears the terminal input and its chat view
   * hides the undone turns at once; on failure its own sentence is shown and nothing here changes.
   */
  const restoreFrom = useCallback(async (entry: PromptEntry) => {
    const out = await act({
      id: session.id, action: 'rewind', text: entry.text, occurrence: entry.occurrence ?? 0,
    })
    if (out.ok) {
      const parts = splitMessage(stripDictatedMark(entry.text).text)
      const req = splitQuotedDraft(parts.text)
      editDraft(d => applyDraftRequest(d, req.text))
      if (req.replies.length > 0) editReply(list => req.replies.reduce(addReply, list))
      if (parts.attachments.length > 0) {
        editAttached(a => [
          ...a,
          ...parts.attachments
            .filter(path => !a.some(x => x.path === path))
            .map(path => ({ name: attachmentName(path), path })),
        ])
      }
      setNotice(out.message)
      setPromptsOpen(false)
      nudgeChat.current()
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
    return { ok: out.ok, message: out.message }
  }, [act, session.id, editDraft, editAttached])

  /**
   * SEND NOW — submit everything claude is holding in ITS OWN queue. It is for the WHOLE queue (a
   * queued message 1 goes out with message 2), and the button says so when there is more than one.
   */
  const [sendNowRun, setSendNowRun] = useState<SendNowRun | null>(null)
  const queuedRef = useRef(queued)
  queuedRef.current = queued
  const showSendNow = sendNowShown({
    harness: session.harness, working, queuedCount: queued.length, dialogOpen: blocked,
  }) && sendNowRun?.kind !== 'running'
  const sendNow = useCallback(async () => {
    setSendNowRun({ kind: 'running', startedAt: Date.now() })
    const out = await act({ id: session.id, action: 'sendNow' })
    // The server's sentence is read off the pane — "delivered", "interrupted to deliver", or why not.
    setSendNowRun({ kind: 'done', ok: out.ok, message: out.message })
    if (out.ok) {
      // Delivered — or, when the server answered that nothing was queued, delivered before the
      // press. Either way nothing is pending any more: clear the bubbles and the count now.
      for (const q of queuedRef.current) deliveredRef.current.add(q.text)
      editEcho(() => [])
      setDeliveredTick(n => n + 1)
      nudgeChat.current()
    }
  }, [act, session.id, editEcho])
  // A success says its sentence and goes; a failure stays until it is dismissed or retried.
  useEffect(() => {
    if (sendNowRun?.kind !== 'done' || !sendNowRun.ok) return
    const t = setTimeout(() => setSendNowRun(null), SEND_NOW_RESULT_MS)
    return () => clearTimeout(t)
  }, [sendNowRun])
  // Another session's result must not be shown over this one.
  useEffect(() => { setSendNowRun(null) }, [session.id])
  /** Selection mode's "Reply (N)" exists only where the composer can send. */
  const canReplySelection = canPrompt
  // Publishes the selection to the header — see `chatSelection.ts`. Declared here, after
  // `canPrompt`, because whether "Reply (N)" is offered depends on it.
  useEffect(() => {
    if (selecting === null) { chatSelection.clear(scratchId); return }
    chatSelection.set({
      owner: scratchId,
      count: selectedList.length,
      forward: () => { if (selectedList.length > 0) setForwardTurns(selectedList) },
      copy: () => {
        const n = selectedList.length
        void copyText(copyTurnsText(selectedList)).then(ok => {
          setNotice(ok
            ? (pt ? (n === 1 ? '1 mensagem copiada.' : `${n} mensagens copiadas.`) : (n === 1 ? '1 message copied.' : `${n} messages copied.`))
            : (pt ? 'O navegador não liberou a área de transferência aqui.' : 'The browser did not allow the clipboard here.'))
          if (ok) setSelecting(null)
        })
      },
      cancel: () => setSelecting(null),
      // Only where the session can take a message — a Reply that the composer will refuse is a
      // control that teaches the wrong thing.
      ...(canReplySelection ? { reply: replyToSelection } : {}),
    })
  }, [selecting, selectedList, scratchId, pt, canReplySelection, replyToSelection])
  /**
   * The `/` picker is open.
   *
   * It inherits the `prompt` action's refusals exactly as the menu's list does — a slash typed
   * into a session sitting on a permission prompt goes into that dialog's own filter, and the
   * submit takes the highlighted option. Where it cannot be offered it is ABSENT: the field itself
   * is already disabled there, so there is nothing to type a `/` into and no control left inert.
   */
  const skillPickerOpen = canPrompt && !blocked && !slashDismissed && slashText !== null
  /**
   * The `@` picker is open. Same refusals `skillPickerOpen` states for the same reason — a
   * reference typed into a session sitting on a dialog goes into that dialog's own filter, and the
   * submit takes the highlighted option.
   */
  const atOpen = canPrompt && !blocked && !atDismissed && atText !== null
  /** The `#` picker is open — same refusals as the other two, and never while one of them is. */
  const hashOpen = canPrompt && !blocked && !hashDismissed && hashText !== null && !atOpen && !skillPickerOpen
    && hashPickerShown(hashText, hashRows.length)
  /** The row's own reopen verb, if it has one. Enabled by the server, never inferred here. */
  const reopen = row?.verbs.find(v => v.action === 'resume')
  const [reopening, setReopening] = useState(false)
  /**
   * Stop the CURRENT turn, without ending the session — the composer's own "esc". Lives here, next
   * to the field, rather than in the panel's header: it is the one thing reached for WHILE something
   * is running, and it does not touch `canPrompt` — typing and sending stay live the whole time, so
   * a reply queued while it works is not blocked on stopping it first. Absent unless the row can
   * take it, since a stop control on an idle session would send Escape into its prompt.
   */
  /**
   * WHILE THE FIELD HAS THE CARET, NOTHING MAY REPLACE IT — the rule `typing` was invented for,
   * applied to the one place it did not reach.
   *
   * `typing` already stops `disabled` blurring the field on a poll. It did NOT stop the composer's
   * whole row being `display: none`'d, and `display: none` on an ANCESTOR blurs just as hard —
   * harder, because the node leaves the layout with the half-written draft in it. The condition was
   * `!canPrompt && !blocked && reopen`, and every term of `canPrompt` is recomputed on the 5s fleet
   * poll (`loading`, `session.actionable`, `payload.live`), while `reopen` is a `find` that never
   * checks `.enabled` — so any single poll reporting the session momentarily not live swapped the
   * focused composer for the reopen block. Reported, again, as "do nada o foco sai do input".
   *
   * ONE expression decides it, read by BOTH the reopen block and the composer's `display`, so the
   * two can never be shown at once or hidden at once.
   */
  const showReopen = !canPrompt && !blocked && !!reopen && !typing

  const stopVerb = row?.verbs.find(v => v.action === 'interrupt')
  /**
   * Is the one button showing STOP right now?
   *
   * `working` and a stop the row actually offers are the preconditions — a stop on an idle session
   * sends Escape into its prompt, which is why the row gates `interrupt` at all. The DRAFT is what
   * decides between the two faces: nothing written means there is nothing to send, so the only
   * thing left to do to a working session is stop it; a single character means the opposite.
   * Attachments count as something written — a message that is only files is still a message.
   */
  const stopEnabled = source ? source.canStop : !!stopVerb?.enabled
  const stopShown = isStopShown({
    working,
    stopEnabled,
    draft,
    attachments: attached.length,
  })
  /** What the send button could send. The same predicate decides its label, its colour and `stopShown`. */
  const somethingToSend = hasSomethingToSend({ draft: stripQuotedLines(draft), attachments: attached.length })
  const [stopping, setStopping] = useState(false)
  async function stopNow() {
    if (!stopEnabled || stopping) return
    setStopping(true)
    const out = await act({ id: session.id, action: 'interrupt' })
    setStopping(false)
    if (!out.ok) setNotice(out.message)
  }

  async function reopenNow() {
    if (!reopen?.enabled || reopening) return
    setReopening(true)
    const out = await withReopening([session.id], () => act({ id: session.id, action: 'resume' }))
    setReopening(false)
    setNotice(out.message)
    // THE NEW ID IS REPORTED UP. The server hands it back precisely so a caller does not stay on
    // the row it just retired; see `onReopened` for what used to happen instead. Navigating is
    // still not this component's decision — it says what happened and hands over the id.
    if (out.ok && out.id) onReopened?.(out.id)
  }

  /**
   * What the session is DOING, from the newest ASSISTANT turn.
   *
   * The newest turn of all is frequently the user's own message, which carries no tools — reading
   * it meant the actions vanished the instant you sent something.
   */
  const newestAssistant = useMemo(
    () => [...turns].reverse().find(t => t.role === 'assistant'),
    [turns],
  )

  /**
   * The working note shows whenever the session is busy, INCLUDING while there is live text.
   *
   * They are different facts: the live bubble is what the assistant is SAYING, the note is what it
   * is DOING. Gating the note on the absence of live text hid the actions for exactly as long as
   * the screen had anything on it, which is most of the time a session is working.
   */
  const showWorking = working && !loading

  async function upload(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      // Which session this is going into. The server records it, so a `[Image #N]` marker the
      // harness substitutes when it QUEUES the message can still find the file it stands for.
      body.append('session', session.id)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          editAttached(a => [...a, { name: json.name!, path: json.path! }])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  function pick(list: FileList | null): void {
    if (!list) return
    const room = attachmentRoom(attached.length)
    const files = Array.from(list).slice(0, room)
    if (files.length < list.length) {
      setNotice(pt
        ? `No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`
        : `At most ${MAX_ATTACHMENTS} attachments per message.`)
    }
    void upload(files)
  }

  /**
   * A paste is three different things and `planPaste` decides which — see that module.
   *
   * The handler only PREVENTS the default when it is doing something else with the clipboard; an
   * ordinary paste falls through to the textarea, which handles the caret and the undo stack better
   * than any manual insert.
   */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (!canPrompt) return
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attached.length,
    })
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') { void upload(plan.files); return }
    if (plan.kind === 'textFile') {
      // Too big to type into a pane. Attached as a file instead, and the chip says so.
      void upload([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(pt
        ? 'O texto colado era grande demais para digitar na sessão, então foi anexado como arquivo.'
        : 'The pasted text was too large to type into the session, so it was attached as a file.')
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!canPrompt) return
    // A tree row dragged onto the composer (§6.1, gesture 1) — checked FIRST, and never a case of
    // "nothing was dropped": `handled: false` means "not a repo entry", so the OS-file path below
    // still runs for an ordinary file dropped from outside the browser.
    const mention = handleComposerDrop(session.id, e.dataTransfer, {
      readRepoEntry: dt => readRepoDrag(dt, session.id),
      harness: session.harness as HarnessId,
    })
    if (mention.handled) { e.preventDefault(); return }
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    pick(e.dataTransfer.files)
  }

  async function send() {
    // A trailing `@server:` is the picker's scaffolding and was never typed — it must not be sent.
    // `#` chips become their lean reference HERE, so the harness never sees a raw `#` — which Claude
    // Code would read as a memory note when it opens the message. See `sessionMention.ts`.
    // The quotes are the STACK above the field (`replyTo`); they go out first, as `> ` blocks.
    const text = expandSessionMentions(dropEmptyAtTrigger(draft), pt).trim()
    // A message that is only quotes, with nothing of the person's own, says nothing.
    const ownWords = stripQuotedLines(draft).trim()
    // A message that is ONLY attachments is still a message: the paths are the content.
    // `canPrompt` is checked HERE now rather than only on the field's `disabled`, which no longer
    // follows it — see the note on the textarea. This is where it belonged anyway: the rule is
    // about what may be DELIVERED, not about what may be typed.
    if ((ownWords === '' && attached.length === 0) || sending) return
    /**
     * A REFUSAL IS SAID, NEVER RETURNED IN SILENCE.
     *
     * This read `|| !canPrompt) return`, so pressing Enter on a session the poll had just reported
     * not-live, not-actionable or newly blocked did NOTHING AT ALL — no send, no sentence, the text
     * still sitting there. That is indistinguishable from a broken key, and it is the same
     * complaint the approval card produced from its own side ("simplesmente não envia"). There is
     * nothing to say when the field is EMPTY — that is not a refusal, it is nothing to send.
     */
    if (!canPrompt) {
      setNotice(blocked
        ? (pt
          ? 'Esta sessão está esperando uma resposta à pergunta acima. Escolha uma opção, ou a opção de escrever, para responder daqui.'
          : 'This session is waiting on an answer to the question above. Pick an option, or the write-your-own one, to answer from here.')
        : (pt
          ? 'Esta sessão não está aceitando mensagens agora. Se ela parou, use Reabrir.'
          : 'This session is not taking messages right now. If it has stopped, use Reopen.'))
      return
    }
    // The message is going out: the microphone stops with it — see `endDictationForSend`.
    endDictationForSend()
    // Paths first, on their own lines, then what was typed — the assistant reads the files it is
    // pointed at, and burying the paths inside a sentence makes them easy to miss.
    // Quote first, then the paths, then what was typed. The quote is trimmed to a few lines: a
    // reply that repeats forty lines back at the session costs it context for no benefit.
    const quote = quoteAll(replyTo)
    // `composeReply` puts a BLANK LINE between the blocks, and that is not formatting: joined with a
    // single newline, CommonMark's lazy continuation pulls what was typed into the blockquote, and
    // the person's own words render inside the grey bar as if the session had said them.
    let composed = composeReply({ quote, paths: attached.map(a => a.path), text })
    // The `:vault` chip: grant first (the gesture), then the chip becomes references + a briefing. A
    // grant that is refused stops the send and keeps the draft — a message pointing at secrets the
    // session cannot use would only fail later, at the command.
    if (hasVaultChip(composed)) {
      if (!vaultSel) { setNotice(pt ? 'Escolha de novo os segredos do chip 🔐 (clique nele).' : 'Choose the 🔐 chip\'s secrets again (click it).'); return }
      const g = await grantVault(vaultSel)
      if (!g.ok) { setNotice(g.sentence || (pt ? 'Os segredos não foram liberados; nada foi enviado.' : 'The secrets were not granted; nothing was sent.')); return }
      setNotice(null)
      composed = expandVaultChip(composed, g.refs.map(r => r.ref), g.briefing)
    }
    // Dictated? The model is told in one short trailing line — see `dictationMark.ts`. Taken and
    // cleared here, so the NEXT message starts undictated unless the microphone is used again.
    const full = dictatedRef.current ? markDictated(composed) : composed
    dictatedRef.current = false
    /**
     * THE COMPOSER EMPTIES ON THE KEYSTROKE, NOT ON THE ANSWER.
     *
     * It used to `await act(...)` and only then clear the draft and draw the echo, so the whole
     * round trip was visible as the field sitting there full with nothing happening. Reported as
     * "a partir do momento que eu dou enter numa mensagem ela está demorando pra ser enviada", and
     * the delivery was never the slow part — the WAIT FOR THE ANSWER was, and the browser has
     * nothing to learn from it that changes what it should draw.
     *
     * The echo already carries the honesty this needs: it renders as an UNREAD message with the
     * wait said in words, and it is retired the instant the transcript carries it. So drawing it
     * before the answer is not a claim that it landed — it is the same claim it was already making
     * one round trip later.
     *
     * A FAILURE PUTS IT BACK, exactly as it was: the text, the attachments and the reply target.
     * The one thing a person must never lose is what they wrote, and an optimistic clear that
     * cannot undo itself is how that happens.
     */
    const restore = { draft, attached, replyTo }
    setSending(true)
    // A SOURCE draws its own optimistic turn (the native runtime's `sent`); an echo would be a second copy.
    if (!source) editEcho(list => [...list, full])
    setDraft('')
    sessionScratch.clearDraft(scratchId)
    setAttached([])
    sessionScratch.writeAttachments(scratchId, [])
    editReply([])
    setAtTail(true)
    toTail()
    setNotice(null)

    /**
     * AN ANSWER IS NOT A PROMPT, and it goes down the route the server verified for it.
     *
     * `approve` with the option's `choice` AND the text: the digit selects the write-your-own row
     * and turns it into a field, then the words go in, then the return. Those three steps are the
     * server's (`answerSession`), and sending this as a `prompt` would type it into the dialog's
     * own filter instead — which is exactly what `canPrompt`'s `blocked` rule exists to prevent.
     *
     * The ATTACHMENTS still ride along, because that is half of why the composer is the field here:
     * their paths are part of the answer's text. And the optimistic clear above covers this path
     * unchanged: `restore` puts back the words, the files AND the reply target if it does not go.
     */
    // Captured BEFORE the await: `answering` is cleared on a successful send below, and this is
    // what the echo has to be retired AGAINST — see `dialogAnswerEcho.ts`.
    const answeringShape = answeringNow && answering ? answering.shape : null
    const out = answeringNow && answering
      ? await act({ id: session.id, action: 'approve', choice: answering.number, text: full })
      : await act({ id: session.id, action: 'prompt', text: full })
    setSending(false)
    if (out.ok) {
      // Ask for the transcript at once. The harness writes the user turn as soon as it takes the
      // message, and the next scheduled read is up to `CHAT_POLL_MS` away — three seconds in which
      // the echo sits there labelled as undelivered when it has in fact already landed.
      nudgeChat.current()
      // THIS ECHO WILL NEVER BE RETIRED BY THE TRANSCRIPT. A free-text dialog answer lands as a
      // `tool_result`, never a user turn, so `pendingEchoes`'s containment check has nothing to
      // ever match it against — without this it queued on screen forever. See `dialogAnswerEcho.ts`.
      if (answeringShape !== null) dialogAnswerEchoes.current.set(full, answeringShape)
      // The question has been answered; the composer stops being an answer field. The card itself
      // goes when the row stops reporting the dialog, which is the server's answer and not ours.
      // Everything else was already cleared on the keystroke — see the optimistic clear above.
      setAnswering(null)
      return
    }
    // It did not go. Take the echo back out — leaving it would show a message that is waiting for
    // a session that never received it — and give the person their words back untouched.
    editEcho(list => list.filter(t => t !== full))
    // EXT.OPEN: not a failure — a QUESTION. The words stay in the field, and the one confirmation
    // sends exactly them (`continueHere`).
    if (out.confirm) setContinueAsk({ message: out.message, text: full })
    setDraft(restore.draft)
    sessionScratch.writeDraft(scratchId, restore.draft)
    setAttached(restore.attached)
    sessionScratch.writeAttachments(scratchId, restore.attached)
    editReply(restore.replyTo)
    // A question is asked in its dialog, once — not again as a line under the field.
    if (!out.confirm) setNotice(out.message)
  }

  if (payload?.unavailable) {
    return (
      <Centered>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
          {payload.unavailable}
        </p>
        {payload.recorded && <RecordedBlock recorded={payload.recorded} pt={pt} />}
        {(payload.attention ?? []).map((m, i) => <AttentionMarkLine key={`am-${i}`} mark={m} pt={pt} />)}
        <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-tertiary)', opacity: 0.8 }}>
          {pt
            ? 'A visão de terminal continua disponível para esta sessão.'
            : 'The terminal view is still available for this session.'}
        </p>
      </Centered>
    )
  }

  return (
    <div
      // `position: 'relative'` is what makes the composer's own `position: absolute` below resolve
      // against THIS box (the whole conversation panel) rather than the next positioned ancestor up
      // the tree — see the composer's own header for why it is absolute now.
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      onDragOver={e => {
        if (!canPrompt) return
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(REPO_DRAG_MIME)) {
          e.preventDefault()
        }
      }}
      onDrop={onDrop}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
          // LONGHAND, not the `'20px 20px 8px'` shorthand this used to be: the bottom side alone now
          // carries the composer's own measured height plus 12px of breathing room, so the last
          // message (and the "trabalhando" line under it) never lands behind the floating field —
          // see `composerHeight`'s own header for why it is measured rather than assumed.
          paddingTop: 20, paddingRight: 20, paddingBottom: composerHeight + 12, paddingLeft: 20,
          // A flick that reaches the top of the conversation stops HERE. Without it the
          // gesture chains to the document, which has nothing to scroll and rubber-bands the
          // whole page instead — reported as "ele roda a página inteira e não deixa scrollar",
          // with the header dragged out from under the status bar. The document lock in
          // App.tsx is the other half; this is the half that keeps the gesture where it began.
          overscrollBehavior: 'contain',
          // THE CENTRED COLUMN NEVER SHIFTS WHEN THE SCROLLBAR COMES AND GOES (owner: "simplesmente
          // nao ta alinhado os cards de mensagens como deveriam estar" — measured off their own
          // screenshot: an earlier bubble at x≈124–944, the last bubble and the composer at
          // x≈131–950, ~7px further right). This scroller and the composer below it are SIBLINGS —
          // the composer never scrolls and so never carries a scrollbar — and each centres its own
          // `maxWidth: 820` column independently via `margin: '0 auto'`. A NATIVE (non-overlay)
          // scrollbar carves its own gutter out of THIS element's content box the moment the
          // conversation grows past the viewport, shrinking the box the 820px column centres
          // within and sliding it left by half the scrollbar's width — while the composer's own
          // column, with no scrollbar of its own, keeps centring in the FULL width. A short
          // conversation (no scrollbar yet) and a long one (scrollbar present) therefore centre
          // their message column at two different x positions, and the composer never moves at
          // all — which is exactly "the last bubble lines up with the composer, the earlier one
          // does not" once enough turns have made the list scroll. `scrollbarGutter: 'stable'`
          // reserves the gutter's width UNCONDITIONALLY, whether or not a scrollbar is currently
          // drawn, so the content box — and the column centred inside it — is the same width, and
          // the message column and the composer stay flush at the same left/right edges, from the
          // very first turn.
          scrollbarGutter: 'stable',
        }}
      >
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {loading ? (
            <Loading pt={pt} />
          ) : turns.length === 0 && live === null && echo.length === 0 ? (
            <Muted text={pt ? 'Esta conversa ainda não tem mensagens.' : 'This conversation has no messages yet.'} />
          ) : null}

          {/* Where the window BEGINS, said at the top of the scroll — the one place a reader looks
              when they wonder where the rest went. Everything derived from these turns (the
              gallery, Files, Live) inherits the same cap and says so in its own panel. */}
          {!loading && payload?.older && (
            <p style={{
              margin: 0, textAlign: 'center', fontSize: 11, lineHeight: 1.5,
              color: 'var(--text-tertiary)',
            }}>{payload.older}</p>
          )}

          {turns.slice(firstShown).map((t, j) => { const i = firstShown + j; return (<Fragment key={i}>
            {(placedAttention.before.get(i) ?? []).map((m, k) => <AttentionMarkLine key={`am-${i}-${k}`} mark={m} pt={pt} />)}
            <ChatBubble
              turn={t}
              sessionId={session.id}
              lang={lang}
              harness={session.harness}
              {...(payload?.attachmentSends ? { attachmentSends: payload.attachmentSends } : {})}
              {...(payload?.attachmentMessages
                ? { attachmentMessages: payload.attachmentMessages, markerSinceMs: previousPersonTurnMs(turns, i) }
                : {})}
              {...(turnAnchors[i] ? { anchorId: turnAnchors[i]! } : {})}
              {...(t.role === 'user' ? (() => { const grant = vaultGrantMessage(t.text, sessionGrants, pt); return grant ? { vaultGrant: grant } : {} })() : {})}
              {...(t.role === 'user' ? { onQuoteClick: onSentQuote } : {})}
              {...(canPrompt && selecting === null ? { onReply: onReplyToTurn } : {})}
              {
                // Forwarding and selecting READ this conversation, so they need nothing from the
                // session's state — only a message that says something.
                ...(forwardable(t) && !t.system && !t.task
                  ? {
                    onForward: onForwardTurn,
                    onSelectStart,
                    ...(selecting !== null
                      ? { selectMode: true, selected: selecting.has(turnKeyOf(t)), onToggleSelect }
                      : {}),
                  }
                  : {})
              }
              {
                // Only on the assistant's side: quoting a fragment of your OWN message back at the
                // session says nothing it did not already read from you a moment ago.
                ...(canPrompt && t.role === 'assistant' ? { onReplyExcerpt: onReplyToExcerpt } : {})
              }
            />
          </Fragment>)})}
          {placedAttention.after.map((m, j) => <AttentionMarkLine key={`am-end-${j}`} mark={m} pt={pt} />)}

          {/* An echo IS an unread message by definition — it is retired the instant the transcript
              carries the same text — so it is drawn as one: faded, with the wait said in words
              under it. It used to be indistinguishable from a delivered message, and on a session
              mid-turn the wait is minutes. */}
          {queued.map((q, i) => (
            <ChatBubble
              key={`echo-${i}`}
              turn={{ role: 'user', text: q.text }}
              sessionId={session.id}
              lang={lang}
              harness={session.harness}
              {...(payload?.attachmentSends ? { attachmentSends: payload.attachmentSends } : {})}
              anchorId={echoAnchorId(session.id, q.text)}
              awaiting
              awaitingWorking={working}
              onQuoteClick={onSentQuote}
              {...(q.at !== undefined ? { awaitingSinceMs: Math.max(0, now - q.at) } : {})}
            />
          ))}

          {/* SEND NOW, under the LAST queued bubble: the queue is one group and this acts on the
              whole of it. Only while claude is working with something held (`sendNowShown`) — idle,
              nothing is held, and elsewhere the keystroke does not exist. */}
          <SendNowControl
            offered={showSendNow}
            count={queued.length}
            run={sendNowRun}
            pt={pt}
            onSend={() => void sendNow()}
            onDismiss={() => setSendNowRun(null)}
          />

          {/* `live` (the screen read off the terminal frame) is deliberately NOT rendered here any
              more — it used to show as a full-size bubble, and a CLI's own screen carries its own
              chrome (a footer like "auto mode on · esc to interrupt") that `liveTurn.ts`'s line
              filter cannot promise to catch for every harness, so a raw, oversized read-from-the-
              screen block was both the wrong SIZE for a "something is happening" signal and the
              wrong PLACE for whatever chrome slipped through. `live` still drives the follow-the-
              tail effect below (new screen content is a sign to keep scrolling), and `WorkingNote`
              is the one and only "the session is busy" indicator now — small, grey, no raw text. */}

          {/* The conversation on screen is one this tab cached before you left, and the current one
              is on its way. AT THE TAIL rather than the top: the view lands at the end, which is
              where the reader is looking and where the messages that changed will appear. */}
          {showRefreshing && (
            <p role="status" style={{
              margin: 0, textAlign: 'center', fontSize: 11, lineHeight: 1.5,
              color: 'var(--text-tertiary)',
            }}>{pt ? 'Atualizando a conversa…' : 'Updating this conversation…'}</p>
          )}

          {/* The quiet line saying the session is busy. AFTER the messages, deliberately not styled
              as one — it is the only place the reasoning and the tool calls surface, and rendering
              those as chat entries buried the sentences actually addressed to the user. */}
          {/* A SOURCE's live text is the model's own stream — exact, unlike a screen read — so it
              is drawn as the bubble it will become (`chatSource.ts`). */}
          {(source?.liveText || source?.liveReasoning) && (
            <ChatBubble turn={{ role: 'assistant', text: source.liveText ?? '', ...(source.liveReasoning ? { reasoning: source.liveReasoning } : {}) }} lang={lang} harness={session.harness} sessionId={session.id} />
          )}

          {showWorking && (
            <WorkingNote
              lang={lang}
              {...(source?.runningTools?.length ? { tools: source.runningTools } : newestAssistant?.tools ? { tools: newestAssistant.tools } : {})}
              thinking={Boolean(newestAssistant?.thinking)}
              {...(compacting ? { compacting } : {})}
            />
          )}

          {/* The question, at the BOTTOM of the conversation, where the next thing to happen goes.
              It is not in the transcript — a dialog lives on the screen and is never written to the
              JSONL — so it arrives on the fleet row instead. */}
          {blocked && row && (
            <ApprovalCard
              row={row}
              lang={lang}
              act={act}
              answering={answering?.number ?? null}
              onWrite={o => {
                setAnswering({ ...o, shape: dialogShape })
                // The point of handing the composer over is that it is READY — the caret in it, on
                // the next frame, so the next thing the person does is type. Same call the skill
                // picker and the reply buttons already make, for the same reason.
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            />
          )}
          {/* A SOURCE's questions, in the same place (`chatSource.ts`'s `approvals` slot). */}
          {source?.approvals}
        </div>
      </div>

      {/* PINNED, and on its OWN surface. It never scrolls with the conversation — replying to
          something further up used to mean scroll down, write, scroll back — and it is a shade
          apart from the bubbles, which are `--bg-card` on `--bg-base`: at the same value it read as
          another message rather than as the place you type. */}
      <div ref={setComposerGroundEl} className="ag-composer-ground" style={{
        // `absolute`, not `sticky` (owner, 2026-09-27: "a conversa deveria rolar a altura toda do
        // painel, com o composer flutuando por cima") — `sticky` still made this a FLEX SIBLING of
        // the scroller above, so the column handed the scroller `container height − composer
        // height` regardless, and the scrollbar's own track stopped at the composer's top edge
        // instead of running to the panel's true bottom. `absolute` removes it from the flex flow
        // entirely: the scroller now fills the WHOLE column (see its own `flex: 1`, unchanged), and
        // this floats over its bottom edge instead of shrinking it. `left`/`right: 0` span the same
        // width `sticky` always gave it (the panel's own width); `bottom: 0` is the same anchor.
        position: 'absolute', left: 0, right: 0, bottom: 0,
        // NO border and NO surface of its own. This used to be a full-width footer bar with a rule
        // across the top, which read as a region of the page rather than as a control — and the
        // thing people recognise as "where I type" is a bounded field, not a strip. The FIELD
        // below carries the border now; this element only positions it.
        //
        // `background: transparent` is what left the conversation CUT here rather than passing
        // under: transparent is not a ground, it is the absence of one, so a message simply ended
        // at this element's top edge. `.ag-composer-ground` draws the blur-and-fade behind it. The
        // FIELD keeps its own opaque surface and border — that is deliberate and recorded above.
        //
        // `paddingRight` carries the extra `chatGutterPx` (normally 0) — see that state's own
        // header. It shrinks THIS element's own content box on the right by exactly what the
        // message scroller above now reserves for its gutter, so the `maxWidth: 820, margin: '0
        // auto'` column below — the composer's own version of the same column the bubbles centre
        // in — re-centres at the SAME left/right edges, whether or not the conversation is
        // currently tall enough to scroll. Longhand rather than the shorthand this used to be,
        // because the shorthand cannot express "20px, but only the right side also carries a
        // variable" without repeating the other three sides by hand anyway.
        paddingTop: 10, paddingRight: 20 + chatGutterPx, paddingBottom: 16, paddingLeft: 20,
        background: 'transparent',
        // ITS OWN STACKING CONTEXT. `.ag-composer-ground::before` (the blur-and-fade) sits at
        // `z-index: -1`, and without a context here that `-1` resolved against the PANEL — so the
        // fade was painted BEHIND the conversation scroller and the text showed straight through
        // (owner, 2026-09-29). `z-index: 1` keeps the ground under the field and over the messages.
        zIndex: 1,
      }}>
        {/* Back to the end. Only while the reader has actually scrolled away — a control that is
            always there teaches nothing about where you are. */}
        {!atTail && !loading && (
          <button
            onClick={() => { setAtTail(true); toTail() }}
            aria-label={pt ? 'Ir para a última mensagem' : 'Jump to the latest message'}
            title={pt ? 'Ir para a última mensagem' : 'Jump to the latest message'}
            style={{
              position: 'absolute', top: -46, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, borderRadius: 17, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)', boxShadow: 'var(--ag-shadow-pop)',
            }}
          >
            <ArrowDown size={16} />
          </button>
        )}

        {/* `relative` so the `/` picker can float ABOVE the field instead of pushing it down —
            growing the composer under somebody's fingers moves the field they are typing in. */}
        <div style={{ maxWidth: 820, margin: '0 auto', position: 'relative' }}>
          {/* THE SKILL PICKER, opened by typing `/` at the start of a line. Above the field, over
              the conversation, listing what this session can be asked to run — GROUPED BY PACKAGE,
              because 49 flat entries is the same as not having a list. It writes `/<name> ` into
              the draft and does not send. */}
          {skillPickerOpen && (
            <div
              ref={skillPickerRef}
              role="listbox"
              aria-label="Skills"
              style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 60,
                marginBottom: 8, padding: 4, borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.38)',
                maxHeight: isMobile ? '50vh' : 300, overflowY: 'auto', overscrollBehavior: 'contain',
              }}
            >
              {skills === null ? (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Lendo as skills…' : 'Reading the skills…'}
                </p>
              ) : skillsNote ? (
                /* The PERMANENT fact, in the machine's own words: a harness that can never take a
                   skill is told so rather than shown an empty list it will read as a broken
                   install. */
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {skillsNote}
                </p>
              ) : slashFlat.length === 0 ? (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {emptyPickerReason(skills.length, slashText ?? '', pt ? 'pt' : 'en')}
                </p>
              ) : (
                <>
                  {slashGroups.map(group => (
                    <div key={group.label}>
                      {/* The package's name. `pkg` is what the plugin is called; the loose group
                          carries a SENTENCE instead, never a blank heading. */}
                      <p style={{
                        margin: '4px 8px 2px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: group.pkg === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
                      }}>
                        {group.label}
                      </p>
                      {group.skills.map(sk => {
                        const at = slashFlat.indexOf(sk)
                        const active = at === Math.min(slashIndex, slashFlat.length - 1)
                        return (
                          <button
                            key={sk.name}
                            role="option"
                            aria-selected={active}
                            data-skill-index={at}
                            title={sk.description}
                            // The press must not blur the field: focus is what holds the caret the
                            // insertion writes against.
                            onMouseDown={e => e.preventDefault()}
                            onMouseEnter={() => setSlashIndex(at)}
                            onClick={() => insertSkill(sk.name)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 8,
                              border: 'none', background: active ? 'var(--bg-surface)' : 'transparent',
                              color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5,
                              cursor: 'pointer', minWidth: 0,
                            }}
                          >
                            <span style={{
                              display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              /{sk.name}
                            </span>
                            {/* One line of what it does. The name alone does not tell you whether
                                `wrangler` is a tool or a topic. */}
                            <span style={{
                              display: 'block', fontSize: 10.5, lineHeight: 1.35, color: 'var(--text-tertiary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {sk.description}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  <p style={{ margin: '4px 8px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                    {pt
                      ? '↑↓ escolhe · enter ou tab escreve no campo · esc fecha. Não envia.'
                      : '↑↓ to move · enter or tab writes it into the field · esc closes. It does not send.'}
                  </p>
                </>
              )}
            </div>
          )}
          {/* THE MCP PICKER, opened by typing `@` at the start of a word. Two levels — the
              configured SERVERS, and (once `:` is typed after one) that server's TOOLS — driven
              entirely by the text itself, exactly as `atMenu.ts`'s header explains. */}
          {atOpen && (
            <div
              ref={atPickerRef}
              role="listbox"
              aria-label="MCP"
              style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 60,
                marginBottom: 8, padding: 4, borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.38)',
                maxHeight: isMobile ? '50vh' : 300, overflowY: 'auto', overscrollBehavior: 'contain',
              }}
            >
              {mcpServers === null ? (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Lendo os servidores MCP…' : 'Reading the MCP servers…'}
                </p>
              ) : atLvl?.level === 'tool' ? (
                // TOOL LEVEL — a `:` was typed after a server's name.
                atTools === null ? null : atTools.kind !== 'tools' ? (
                  <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                    {atToolViewReason(atTools, atLvl.serverText, pt ? 'pt' : 'en')}
                  </p>
                ) : atTools.tools.length === 0 ? (
                  <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                    {emptyAtToolReason(
                      atLvl.serverText, findAtServer(mcpServers, atLvl.serverText)?.tools?.length ?? 0,
                      atLvl.toolText, pt ? 'pt' : 'en',
                    )}
                  </p>
                ) : (
                  <>
                    {atTools.tools.map((t, i) => (
                      <button
                        key={t.name}
                        role="option"
                        aria-selected={i === Math.min(atIndex, atTools.tools.length - 1)}
                        data-at-index={i}
                        title={t.description}
                        onMouseDown={e => e.preventDefault()}
                        onMouseEnter={() => setAtIndex(i)}
                        onClick={() => insertAtTool(atLvl.serverText, t.name)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 8,
                          border: 'none',
                          background: i === Math.min(atIndex, atTools.tools.length - 1) ? 'var(--bg-surface)' : 'transparent',
                          color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5,
                          cursor: 'pointer', minWidth: 0,
                        }}
                      >
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.name}
                        </span>
                        {t.description && (
                          <span style={{
                            display: 'block', fontSize: 10.5, lineHeight: 1.35, color: 'var(--text-tertiary)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {t.description}
                          </span>
                        )}
                      </button>
                    ))}
                    <p style={{ margin: '4px 8px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                      {pt
                        ? '↑↓ escolhe · enter ou tab adiciona (dá para escolher mais de uma) · esc fecha. Não envia.'
                        : '↑↓ to move · enter or tab adds it (choose more than one) · esc closes. It does not send.'}
                    </p>
                  </>
                )
              ) : (
                // SERVER LEVEL — no `:` typed yet.
                atServers.length === 0 ? (
                  <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                    {emptyAtServerReason(mcpServers.length, atLvl?.serverText ?? '', pt ? 'pt' : 'en')}
                  </p>
                ) : (
                  <>
                    {atServers.map((s, i) => (
                      <button
                        key={s.name}
                        role="option"
                        aria-selected={i === Math.min(atIndex, atServers.length - 1)}
                        data-at-index={i}
                        onMouseDown={e => e.preventDefault()}
                        onMouseEnter={() => setAtIndex(i)}
                        onClick={() => insertAtServer(s.name)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 8,
                          border: 'none',
                          background: i === Math.min(atIndex, atServers.length - 1) ? 'var(--bg-surface)' : 'transparent',
                          color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5,
                          cursor: s.status === 'unreachable' ? 'default' : 'pointer', minWidth: 0,
                        }}
                      >
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          @{s.name}
                        </span>
                        <span style={{
                          display: 'block', fontSize: 10.5, lineHeight: 1.35,
                          color: s.status === 'unreachable' ? 'var(--accent-red)' : 'var(--text-tertiary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {atServerStatusText(s, pt ? 'pt' : 'en')}
                        </span>
                      </button>
                    ))}
                    <p style={{ margin: '4px 8px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                      {pt
                        ? '↑↓ escolhe · enter ou tab referencia · digite “:” para ver as ferramentas · esc fecha.'
                        : '↑↓ to move · enter or tab references it · type “:” to see its tools · esc closes.'}
                    </p>
                  </>
                )
              )}
            </div>
          )}
          {/* THE SESSION PICKER, opened by typing `#` at the start of a word. It lists the fleet —
              searched by title, folder, harness and state — and writes a CHIP naming the session
              (`#«title · id»`) that goes out as a lean reference. A pointer, never the other
              session's content: that is what Forward is for. */}
          {hashOpen && (
            <div
              ref={hashPickerRef}
              role="listbox"
              aria-label={pt ? 'Mencionar sessão' : 'Mention a session'}
              style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 60,
                marginBottom: 8, padding: 4, borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.38)',
                maxHeight: isMobile ? '50vh' : 300, overflowY: 'auto', overscrollBehavior: 'contain',
              }}
            >
              {hashRows.length === 0 ? (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {fleet.sessions.length === 0
                    ? (pt ? 'Lendo as sessões…' : 'Reading the sessions…')
                    : (pt ? `Nenhuma outra sessão corresponde a “${hashText ?? ''}”.` : `No other session matches “${hashText ?? ''}”.`)}
                </p>
              ) : (
                <>
                  {hashRows.map((r, i) => {
                    const active = i === Math.min(hashIndex, hashRows.length - 1)
                    const where = [
                      (HARNESS_LABELS as Record<string, string>)[r.harness] ?? r.harness,
                      r.stateLabel,
                      r.task || r.project || r.cwd,
                    ].filter(Boolean).join(' · ')
                    return (
                      <button
                        key={r.id}
                        role="option"
                        aria-selected={active}
                        data-hash-index={i}
                        onMouseDown={e => e.preventDefault()}
                        onMouseEnter={() => setHashIndex(i)}
                        onClick={() => insertMention(r)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 8,
                          border: 'none', background: active ? 'var(--bg-surface)' : 'transparent',
                          color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5,
                          cursor: 'pointer', minWidth: 0,
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            #{r.title || (pt ? 'sem título' : 'untitled')}
                          </span>
                          <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
                            {shortSessionId(r)}
                          </span>
                        </span>
                        {where && (
                          <span style={{
                            display: 'block', fontSize: 10.5, lineHeight: 1.35, color: 'var(--text-tertiary)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {where}
                          </span>
                        )}
                      </button>
                    )
                  })}
                  <p style={{ margin: '4px 8px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                    {pt
                      ? '↑↓ escolhe · enter ou tab menciona · esc fecha. Vai como nome + id curto — para levar o conteúdo, use Encaminhar.'
                      : '↑↓ to move · enter or tab mentions it · esc closes. It goes as name + short id — to carry content, use Forward.'}
                  </p>
                </>
              )}
            </div>
          )}
          {/* NO COMPOSER UNTIL THE CONVERSATION IS THERE. A field offered over a conversation still
              loading invites a message into a session whose state is not yet known — including one
              sitting in a dialog, where the text would go into the dialog's own filter. */}
          {loading ? (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              {pt ? 'Carregando a conversa…' : 'Loading the conversation…'}
            </p>
          ) : (
            <>
              {blocked && (
                <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--anthropic-orange)', lineHeight: 1.5 }}>
                  {pt
                    ? 'Esta sessão está esperando resposta a uma pergunta dela. Responda no card acima — o que você digitar aqui iria para o filtro do diálogo.'
                    : 'This session is waiting on an answer to a question of its own. Answer it in the card above — anything typed here would go into the dialog’s own filter.'}
                </p>
              )}

              {/* WHAT THE MICROPHONE IS HEARING, live. Interim results are a guess the recogniser
                  keeps revising, so they are shown here and never written into the field — the
                  settled words land in the draft on their own. `role="status"` so it is announced,
                  and it disappears the moment listening stops. */}
              {listening && (
                <p role="status" style={{
                  margin: '0 0 8px', padding: '6px 10px', borderRadius: 9,
                  background: 'var(--bg-elevated)', borderLeft: '3px solid var(--accent-red)',
                  fontSize: 12, lineHeight: 1.45, color: 'var(--text-secondary)',
                  fontStyle: heard === '' ? 'italic' : 'normal',
                }}>
                  {heard === ''
                    ? (pt ? 'ouvindo…' : 'listening…')
                    : heard}
                </p>
              )}

              {/* A session that is not running cannot be written to, and a disabled field is a dead
                  end. The conversation is still fully readable above; what is offered here is the
                  way BACK INTO it. The verb is the row's own `resume`, which the server enables only
                  when it has a conversation to reopen — where it does not, the sentence says why
                  rather than a button that fails. */}
              {showReopen && reopen && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '10px 12px', borderRadius: 12,
                  background: 'var(--bg-base)', border: '1px solid var(--border)',
                }}>
                  <span style={{ flex: 1, minWidth: 160, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
                    {pt
                      ? 'Esta sessão não está rodando, então não dá para escrever nela.'
                      : 'This session is not running, so there is nothing to write to.'}
                  </span>
                  {/* A DRAFT waiting here — typically a FORWARD landed in it — is invisible while the
                      field is hidden, so it is said. It is keyed on the conversation, so Reopen
                      brings the field back with it (`scratchKey`). */}
                  {draft.trim() !== '' && (
                    <span role="status" style={{ flexBasis: '100%', order: 3, fontSize: 11.5, lineHeight: 1.5, color: 'var(--anthropic-orange)' }}>
                      {pt
                        ? 'Há um rascunho guardado aqui. Reabra a sessão para continuar a escrever e enviar.'
                        : 'A draft is waiting here. Reopen the session to finish and send it.'}
                    </span>
                  )}
                  <button
                    onClick={() => void reopenNow()}
                    disabled={!reopen.enabled || reopening}
                    title={reopen.reason}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
                      padding: '9px 14px', borderRadius: 9, border: 'none',
                      background: reopen.enabled ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                      color: reopen.enabled ? '#fff' : 'var(--text-tertiary)',
                      cursor: reopen.enabled && !reopening ? 'pointer' : 'default',
                      fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
                    }}
                  >
                    {reopening ? <AgentisticsLoader size={14} label={reopeningLabel(pt)} /> : <RotateCcw size={14} />}
                    {reopening ? reopeningLabel(pt) : reopen.label}
                  </button>
                  {/* Why it cannot be reopened, in the row's own words. */}
                  {!reopen.enabled && reopen.reason && (
                    <span style={{ width: '100%', fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                      {reopen.reason}
                    </span>
                  )}
                </div>
              )}

              {/* WHAT THIS FIELD IS ABOUT TO DO. While the composer is answering a dialog, the
                  Enter key does something different from what it does every other minute of the
                  day, and a field that changes meaning without saying so is how somebody sends an
                  answer they meant as a message. It names the option by NUMBER and LABEL — the same
                  two things the card shows — and carries the way out. */}
              {answeringNow && answering && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                  padding: '7px 10px', borderRadius: 10, minWidth: 0,
                  border: '1px solid var(--anthropic-orange)',
                  background: 'var(--anthropic-orange-dim)',
                }}>
                  <span style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                    background: 'var(--anthropic-orange)', color: '#fff',
                    fontSize: 10, fontWeight: 700,
                  }}>{answering.number}</span>
                  <span style={{
                    minWidth: 0, flex: 1, fontSize: 11.5, lineHeight: 1.45,
                    color: 'var(--anthropic-orange)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {pt
                      ? `Respondendo à pergunta — ${answering.label}`
                      : `Answering the question — ${answering.label}`}
                  </span>
                  <button
                    onClick={() => setAnswering(null)}
                    aria-label={pt ? 'Cancelar a resposta' : 'Cancel answering'}
                    title={pt ? 'Cancelar (Esc)' : 'Cancel (Esc)'}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 24, height: 24, borderRadius: 6, border: 'none', flexShrink: 0,
                      background: 'transparent', color: 'var(--anthropic-orange)', cursor: 'pointer',
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}

              {/* Loose on the composer's own surface — no second card behind it. It used to sit in
                  its own `--bg-base` box with a border, which read as a field floating inside the
                  field that holds it; dropping both leaves it the same colour as its container. */}
              <ComposerShell hidden={showReopen} dimmed={!canPrompt}>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  onChange={e => pick(e.target.files)}
                  style={{ display: 'none' }}
                />
                {/* THE ATTACHMENTS LIVE INSIDE THE FIELD — its first row, above the text, the way Claude
                    Desktop draws them. They used to sit ABOVE the field, loose over the conversation
                    on a transparent ground, where a pasted screenshot was hard to see and it was not
                    even clear anything was attached (owner, 2026-09-29). Inside the box they read as
                    part of the message being written, which is what they are. */}
                {/* THE QUOTES, as rendered blocks ABOVE the text — a separate row of the field, like
                    the attachments, never painted over the textarea. Each collapses to two lines,
                    opens its source, and has its own ×. */}
                {replyTo.length > 0 && (
                  <div
                    aria-label={pt ? 'Citações desta mensagem' : 'Quotes in this message'}
                    style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 4px 2px', maxHeight: '40vh', overflowY: 'auto' }}
                  >
                    {replyTo.map((t, i) => (
                      <QuoteBlock
                        key={`${t.key ?? ''}:${i}:${t.text.slice(0, 24)}`}
                        text={unquoteLines(quoteFor(t))}
                        pt={pt}
                        onOpen={() => openComposerQuote(t)}
                        onRemove={() => editReply(list => list.filter(x => x !== t))}
                      />
                    ))}
                  </div>
                )}
                <ComposerAttachments
                  items={attached}
                  pt={pt}
                  isImage={isImagePath}
                  imageSrc={attachmentUrl}
                  onOpenImage={path => setComposerLightbox(composerImages.indexOf(path))}
                  onRemove={path => editAttached(list => list.filter(x => x.path !== path))}
                />
                {/* THE INVOCATION IS PAINTED LIKE A BUTTON, IN THE FIELD ITSELF.
                    A textarea cannot hold a coloured span, so a FOUND command is drawn by a mirror:
                    a div with the SAME typography, padding and wrapping, behind the field, drawing
                    the whole draft again with the command's run wrapped in an orange-on-white span
                    — and the field's OWN text turned transparent so only the mirror is seen. That is
                    a bigger step than colouring a background block behind the field's own opaque
                    text (which is all a background-only marker can ever do): a BUTTON needs the
                    glyphs themselves recoloured, and a plain textarea has no way to recolour one run
                    of its own text. `caretColor` is set explicitly so hiding the text does not hide
                    the caret with it (the caret otherwise follows `color`, which the transparency
                    would carry off too) — the trade this makes, and it is a real one, is that a
                    dragged SELECTION over the mirrored text highlights the right span (the browser
                    measures the real, transparent characters) but shows no glyphs inside it, because
                    those glyphs are exactly what was made invisible.
                    `needsMirror`/`draftSegments` (`commandMirror.ts`) are the ONE place both
                    decisions are made — whether to draw the mirror at all and which runs it paints —
                    so the two can never drift into "a mirror with nothing painted" or "hidden text
                    with no mirror to show it". Nothing here is state: both are re-derived from the
                    draft and the token on every render, which is what makes deleting one character
                    of the command turn it back into plain text with no flag to remember.
                    The mirror scrolls with the field, is `aria-hidden` (the text is already in the
                    field, and a screen reader must not hear it twice) and takes no pointer events. */}
                <div style={{ position: 'relative' }}>
                  {needsMirror(cmdToken, mentions) && (
                    <div
                      aria-hidden
                      ref={underlayRef}
                      style={{
                        position: 'absolute', top: 0, left: 0, bottom: 0, right: composerScrollbarPx,
                        overflow: 'hidden', pointerEvents: 'none',
                        boxSizing: 'border-box', padding: '6px 6px',
                        // ABOVE the field, so a quote card can take a click; everything else in
                        // it takes no pointer events, so typing and selecting still reach the field.
                        zIndex: 2,
                        // The field computes to 16px on a phone (index.css's iOS zoom guard, which
                        // is `!important`), so the mirror must too or it stops lining up.
                        fontFamily: composerFieldStyle.fontFamily,
                        fontSize: isMobile ? 16 : composerFieldStyle.fontSize,
                        lineHeight: composerFieldStyle.lineHeight,
                        whiteSpace: 'pre-wrap', overflowWrap: 'break-word', color: 'var(--text-primary)',
                      }}
                    >
                      {draftSegments(draft, cmdToken, mentions).map((seg, i) => {
                        // A plain run gets a key and nothing else, so it can never disagree with
                        // the textarea's own metrics for the text it is standing in for.
                        if (seg.kind === 'plain') return <span key={i}>{seg.text}</span>
                        // TWO MARKS, because they are two different things. A command is an ACTION
                        // the message performs and is painted as the button it effectively is; a
                        // mention is a REFERENCE to something on this machine and is marked as a
                        // chip. Giving both the same paint would say they do the same thing.
                        const command = seg.kind === 'command'
                        return (
                          <span key={i} style={{
                            background: command ? 'var(--anthropic-orange)' : 'var(--accent-blue-dim)',
                            color: command ? '#fff' : 'var(--accent-blue)',
                            borderRadius: 4,
                            // The ring is what gives the run its padding WITHOUT taking any width:
                            // the mirror has to lay out character-for-character with the field
                            // behind it, so nothing here may change the text's metrics.
                            boxShadow: command
                              ? '0 0 0 2px var(--anthropic-orange)'
                              : '0 0 0 2px var(--accent-blue-dim)',
                          }}>{seg.text}</span>
                        )
                      })}
                    </div>
                  )}
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={e => {
                    // Plain text only: the quotes are a separate stack above the field.
                    const raw = e.target.value
                    editDraft(raw)
                    setCaret(e.target.selectionStart ?? raw.length)
                  }}
                  // Every caret move, not only every keystroke: clicking into the middle of a
                  // written prompt changes whether the caret is inside a `/command`, and a picker
                  // that only listened to typing would answer for wherever the caret used to be.
                  onClick={e => {
                    // Clicking the 🔐 chip reopens the vault picker (view, add, remove).
                    const c = e.currentTarget.selectionStart
                    if (vaultChipTokens(draft).some(r => c > r.start && c < r.end)) setVaultPickerOpen(true)
                  }}
                  onSelect={e => {
                    // The caret never rests INSIDE a quote card — it walks over it.
                    const node = e.currentTarget
                    // A selection made in the CONVERSATION (choosing a passage to quote) also fires
                    // this, with the field's caret reset to 0 — it says nothing about where the
                    // person was writing, so it is not recorded.
                    const anchor = document.getSelection()?.anchorNode
                    if (anchor && node.parentElement && !node.parentElement.contains(anchor)) return
                    // A RANGED selection writes no state: re-rendering the whole chat on every
                    // `select` while iOS selection handles are dragged stalled the gesture and its
                    // Copy menu (`selectionCaret.ts`).
                    const from = caretOfSelection(node.selectionStart, node.selectionEnd)
                    if (from === null) return
                    setCaret(from)
                  }}
                  onFocus={() => setTyping(true)}
                  onBlur={e => {
                    setTyping(false)
                    // Leaving the field closes the picker — unless the focus went INTO it, which
                    // is what a keyboard user tabbing onto an entry does.
                    const into = e.relatedTarget as Node | null
                    if (!skillPickerRef.current?.contains(into)) setSlashDismissed(true)
                    if (!hashPickerRef.current?.contains(into)) setHashDismissed(true)
                    if (!atPickerRef.current?.contains(into)) {
                      setAtDismissed(true)
                      setDraft(d => dropEmptyAtTrigger(d))
                    }
                  }}
                  onPaste={onPaste}
                  onKeyDown={e => {
                    // THE PICKER OWNS THESE KEYS WHILE IT IS OPEN, and gives them all back the
                    // moment it closes. Enter must not send: the person is choosing a skill, and a
                    // half-typed `/bra` reaching the session is a message nobody wrote.
                    if (skillPickerOpen && slashFlat.length > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => stepSkill(i, slashFlat.length, 1)); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => stepSkill(i, slashFlat.length, -1)); return }
                      // Enter or Tab — one rule, shared with the `@` picker below. See
                      // `pickerKeys.ts` for why shift is excluded and why Tab is not gated on
                      // mobile the way Enter is.
                      if (isPickerSelectKey({ key: e.key, shiftKey: e.shiftKey, isMobile })) {
                        e.preventDefault()
                        const picked = slashFlat[Math.min(slashIndex, slashFlat.length - 1)]
                        if (picked) insertSkill(picked.name)
                        return
                      }
                    }
                    // Escape closes the picker BEFORE it reaches the stop verb: a person dismissing
                    // a list they opened by accident must not interrupt the session's turn.
                    if (e.key === 'Escape' && skillPickerOpen) { e.preventDefault(); setSlashDismissed(true); return }
                    // THE `@` PICKER OWNS THE SAME KEYS, over whichever level is showing. At the
                    // tool level Enter does NOT close it — `insertAtTool` reopens an empty
                    // `@server:` trigger right after the token it writes, which is the whole
                    // mechanism behind picking more than one before moving on.
                    if (atOpen && atFlatLen > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setAtIndex(i => stepSkill(i, atFlatLen, 1)); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setAtIndex(i => stepSkill(i, atFlatLen, -1)); return }
                      if (isPickerSelectKey({ key: e.key, shiftKey: e.shiftKey, isMobile })) {
                        e.preventDefault()
                        const i = Math.min(atIndex, atFlatLen - 1)
                        if (atLvl?.level === 'tool') {
                          const picked = atTools?.kind === 'tools' ? atTools.tools[i] : undefined
                          if (picked) insertAtTool(atLvl.serverText, picked.name)
                        } else {
                          const picked = atServers[i]
                          if (picked) insertAtServer(picked.name)
                        }
                        return
                      }
                    }
                    // THE `#` PICKER owns the same keys while it is open — see `insertMention`.
                    if (hashOpen && hashRows.length > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setHashIndex(i => stepSkill(i, hashRows.length, 1)); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setHashIndex(i => stepSkill(i, hashRows.length, -1)); return }
                      if (isPickerSelectKey({ key: e.key, shiftKey: e.shiftKey, isMobile })) {
                        e.preventDefault()
                        const picked = hashRows[Math.min(hashIndex, hashRows.length - 1)]
                        if (picked) insertMention(picked)
                        return
                      }
                    }
                    if (e.key === 'Escape' && hashOpen) { e.preventDefault(); setHashDismissed(true); return }
                    // SELECTION MODE takes Escape before the stop verb — leaving the mode must never
                    // also interrupt the session's turn.
                    if (e.key === 'Escape' && selecting !== null) { e.preventDefault(); setSelecting(null); return }
                    if (e.key === 'Escape' && atOpen) {
                      e.preventDefault()
                      setAtDismissed(true)
                      // Closing the picker ends the pick, so the open `@server:` it left for the
                      // NEXT one is scaffolding now — see `dropEmptyAtTrigger`.
                      setDraft(d => dropEmptyAtTrigger(d))
                      return
                    }
                    // ON A PHONE, ENTER BREAKS THE LINE. Asked for directly, and it is the
                    // convention every messaging app on a touch keyboard follows: the return key is
                    // the only way to write a second line there, because `shift+enter` needs a
                    // shift key the software keyboard does not have. Sending is the ✈ button, which
                    // is a 44px target sitting right beside the field. On a hardware keyboard the
                    // rule is the opposite one and unchanged — enter sends, shift+enter breaks —
                    // and the picker above follows the same split for the same reason.
                    if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); void send() }
                    // ANSWERING MODE LETS GO FIRST. Escape here means "I am not answering with my
                    // own words after all" — the draft is kept, because it is what was typed and
                    // may well be the next message. Only once that is off does Escape reach the
                    // stop verb; a single key doing both at once is the double-booking the tab bar
                    // was fixed for.
                    if (e.key === 'Escape' && answeringNow) { e.preventDefault(); setAnswering(null); return }
                    // The composer's own "esc": stops the CURRENT turn without touching the draft
                    // or the field's own ability to keep taking text — see `stopNow`.
                    if (e.key === 'Escape' && stopEnabled) { e.preventDefault(); void stopNow() }
                  }}
                  // NEVER WHILE IT HAS THE CARET. `disabled` blurs, so making it depend on a
                  // 5s poll makes the poll able to interrupt a sentence. What the state actually
                  // has to stop is SENDING, and `send()` refuses on its own — a field that accepts
                  // text it cannot deliver yet costs nothing, while a field that empties your focus
                  // mid-word costs the sentence.
                  disabled={!typing && (!canPrompt || sending)}
                  rows={1}
                  placeholder={answeringNow
                    ? (pt ? 'Escreva a sua resposta…' : 'Write your own answer…')
                    : canPrompt
                      ? (pt ? 'Escreva para esta sessão…' : 'Write to this session…')
                      : (pt ? 'Indisponível para esta sessão' : 'Not available for this session')}
                  style={{
                    // NO `flex: 1`. In a COLUMN container that sets `flex-basis: 0` on the HEIGHT
                    // axis, which beats the explicit height the auto-grow effect writes — so the
                    // field never grew past its one row however much was typed, and a prompt could
                    // only be read two lines at a time. It was correct while the composer was a
                    // ROW and was left behind when it became a column.
                    ...composerFieldStyle,
                    // Transparent ONLY while the mirror is drawing the same text underneath — see
                    // the note above the mirror div. `caretColor` is set unconditionally to the same
                    // colour the text would otherwise be, so it never rides on `color` and vanishes
                    // the moment `color` does.
                    color: needsMirror(cmdToken, mentions) ? 'transparent' : 'var(--text-primary)',
                    caretColor: 'var(--anthropic-orange)',
                    fontFamily: 'inherit', fontSize: 13.5,
                    lineHeight: 1.5, maxHeight: maxComposerH, overflowY: 'auto', padding: '6px 6px',
                    // Above the mirror.
                    position: 'relative', zIndex: 1,
                    // Native selection and the iOS Copy callout, said explicitly so no ancestor rule
                    // can take them away from the one place text is written.
                    userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default',
                  }}
                  onScroll={e => {
                    syncComposerMirror()
                  }}
                />
                </div>

                {slashHint && (
                  <p role="status" style={{
                    margin: '2px 6px 0', fontSize: 10.5, lineHeight: 1.5,
                    color: 'var(--text-tertiary)',
                  }}>
                    {pt
                      ? 'Uma skill só vale no começo da linha — apague o que está antes, ou quebre a linha.'
                      : 'A skill only counts at the start of a line — clear what is before it, or break the line.'}
                  </p>
                )}

                {/* MISSING WARNS, IT NEVER BLOCKS. `commandToken.ts` already refuses to guess here:
                    this only ever renders for `missing` (the session's own list does not have it),
                    never for `unknown` (no list to check yet) — see its header for why those two
                    are not the same fact. The send button below reads none of this. */}
                {cmdToken?.state === 'missing' && (
                  <p role="status" style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    margin: '2px 6px 0', fontSize: 10.5, lineHeight: 1.5,
                    color: '#f59e0b',
                  }}>
                    <AlertTriangle size={11} style={{ flexShrink: 0 }} />
                    {commandNotFoundNotice(cmdToken.text, pt)}
                  </p>
                )}

                {/* The controls, on their own line under the text. ATTACH opens the row on the
                    left and the acting group closes it on the right — the two halves are what the
                    control does: attach only prepares a message, the group at the other end sends
                    it, stops the turn, or opens what is used rarely.
                    The gap is 6 rather than 4, and the two halves are separated by the whole
                    remaining width: asked for a row where the controls "nao fiquem entulhados". A
                    row of touching 34px squares reads as one object with lines in it. */}
                <ComposerToolbar>
                {/* ANSWERING A QUESTION IS NOT WRITING A PROMPT, so the row is not the same row.
                    An answer travels a different route — `answerSession` presses the option's
                    digit, waits for the field to open, then types ONE line and returns — and an
                    attachment is a PATH on a line of its own, so what would reach the dialog is a
                    path submitted as the answer. The control is removed rather than disabled: a
                    greyed button in a mode a person entered on purpose reads as something broken.
                    Asked for in these words: the prompt input, "removendo alguns botões APENAS PRA
                    RESPONDER A QUESTAO FEITA PELO LLM". */}
                {!answeringNow && (
                <ComposerAttachButton
                  onClick={() => fileRef.current?.click()}
                  disabled={!canPrompt}
                  uploading={uploading}
                  label={pt ? 'Anexar arquivo' : 'Attach file'}
                />
                )}

                {/* DICTATION, beside attach — the pair that PREPARES a message, which is what the
                    left of this row is. It was reachable only through the "more" menu, and two
                    clicks for a control used mid-sentence is one too many.
                    ONLY WHEN IT CAN WORK. Its refusal needs a LINE, not a `title` — the Web Speech
                    API needs a secure context, so a dashboard opened over plain HTTP on a LAN has
                    no microphone at all — and that line only fits in the menu, where the control
                    stays in that case. A control that is present and silently does nothing is the
                    thing this codebase refuses everywhere else.
                    IT IS NO LONGER HIDDEN ON A PHONE. That was a WIDTH argument, written when this
                    was one row holding the field and the buttons together; it became a column, and
                    the row now has the space. Reported as the composer not looking like the
                    desktop's — the microphone was the whole of the difference. Where it cannot
                    work it is still in the menu, on a phone exactly as anywhere else, because there
                    is the only place the reason fits. */}
                {dictation.state === 'ready' && (
                  <ComposerMicButton
                    onClick={toggleDictation}
                    disabled={!canPrompt}
                    listening={listening}
                    label={listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')}
                  />
                )}

                {/* THE CONTEXT GAUGE (design item 3, owner 2026-09-27) — right after the
                    microphone, the header's old "66%" tab moved down into the composer it was
                    always about. DESKTOP ONLY: mobile already has its own header metrics button
                    (`SessionsPage.tsx`'s `touch`-variant `SessionStatsMenu`), and this would be a
                    second, redundant control on a phone. `metrics` is absent on any surface with
                    no data source for it (never expected on a real page, but keeps a caller that
                    forgot to wire it up silent rather than crashing), and the component itself
                    renders NOTHING when the session's context cannot be measured — see its own
                    `variant === 'gauge'` branch. */}
                {!isMobile && metrics && (
                  <SessionStatsMenu
                    variant="gauge"
                    harness={session.harness}
                    sessionId={session.conversationId ?? session.id}
                    meta={metrics.meta}
                    {...(metrics.stats ? { stats: metrics.stats } : {})}
                    lang={lang}
                    currency={metrics.currency}
                    brlRate={metrics.brlRate}
                    costBasis={metrics.costBasis}
                    planFactor={metrics.planFactor}
                    {...(session.task ? { task: session.task } : {})}
                    {...(metrics.onOpenTask ? { onOpenTask: metrics.onOpenTask } : {})}
                    {...(metrics.onOpenLive ? { onOpenLive: metrics.onOpenLive } : {})}
                    {...(metrics.onOpenFull ? { onOpenFull: metrics.onOpenFull } : {})}
                    rowId={session.id}
                    {...(session.model ? { startedModel: session.model } : {})}
                    {...(session.effort ? { startedEffort: session.effort } : {})}
                  />
                )}

                {/* Mode · Stop · Recall · Send · More, held together at the far end, in that
                    order: the two that act on the RUNNING TURN, then the two about the message you
                    are writing, then the menu. `marginLeft: auto` on the GROUP rather than on send,
                    so they keep their order and their spacing whether or not the conditional two
                    are there — a margin on send alone would push the more button off to the right
                    on its own the moment a turn ended. */}
                {/* THE CHARACTER COUNT, in the gap the row already had.
                    It sits between attach and the acting group — `marginLeft: auto` on that group
                    is what pushed the two halves apart, so this costs the composer NO height and
                    takes no room from the field. Absent on an empty box (`promptCountLabel`
                    answers null): a counter reading `0` is a control with nothing to say, standing
                    where the composer's own hints need to be able to appear.
                    It counts the FIELD, not the message that will be sent — the attachment paths
                    are prepended at send time and are not something anybody typed, so including
                    them would make the number disagree with what is on screen, which is the one
                    thing a counter beside a text box may not do.
                    `pointerEvents: none` so it can never take a tap meant for a control beside it,
                    and it gives way before the buttons do when the row runs out of width. */}
                {countLabel && (
                  <span
                    aria-hidden
                    style={{
                      marginLeft: 'auto', minWidth: 0, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none',
                      fontSize: 10.5, lineHeight: 1, color: 'var(--text-tertiary)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {countLabel}
                  </span>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: countLabel ? 6 : 'auto' }}>
                {/* THE HARNESS MODE, and the one control that changes it.
                    Asked for: "nao consigo alternar entre os modos que os harnesses possuem (auto
                    mode, plan mode etc)", to sit left of the recent-message button.

                    IT CYCLES, and the label says which mode it is IN — not which one it would move
                    to. The harness offers one keystroke and no way to jump to a named mode, so a
                    menu of four would reach three of them by luck; `mode-spec.ts` records the key
                    and the order, driven against a live session.

                    ABSENT when the row carries no mode: a harness nobody has probed, or a frame
                    whose footer has not been read. A chip naming the wrong mode is worse than no
                    chip — it is read at a glance and believed. */}
                {/* NOT WHILE ANSWERING A QUESTION. Asked for: the mode, the model and the last
                    prompt come off the row for as long as the composer is an answer field. They are
                    about the next TURN, and this is not one — cycling the harness's mode with a
                    dialog open sends a keystroke into that dialog. */}
                {row?.mode && !answeringNow && (
                  <button
                    ref={modeButtonRef}
                    className="ag-tap-icon"
                    onClick={() => {
                      const rect = modeButtonRef.current?.getBoundingClientRect()
                      if (rect) setModeMenuPos(modeMenuPlacement(rect, window.innerWidth, window.innerHeight))
                      setModeMenuOpen(value => !value)
                    }}
                    disabled={!canPrompt}
                    aria-haspopup="menu"
                    aria-expanded={modeMenuOpen}
                    aria-label={pt ? `Modo: ${row.mode.label}` : `Mode: ${row.mode.label}`}
                    title={row.mode.label}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                      height: 30, padding: '0 9px',
                      borderRadius: 9, flexShrink: 0, maxWidth: 150,
                      // The colour IS the mode — see `modeStyle.ts`. Ordered by how much the
                      // session proceeds without asking, and never the fault colour: `auto` is how
                      // this product is normally used, and a red ordinary state is the cry-wolf
                      // this codebase avoids everywhere else.
                      border: `1px solid ${modeStyle(row.mode.id).border}`,
                      background: modeStyle(row.mode.id).bg,
                      color: modeStyle(row.mode.id).fg,
                      fontFamily: 'inherit', fontSize: 11.5,
                      cursor: canPrompt ? 'pointer' : 'default',
                      opacity: canPrompt ? 1 : 0.55,
                    }}
                  >
                    <SlidersHorizontal size={13} style={{ flexShrink: 0 }} />
                    {!isMobile && <span style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{row.mode.label}</span>}
                  </button>
                )}
                {modeMenuOpen && row?.mode && modeOptions.length > 0 && modeMenuPos && createPortal(
                  <div
                    data-mode-menu
                    role="menu"
                    aria-label={pt ? 'Modos' : 'Modes'}
                    style={{
                      position: 'fixed', top: modeMenuPos.top, left: modeMenuPos.left,
                      width: modeMenuPos.width, zIndex: 3000, padding: 4,
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: 10, boxShadow: 'var(--ag-shadow-pop)',
                    }}
                  >
                    {modeOptions.map(option => {
                      const current = option.id === row.mode?.id
                      const style = modeStyle(option.id)
                      return (
                        <button
                          key={option.id}
                          role="menuitemradio"
                          aria-checked={current}
                          onClick={() => void chooseMode(option.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                            minHeight: 36, padding: '7px 9px', border: 'none', borderRadius: 7,
                            background: current ? style.bg : 'transparent',
                            color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12,
                            textAlign: 'left', cursor: canPrompt ? 'pointer' : 'default',
                          }}
                        >
                          <span style={{
                            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                            background: style.fg,
                          }} />
                          <span style={{ flex: 1 }}>{option.label}</span>
                          {current && <span aria-hidden style={{ color: style.fg }}>✓</span>}
                        </button>
                      )
                    })}
                  </div>,
                  document.body,
                )}

                {/* THE PANEL OF EVERYTHING YOU SENT, its first row being the last message. ABSENT until
                    there is one — a control whose only outcome is a panel saying "nothing" is one
                    that exists to refuse. It sits with the acting group because it is about what
                    you have already sent, not about composing.
                    NOT WHILE ANSWERING A QUESTION, with the mode chip and the model: all three are
                    about the next TURN, and this is an answer to a dialog already open. */}
                {promptList.length > 0 && !answeringNow && (
                  <button
                    ref={historyBtnRef}
                    onClick={() => setPromptsOpen(true)}
                    aria-label={pt ? 'Suas mensagens' : 'Your messages'}
                    aria-haspopup="dialog"
                    title={pt ? 'Suas mensagens' : 'Your messages'}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
                      background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
                    }}
                  >
                    <History size={15} />
                  </button>
                )}

                {/* ONE SLOT: STOP WHILE IT WORKS, SEND WHEN IT DOES NOT.
                    A stop on an idle session would send Escape into its prompt, which is the row's
                    own gate on `interrupt`.

                    This supersedes an earlier reorder of mine and does its job better. The
                    complaint was that stop appeared and disappeared in the MIDDLE of the group, so
                    every time a turn ended send jumped left under a thumb already moving toward it;
                    moving stop to the head of the group only shortened the jump. Sharing one slot
                    removes it: the control under your thumb is always the one you want, and
                    nothing else shifts at all.

                    `stopShown` DECIDES IT, and this reads that one expression rather than
                    re-deriving it. It was re-derived here as `working && stopVerb?.enabled`, which
                    is the same rule minus the draft — so the stop button stayed up while somebody
                    typed, and the send button they were typing toward never appeared. `stopShown`
                    was sitting one screen up, correct and unused. */}
                {stopShown ? (
                  <button
                    onClick={() => void stopNow()}
                    disabled={stopping}
                    title={stopVerb?.label ?? (pt ? 'Parar' : 'Stop')}
                    aria-label={stopVerb?.label ?? (pt ? 'Parar' : 'Stop')}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, flexShrink: 0, border: 'none',
                      cursor: stopping ? 'default' : 'pointer',
                      // Filled, not outlined: this is the one control in the row that ENDS
                      // something, and an outline reads as the same weight as the others.
                      background: 'var(--accent-red)',
                      color: '#fff',
                    }}
                  >
                    {stopping ? <Loader size={14} className="ag-working-spin" /> : <Square size={13} fill="currentColor" />}
                  </button>
                ) : (
                  <ComposerSendButton
                    onClick={() => void send()}
                    disabled={!canPrompt || sending || !somethingToSend}
                    sending={sending}
                    active={somethingToSend && canPrompt}
                    label={pt ? 'Enviar' : 'Send'}
                  />
                )}

                {/* Mic and model live behind ONE button. Four controls plus the field on a
                    390px screen is a row where the buttons win, and these two are the pair a person
                    reaches for occasionally — attach and send are the ones used every turn.
                    A menu, not a second row: another row costs height, which is the thing a phone
                    has least of. */}
                {/* AND THE MENU GOES TOO. What is behind it — the model and the session's mode —
                    is about the NEXT prompt, not about the answer to a question already on screen;
                    changing the model does not change what the dialog does with the line it is
                    waiting for. Dictation stays, because it only puts words in the field, and the
                    field is the one thing this mode is FOR. */}
                {!answeringNow && (
                <div ref={moreMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    onClick={() => setMoreOpen(v => !v)}
                    disabled={!canPrompt || sending}
                    aria-label={pt ? 'Mais opções' : 'More options'}
                    aria-expanded={moreOpen}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, border: 'none',
                      background: moreOpen ? 'var(--bg-surface)' : 'transparent',
                      color: 'var(--text-tertiary)',
                      cursor: canPrompt ? 'pointer' : 'default',
                    }}
                  >
                    <ChevronUp size={15} style={{ transform: moreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                  </button>

                  {moreOpen && (
                    <div style={{
                      // Anchored on its RIGHT edge: the button now sits at the end of the row, and
                      // a menu opening rightwards from there would leave the screen.
                      position: 'absolute', bottom: 40, right: 0, zIndex: 50,
                      minWidth: 210, maxWidth: 260, padding: 4, borderRadius: 10,
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                    }}>
                      {/* DICTATION. Its refusal is a LINE, not a `title`: a phone has no hover, and
                          this is exactly where it is refused most — the Web Speech API needs a
                          secure context, so a dashboard reached over plain HTTP on a LAN never has
                          a microphone. A control that silently does nothing there is one people
                          report as broken, which is what happened. */}
                      {/* NOT RENDERED where the standalone button above is shown, so dictation is
                          in ONE place at a time — two controls for one act is two states to keep in
                          agreement. Where it cannot work it lives here, because only here can it
                          say why. The `isMobile` half of this condition is gone with the one on the
                          row: the two are the SAME switch, and leaving one of them would put the
                          microphone in both places on a phone, which is the bug below.
                          It was `hidden` and that did nothing: the row sets `display: flex` inline,
                          and an inline style beats the user-agent rule `[hidden] { display: none }`
                          without `!important`. So the microphone appeared TWICE — reported as
                          exactly that. A conditional render has no such loophole. */}
                      {/* IT IS ONLY EVER DISABLED HERE, and the compiler is what said so: this
                          branch is reached only when the state is NOT `ready`, so the enabled half
                          of this row — its click, its cursor, its "Parar de ouvir" — was code that
                          could not run. It existed for the phone, which used to be sent here even
                          when dictation worked. The row is now what it always was in practice: the
                          REASON dictation is unavailable, said where there is room to say it. */}
                      {dictation.state !== 'ready' && <div
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                          minHeight: 40, padding: '6px 8px', borderRadius: 7,
                          color: 'var(--text-tertiary)', fontFamily: 'inherit', fontSize: 12.5,
                        }}
                      >
                        <Mic size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span>{pt ? 'Ditar' : 'Dictate'}</span>
                          {dictation.reason && (
                            <span style={{ fontSize: 10.5, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                              {dictation.reason}
                            </span>
                          )}
                        </span>
                      </div>}

                      {/* The address that WOULD work, when there is one.
                          `localhost` is a secure context and `http://192.168.x.y:47292` is not, so
                          a member machine's dashboard has an exact equivalent one click away —
                          naming it is more useful than naming the rule. Only a literal IPv4 host is
                          rewritten (see `insecureAlternative`): sending someone from a hostname to
                          `localhost` would be a guess about which machine they are sitting at, so
                          where there is no answer this row is simply absent. */}
                      {dictation.state === 'insecure' && (() => {
                        // `!isMobile` is the "am I sitting at the machine serving this page" the
                        // rewrite needs. A phone reaches the dashboard by its LAN address and
                        // nothing else, so `localhost` there is the PHONE — a link to a page that
                        // cannot load, offered on the one device where this refusal always fires.
                        const alt = typeof window === 'undefined'
                          ? null
                          : insecureAlternative(window.location.href, !isMobile)
                        return alt === null
                          ? (
                            // Said rather than left blank: "the microphone needs HTTPS" with no
                            // follow-up reads as a bug in this product, and it is a rule of the
                            // browser that nothing here can lift.
                            <p style={{
                              margin: 0, padding: '4px 8px 8px 30px', fontSize: 10.5,
                              lineHeight: 1.45, color: 'var(--text-tertiary)',
                            }}>
                              {pt
                                ? 'Num celular não há alternativa: o navegador só libera o microfone em HTTPS, e este painel está em HTTP na rede local. Dite no computador ou sirva o painel por HTTPS.'
                                : 'On a phone there is no alternative: the browser only allows the microphone over HTTPS, and this dashboard is on plain HTTP over the local network. Dictate on the computer, or serve it over HTTPS.'}
                            </p>
                          )
                          : (
                            <a
                              href={alt}
                              style={{
                                display: 'block', padding: '4px 8px 8px 30px', fontSize: 11,
                                lineHeight: 1.4, color: 'var(--anthropic-orange)',
                                overflowWrap: 'anywhere', textDecoration: 'none',
                              }}
                            >
                              {pt ? `Abrir em ${alt}` : `Open at ${alt}`}
                            </a>
                          )
                      })()}

                      {/* MODEL. Same treatment: where it cannot work, the menu says why instead of
                          offering a control that answers nothing.
                          ABSENT WHILE ANSWERING A QUESTION, with the mode chip and the recall
                          button: choosing a model is a decision about the next turn, and this is an
                          answer to a dialog that is already open. */}
                      {answeringNow ? null : modelReason ? (
                        <p style={{ margin: 0, padding: '6px 8px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                          {modelReason}
                        </p>
                      ) : (menuModels.length > 0 || menuFreeText) && (
                        <>
                          <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
                          <p style={{
                            margin: '2px 8px 4px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                            letterSpacing: '0.06em', color: 'var(--text-tertiary)',
                          }}>
                            {pt ? 'Modelo' : 'Model'}
                          </p>
                          {/* The LABEL is what you read; the ID is what gets typed into the
                              session. Where the server has no labels the two are the same string,
                              which is what this menu showed before. */}
                          {menuModels.map(m => (
                            <button
                              key={m.id}
                              disabled={sourceControls?.busy === true}
                              aria-current={sourceControls?.model?.current === m.id ? 'true' : undefined}
                              onClick={() => { setMoreOpen(false); void switchModel(m.id) }}
                              style={{
                                display: 'block', width: '100%', textAlign: 'left',
                                minHeight: 36, padding: '6px 8px', borderRadius: 7, border: 'none',
                                background: 'transparent', color: 'var(--text-primary)',
                                fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
                              }}
                            >
                              {m.label}{sourceControls?.model?.current === m.id ? ' ✓' : ''}
                            </button>
                          ))}
                          {menuFreeText && (
                            <TypedModel lang={pt ? 'pt' : 'en'} onPick={id => { setMoreOpen(false); void switchModel(id) }} />
                          )}
                          <p style={{ margin: '2px 8px 4px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                            {sourceControls?.model
                              ? (pt ? 'Vale para os próximos turnos.' : 'Applies to the next turns.')
                              : (pt ? 'Envia /model para a sessão.' : 'Sends /model to the session.')}
                          </p>
                        </>
                      )}

                      {/* A SOURCE's own settings (the native runtime): reasoning effort on the same
                          EffortPicker the new-session dialog uses, the gated browser and the extra
                          folders — what the session's own page drew before UI.UNIFY. */}
                      {!answeringNow && sourceControls && (
                        <SourceSettings controls={sourceControls} pt={pt} onRefused={setNotice} />
                      )}

                      {/* NOTIFICATIONS for THIS session. Delivery only — the session still reads as
                          waiting. Styled as the model buttons above; the divider is the same 1px
                          rule the model block opens with. */}
                      <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
                      <button
                        onClick={() => { setMoreOpen(false); toggleSessionMuted(notifyKey) }}
                        title={notifyMuted ? mutedTooltip(pt) : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                          minHeight: 36, padding: '6px 8px', borderRadius: 7, border: 'none',
                          background: 'transparent', color: 'var(--text-primary)',
                          fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
                        }}
                      >
                        {notifyMuted ? <Bell size={14} /> : <BellOff size={14} />}
                        {notifyMuted
                          ? (pt ? 'Reativar notificações' : 'Unmute notifications')
                          : (pt ? 'Silenciar notificações' : 'Mute notifications')}
                      </button>

                      {/* THE SKILLS LIST LIVED HERE AND IS GONE. It was the only place to see
                          them; there is a dedicated view now, and two lists of one thing are two
                          places for them to disagree about what is installed. What stays is the
                          `/` picker IN THE FIELD, which is a different gesture — completing what
                          you are already typing, not browsing. */}
                    </div>
                  )}
                </div>
                )}

                </div>
                </ComposerToolbar>
              </ComposerShell>
              {(notice ?? source?.notice) && (
                <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {notice ?? source?.notice}
                </p>
              )}
              {/* A SOURCE's run line (tokens, cost, context) — the bottom bar's slot. */}
              {source?.status}
            </>
          )}
        </div>
      </div>

      {/* THE RECENT-PROMPTS PANEL: a list of everything the person sent, with search, "go to",
          "view" and — on claude — "restore from here". Full-screen sheet on a phone, a centred
          dialog with its own scrolling list elsewhere (see the component). */}
      {promptsOpen && (
        <RecentPromptsPanel
          entries={promptList}
          lang={lang}
          isMobile={isMobile}
          harness={session.harness}
          state={session.state}
          dialogOpen={blocked}
          onClose={closePrompts}
          onGoTo={goToPrompt}
          onRestore={restoreFrom}
          // Forward from "your messages": the same modal the message menu opens, with the message
          // as sent (the dictation mark stripped, as restore strips it).
          onForward={entry => {
            setPromptsOpen(false)
            setForwardTurns([{ role: 'user', text: stripDictatedMark(entry.text).text, ...(entry.at ? { at: entry.at } : {}) }])
          }}
        />
      )}

      {/* EXT.OPEN — asked ONCE, before a write ends an external process (`external-continue.ts`). */}
      <ConfirmModal
        open={continueAsk !== null}
        title={pt ? 'Continuar esta sessão aqui?' : 'Continue this session here?'}
        message={continueAsk?.message ?? ''}
        confirmLabel={continuing ? (pt ? 'Continuando…' : 'Continuing…') : (pt ? 'Continuar aqui' : 'Continue here')}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => void continueHere()}
        onCancel={() => setContinueAsk(null)}
      />

      {/* THE ATTACHED PICTURE, full size. The same component a sent message opens, over the images
          attached right now — reused rather than reimplemented, so what you attached and what you
          sent are viewed the same way. `composerLightboxAt` is what keeps it honest when the list
          is edited underneath it. */}
      {composerLightboxAt !== null && (
        <AttachmentLightbox
          paths={composerImages}
          index={composerLightboxAt}
          onIndexChange={setComposerLightbox}
          onClose={() => setComposerLightbox(null)}
          lang={lang}
        />
      )}

      {/* VAULT.PERSONAL §8.5 — the `:vault` picker and the code the grant may ask at send. */}
      {vaultPickerOpen && (
        <VaultPicker
          lang={pt ? 'pt' : 'en'} isMobile={isMobile} initial={vaultSel}
          onClose={() => setVaultPickerOpen(false)}
          onClear={() => { setVaultSel(null); editDraft(removeVaultChip(draft)); setVaultPickerOpen(false) }}
          onConfirm={sel => {
            setVaultSel(sel); setVaultPickerOpen(false)
            const out = applyVaultChip(draft, textareaRef.current?.selectionStart ?? caret, sel, pt)
            editDraft(out.text); setCaret(out.caret)
            requestAnimationFrame(() => { const n = textareaRef.current; if (n) { n.focus(); n.setSelectionRange(out.caret, out.caret) } })
          }}
        />
      )}
      {vaultCodeAsk && <VaultCodeAsk lang={pt ? 'pt' : 'en'} isMobile={isMobile} onDone={vaultCodeAsk} />}

      {/* FORWARD — the fleet picker as its third feature: pick one or more sessions, then an
          optional comment and where it lands (the draft by default). See `chatForward.ts`. */}
      {forwardTurns !== null && (
        <SessionPickModal
          kind="forward"
          lang={lang}
          rows={forwardRows}
          busy={forwardBusy}
          forwardPreview={forwardBlock(forwardSource, forwardTurns, pt)}
          onClose={() => { if (!forwardBusy) setForwardTurns(null) }}
          onConfirm={(ids, comment, opts) => { void deliverForward(ids, comment, opts) }}
        />
      )}

    </div>
  )
}

/** Whitespace-insensitive, because the harness re-wraps what it stores. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function Loading({ pt }: { pt: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      padding: '48px 0', color: 'var(--text-tertiary)', fontSize: 12.5,
    }}>
      <Loader size={16} className="ag-working-spin" />
      {pt ? 'Lendo a conversa…' : 'Reading the conversation…'}


    </div>
  )
}

function Muted({ text }: { text: string }) {
  return <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{text}</p>
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', minHeight: 260, padding: 32, textAlign: 'center', maxWidth: 460, margin: '0 auto',
    }}>
      {children}
    </div>
  )
}

/** The DOM range of an excerpt inside a rendered message, or `null` — see `locateExcerpt`. */
function excerptRange(root: HTMLElement, excerpt: string): Range | null {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  const starts: number[] = []
  let text = ''
  for (const n of nodes) { starts.push(text.length); text += n.data }
  const hit = locateExcerpt(text, excerpt)
  if (!hit) return null
  const at = (off: number, end: boolean): [Text, number] | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const s0 = starts[i]!
      if (end ? off > s0 : off >= s0) return [nodes[i]!, off - s0]
    }
    return null
  }
  const a = at(hit[0], false)
  const b = at(hit[1], true)
  if (!a || !b) return null
  const r = document.createRange()
  r.setStart(a[0], a[1])
  r.setEnd(b[0], b[1])
  return r
}
