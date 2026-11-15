/**
 * browser-action-spec.ts — PURE: what a browser action may be asked to do (NAVEGADOR S2, spec §1.6 / §5).
 *
 * One table for the REST door (`/api/browser/session/<action>`, `/api/browser/personal/<action>`) and
 * the MCP tools that call it: the action names, which are ACTIONS (change the page) and which are
 * READS, how each one's body is validated, the key table for `press`, and the byte cap for
 * `evaluate`. Every refusal is a code plus a sentence — the model reads the sentence.
 *
 * The lock is S3. The distinction it will need — an action is held while the person drives, a read is
 * not — is already here (`ACTION_KIND`), and `ActionGate` is the hook the route calls before every
 * action; S2's gate always proceeds.
 */

import { MAX_SNAPSHOT_BYTES, MIN_SNAPSHOT_BYTES, parseBoundRef } from './ax-snapshot'

export const SESSION_ACTIONS = [
  'navigate', 'back', 'forward', 'reload', 'click', 'type', 'press', 'select', 'scroll', 'evaluate',
  'tab_new', 'tab_select', 'tab_close', 'close',
  'snapshot', 'screenshot', 'wait_for', 'tabs',
] as const
export type BrowserAction = (typeof SESSION_ACTIONS)[number]

/** `action` = changes the page (held by the lock in S3); `read` = never held. */
export const ACTION_KIND: Record<BrowserAction, 'action' | 'read'> = {
  navigate: 'action', back: 'action', forward: 'action', reload: 'action', click: 'action', type: 'action',
  press: 'action', select: 'action', scroll: 'action', evaluate: 'action', tab_new: 'action',
  tab_select: 'action', tab_close: 'action', close: 'action',
  snapshot: 'read', screenshot: 'read', wait_for: 'read', tabs: 'read',
}

/** The person's own browser takes the same verbs minus `evaluate` (nobody asked for a console there). */
export const PERSONAL_ACTIONS: readonly BrowserAction[] = SESSION_ACTIONS.filter(a => a !== 'evaluate')

export function isBrowserAction(s: string): s is BrowserAction {
  return (SESSION_ACTIONS as readonly string[]).includes(s)
}

/** S3's hook: called before every `action` (never a `read`). S2 always proceeds. */
export type ActionGate = (ownerKey: string, action: BrowserAction) => Promise<{ proceed: true } | { proceed: false; result: unknown }>
export const ALWAYS_PROCEED: ActionGate = async () => ({ proceed: true })

export const EVALUATE_MAX_BYTES = 20 * 1024
export const EVALUATE_EXPRESSION_MAX = 20_000
export const TYPE_TEXT_MAX = 10_000
export const URL_MAX = 4096
export const WAIT_MAX_MS = 10_000
export const WAIT_DEFAULT_MS = 5_000
export const SCROLL_MAX = 20_000
export const FULLPAGE_MAX_HEIGHT = 6_000

export type ActionArgs =
  | { action: 'navigate'; url: string; tab?: string }
  | { action: 'back' | 'forward' | 'reload' | 'tabs' | 'close'; tab?: string }
  | { action: 'click'; ref?: string; x?: number; y?: number; button: 'left' | 'right' | 'middle'; double: boolean; tab?: string }
  | { action: 'type'; ref: string; text: string; submit: boolean; tab?: string }
  | { action: 'press'; key: string; tab?: string }
  | { action: 'select'; ref: string; values: string[]; tab?: string }
  | { action: 'scroll'; ref?: string; dx: number; dy: number; tab?: string }
  | { action: 'evaluate'; expression: string; tab?: string }
  | { action: 'tab_new'; url?: string }
  | { action: 'tab_select' | 'tab_close'; tab: string }
  | { action: 'snapshot'; mode: 'full' | 'viewport'; maxBytes?: number; tab?: string }
  | { action: 'screenshot'; fullPage: boolean; format: 'png' | 'jpeg'; tab?: string }
  | { action: 'wait_for'; text?: string; ref?: string; ms?: number; timeoutMs: number; tab?: string }

