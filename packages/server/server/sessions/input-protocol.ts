/**
 * input-protocol.ts — PURE contract for the live terminal's WRITE channel.
 *
 * The read channel (`terminal-stream.ts`) turns a capture into a frame; this is its write-side
 * sibling: it turns one raw WebSocket message from the browser into a validated keystroke, and
 * shapes the confirmation that goes back. No IO — the queue that runs the sends is `input-channel.ts`
 * and the socket wiring is `input-web.ts`.
 *
 * ## Wire contract (agreed with the CONSUMER, `agentistics/web`)
 *
 * Client → server, one JSON object per WS message:
 *
 *   { "seq": 1, "kind": "text",  "data": "l"   }   // literal characters, typed with `-l`, NO Enter
 *   { "seq": 2, "kind": "key",   "name": "C-c" }   // one NAMED key from the CLOSED set below
 *   { "seq": 3, "kind": "paste", "data": "…"   }   // a whole clipboard PASTE, atomic, never split
 *
 * `paste` is a SEPARATE kind from `text`, not a longer `text` — it goes through a different tmux
 * primitive (bracketed `paste-buffer`, see `tmux-cli.ts`), and its own, larger length cap
 * (`MAX_PASTE_TEXT`), because the client can tell the two apart at the source (the DOM `paste`
 * event) in a way the server never could from bytes alone.
 *
 * Server → client, one ack per message:
 *
 *   { "seq": 1, "ok": true }
 *   { "seq": 2, "ok": false, "reason": "send_failed" }
 *
 * - `seq` is the client's own monotonic counter, ECHOED in the ack — the mapping a browser needs to
 *   show "not delivered" against the exact keystroke, and the thing that makes FIFO VERIFIABLE rather
 *   than assumed: a mismatch is a detected, surfaced failure, not a silently swallowed one. Every
 *   message is answered by exactly one ack; without that, key-by-key typing would repeat the lie
 *   PR #269 fixed for line sends.
 * - `reason` is present iff `ok` is false — a stable code the client renders (or maps/localizes).
 * - There is NO local echo: a character appears on screen only when the SESSION draws it, read back
 *   over the existing SSE `/api/fleet/stream`. That is what makes "the UI never shows an undelivered
 *   keystroke" true BY CONSTRUCTION — a key that never reached the process is never painted.
 *
 * The `text`/`key` split is by construction: `text` NEVER carries `Enter`; a submit is a `key`
 * (`Enter`). Confusing the two fails silently in tmux (`send-keys -l Enter` types five letters), which
 * is exactly why `sendKeysLiteralArgs` and `sendKeysNamedArgs` are separate downstream.
 */
import { originAllowed } from '../cors'
import { sanitizePasteText } from '@agentistics/core'

/** A `text` payload longer than this is refused. Direct typing is small — a batched `xterm.onData`
 *  chunk from a person's own keystrokes — and 8 KiB is generous headroom for one. A PASTE is a
 *  different payload with its own, larger cap: see `MAX_PASTE_TEXT`. */
export const MAX_INPUT_TEXT = 8192

/** A `paste` payload longer than this is REFUSED, never truncated — a truncated paste silently
 *  types less than the person copied, which is worse than a refusal they can see. 64 KiB is
 *  generous for a clipboard paste (a long log line, a stack trace, a config file) while still
 *  bounding what one WebSocket message can make the server type into a pane. */
export const MAX_PASTE_TEXT = 65536

/**
 * The CLOSED set of named keys this channel will send — defence in depth.
 *
 * The client keeps its own allowlist; the server does NOT trust it and validates membership here.
 * Everything ordinary a browser's `xterm.onData` emits — printable characters AND raw escape
 * sequences (arrows, function keys) — travels as `kind:"text"` and is typed verbatim with `-l`; the
 * `key` path exists only for the SEMANTIC control keys where a NAMED send is the correct, verifiable
 * mechanism (A4: `C-c` must go through `sendKeysNamedArgs`, not literal text). A name outside this set
 * is refused rather than passed to `send-keys`, so the write channel can never be talked into an
 * arbitrary key sequence. To widen it, add the tmux key name here — deliberately a code change, not a
 * client-supplied value.
 *
 * `Escape` was ADDED for the per-session utility shell's mobile key strip, and the reasoning is the
 * line this set draws: Escape CANCELS (leaves insert mode, dismisses a picker) and controls no
 * process, so it belongs with the editing keys rather than with `C-z`. A soft keyboard has none at
 * all — the cockpit already records that it has no arrow keys either — so without it there is no way
 * to leave `vim` from a phone; and a Claude Code permission dialog's own footer says `Esc to
 * cancel`, which this channel could not reach for as long as the set excluded it.
 *
 * `C-l` was added for the same shape of reason and is the odder story: `backend-tmux.ts` ALREADY
 * clears the pane's scrollback after a successful `C-l`, written before the key could arrive from a
 * browser at all — this set refused it as `bad_key`, so that handling was unreachable from the web.
 * It CLEARS the screen and controls no process, which is the line this set draws.
 */
