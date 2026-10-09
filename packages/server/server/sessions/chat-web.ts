/**
 * chat-web.ts — the CONVERSATION behind the web sessions workspace's chat view.
 *
 * `chat-tail.ts` answers a different question: the last handful of turns, for a detail pane six
 * rows tall. A chat view needs the whole conversation, and needs to fetch only what it has not
 * already seen — so this reads the transcript with an explicit turn budget and reports how many
 * turns exist, letting the browser hold what it already has.
 *
 * THE HARNESS LIMIT IS THE POINT, and it is TWO limits that were one thing for as long as Claude
 * was the only readable harness.
 *
 * The first is the LINK: a session can only be tied to its transcript where the id is EXACT — the
 * one agentop handed the CLI, or Claude Code's own `~/.claude/sessions/<pid>.json` naming our tmux
 * session. Guessing by harness-and-directory would put SOME OTHER conversation from the same folder
 * on screen under this session's name, which is worse than showing nothing: a confident wrong
 * answer the reader has no way to tell. `SessionView.conversationId` already enforces this, and
 * nothing here relaxes it.
 *
 * The second is the FORMAT: whether anybody has written a reader for it (`harness-transcript.ts`).
 * Collapsing the two cost the feature its honesty. Measured 2026-09-05 on a live antigravity
 * session holding a perfectly exact link — `/proc/<pid>/cmdline` was `agy --conversation
 * 01d0814f-…`, the very id the registry held — the request ran into the CLAUDE path resolver, came
 * back with no file, and answered `{turns: [], live: true}`: a completely blank pane with nothing
 * on it saying why. The link was never the problem; there was no reader.
 */

import { stripContextTurns } from './agentistics-context'
import { anyGrant, scrubDeep } from '../vault/grants'
import { isExternalRowId } from './external-continue'
import type { StartHost } from '../cli-start'
import { applyPendingRewind, forgetRewind, pendingRewindFor } from './rewind-pending'
import type { CliLang } from '../cli-lang'
import { controlStrings } from '@agentistics/tui/control/i18n'
import type { ChatTurn } from './chat-turn'
import type { AttachmentMessage, AttachmentSend } from '@agentistics/core'
import { ATTACHMENT_DIR, readAttachmentLog } from './attachment-web'
import { transcriptReaderFor } from './harness-transcript'
import { conversationOfRow } from './row-conversation'
import { migratePrompts, pendingFor, type PendingPrompt } from './pending-prompts'
import { transcriptAvailability, transcriptSentence, type TranscriptAvailability } from './transcript-availability'
import type { SessionConversationLink } from '@agentistics/core'
import type { SurfaceMark } from '../projections/session-surface'
import { planSessionSource } from './session-source'
import type { SessionSurfaceDeps } from './session-surface-deps'
import { CLAUDE_DIR } from '../config'
import { safeReadJson } from '../utils'
import { isComposerMessage } from './composer-message'

/** What the journal remembers of a conversation whose transcript is gone — numbers only (D5, Q3). */
export interface ChatRecorded {
  firstAt: string | null
  lastAt: string | null
  turns: number
  toolCalls: number
  toolsFailed: number
  toolsDenied: number
  models: string[]
  /** `null` = no model response was ever recorded (absent is not zero). */
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null
}

