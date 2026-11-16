/**
 * browserCard.ts — the pure rules of the session browser CARD (NAVEGADOR S5, spec §3.2, prototype A1).
 *
 * Where the card sits in the conversation, what its caption says, whether this session has a browser at all
 * (read off `GET /api/browser/status`, never guessed) and how the person takes the browser over: an unlock is
 * the padlock route with the person's single-use VAULT grant (`POST /api/vault/browser-unlock`, S4b) — the
 * same `postWithOwnerProof` the delivery moves use, never a second proof path. Nothing here touches the DOM.
 */
import { postWithOwnerProof, ownerProofSentence, type OwnerGrant } from './ownerProof'
import { vaultPost } from './vaultApi'
import type { BrowserScreenStateEvent } from './browserStream'

// ── does this session browse? ──────────────────────────────────────────────────────────────────────

/**
 * A call to the agentistics browser tools, in any harness's spelling: `agentistics_browser_click`
 * (bare), `mcp__agentistics__agentistics_browser_click` (Claude), `agentistics__agentistics_browser_…`.
 * S6 replaces this with core's per-harness `isBrowserTool`; until then the card only needs OUR tools.
 */
export function isAgentisticsBrowserTool(name: string): boolean {
  return /(^|_)agentistics_browser_[a-z_]+$/.test(name)
}

interface ToolTurn { tools?: ReadonlyArray<{ name: string }> }

/** Index of the first turn that called a browser tool, or null. */
export function firstBrowserTurn(turns: readonly ToolTurn[]): number | null {
  for (let i = 0; i < turns.length; i++) if (turns[i]!.tools?.some(t => isAgentisticsBrowserTool(t.name))) return i
  return null
}

/**
 * Where the ONE card of a session goes: at the first browser call (it stays where the browser opened); when
 * no turn names one (a harness with no chat reader, or a name not in the transcript yet) but the host says
 * this session HAS a live browser, at the end. `null` = no card.
 */
export function browserAnchor(turns: readonly ToolTurn[], live: boolean): number | null {
  const first = firstBrowserTurn(turns)
  if (first !== null) return first
  return live ? turns.length : null
}

/**
 * The anchor mapped onto the rendered items (turns and grouped tool activity): the card is drawn AFTER the
 * returned position (-1 = before every item). A turn that SAID something before calling the browser is drawn
 * as its own item, and the card follows it directly (the prototype: "Vou abrir a página…" then the card — the
 * calls land in the tool run under the card). A call with no words is folded into the tool run after the
 * last turn at or before it, so the card follows that run. `anchor` is relative to the rendered window;
 * past the end = after everything.
 */
export function anchorItemPosition(items: ReadonlyArray<{ type: 'turn'; index: number } | { type: 'activity' }>, anchor: number): number {
  let p = -1
  let last = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.type === 'turn') {
      if (it.index === anchor) return i
      last = it.index
      if (it.index < anchor) p = i; else break
    }
  }
  if (anchor > last) return items.length - 1
  if (p + 1 < items.length && items[p + 1]!.type === 'activity') return p + 1
  return p
}

// ── the host's view of this session's browser ──────────────────────────────────────────────────────

export interface StatusLiveRow {
  owner: { kind: 'session'; managedId: string } | { kind: 'personal' }
  phase: string
  tabs: Array<{ targetId: string; url: string; title: string; active: boolean }>
}

/** This session's live browser in a `/api/browser/status` answer, or null. Malformed input reads as none. */
export function sessionBrowserOf(status: unknown, managedId: string): StatusLiveRow | null {
  const live = status && typeof status === 'object' ? (status as { live?: unknown }).live : null
  if (!Array.isArray(live)) return null
  for (const row of live) {
    const o = row && typeof row === 'object' ? (row as { owner?: unknown }).owner : null
    if (o && typeof o === 'object' && (o as { kind?: unknown }).kind === 'session' && (o as { managedId?: unknown }).managedId === managedId) {
      const r = row as StatusLiveRow
      if (r.phase === 'stopping') return null
      return { owner: r.owner, phase: String(r.phase), tabs: Array.isArray(r.tabs) ? r.tabs : [] }
    }
  }
  return null
}

// ── the caption ────────────────────────────────────────────────────────────────────────────────────

export type BrowserCaption =
  | { kind: 'yours' }
  | { kind: 'acting'; verb: string; target: string }
  | { kind: 'watching' }

const VERB: Record<string, { pt: string; en: string }> = {
  click: { pt: 'Clicando em', en: 'Clicking' },
  type: { pt: 'Digitando em', en: 'Typing into' },
  press: { pt: 'Pressionando', en: 'Pressing' },
  select: { pt: 'Escolhendo em', en: 'Choosing in' },
  scroll: { pt: 'Rolando', en: 'Scrolling' },
  navigate: { pt: 'Abrindo', en: 'Opening' },
  back: { pt: 'Voltando', en: 'Going back' },
  forward: { pt: 'Avançando', en: 'Going forward' },
  reload: { pt: 'Recarregando', en: 'Reloading' },
  tab_new: { pt: 'Abrindo uma aba', en: 'Opening a tab' },
  tab_select: { pt: 'Trocando para', en: 'Switching to' },
  tab_close: { pt: 'Fechando', en: 'Closing' },
  evaluate: { pt: 'Lendo a página', en: 'Reading the page' },
}

