/**
 * browser-input-protocol.ts — the person's input onto a browser tab (NAVEGADOR S4, spec §1.6).
 *
 * The browser sibling of `sessions/input-protocol.ts` + `sessions/input-channel.ts`: same wire shape
 * (`{seq, …}` in, exactly one `{seq, ok, reason?}` ack out, FIFO by a serial chain), extended with the
 * three ops a page needs — `pointer`, `key`, `text`. Coordinates arrive NORMALIZED (0–1 over the frame)
 * and become viewport pixels here, from the size of the last frame the person saw.
 *
 * THE RULE THIS FILE EXISTS FOR: the padlock is decided by the SERVER at EACH event (`allowed()`), never
 * once at connect and never by the client. Locked (the model drives) ⇒ every event is answered
 * `locked` and nothing reaches the page. Nothing here logs an event — a typed password appears nowhere:
 * it goes straight to `Input.dispatch*`.
 */
import { MAX_INPUT_TEXT } from '../sessions/input-protocol'

/** `text` (mobile keyboard, paste) longer than this is refused, never truncated. */
export const MAX_BROWSER_TEXT = MAX_INPUT_TEXT
/** A person does not produce more than this; a flood is a client bug or worse. */
export const MAX_EVENTS_PER_SECOND = 120
const MAX_DELTA = 10_000
const MAX_KEY_LEN = 32

export type PointerType = 'down' | 'up' | 'move' | 'wheel'
export type PointerButton = 'left' | 'middle' | 'right' | 'none'

export type BrowserInputMessage =
  | { seq: number; op: 'pointer'; type: PointerType; x: number; y: number; button: PointerButton; clicks: number; deltaX: number; deltaY: number; mods: number }
  | { seq: number; op: 'key'; type: 'down' | 'up'; key: string; code: string; text?: string; mods: number }
  | { seq: number; op: 'text'; text: string }

export type BrowserInputReason =
  | 'bad_json' | 'bad_message' | 'out_of_range' | 'empty_text' | 'text_too_long'
  | 'locked' | 'no_browser' | 'rate_limited' | 'send_failed'

export type BrowserInputAck =
  | { seq: number | null; ok: true }
  | { seq: number | null; ok: false; reason: BrowserInputReason }

export type ParsedInput = { ok: true; msg: BrowserInputMessage } | { ok: false; seq: number | null; reason: BrowserInputReason }

export interface CdpCommand { method: string; params: Record<string, unknown> }

const POINTER_TYPES = new Set<PointerType>(['down', 'up', 'move', 'wheel'])
const BUTTONS = new Set<PointerButton>(['left', 'middle', 'right', 'none'])

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const unit = (v: unknown): boolean => isNum(v) && v >= 0 && v <= 1
const mods = (v: unknown): number | null => (v === undefined ? 0 : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 15 ? (v as number) : null)

/** One raw WS message → a typed event or an answered refusal. Never throws. */
export function parseBrowserInput(raw: string): ParsedInput {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return { ok: false, seq: null, reason: 'bad_json' } }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, seq: null, reason: 'bad_message' }
  const r = o as Record<string, unknown>
  if (!isNum(r.seq)) return { ok: false, seq: null, reason: 'bad_message' }
  const seq = r.seq
  const bad = { ok: false as const, seq, reason: 'bad_message' as const }
  const m = mods(r.mods)
  if (m === null) return bad

  if (r.op === 'pointer') {
    if (typeof r.type !== 'string' || !POINTER_TYPES.has(r.type as PointerType)) return bad
    const type = r.type as PointerType
    const button = (r.button === undefined ? (type === 'wheel' || type === 'move' ? 'none' : 'left') : r.button) as PointerButton
    if (typeof button !== 'string' || !BUTTONS.has(button)) return bad
    if (!unit(r.x) || !unit(r.y)) return { ok: false, seq, reason: 'out_of_range' }
    const dx = r.deltaX === undefined ? 0 : r.deltaX
    const dy = r.deltaY === undefined ? 0 : r.deltaY
    if (!isNum(dx) || !isNum(dy) || Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) return { ok: false, seq, reason: 'out_of_range' }
    const clicks = r.clicks === undefined ? (type === 'down' || type === 'up' ? 1 : 0) : r.clicks
    if (!Number.isInteger(clicks) || (clicks as number) < 0 || (clicks as number) > 3) return bad
    return { ok: true, msg: { seq, op: 'pointer', type, x: r.x as number, y: r.y as number, button, clicks: clicks as number, deltaX: dx, deltaY: dy, mods: m } }
  }
  if (r.op === 'key') {
    if (r.type !== 'down' && r.type !== 'up') return bad
    if (typeof r.key !== 'string' || r.key.length === 0 || r.key.length > MAX_KEY_LEN) return bad
    if (typeof r.code !== 'string' || r.code.length > MAX_KEY_LEN) return bad
    if (r.text !== undefined && (typeof r.text !== 'string' || [...r.text].length > 1)) return bad
    return { ok: true, msg: { seq, op: 'key', type: r.type, key: r.key, code: r.code, ...(typeof r.text === 'string' && r.text ? { text: r.text } : {}), mods: m } }
  }
  if (r.op === 'text') {
    if (typeof r.text !== 'string') return bad
    if (r.text.length === 0) return { ok: false, seq, reason: 'empty_text' }
    if (r.text.length > MAX_BROWSER_TEXT) return { ok: false, seq, reason: 'text_too_long' }
    return { ok: true, msg: { seq, op: 'text', text: r.text } }
  }
  return bad
}