export interface ChatPayload {
  /** The turns, oldest first. Empty with no `unavailable` means a conversation with nothing in it. */
  turns: ChatTurn[]
  /**
   * What agentop typed into THIS session's pane, and when — so the view can draw a thumbnail where
   * the harness substituted a `[Image #N]` marker for the path it was given. The RULE that reads it
   * is `lib/attachmentPreview.ts`'s `resolveMarkerPaths`, which sits beside the marker parsing it
   * serves and resolves only when the record accounts for a turn's markers exactly.
   */
  attachmentSends?: AttachmentSend[]
  /**
   * What each delivered message CARRIED, keyed by this CONVERSATION — the record that answers the
   * question `attachmentSends` could only approximate by upload time. See `AttachmentMessage`.
   */
  attachmentMessages?: AttachmentMessage[]
  /**
   * Already-localized reason there is no conversation to show.
   *
   * Distinct from an empty `turns` on purpose: "this harness can never be read this way" and "this
   * conversation has not said anything yet" are different facts, and the second is temporary.
   */
  unavailable?: string
  /**
   * WHY there is no transcript, as a state the UI can branch on (`present` / `not-yet-written` /
   * `expired` / `deleted` / `unreadable`). `unavailable` is the sentence for it; this is the fact,
   * so a surface that wants more than a sentence — a date, a different control — never has to parse
   * words. See `transcript-availability.ts`.
   */
  transcript?: TranscriptAvailability
  /** WHERE this session's conversation link came from (LIVE.1). Additive; absent = not linked yet. */
  link?: SessionConversationLink | null
  /**
   * LIVE.2 — the times a person was asked something in this conversation (an approval, a question), as the
   * journal recorded them. HISTORY: whether a card can be answered NOW is the live fleet row's word alone.
   * Present only when the `sessions` surface is on and the journal has marks; the legacy payload is
   * otherwise byte for byte what it was.
   */
  attention?: SurfaceMark[]
  /**
   * LIVE.2 — the transcript is gone (`transcript.state` `expired` or `deleted`) and the journal knows the
   * conversation: its NUMBERS, and nothing else (the owner's Q3 — no turns, no tool summaries, no
   * text). Always accompanies `unavailable`, which says why.
   */
  recorded?: ChatRecorded
  /** True while the session is running, so the view knows whether to expect more. */
  live: boolean
  /**
   * Messages handed to this session that its transcript does not carry yet.
   *
   * Held by the SERVER (`pending-prompts.ts`) rather than by the tab that sent them, which is what
   * makes every device show the same queue — the report this answers was a message visible on the
   * phone that sent it and nowhere else. Each carries when it was sent, so any device can say how
   * long it has been waiting instead of drawing a bubble with no age.
   */
  pending?: PendingPrompt[]
  /**
   * Already-localized: these turns are the END of a longer conversation.
   *
   * Present ONLY when the read stopped on its cap with transcript still above it. Everything built
   * on these turns inherits the window — the gallery lists the files of the turns it was given —
   * so a panel that empties because of the cap must be able to say that is why, instead of showing
   * nothing and letting it read as "there was never anything here".
   */
  older?: string
  /**
   * This machine's REAL attachments directory (`ATTACHMENT_DIR`), carried on the turns that can
   * actually name one — see `attachmentUrl.ts`'s `galleryFileUrl`. The browser side used to GUESS it
   * from the default layout (`~/.agentistics/attachments/`), which stops matching the moment
   * `AGENTISTICS_DIR` relocates the data directory: a `viewed` file the assistant re-read out of the
   * (relocated) attachments directory then routed through the session-media route instead of the
   * attachments route, and the gallery reported a file that was right there as no longer on disk.
   * The server knows its own configured directory outright, so it says so once rather than the
   * client guessing at a layout that is only usually true.
   */
  attachmentsDir?: string
}

/** The most turns one read returns. A conversation of thousands must not arrive as one response. */
const MAX_TURNS = 400

/** "All of it" for the conversation search — a bound only so no arithmetic on it can overflow. */
export const FULL_TRANSCRIPT_TURNS = 1_000_000

/**
 * The user's own retention setting for a harness, when one is recorded — Claude Code's
 * `cleanupPeriodDays` in `settings.json`. `undefined` for everything else, and for a file that is
 * absent or does not say: the default then lives in `TRANSCRIPT_RETENTION`, in one place.
 */
