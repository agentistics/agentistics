/**
 * The browser's door onto `/api/vault/*` (SECRETS.4 §7.1) and the few pure rules the screen needs.
 *
 * What is NOT here: any decision about what an action asks. The server sends its own table
 * (`gates`, from `VAULT_ACTION_ROWS`) and every route enforces it again — this module only reads it to
 * draw the 🔑 / 👆 icons and to know whether a code field has to appear BEFORE the request rather than
 * after a 401. It is deliberately not `lib/stepup.ts`: that is the IAM step-up (a different grant, a
 * different route set); the vault's grant is bound to the vault service and travels in its own header.
 *
 * The 5-minute 'read' grant lives in MEMORY only — never localStorage, never a cookie — so closing the
 * tab ends it, and a script on another origin cannot read it.
 */
export type VaultLang = 'en' | 'pt'

export interface GateRow { code: boolean; gesture: boolean; grant: boolean }
export interface VaultItem {
  kind: string; state: 'sealed' | 'pending' | 'unreadable'; reason?: string; sealedAt?: string; file: string; restoreWith?: string
}
export interface Hardening { state: 'ok' | 'limited' | 'failed'; private: boolean | null; coreDumps: 'off' | 'on' | null; yama: string | null; lines: string[] }
export interface VaultView {
  state: string
  protector: string | null
  protectorLabel: string | null
  kid: string | null
  createdAt: string | null
  sentence: string | null
  pending: number
  canLock: boolean
  items: VaultItem[]
  locked?: boolean
  wrappers: string[]
  presence: boolean
  presenceAvailable: string[]
  authenticator: { enrolledAt: string; lastUsedAt: string | null; failures: number; pausedUntil: string | null; frozen: boolean } | null
  recoveryCreatedAt: string | null
  requirePresence: boolean
  autoLockMinutes: number
  autoLockInMs: number | null
  pendingStepup: boolean
  lockedBy: string | null
  recoveryTodo: string[] | null
  hardening: Hardening | null
  gates: Record<string, GateRow>
}

/** A refusal, exactly as the server words it (already in the user's language). */
export interface Refusal { ok: false; code: string; sentence: string; status: number }
export type Reply<T = Record<string, never>> = ({ ok: true } & T) | Refusal

export type LoadResult =
  | { kind: 'view'; view: VaultView }
  | { kind: 'needs-stepup'; view: VaultView; sentence: string; code: string }
  | { kind: 'failed' }

// ── the grant (memory only) ──────────────────────────────────────────────────────────────────

const GRANT_MARGIN_MS = 5_000
let _grant: { token: string; until: number } | null = null

export function rememberGrant(token: string | undefined, now = Date.now()): void {
  _grant = token ? { token, until: now + 5 * 60_000 - GRANT_MARGIN_MS } : _grant
}
export function forgetGrant(): void { _grant = null }
export function grantAlive(now = Date.now()): boolean { return _grant !== null && now < _grant.until }

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> } | null> {
  try {
    const headers: Record<string, string> = {}
    // Every POST is JSON, even an empty one: the server refuses a vault POST of any other type (a
    // cross-site page could send text/plain without a preflight — review M1).
    const sent = method === 'POST' ? (body ?? {}) : body
    if (sent !== undefined) headers['Content-Type'] = 'application/json'
    if (grantAlive()) headers['x-vault-grant'] = _grant!.token
    const r = await fetch(path, { method, headers, ...(sent !== undefined ? { body: JSON.stringify(sent) } : {}) })
    const json = await r.json().catch(() => ({})) as Record<string, unknown>
    if (typeof json.grant === 'string') rememberGrant(json.grant)
    if (r.status === 401 && json.code === 'stepup-required') forgetGrant()
    return { status: r.status, json }
  } catch { return null }
}

const reply = <T,>(r: { status: number; json: Record<string, unknown> } | null): Reply<T> => {
  if (!r) return { ok: false, code: 'network', sentence: '', status: 0 }
  if (r.json.ok === true) return r.json as unknown as Reply<T>
  return { ok: false, code: String(r.json.code ?? 'failed'), sentence: String(r.json.sentence ?? r.json.error ?? ''), status: r.status }
}