/** The card's footer: the person's turn while unlocked, else what the model is doing (the prototype's line). */
export function browserCaption(lock: 'locked' | 'unlocked' | 'none' | null, lastAction: BrowserScreenStateEvent['lastAction'], lang: 'pt' | 'en'): BrowserCaption {
  if (lock === 'unlocked') return { kind: 'yours' }
  if (!lastAction) return { kind: 'watching' }
  const v = VERB[lastAction.kind]
  if (!v) return lastAction.label ? { kind: 'acting', verb: '', target: lastAction.label } : { kind: 'watching' }
  return { kind: 'acting', verb: lang === 'pt' ? v.pt : v.en, target: lastAction.label }
}

/** Where the ring goes on the picture, as percentages of the frame, or null when the action has no point. */
export function ringAt(lastAction: BrowserScreenStateEvent['lastAction'], frame: { w: number; h: number } | null): { left: number; top: number } | null {
  if (!lastAction || typeof lastAction.x !== 'number' || typeof lastAction.y !== 'number' || !frame || !(frame.w > 0) || !(frame.h > 0)) return null
  const left = (lastAction.x / frame.w) * 100
  const top = (lastAction.y / frame.h) * 100
  if (!(left >= 0 && left <= 100 && top >= 0 && top <= 100)) return null
  return { left, top }
}

/**
 * Where the WHOLE page goes inside the screen: the frame scaled to fit both sides, centred (the bars are the
 * screen's black). The whole page, because the person must see what the model acts on — a width-fit crop hid
 * the form and the ring on a 330px card. `null` until both sizes are known.
 */
export function containBox(box: { width: number; height: number }, frame: { w: number; h: number } | null): { left: number; top: number; width: number; height: number } | null {
  if (!frame || !(frame.w > 0) || !(frame.h > 0) || !(box.width > 0) || !(box.height > 0)) return null
  const scale = Math.min(box.width / frame.w, box.height / frame.h)
  const width = Math.round(frame.w * scale)
  const height = Math.round(frame.h * scale)
  return { left: Math.floor((box.width - width) / 2), top: Math.floor((box.height - height) / 2), width, height }
}

/** The address shown read-only in the card's head: no scheme, no trailing slash. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '')
}

// ── the padlock ────────────────────────────────────────────────────────────────────────────────────

export type LockOutcome =
  | { ok: true; lock: 'locked' | 'unlocked' }
  | { ok: false; code: string; sentence: string; openVault: boolean }

/** The person's grant for ONE session browser (S4b), from the vault — its own prompt when the vault asks a password. */
export async function requestBrowserUnlockGrant(managedId: string): Promise<OwnerGrant> {
  const r = await vaultPost<{ ownerGrant: string }>('/api/vault/browser-unlock', { managedId })
  if (r.ok && typeof r.ownerGrant === 'string') return { ok: true, grant: r.ownerGrant }
  return { ok: false, code: r.ok ? 'failed' : r.code, sentence: r.ok ? '' : r.sentence }
}

const UNAVAILABLE = new Set(['owner_proof_unavailable', 'owner-proof-unavailable'])

/** The words for a refused padlock change — ours for the proof codes, else the server's sentence. */
export function lockRefusalSentence(code: string, serverSentence: string | undefined, pt: boolean): string {
  if (UNAVAILABLE.has(code)) {
    return pt
      ? 'Para assumir o navegador de uma sessão, o agentistics precisa confirmar que é você. Abra o Cofre e crie uma senha (ou ative o Windows Hello / Touch ID); depois tente de novo.'
      : "To take over a session's browser, agentistics needs to confirm it is you. Open the Vault and set a password (or turn on Windows Hello / Touch ID), then try again."
  }
  if (code === 'session_cannot_unlock') {
    return pt ? 'Só a pessoa pode destravar o navegador de uma sessão.' : "Only the person can unlock a session's browser."
  }
  if (code === 'no_browser') {
    return pt ? 'Esta sessão não tem um navegador aberto agora.' : 'This session has no browser open right now.'
  }
  if (code.startsWith('owner') || code.startsWith('grant') || code === 'locked' || code === 'presence-cancelled' || code === 'stepup-frozen' || code === 'recovery-mode') {
    return ownerProofSentence(code, pt)
  }
  return serverSentence && serverSentence.trim() ? serverSentence : (pt ? 'Não foi possível mudar o cadeado.' : 'Could not change the padlock.')
}

/**
 * Lock or unlock a session's browser. Locking is a plain request; unlocking asks the vault for the person's
 * grant when the server says so and repeats the SAME request with it (`postWithOwnerProof`).
 */
export async function setBrowserLock(
  managedId: string, lock: 'locked' | 'unlocked', pt: boolean,
  ask: (managedId: string) => Promise<OwnerGrant> = requestBrowserUnlockGrant,
): Promise<LockOutcome> {
  const r = await postWithOwnerProof('/api/browser/lock', { owner: managedId, lock }, { pieceKey: managedId, move: lock }, undefined, pt, (k) => ask(k))
  if (r.status < 400 && r.body.ok !== false) {
    const got = r.body.lock === 'unlocked' || r.body.lock === 'locked' ? r.body.lock : lock
    return { ok: true, lock: got }
  }
  const code = typeof r.body.error === 'string' ? r.body.error : 'failed'
  const sentence = typeof r.body.sentence === 'string' ? r.body.sentence : undefined
  const action = r.body.action as { kind?: unknown } | undefined
  return { ok: false, code, sentence: lockRefusalSentence(code, sentence, pt), openVault: UNAVAILABLE.has(code) || action?.kind === 'open-vault' }
}