async function retentionSetting(harness: string): Promise<number | undefined> {
  if (harness !== 'claude') return undefined
  const settings = await safeReadJson<{ cleanupPeriodDays?: unknown }>(`${CLAUDE_DIR}/settings.json`)
  const n = settings?.cleanupPeriodDays
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
}

async function readSessionChatCore(
  host: StartHost,
  lang: CliLang,
  id: string,
  // Injectable for tests only — the same seam `resolveChatTranscriptPath` gives `projectsDir` and
  // `now`. Without it the "found but unreadable" refusal below can only be reached by making a real
  // file unreadable under a `PROJECTS_DIR` fixed at import time, which is why that branch went
  // untested long enough to become a blank pane in front of a user.
  readerFor: typeof transcriptReaderFor = transcriptReaderFor,
  onRow: (row: { id: string; conversationId?: string; harness?: string; link?: SessionConversationLink | null }) => void = () => undefined,
  /** The transcript file this read resolved (the chat stream watches it). */
  onPath: (path: string) => void = () => undefined,
  /** How many turns from the end. The chat's window by default; the conversation search reads all. */
  maxTurns: number = MAX_TURNS,
): Promise<ChatPayload> {
  const s = controlStrings(lang)
  if (!host.sessions) return { turns: [], unavailable: s.sessionsNoHost, live: false }

  const fleet = await host.sessions()
  const row = fleet.sessions.find(r => r.id === id)
  if (!row) {
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? 'Esta sessão não está mais na lista desta máquina.'
        : 'This session is no longer in this machine’s list.',
      live: false,
    }
  }

  onRow(row)
  // EXT.OPEN: an EXTERNAL row is a RUNNING process (agentop only cannot see its screen), so its
  // conversation is live and more is expected — it is read exactly like a session agentop hosts.
  const live = row.state === 'working' || row.state === 'waiting' || row.state === 'waiting-approval'
    || (row.state === 'unknown' && isExternalRowId(row.id))

  // The EXACT link, or nothing. `conversationBlind` is the row's own sentence for a harness that
  // can never report which conversation it is writing — reused rather than reworded, so the chat
  // view and the row give one answer.
  //
  // A CLOSED row names its conversation in its ID, not in `conversationId` — it is a conversation
  // you can reopen rather than a session that recorded a link. Reading only the field, this refused
  // every finished conversation with "no linked conversation yet", which is the one row people open
  // precisely to read one. `conversationOfRow` is the single place both shapes are known.
  const conversationId = conversationOfRow(row)
  // An echo recorded before the link existed is held under the ROW id; once the link is there it
  // moves to the conversation (never duplicated, never lost).
  if (conversationId) migratePrompts(row.id, conversationId)
  if (!conversationId) {
    // A session sitting on a question (agy's "do you trust this folder?") has not CREATED its
    // conversation yet — the harness makes it only after the answer. Saying "no linked
    // conversation" there reads as a fault; the session is simply waiting for a person.
    if (row.state === 'waiting-approval') {
      return {
        turns: [],
        unavailable: lang === 'pt'
          ? 'Esta sessão está esperando uma resposta sua antes de criar a conversa (por exemplo, confiar na pasta). Responda no cartão da sessão e a transcrição aparece em seguida.'
          : 'This session is waiting for your answer before it creates the conversation (for example, trusting the folder). Answer it on the session card and the transcript follows.',
        live,
      }
    }
    // A RUNNING session of a harness that creates its conversation on the FIRST MESSAGE (agy: its
    // process log says `Created conversation` only once something is sent) is an EMPTY
    // conversation, not an unlinkable one. Answering `unavailable` here replaced the composer with a
    // refusal, so the one act that creates the conversation — sending the first message — was the
    // one act the chat withheld, and the person had to open the terminal. Same "not yet" against
    // "never" rule as the missing-transcript branch below; the link lands on the poll after the
    // message does (measured: under 6s).
    // The same holds for EVERY harness, linked-by-process-log or not: codex, kimi and gemini name
    // no conversation until their first message is claimed (`conversationBlind`), and a session
    // that is RUNNING and has said nothing is an empty chat — "waiting for the first message" —
    // not an unlinkable one. Refusing here replaced the composer, so the one act that creates the
    // conversation was the one the chat withheld (CHAT.FIRST). A session that is NOT running keeps
    // its sentence: nothing more is coming.
    if (live && row.harness) {
      const queued = pendingFor(row.id, [])
      return { turns: [], live, ...(queued.length > 0 ? { pending: queued } : {}) }
    }
    return {
      turns: [],
      unavailable: row.conversationBlind ?? (lang === 'pt'
        ? 'Esta sessão ainda não tem uma conversa vinculada, então não há transcrição para ler.'
        : 'This session has no linked conversation yet, so there is no transcript to read.'),
      live,
    }
  }

  // No reader for this harness's transcript FORMAT — see `harness-transcript.ts`. It is said in
  // words and it NAMES the harness, because "nothing here parses this yet" and "this conversation
  // has said nothing yet" are different facts, and only the second one changes on its own.
  // A row whose harness the registry has forgotten (`ControlSession.harness` is `''`) cannot be
  // routed to any reader, and saying "we cannot read ''" would be worse than saying nothing.
  if (!row.harness) {
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? 'O registro não guarda mais qual assistente escreveu esta sessão, então não há como saber que transcrição ler.'
        : 'The registry no longer records which assistant wrote this session, so there is no way to know which transcript to read.',
      live,
    }
  }

  const reader = readerFor(row.harness)
  if (!reader) {
    const name = row.harness
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? `Ainda não sabemos ler a transcrição do ${name}. A conversa desta sessão está gravada no disco desta máquina — o que falta é um leitor para o formato dela.`
        : `We cannot read ${name}'s transcript format yet. This session's conversation is recorded on this machine — what is missing is a reader for it.`,
      live,
    }
  }

  const path = await reader
    // `conversationId` and NOT `row.conversationId`: a CLOSED row names its conversation in its
    // id and carries no field, and reading only the field refused every finished conversation —
    // the row people open precisely to read one. See `row-conversation.ts`.
    .resolve({
      conversationId,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      // What was sent and is not echoed yet: the proof a transcript the conversation moved to is ours.
      pending: pendingFor(conversationId, []).map(p => p.text),
    })
    .catch(() => null)
  if (!path) {
    // A LIVE session whose transcript is not on disk YET is an EMPTY conversation, not a missing
    // one — and the difference is the whole usability of a new session. A harness writes its
    // transcript when the conversation first says something, so every session agentop has just
    // started has no file for as long as nobody has spoken to it. Reporting that as `unavailable`
    // made the chat view render its refusal INSTEAD of the composer, so the one thing that would
    // create the transcript — sending the first message — was the one thing the view withheld. A
    // session created from the workspace was therefore un-chattable for its whole life, and the
    // only way in was the terminal tab.
    //
    // So the empty answer is reserved for the case the shape already documents: `turns: []` with no
    // `unavailable` means "a conversation with nothing in it". A session that is NOT running keeps
    // the refusal, because there its missing transcript really is a transcript that is gone — the
    // same N/A-versus-a-confident-0 rule, applied to "not yet" against "no longer".
    if (live) {
      // THE FIRST MESSAGE IS EXACTLY THIS CASE. A harness writes its transcript when the
      // conversation first says something, so a session that has only ever been sent one message
      // has no file — and returning an empty payload here would hide the very message that is
      // waiting to create it.
      const queued = pendingFor(conversationId, [])
      return { turns: [], live, ...(queued.length > 0 ? { pending: queued } : {}) }
    }
    // `endedAt` is when it stopped; a session that never recorded one was last heard from when the
    // person last wrote to it, or failing that when it began.
    const lastActivityMs = row.endedAt ?? row.lastUserMessageAt ?? row.startedAt
    const retentionDays = await retentionSetting(row.harness)
    const availability = transcriptAvailability({
      harness: row.harness, resolved: false, live, nowMs: Date.now(),
      ...(lastActivityMs !== undefined ? { lastActivityMs } : {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
    })
    return {
      turns: [],
      unavailable: transcriptSentence(availability, lang, row.harness, lastActivityMs) ?? '',
      transcript: availability,
      live,
    }
  }

  // `older` is asked of the READER, and EVERY reader answers it — see `TranscriptRead`. It was
  // briefly an optional `readWindow` that only Claude implemented, which gives the other four the
  // silent version of the bug the notice exists to fix: the antigravity transcript this reader was
  // written against holds 1239 turns, so a 400-turn window cuts it and says nothing.
  // A READ THAT FAILED IS NOT AN EMPTY CONVERSATION. This catch used to flatten the two into
  // `turns: []`, which on a LIVE session carries no `unavailable` — so a transcript that resolved
  // and then could not be read drew "This conversation has no messages yet" over a conversation
  // that was entirely there. That is the same confident-empty this module exists to refuse, reached
  // one step later than the link and format refusals above. The cause behind the report was the
  // stale memo in `transcript-path-memo.ts`; this is the symptom guard beside it, so the next cause
  // says something instead of drawing a blank pane.
  onPath(path)
  const read = await reader.read(path, maxTurns).catch(() => null)
  if (read === null) {
    const availability = transcriptAvailability({
      harness: row.harness, resolved: true, readFailed: true, live, nowMs: Date.now(),
    })
    return {
      turns: [],
      unavailable: transcriptSentence(availability, lang, row.harness) ?? '',
      transcript: availability,
      live,
    }
  }
  // The fenced agentistics context (a harness with no invisible channel gets it in its first message)
  // never reaches a bubble: the person's own words stay, and one small chip says it was sent.
  read.turns = stripContextTurns(read.turns)
  // A REWIND agentop just drove is not in the transcript until the conversation continues — the
  // turns it undid are cut here until then. See `rewind-pending.ts`.
  const rewound = pendingRewindFor(conversationId, Date.now())
  if (rewound) {
    const cut = applyPendingRewind(read.turns, rewound)
    if (cut.stale) forgetRewind(conversationId)
    else read.turns = cut.turns
  }
  read.turns = read.turns.map(turn => turn.role === 'user' && isComposerMessage(id, turn.text)
    ? { ...turn, composer: true }
    : turn)
  // What is still waiting, judged against the user turns THIS read returned. The window matters and
  // is the right one: a message queued a minute ago cannot be older than the last 400 turns, and
  // comparing against a wider slice would cost a second read to learn nothing.
  let pending = pendingFor(conversationId, read.turns.filter(t => t.role === 'user').map(t => t.text))
  // Read once per chat load, not per turn: the log is one small append-only file and the view
  // resolves against it locally. Omitted when there is nothing recorded, so a machine that never
  // attached anything carries no field at all.
  const { sends, messages } = await readAttachmentLog({ sessionId: id, conversationId, pendingId: row.id })
  // VAULT.PERSONAL §8.4: a session granted vault secrets is served with every value — and its
  // base64/url/hex forms — replaced by «vault:NAME». No grant, no work: the same objects come back.
  if (anyGrant()) {
    read.turns = await scrubDeep(id, read.turns)
    pending = await scrubDeep(id, pending)
  }
  return {
    turns: read.turns,
    attachmentsDir: ATTACHMENT_DIR,
    ...(sends.length > 0 ? { attachmentSends: sends } : {}),
    ...(messages.length > 0 ? { attachmentMessages: messages } : {}),
    live,
    ...(pending.length > 0 ? { pending } : {}),
    ...(read.older
      ? {
          older: lang === 'pt'
            ? `Esta é a parte final da conversa — as últimas ${MAX_TURNS} interações. O que veio antes está na transcrição, mas fora desta janela.`
            : `This is the end of a longer conversation — its last ${MAX_TURNS} turns. What came before is still in the transcript, outside this window.`,
        }
      : {}),
  }
}

/**
 * The WHOLE conversation of one session, for "Buscar na conversa" (`chat-search-web.ts`).
 *
 * The same core as the chat view — the same row resolution, the same exact-link rule, the same
 * refusals, the same pending-rewind cut and the same vault scrub — so a search can never surface a
 * message the chat would not show, nor a secret the chat would hide. Only the window differs.
 */
export function readSessionChatAll(
  host: StartHost,
  lang: CliLang,
  id: string,
  readerFor: typeof transcriptReaderFor = transcriptReaderFor,
  /** The fleet row the read resolved — the search names the harness from it without a second poll. */
  onRow?: (row: { id: string; harness?: string }) => void,
  maxTurns: number = FULL_TRANSCRIPT_TURNS,
): Promise<ChatPayload> {
  return readSessionChatCore(host, lang, id, readerFor, onRow, undefined, maxTurns)
}

/**
 * LIVE.2 — fold the journal's answer into a chat payload by `planSessionSource` (the one place the rule
 * lives). `deps` undefined (no engine / flag off) is the legacy path and returns `base` itself.
 */
export async function mergeSessionSurface(
  base: ChatPayload,
  who: { harness: string; conversationId: string } | null,
  deps: SessionSurfaceDeps | undefined,
): Promise<ChatPayload> {
  if (!deps || !who || !base.transcript) return base
  const found = await deps.lookup(who.harness, who.conversationId).catch(() => ({ ready: false, row: null }))
  const plan = planSessionSource({
    enginePresent: true, surfaceFlag: true, projectionReady: found.ready,
    projected: found.row !== null, projectedAttention: found.row?.attention.length ?? 0,
    transcript: base.transcript, legacyReadOk: base.unavailable === undefined,
  })
  const row = found.row
  if (plan.from === 'legacy' || !row) return base
  if (plan.from === 'legacy+overlay') return { ...base, attention: row.attention }
  return {
    ...base,
    recorded: {
      firstAt: row.firstAt, lastAt: row.lastAt, turns: row.turns, toolCalls: row.toolCalls,
      toolsFailed: row.toolsFailed, toolsDenied: row.toolsDenied, models: row.models, tokens: row.tokens,
    },
    ...(row.attention.length > 0 ? { attention: row.attention } : {}),
  }
}

/**
 * The chat for one session, plus the two canonical facts (LIVE.1): `transcript` (always present
 * on a success path — `present/resolved` when the file was read) and `link` (the row's provenance).
 */
export async function readSessionChat(
  host: StartHost,
  lang: CliLang,
  id: string,
  readerFor: typeof transcriptReaderFor = transcriptReaderFor,
  onPath?: (path: string) => void,
  /** LIVE.2 — absent unless an engine is present and the `sessions` surface is on; absent = legacy, byte for byte. */
  surface?: SessionSurfaceDeps,
): Promise<ChatPayload> {
  let link: SessionConversationLink | null | undefined
  let who: { harness: string; conversationId: string } | null = null
  const p = await readSessionChatCore(host, lang, id, readerFor, r => {
    link = r.link
    const c = conversationOfRow(r)
    const h = r.harness
    who = c && h ? { harness: h, conversationId: c } : null
  }, onPath)
  const transcript: TranscriptAvailability | undefined = p.transcript
    ?? (p.unavailable === undefined && p.turns.length > 0 ? { state: 'present', reason: 'resolved' } : undefined)
  const merged: ChatPayload = {
    ...p,
    ...(transcript ? { transcript } : {}),
    ...(link !== undefined ? { link } : {}),
  }
  return mergeSessionSurface(merged, who, surface)
}
