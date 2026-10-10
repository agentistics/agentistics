/**
 * structured-composing.ts — ADAPTER.ESSENTIALS-B item 6: "the assistant is FORMULATING a question".
 *
 * A question card only exists once the harness asks for it whole (claude: `control_request
 * can_use_tool AskUserQuestion`), but the model has been writing that question for a while before: with
 * `--include-partial-messages` the main chain announces the tool the moment it starts
 * (`stream_event content_block_start {type:'tool_use', name:'AskUserQuestion'}`) and then streams its
 * input as `input_json_delta`. Measured on claude 2.1.295 (engine fixture `claude-stream-json-basic`):
 * the block starts at t=5144 ms and the card arrives at t=5488 ms — 344 ms of a screen saying nothing for
 * a one-line question, and seconds for a multi-question one. So the chat can say "formulating
 * questions…" from the START of the block until the card (or anything that ends the block) arrives.
 *
 * The rule is PURE (`composingStep`), per harness, over the raw stdout lines the relay already hands the
 * host (`structured-durable.ts`, beside `noteStructuredLine`). A harness whose protocol has not been
 * measured streaming a question ahead of asking it is `null` WITH its reason — never a guessed frame.
 * The small store below is the IO half: what each session is composing now, and who is listening.
 */
import type { HarnessId } from '@agentistics/core'

/** What a session is formulating right now; `null` = nothing. */
export type Composing = 'question' | null

/** One line of a harness's stdout → the next composing value (PURE, total: a bad line changes nothing). */
type ComposingRule = (prev: Composing, frame: Record<string, unknown>) => Composing

const QUESTION_TOOL = 'AskUserQuestion'

/** claude stream-json: the main chain's `AskUserQuestion` tool block, from its start to the card. */
const claudeRule: ComposingRule = (prev, o) => {
  // A subagent's frames are not the main chat (the driver drops them for the same reason).
  if (o.parent_tool_use_id != null) return prev
  if (o.type === 'stream_event') {
    const ev = o.event as { type?: string; content_block?: { type?: string; name?: string } } | undefined
    if (ev?.type === 'content_block_start') {
      return ev.content_block?.type === 'tool_use' && ev.content_block.name === QUESTION_TOOL ? 'question' : null
    }
    // A new message, or the message ending, ends whatever block was being written.
    if (ev?.type === 'message_start' || ev?.type === 'message_stop') return null
    return prev
  }
  // The card itself (or any request the host must answer), the turn's end, or a tool result: the
  // formulating is over — the card says the rest.
  if (o.type === 'control_request' || o.type === 'result' || o.type === 'user') return null
  return prev
}

const NOT_MEASURED = 'no partial question frame has been captured for this protocol: it is shown when the request arrives whole'

/**
 * Per harness. A `string` is the reason there is no rule — said, never guessed (equal treatment: every
 * harness is listed, and a rule is added the day its protocol is measured streaming a question).
 */
export const COMPOSING_RULES: Record<HarnessId, ComposingRule | string> = {
  claude: claudeRule,
  codex: `codex app-server: ${NOT_MEASURED}`,
  gemini: `gemini ACP: ${NOT_MEASURED}`,
  copilot: `copilot ACP: ${NOT_MEASURED}`,
  kimi: `kimi ACP: ${NOT_MEASURED}`,
  antigravity: 'agy print mode has no question events at all (docs/f2-structured-backend.md)',
  opencode: 'opencode has no structured driver here',
}

/** PURE. The composing value after one raw stdout line. */
export function composingStep(harness: HarnessId | string, prev: Composing, line: string): Composing {
  const rule = (COMPOSING_RULES as Record<string, ComposingRule | string | undefined>)[harness]
  if (typeof rule !== 'function') return null
  let o: unknown
  try { o = JSON.parse(line) } catch { return prev }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return prev
  return rule(prev, o as Record<string, unknown>)
}

// ── the IO half: one value per session, and its listeners ──────────────────────────────────────────

const now = new Map<string, Composing>()
const listeners = new Map<string, Set<(c: Composing) => void>>()

function set(id: string, next: Composing): void {
  const was = now.get(id) ?? null
  if (next === null) now.delete(id); else now.set(id, next)
  if (was === next) return
  for (const cb of listeners.get(id) ?? []) { try { cb(next) } catch { /* a listener never breaks the tap */ } }
}

/** A raw stdout line of a structured session (the relay's tap). */
export function noteComposingLine(id: string, harness: HarnessId | string, line: string): void {
  set(id, composingStep(harness, now.get(id) ?? null, line))
}

/** The session ended or was replaced: nothing is being formulated any more. */
export function clearComposing(id: string): void { set(id, null) }

export function composingOf(id: string): Composing { return now.get(id) ?? null }

/** Listen to one session's value; the current one is NOT replayed (call `composingOf`). */
export function onComposing(id: string, cb: (c: Composing) => void): () => void {
  let s = listeners.get(id)
  if (!s) { s = new Set(); listeners.set(id, s) }
  s.add(cb)
  return () => {
    const cur = listeners.get(id)
    if (!cur) return
    cur.delete(cb)
    if (cur.size === 0) listeners.delete(id)
  }
}

export function __resetComposingForTest(): void { now.clear(); listeners.clear() }
