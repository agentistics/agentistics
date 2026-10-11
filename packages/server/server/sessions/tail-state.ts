/**
 * tail-state.ts — what a session is DOING, read off the transcript tail the fleet poll already fetched,
 * for the rows nothing else states it for (ELSEWHERE: no structured driver, no engine `state` reading).
 *
 * The poll reads `TAIL_CHAT_TURNS` turns of every exactly-linked row's transcript anyway (`readChatTail`
 * in `sessions-host.ts`), so this costs NO file read: it is a pure function over turns already in hand.
 *
 * What a tail can say, the same for every harness that has a reader (`harness-transcript.ts`):
 *
 * - the newest turn is a PERSON's message           → working (the harness picked it up);
 * - the newest turn invoked tools (`pending` or not) → working (a tool is running — or waiting on a
 *   permission dialog, which only the SCREEN can show, so a working row's screen is still read);
 * - the newest pending call is a QUESTION tool       → attention (the options are read off the screen);
 * - the newest turn is an assistant reply            → waiting (the turn ended);
 * - a person's `!` command still running             → working; finished → waiting;
 * - an interrupt marker / anything the harness wrote under the user role (`system`) → `undefined`:
 *   the transcript cannot tell, the screen decides.
 *
 * Gemini's reader carries no tool calls at all (`gemini-chat.ts`), so an assistant turn there cannot be
 * told apart from one about to run a tool: only "a person's message is newest" is stated for it.
 *
 * WHY THE SCREEN STILL CONFIRMS AN IDLE ROW ONCE. A reply written mid-turn (text, then more thinking
 * before the next tool call) reads exactly like a finished turn. So a tail's `waiting` is believed
 * WITHOUT a capture only after one screen read agreed with it for that very tail (`agreed`); a new
 * turn in the file, a forced read after an act, or `TAIL_SCREEN_REFRESH_MS` re-opens the screen.
 * Idle polls then capture nothing — the whole point — and a disagreement always goes to the screen.
 */
import type { ChatTurn, HarnessId } from '@agentistics/core'
import { toolActivityNames } from './chat-tail'
import type { SessionActivity } from './types'

/** How often an idle tail-stated row's screen is read anyway (mode chip, rate-limit banner, raw tail). */
export const TAIL_SCREEN_REFRESH_MS = 120_000

export interface TailReading {
  working: boolean
  /** A question tool is pending: a person is being asked something. */
  attention?: 'question'
  /** Identifies the newest turn — a different value means the file moved. */
  sig: string
}

/** The tool names, per harness, whose pending call is a question to the person. Measured, never guessed. */
const QUESTION_TOOLS: Partial<Record<HarnessId, ReadonlySet<string>>> = {
  claude: new Set(['AskUserQuestion', 'ExitPlanMode']),
}

/** Harnesses whose reader carries tool calls, so an assistant turn with no pending call is a turn END. */
const ENDS_ARE_READABLE: Partial<Record<HarnessId, true>> = {
  claude: true, codex: true, copilot: true, kimi: true, antigravity: true,
}

const INTERRUPTED = /^\[Request interrupted by user/

function sigOf(t: ChatTurn, n: number): string {
  return `${n}\0${t.at ?? ''}\0${t.role}\0${t.text.length}\0${t.pending ? 1 : 0}\0${t.tools?.length ?? 0}\0${t.shell?.running ? 1 : 0}`
}

/** PURE. The tail's reading, or `undefined` when the transcript cannot tell. */
export function tailStateOf(harness: HarnessId | undefined, turns: readonly ChatTurn[]): TailReading | undefined {
  if (!harness || turns.length === 0) return undefined
  const last = turns[turns.length - 1]!
  const sig = sigOf(last, turns.length)
  if (last.system !== undefined) return undefined
  if (last.role === 'user') {
    if (last.shell) return { working: last.shell.running, sig }
    if (INTERRUPTED.test(last.text)) return undefined
    return { working: true, sig }
  }
  if (last.task?.running && !last.tools?.length) return undefined // a background task, not the turn
  // A turn that INVOKED tools is not a turn end: their results, and a reply, are still to come. Copilot
  // and agy write the text and the calls of one step together, so `pending` alone would miss them.
  if (last.pending || (last.tools?.length ?? 0) > 0) {
    const questions = QUESTION_TOOLS[harness]
    // Claude's poll reader names a pending call only in its label (`chat-tail.ts`), the others in `tools`.
    const names = last.tools?.length ? last.tools.map(t => t.name) : toolActivityNames(last)
    const asks = !!questions && names.some(n => questions.has(n))
    return asks ? { working: true, attention: 'question', sig } : { working: true, sig }
  }
  if (!ENDS_ARE_READABLE[harness]) return undefined
  return { working: false, sig }
}

/**
 * PURE. The row's activity from the tail AND the screen read this poll. Agreement is exact; a dialog
 * only the screen shows wins; any other disagreement is the screen's (confirmed like any screen read).
 */
export function tailActivity(reading: TailReading, screen: SessionActivity): { state: SessionActivity; exact: boolean } {
  if (reading.attention) return { state: 'waiting-approval', exact: true }
  if (screen === 'waiting-approval') return { state: screen, exact: false }
  if (reading.working && screen === 'working') return { state: 'working', exact: true }
  if (!reading.working && screen === 'waiting') return { state: 'waiting', exact: true }
  return { state: screen, exact: false }
}

/** PURE. May this poll skip the row's screen and believe the tail? Only an idle tail the screen agreed with. */
export function tailSkipsScreen(o: {
  reading: TailReading | undefined
  agreedSig: string | undefined
  lastScreenMs: number | undefined
  nowMs: number
  forced: boolean
}): boolean {
  const r = o.reading
  if (!r || r.working || r.attention || o.forced) return false
  if (o.agreedSig !== r.sig) return false
  return o.lastScreenMs !== undefined && o.nowMs - o.lastScreenMs < TAIL_SCREEN_REFRESH_MS
}

/** The per-row memory the poller keeps for tail-stated rows. */
export interface TailStateMemo {
  agreed(id: string): string | undefined
  setAgreed(id: string, sig: string | undefined): void
  lastScreen(id: string): number | undefined
  screenRead(id: string, atMs: number): void
  forceScreen(id: string): void
  takeForced(id: string): boolean
  /** Drop the rows that are no longer live. */
  retain(live: ReadonlySet<string>): void
}

export function createTailStateMemo(): TailStateMemo {
  const agreed = new Map<string, string>()
  const screens = new Map<string, number>()
  const forced = new Set<string>()
  return {
    agreed: id => agreed.get(id),
    setAgreed(id, sig) { if (sig === undefined) agreed.delete(id); else agreed.set(id, sig) },
    lastScreen: id => screens.get(id),
    screenRead(id, atMs) { screens.set(id, atMs) },
    forceScreen(id) { forced.add(id) },
    takeForced(id) { return forced.delete(id) },
    retain(live) {
      for (const id of [...agreed.keys()]) if (!live.has(id)) agreed.delete(id)
      for (const id of [...screens.keys()]) if (!live.has(id)) screens.delete(id)
    },
  }
}