// ── the calls ────────────────────────────────────────────────────────────────────────────────

export async function loadVault(): Promise<LoadResult> {
  const r = await call('GET', '/api/vault')
  if (!r) return { kind: 'failed' }
  if (r.status === 401 || r.status === 403) {
    if (r.json.needsStepUp === true && r.json.view) return { kind: 'needs-stepup', view: r.json.view as VaultView, sentence: String(r.json.sentence ?? ''), code: String(r.json.code ?? '') }
    return { kind: 'failed' }
  }
  return r.status === 200 && typeof r.json.state === 'string' ? { kind: 'view', view: r.json as unknown as VaultView } : { kind: 'failed' }
}

export const stepUp = (code: string) => call('POST', '/api/vault/stepup', { code }).then(r => reply<{ grant: string }>(r))
export const lockNow = (code?: string) => call('POST', '/api/vault/lock', code ? { code } : {}).then(r => reply(r))
/** Phase 1: raises the gesture IN THE SERVICE. `pending-stepup` = a code is owed (§2.2). */
export const unlockGesture = () => call('POST', '/api/vault/unlock').then(r => reply<{ state: string }>(r))
export const unlockCode = (code: string) => call('POST', '/api/vault/unlock/code', { code }).then(r => reply(r))
export const setAutoLock = (minutes: number, code?: string) => call('POST', '/api/vault/auto-lock', { minutes, ...(code ? { code } : {}) }).then(r => reply(r))
export const heartbeat = () => { void call('POST', '/api/vault/activity', {}) }

/** `setupCode`: the one-time code `agentop vault setup-code` prints — a page's FIRST enrolment needs it (review S2). */
export const authenticatorBegin = (code?: string, setupCode?: string) => call('POST', '/api/vault/authenticator/begin', { ...(code ? { code } : {}), ...(setupCode ? { setupCode } : {}) }).then(r => reply<{ uri: string; secret: string }>(r))
export const authenticatorConfirm = (code: string) => call('POST', '/api/vault/authenticator/confirm', { code }).then(r => reply<{ grant: string }>(r))
export const presenceProbe = (protector: 'hello' | 'fido2', code?: string) => call('POST', '/api/vault/presence/probe', { protector, ...(code ? { code } : {}) }).then(r => reply(r))
export const recoveryBegin = (code?: string, setupCode?: string) => call('POST', '/api/vault/recovery/begin', { ...(code ? { code } : {}), ...(setupCode ? { setupCode } : {}) }).then(r => reply<{ words: string[]; positions: number[] }>(r))
export const recoveryConfirm = (typed: string[]) => call('POST', '/api/vault/recovery/confirm', { typed }).then(r => reply(r))
/** `replaceRecovery`: no words at hand — make NEW words after presence (the old ones stop working). */
export const presenceEnrol = (protector: 'hello' | 'fido2', code?: string, replaceRecovery?: boolean) => call('POST', '/api/vault/presence/enroll', { protector, ...(code ? { code } : {}), ...(replaceRecovery ? { replaceRecovery: true } : {}) }).then(r => reply<{ removed: string[]; recoveryOwed: boolean }>(r))
export const presenceDisable = (code?: string) => call('POST', '/api/vault/presence/disable', code ? { code } : {}).then(r => reply(r))
export interface Credential { type: string; label: string; createdAt: string }
export const credentials = () => call('GET', '/api/vault/credentials').then(r => reply<{ credentials: Credential[]; recoveryCreatedAt: string | null; requirePresence: boolean }>(r))

// ── pure rules ───────────────────────────────────────────────────────────────────────────────

export const AUTO_LOCK_MIN = 5
export const AUTO_LOCK_MAX = 480