export const KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'Enter', 'BSpace', 'Tab', 'Escape',
  'Up', 'Down', 'Left', 'Right',
  'C-c', 'C-d', 'C-a', 'C-e', 'C-u', 'C-w', 'C-k', 'C-l',
])

export type InputMessage =
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'key'; key: string }
  | { seq: number; kind: 'paste'; text: string }

/** Every stable failure reason a client may receive. */
export type InputReason =
  | 'bad_json'
  | 'bad_message'
  | 'empty_text'
  | 'text_too_long'
  | 'paste_too_long'
  | 'bad_key'
  | 'send_failed'
  | 'error'

export type ParseResult =
  | { ok: true; msg: InputMessage }
  // `seq` is null when the message was too malformed to carry one; otherwise it is echoed so the
  // browser can map even a rejection to the keystroke that caused it.
  | { ok: false; seq: number | null; reason: InputReason }

export type InputAck =
  | { seq: number | null; ok: true }
  | { seq: number | null; ok: false; reason: InputReason }

export function ackOk(seq: number | null): InputAck {
  return { seq, ok: true }
}

export function ackFail(seq: number | null, reason: InputReason): InputAck {
  return { seq, ok: false, reason }
}

export function encodeAck(ack: InputAck): string {
  return JSON.stringify(ack)
}

/**
 * Validate one raw client message into a typed keystroke, or a mapped rejection.
 *
 * Never throws — a malformed message from a browser is an ordinary outcome, answered with an ack, not
 * an error that tears down the socket.
 */
export function parseInputMessage(raw: string): ParseResult {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ok: false, seq: null, reason: 'bad_json' }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, seq: null, reason: 'bad_message' }
  }
  const rec = obj as Record<string, unknown>

  // A seq that is not a finite number cannot map an ack to a keystroke, so the whole message is
  // refused with a null seq — there is nothing meaningful to echo.
  const rawSeq = rec.seq
  if (typeof rawSeq !== 'number' || !Number.isFinite(rawSeq)) {
    return { ok: false, seq: null, reason: 'bad_message' }
  }
  const seq = rawSeq

  const kind = rec.kind
  if (kind === 'text') {
    const data = rec.data
    if (typeof data !== 'string') return { ok: false, seq, reason: 'bad_message' }
    if (data.length === 0) return { ok: false, seq, reason: 'empty_text' }
    if (data.length > MAX_INPUT_TEXT) return { ok: false, seq, reason: 'text_too_long' }
    return { ok: true, msg: { seq, kind: 'text', text: data } }
  }
  if (kind === 'key') {
    const name = rec.name
    if (typeof name !== 'string' || !KEY_ALLOWLIST.has(name)) {
      return { ok: false, seq, reason: 'bad_key' }
    }
    return { ok: true, msg: { seq, kind: 'key', key: name } }
  }
  if (kind === 'paste') {
    const data = rec.data
    if (typeof data !== 'string') return { ok: false, seq, reason: 'bad_message' }
    if (data.length === 0) return { ok: false, seq, reason: 'empty_text' }
    // REFUSED, never truncated — see `MAX_PASTE_TEXT`. Checked on the RAW length, before
    // sanitizing: the cap bounds what one WS message may carry, not what survives sanitizing.
    if (data.length > MAX_PASTE_TEXT) return { ok: false, seq, reason: 'paste_too_long' }
    // THE security check for this whole message kind: neutralize a bracketed-paste breakout
    // (`\x1b[200~`/`\x1b[201~`) and every other C0 control byte / DEL before this text ever
    // reaches a tmux buffer. This is the ONE place both write channels (the Shell's
    // `/api/shell/input` and the assistant terminal's `/api/fleet/input`) route a paste through —
    // see `pasteSanitize.ts` for why sanitizing here is the fix, not a refusal-with-reason-code.
    // A payload that sanitizes down to nothing carried no real content (entirely markers/control
    // bytes), so it is refused exactly like an outright empty paste — never silently accepted as a
    // no-op "success".
    const text = sanitizePasteText(data)
    if (text.length === 0) return { ok: false, seq, reason: 'empty_text' }
    return { ok: true, msg: { seq, kind: 'paste', text } }
  }
  return { ok: false, seq, reason: 'bad_message' }
}

/**
 * Same-origin (or allowlisted) gate for the WS UPGRADE — CSWSH protection.
 *
 * `localShell` being on (local profile) does not stop a malicious page in the user's own browser from
 * opening a socket to `localhost`, so the Origin must be checked exactly as `csrf.ts` checks it for
 * unsafe methods. A browser ALWAYS sends `Origin` on a WS handshake, so a MISSING origin is a
 * non-browser client (a CLI, a test) and is allowed — it cannot be a cross-site page.
 */
export function wsInputOriginOk(input: {
  origin: string | null
  host: string
  allowlist: string[]
  dev: boolean
}): boolean {
  const { origin, host } = input
  if (!origin) return true
  if (origin === `https://${host}` || origin === `http://${host}`) return true
  return originAllowed(origin, input.allowlist, input.dev)
}