/** Windows virtual key codes CDP needs for a named key to act (Enter submits, Backspace deletes). */
const VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
}

function vkOf(key: string): number | undefined {
  if (key in VK) return VK[key]
  if (key.length === 1) {
    const u = key.toUpperCase()
    if (/^[A-Z0-9]$/.test(u)) return u.charCodeAt(0)
  }
  return undefined
}

const BUTTON_BITS: Record<PointerButton, number> = { none: 0, left: 1, right: 2, middle: 4 }
const MOUSE_TYPE: Record<PointerType, string> = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' }

/** PURE: one event → the CDP calls that perform it, in viewport pixels. */
export function toCdpCommands(msg: BrowserInputMessage, viewport: { w: number; h: number }): CdpCommand[] {
  if (msg.op === 'text') return [{ method: 'Input.insertText', params: { text: msg.text } }]
  if (msg.op === 'pointer') {
    const x = Math.round(msg.x * viewport.w)
    const y = Math.round(msg.y * viewport.h)
    const params: Record<string, unknown> = {
      type: MOUSE_TYPE[msg.type], x, y, button: msg.button,
      buttons: msg.type === 'up' ? 0 : BUTTON_BITS[msg.button], clickCount: msg.clicks, modifiers: msg.mods,
    }
    if (msg.type === 'wheel') { params.deltaX = msg.deltaX; params.deltaY = msg.deltaY }
    return [{ method: 'Input.dispatchMouseEvent', params }]
  }
  const ctrlOrMeta = (msg.mods & (2 | 4)) !== 0
  const text = msg.type === 'down'
    ? (msg.key === 'Enter' ? '\r' : msg.text ?? (msg.key.length === 1 && !ctrlOrMeta ? msg.key : undefined))
    : undefined
  const vk = vkOf(msg.key)
  return [{
    method: 'Input.dispatchKeyEvent',
    params: {
      type: msg.type === 'down' ? 'keyDown' : 'keyUp', key: msg.key, code: msg.code,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
      ...(vk !== undefined ? { windowsVirtualKeyCode: vk } : {}),
      modifiers: msg.mods,
    },
  }]
}

export interface BrowserInputChannelDeps {
  /** May the person drive this browser NOW? (session browser: the padlock is unlocked; personal: yes) */
  allowed(): boolean
  /** The viewport the frame shows, in CSS px; `null` = no browser / no tab. */
  viewport(): Promise<{ w: number; h: number } | null>
  dispatch(cmds: CdpCommand[]): Promise<boolean>
  /** The person touched the browser (the padlock's 15-min auto-lock and the host's idle clock). */
  noteInput(): void
  emit(ack: BrowserInputAck): void
  now(): number
}

export interface BrowserInputChannel { submit(raw: string): void }

/** One channel per socket: strictly serial, one ack per message, the padlock read at every event. */
export function createBrowserInputChannel(d: BrowserInputChannelDeps): BrowserInputChannel {
  let tail: Promise<void> = Promise.resolve()
  let windowStart = -Infinity
  let inWindow = 0

  async function handle(raw: string, at: number): Promise<void> {
    const p = parseBrowserInput(raw)
    if (!p.ok) { d.emit({ seq: p.seq, ok: false, reason: p.reason }); return }
    const seq = p.msg.seq
    if (at - windowStart >= 1000) { windowStart = at; inWindow = 0 }
    if (++inWindow > MAX_EVENTS_PER_SECOND) { d.emit({ seq, ok: false, reason: 'rate_limited' }); return }
    if (!d.allowed()) { d.emit({ seq, ok: false, reason: 'locked' }); return }
    const vp = await d.viewport()
    if (!vp) { d.emit({ seq, ok: false, reason: 'no_browser' }); return }
    // Re-read after the await: the person may have handed the browser back in between.
    if (!d.allowed()) { d.emit({ seq, ok: false, reason: 'locked' }); return }
    let ok = false
    try { ok = await d.dispatch(toCdpCommands(p.msg, vp)) } catch { ok = false }
    if (ok) d.noteInput()
    d.emit(ok ? { seq, ok: true } : { seq, ok: false, reason: 'send_failed' })
  }

  return {
    submit(raw) {
      const at = d.now()
      tail = tail.then(() => handle(raw, at)).catch(() => {})
    },
  }
}