/** PURE. The idle period as typed: whole minutes only; anything else is "not a number yet" (null). */
export function parseAutoLockInput(s: string): number | null {
  const t = s.trim()
  return /^\d{1,4}$/.test(t) ? Number(t) : null
}
/** PURE. 5–480, never "never" (§5.1). */
export function clampAutoLock(n: number): number {
  return Number.isFinite(n) ? Math.min(AUTO_LOCK_MAX, Math.max(AUTO_LOCK_MIN, Math.round(n))) : 30
}

/** PURE. Milliseconds left on the idle clock, counted from when the server reported it. */
export function remainingMs(reportedInMs: number | null, reportedAt: number, now: number): number | null {
  return reportedInMs === null ? null : Math.max(0, reportedInMs - (now - reportedAt))
}
/** PURE. Whole minutes for a countdown, rounded UP so "0 min" never shows while it is still open. */
export function minutesLeft(ms: number): number { return Math.max(0, Math.ceil(ms / 60_000)) }

/**
 * PURE. Which of the two proofs an action asks of THIS vault right now: the code only once an
 * authenticator is enrolled, the gesture only once a presence wrapper exists (the server's own rule —
 * `requireVaultStepUp`). Used to draw the icons and to decide whether to ask for a code up front.
 */
export function gateFor(view: Pick<VaultView, 'gates' | 'authenticator' | 'presence'>, action: string): { code: boolean; gesture: boolean; grant: boolean } {
  const row = view.gates[action]
  if (!row) return { code: false, gesture: false, grant: false }
  return { code: row.code && view.authenticator !== null, gesture: row.gesture && view.presence, grant: row.grant }
}
/** PURE. Does the request need a typed code, or can a live grant stand in for it? */
export function needsTypedCode(g: { code: boolean; grant: boolean }, grantIsAlive: boolean): boolean {
  return g.code && !(g.grant && grantIsAlive)
}

export type WizardStep = 'authenticator' | 'recovery' | 'presence'
/** What the wizard runs: the device check leads whenever a fresh enrolment will end in presence. */
export type WizardPhaseStep = 'probe' | WizardStep

/** PURE. The whole §7.3 flow for what is missing: probe → authenticator → recovery → presence. */
export function wizardPlan(missing: readonly WizardStep[]): WizardPhaseStep[] {
  return missing.includes('presence') && missing.includes('authenticator') ? ['probe', ...missing] : [...missing]
}

/** PURE. What an action will ask, as words for a tooltip — from the gate row, narrowed by this vault. */
export function askWords(g: { code: boolean; gesture: boolean }, words: { code: string; presence: string; and: string; asks: string; nothing: string }): string {
  if (!g.code && !g.gesture) return words.nothing
  const parts = [g.code ? words.code : null, g.gesture ? words.presence : null].filter(Boolean).join(words.and)
  return words.asks.replace('{what}', parts)
}
/** PURE. What an "ultra secure" setup still lacks, in the one safe order (presence last — it retires the silent wrapper). */
export function missingSteps(v: Pick<VaultView, 'authenticator' | 'recoveryCreatedAt' | 'presence' | 'presenceAvailable'>): WizardStep[] {
  const out: WizardStep[] = []
  // Leader decision 2: presence BEFORE the recovery key (presence replaces the data key; the words made
  // last wrap the final one and are never kept in memory across steps).
  if (!v.authenticator) out.push('authenticator')
  if (!v.presence && v.presenceAvailable.length > 0) out.push('presence')
  if (!v.recoveryCreatedAt) out.push('recovery')
  return out
}

/** PURE. The 24 words as 6 rows × 4 columns, numbered (the order a person copies them onto paper). */
export function wordRows(words: readonly string[], perRow = 4): { n: number; word: string }[][] {
  const rows: { n: number; word: string }[][] = []
  for (let i = 0; i < words.length; i += perRow) rows.push(words.slice(i, i + perRow).map((word, j) => ({ n: i + j + 1, word })))
  return rows
}

