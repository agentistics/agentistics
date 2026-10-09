/**
 * chatSource.ts — THE SEAM (UI.UNIFY): where the standard `SessionChat` gets a conversation from.
 *
 * Absent, the chat reads the way it always has — `/api/fleet/chat` for the turns, the tmux screen
 * for the in-flight text, the fleet's `act` for every verb — and NOTHING about that path changes.
 * Present, it is the one place a harness that has none of those (the NATIVE runtime, which streams
 * its own window and events) hands the same chat its turns, its live text, its verbs and the two
 * harness-specific SLOTS: the question card and the run line. The shell around them — the header,
 * the side panels, the composer with every control, the bottom bar, the keyboard and the 390 px
 * layout — is the one every harness gets.
 */
import type { ReactNode } from 'react'
import type { ChatTurn } from './ChatBubble'
import type { FleetActionId } from '../../lib/fleet'

export type ChatAct = (req: { id: string; action: FleetActionId; text?: string; choice?: number; occurrence?: number; confirm?: boolean })
  => Promise<{ ok: boolean; message: string; id?: string; confirm?: boolean; failure?: 'prompt' | 'ended' | 'unconfirmed' }>

export interface ChatSource {
  /** The conversation, or null while the first read is in flight (the chat's own loading state). */
  turns: ChatTurn[] | null
  /** A sentence when the conversation cannot be read at all — drawn by the chat's own refusal. */
  unavailable?: string
  /** A turn is running. */
  working: boolean
  /** The model's own in-flight text — exact, so it is drawn as a bubble (unlike a screen scrape). */
  liveText: string | null
  /** The in-flight turn's reasoning, folded above the live text (`ReasoningBlock`). */
  liveReasoning?: string | null
  /** Tools running right now, for the standard working note. */
  runningTools?: { name: string; detail?: string }[]
  /** Every verb the chat performs: `prompt`, `interrupt`, `approve`. */
  act: ChatAct
  /** Whether a running turn can be stopped from the composer. */
  canStop: boolean
  /** SLOT: the question(s) waiting on the person — drawn where `ApprovalCard` is drawn. */
  approvals?: ReactNode
  /** SLOT: the run line (tokens, cost, context) — drawn under the composer, in the bottom bar. */
  status?: ReactNode
  /** A sentence the source wants said under the composer (a refused send, a failed read). */
  notice?: string | null
  /**
   * The session's own settings for its NEXT turns, drawn in the composer's standard "more" menu —
   * the model list a CLI session gets there, the `EffortPicker` scale, and two controls of the same
   * kind. Each member is optional; a refusal comes back as a sentence (null = done).
   */
  controls?: SourceControls
}

export interface SourceControls {
  /** Settings are refused mid-turn: the running turn keeps what it started with. */
  busy: boolean
  model?: { current: string; options: readonly { id: string; label: string }[]; freeText: boolean; switch(id: string): Promise<string | null> }
  /** `efforts` is the closed scale (`EffortPicker`); `''` is "off". */
  effort?: { value: string; efforts: readonly string[]; set(value: string): Promise<string | null> }
  browser?: { on: boolean; set(on: boolean): Promise<string | null> }
  extraDirs?: { dirs: readonly string[]; add(path: string): Promise<string | null> }
}