export type Parsed = { ok: true; args: ActionArgs } | { ok: false; error: 'bad_request'; sentence: string }

const bad = (sentence: string): Parsed => ({ ok: false, error: 'bad_request', sentence })

/** A CDP target id (32 hex characters in every Chromium measured; accepted 8–64). */
export function validTab(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Fa-f0-9]{8,64}$/.test(v)
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Validate one action's body. Unknown fields are ignored; a malformed known field is refused. */
export function parseActionArgs(action: BrowserAction, body: unknown): Parsed {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  let tab: string | undefined
  if (b.tab !== undefined && b.tab !== null && b.tab !== '') {
    if (!validTab(b.tab)) return bad('`tab` must be a tab id from agentistics_browser_tabs.')
    tab = b.tab
  }
  const withTab = <T extends object>(o: T) => (tab ? { ...o, tab } : o)
  const refOk = (r: unknown) => typeof r === 'string' && parseBoundRef(r) !== null
  switch (action) {
    case 'navigate': {
      const url = str(b.url, URL_MAX)
      if (!url || !url.trim()) return bad('`url` is required (at most 4096 characters).')
      return { ok: true, args: withTab({ action, url: url.trim() }) }
    }
    case 'back': case 'forward': case 'reload': case 'tabs': case 'close':
      return { ok: true, args: withTab({ action }) }
    case 'click': {
      const button = b.button === undefined ? 'left' : b.button
      if (button !== 'left' && button !== 'right' && button !== 'middle') return bad('`button` is left, right or middle.')
      const double = b.double === true
      if (b.ref !== undefined) {
        if (!refOk(b.ref)) return bad('`ref` is a ref from agentistics_browser_snapshot, like "e12".')
        return { ok: true, args: withTab({ action, ref: b.ref as string, button, double }) }
      }
      const x = fin(b.x), y = fin(b.y)
      if (x === null || y === null || x < 0 || y < 0 || x > 10_000 || y > 10_000) return bad('Give `ref` (from a snapshot) or both `x` and `y` in viewport pixels.')
      return { ok: true, args: withTab({ action, x, y, button, double }) }
    }
    case 'type': {
      if (!refOk(b.ref)) return bad('`ref` is required: the field to type into, from agentistics_browser_snapshot.')
      const text = str(b.text, TYPE_TEXT_MAX)
      if (text === null) return bad('`text` is required (at most 10000 characters).')
      return { ok: true, args: withTab({ action, ref: b.ref as string, text, submit: b.submit === true }) }
    }
    case 'press': {
      const key = str(b.key, 32)
      if (!key || !keyDef(key)) return bad('`key` is a single character or a key name such as Enter, Tab, Escape, Backspace, ArrowDown, PageDown.')
      return { ok: true, args: withTab({ action, key }) }
    }
    case 'select': {
      if (!refOk(b.ref)) return bad('`ref` is required: the <select> element, from agentistics_browser_snapshot.')
      const raw = typeof b.values === 'string' ? [b.values] : b.values
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50 || !raw.every(v => typeof v === 'string' && v.length <= 1000)) {
        return bad('`values` is a list of option values or labels (1 to 50).')
      }
      return { ok: true, args: withTab({ action, ref: b.ref as string, values: raw as string[] }) }
    }
    case 'scroll': {
      if (b.ref !== undefined) {
        if (!refOk(b.ref)) return bad('`ref` is a ref from agentistics_browser_snapshot.')
        return { ok: true, args: withTab({ action, ref: b.ref as string, dx: 0, dy: 0 }) }
      }
      const dy = b.dy === undefined ? 0 : fin(b.dy)
      const dx = b.dx === undefined ? 0 : fin(b.dx)
      if (dy === null || dx === null || Math.abs(dy) > SCROLL_MAX || Math.abs(dx) > SCROLL_MAX || (dx === 0 && dy === 0)) {
        return bad('Give `ref` (scroll it into view) or `dy` / `dx` in pixels (±20000, not both zero).')
      }
      return { ok: true, args: withTab({ action, dx, dy }) }
    }
    case 'evaluate': {
      const expression = str(b.expression, EVALUATE_EXPRESSION_MAX)
      if (!expression || !expression.trim()) return bad('`expression` is required (at most 20000 characters).')
      return { ok: true, args: withTab({ action, expression }) }
    }
    case 'tab_new': {
      if (b.url === undefined || b.url === '') return { ok: true, args: { action } }
      const url = str(b.url, URL_MAX)
      if (!url) return bad('`url` is at most 4096 characters.')
      return { ok: true, args: { action, url: url.trim() } }
    }
    case 'tab_select': case 'tab_close':
      if (!tab) return bad('`tab` is required: a tab id from agentistics_browser_tabs.')
      return { ok: true, args: { action, tab } }
    case 'snapshot': {
      const mode = b.mode === undefined ? 'full' : b.mode
      if (mode !== 'full' && mode !== 'viewport') return bad('`mode` is "full" or "viewport".')
      let maxBytes: number | undefined
      if (b.maxBytes !== undefined) {
        const m = fin(b.maxBytes)
        if (m === null || m < MIN_SNAPSHOT_BYTES || m > MAX_SNAPSHOT_BYTES) return bad(`\`maxBytes\` is between ${MIN_SNAPSHOT_BYTES} and ${MAX_SNAPSHOT_BYTES}.`)
        maxBytes = Math.floor(m)
      }
      return { ok: true, args: withTab({ action, mode, ...(maxBytes ? { maxBytes } : {}) }) }
    }
    case 'screenshot': {
      const format = b.format === undefined ? 'png' : b.format
      if (format !== 'png' && format !== 'jpeg') return bad('`format` is png or jpeg.')
      return { ok: true, args: withTab({ action, fullPage: b.fullPage === true, format }) }
    }
    case 'wait_for': {
      const given = [b.text !== undefined, b.ref !== undefined, b.ms !== undefined].filter(Boolean).length
      if (given !== 1) return bad('Give exactly one of `text`, `ref` or `ms`.')
      const timeout = b.timeoutMs === undefined ? WAIT_DEFAULT_MS : fin(b.timeoutMs)
      if (timeout === null || timeout < 0 || timeout > WAIT_MAX_MS) return bad('`timeoutMs` is at most 10000.')
      if (b.text !== undefined) {
        const text = str(b.text, 500)
        if (!text) return bad('`text` is 1 to 500 characters.')
        return { ok: true, args: withTab({ action, text, timeoutMs: timeout }) }
      }
      if (b.ref !== undefined) {
        if (!refOk(b.ref)) return bad('`ref` is a ref from agentistics_browser_snapshot.')
        return { ok: true, args: withTab({ action, ref: b.ref as string, timeoutMs: timeout }) }
      }
      const ms = fin(b.ms)
      if (ms === null || ms < 0 || ms > WAIT_MAX_MS) return bad('`ms` is 0 to 10000.')
      return { ok: true, args: withTab({ action, ms, timeoutMs: timeout }) }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Keys

export interface KeyDef { key: string; code: string; keyCode: number; text?: string }

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}
const ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', ' ': 'Space' }

/** The CDP key event for a key name or one printable character; null for anything else. */
export function keyDef(raw: string): KeyDef | null {
  const name = ALIASES[raw] ?? raw
  if (NAMED[name]) return NAMED[name]!
  const lower = Object.keys(NAMED).find(k => k.toLowerCase() === name.toLowerCase())
  if (lower) return NAMED[lower]!
  if ([...raw].length !== 1 || /[\u0000-\u001f\u007f]/.test(raw)) return null
  const ch = raw
  const up = ch.toUpperCase()
  const code = /^[a-z]$/i.test(ch) ? `Key${up}` : /^\d$/.test(ch) ? `Digit${ch}` : ''
  const keyCode = /^[a-z0-9]$/i.test(ch) ? up.charCodeAt(0) : 0
  return { key: ch, code, keyCode, text: ch }
}

// ---------------------------------------------------------------------------------------------------
// Results

/** Cut a string to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(s, 'utf8')
  if (bytes <= maxBytes) return { text: s, truncated: false, bytes }
  let buf = Buffer.from(s, 'utf8').subarray(0, maxBytes)
  // Step back over a partial multi-byte sequence.
  let end = buf.length
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--
  if (end > 0 && buf[end - 1]! >= 0xc0) end--
  buf = buf.subarray(0, end)
  return { text: buf.toString('utf8'), truncated: true, bytes }
}

/** What `evaluate` returns: the value as JSON (or `undefined`), capped at EVALUATE_MAX_BYTES. */
export function evaluateResult(value: unknown, type: string | undefined): { value: string; truncated: boolean; bytes: number } {
  let s: string
  if (type === 'undefined' || value === undefined) s = 'undefined'
  else {
    try { s = JSON.stringify(value) ?? 'undefined' } catch { s = String(value) }
  }
  const t = truncateUtf8(s, EVALUATE_MAX_BYTES)
  return { value: t.text, truncated: t.truncated, bytes: t.bytes }
}

/** A URL as the session's OWN tools return it: credentials removed, a `data:` URL shortened. */
export function ownUrl(raw: string): string {
  if (typeof raw !== 'string') return ''
  if (raw.slice(0, 5).toLowerCase() === 'data:') {
    const t = truncateUtf8(raw, 100)
    return t.truncated ? `${t.text}…` : t.text
  }
  try {
    const u = new URL(raw)
    if (u.username || u.password) { u.username = ''; u.password = '' }
    return u.toString().slice(0, URL_MAX)
  } catch { return raw.slice(0, 300) }
}

/** The sentence for a URL the block rules refused. */
export function blockSentence(reason: string, url: string, via?: 'redirect' | 'subresource' | 'popup'): string {
  const what = reason === 'scheme' ? 'that kind of address (file:, chrome:, devtools:… are never loaded)'
    : reason === 'agentistics-port' ? "agentistics' own server port"
    : reason === 'debug-port' ? "another browser's debugging port"
    : 'an address that does not parse'
  const how = via === 'redirect' ? ' (the page redirected there)' : via === 'popup' ? ' (a popup opened it)' : ''
  return `Refused: ${url} points at ${what}${how}. Other localhost ports (your dev server) are allowed.`
}

// ---------------------------------------------------------------------------------------------------
// Refs bound to their document (S2 fix 2)

/**
 * What a tab remembers about its last snapshot. A ref is `e<backendNodeId>@g<generation>`; the backend node
 * id alone is only unique inside one document, so a ref taken on page A could name an unrelated element of
 * page B. `gen` is the generation of the snapshot whose refs may still be acted on (null = none: the page
 * navigated, reloaded or the tab was switched), `loaderId` the document that snapshot was taken on.
 */
export interface TabRefState { gen: number | null; loaderId: string | null }

export type RefCheck = { ok: true; id: number } | { ok: false; error: 'stale_ref'; sentence: string }

const STALE = (why: string): RefCheck => ({ ok: false, error: 'stale_ref', sentence: `${why} Nothing was done. Take a new agentistics_browser_snapshot and use its refs.` })

/** Is `ref` still the one its snapshot minted, on the document that snapshot read? Pure. */
export function checkRef(ref: string, state: TabRefState | undefined, currentLoaderId: string | null): RefCheck {
  const p = parseBoundRef(ref)
  if (!p) return STALE('That is not a ref from a snapshot.')
  if (p.gen === null) return STALE('That ref has no snapshot mark (refs look like e12@g3).')
  if (!state || state.gen === null) return STALE('The page changed since that snapshot (navigation, reload or tab switch), so its refs are void.')
  if (p.gen !== state.gen) return STALE('That ref comes from an older snapshot.')
  if (currentLoaderId === null || currentLoaderId !== state.loaderId) return STALE('The page is not the one that snapshot was taken on.')
  return { ok: true, id: p.id }
}