/** PURE. Digits only, at most 6 — what a code field holds. */
export function cleanCode(s: string): string { return s.replace(/\D/g, '').slice(0, 6) }
/** The 8-digit setup code (`agentop vault setup-code`), spaces and dashes ignored. */
export function cleanSetupCode(s: string): string { return s.replace(/\D/g, '').slice(0, 8) }
export const setupCodeComplete = (s: string): boolean => /^\d{8}$/.test(s)
export const codeComplete = (s: string): boolean => /^\d{6}$/.test(s)

// ── what a glance should say (VAULT.UX2) ─────────────────────────────────────────────────────

export type Tone = 'ok' | 'warn' | 'rec' | 'off'
export type BadgeKey =
  | 'badge_configured' | 'badge_missing' | 'badge_recommended' | 'badge_on' | 'badge_na' | 'badge_attention'
  | 'badge_active' | 'badge_limited' | 'badge_minutes' | 'badge_sealed' | 'badge_pending'
export type SectionId = 'authenticator' | 'presence' | 'recovery' | 'autolock' | 'memory' | 'secrets'

/**
 * PURE. The badge each section wears: a tone (colour AND a glyph in the words, never colour alone) and
 * the text key. "missing" is only said for what the setup can still add; a thing this machine cannot
 * have is "not available here", which is a fact and not a to-do.
 */
export function sectionBadge(
  v: Pick<VaultView, 'authenticator' | 'presence' | 'presenceAvailable' | 'recoveryCreatedAt' | 'hardening'>,
  id: SectionId, counts: { sealed: number; pending: number } = { sealed: 0, pending: 0 },
): { tone: Tone; key: BadgeKey } {
  switch (id) {
    case 'authenticator':
      if (!v.authenticator) return { tone: 'warn', key: 'badge_missing' }
      return v.authenticator.frozen || v.authenticator.pausedUntil ? { tone: 'warn', key: 'badge_attention' } : { tone: 'ok', key: 'badge_configured' }
    case 'presence':
      if (v.presence) return { tone: 'ok', key: 'badge_on' }
      return v.presenceAvailable.length === 0 ? { tone: 'off', key: 'badge_na' } : { tone: 'rec', key: 'badge_recommended' }
    case 'recovery': return v.recoveryCreatedAt ? { tone: 'ok', key: 'badge_configured' } : { tone: 'warn', key: 'badge_missing' }
    case 'autolock': return { tone: 'ok', key: 'badge_minutes' }
    case 'memory': {
      const h = v.hardening
      if (!h) return { tone: 'off', key: 'badge_limited' }
      if (h.state === 'failed' || h.private === false || h.coreDumps === 'on') return { tone: 'warn', key: 'badge_attention' }
      return h.private === true && h.coreDumps === 'off' ? { tone: 'ok', key: 'badge_active' } : { tone: 'off', key: 'badge_limited' }
    }
    case 'secrets': return counts.pending > 0 ? { tone: 'warn', key: 'badge_pending' } : { tone: 'ok', key: 'badge_sealed' }
  }
}

/** PURE. Which of the three steps of "how your vault works" the person is on NOW: 0 locked, 1 confirming, 2 open. */
export function howNow(v: Pick<VaultView, 'state' | 'pendingStepup'>): 0 | 1 | 2 {
  return v.state === 'open' ? 2 : v.pendingStepup ? 1 : 0
}

/** PURE. What step 2 asks of THIS vault: nothing yet, the code alone, or the gesture and the code. */
export function howConfirms(v: Pick<VaultView, 'authenticator' | 'presence'>): 'nothing' | 'code' | 'both' {
  return v.presence && v.authenticator ? 'both' : v.authenticator ? 'code' : v.presence ? 'both' : 'nothing'
}

/**
 * PURE. The ONE primary action of the page: the first thing the setup still lacks, and only when the
 * banner (which carries its own primary) is not showing. Everything else that is missing keeps a
 * quiet button — two loud buttons for one flow is how a person stops knowing where to start.
 */
export function primarySection(missing: readonly WizardStep[], bannerShowing: boolean): WizardStep | null {
  return bannerShowing ? null : (missing[0] ?? null)
}
